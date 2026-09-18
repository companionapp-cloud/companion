package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"companion/core/agents"
	"companion/core/domain"
	"companion/core/llm"
	"companion/core/store"
)

// Agent bridge methods (PLAN-agents.md §2.1). An agent is something the user installs: a cloud
// API with a key, or a local tool (Claude Code, Codex, Ollama, LM Studio) discovered on and
// hosted by a desktop. The model is chosen per chat, not here.

const eventAgentsChanged = "agents.changed"

// emitAgentsChanged tells open chat surfaces to re-fetch the agent list. The legacy
// llm.configs.changed name is emitted too for one release.
func (c *Core) emitAgentsChanged() {
	c.emit(eventAgentsChanged, nil)
	c.emit(eventLLMConfigsChanged, nil)
}

// agentView decorates an agent with runtime facts the UI needs: whether this device hosts it
// and whether its host is reachable right now.
type agentView struct {
	*domain.Agent
	HostedHere bool `json:"hostedHere"`
	Online     bool `json:"online"`
}

func (c *Core) agentView(a *domain.Agent) agentView {
	me, _ := c.store.EnsureDeviceID()
	hostedHere := a.IsHostedBy(me)
	online := true
	if a.IsLocal() {
		if hostedHere {
			online = a.Runtime.IsHTTP() || c.runners != nil
		} else {
			online = c.deviceOnline(*a.HostDeviceID)
		}
	}
	return agentView{Agent: a, HostedHere: hostedHere, Online: online}
}

func (c *Core) agentsList() ([]byte, error) {
	list, err := c.store.Agents.List()
	if err != nil {
		return nil, err
	}
	out := make([]agentView, 0, len(list))
	for _, a := range list {
		out = append(out, c.agentView(a))
	}
	return json.Marshal(out)
}

// agentsInstall creates an agent. Local runtimes are pinned to this device (the caller may
// pass hostDeviceId explicitly only when installing on behalf of this same device). A cloud
// key is encrypted into the synced row on an E2EE account, else kept in the device secret
// store with only a ref on the row.
func (c *Core) agentsInstall(payload []byte) ([]byte, error) {
	var args struct {
		store.CreateAgentInput
		APIKey string `json:"apiKey"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	in := args.CreateAgentInput
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		in.Name = in.Runtime.Label()
	}
	if !domain.ValidRuntime(in.Runtime) {
		return nil, fmt.Errorf("unknown runtime %q", in.Runtime)
	}
	if !in.Runtime.IsCloud() && in.Runtime != domain.RuntimeOpenAICompat {
		// Discovered local tools are always hosted by the installing device.
		info, err := c.store.DeviceInfo()
		if err != nil {
			return nil, err
		}
		in.HostDeviceID = &info.ID
		name := c.deviceDisplayName(info)
		in.HostName = &name
	}
	if in.Runtime.NeedsAPIKey() && strings.TrimSpace(args.APIKey) == "" {
		return nil, errors.New("an API key is required for " + in.Runtime.Label())
	}
	// First agent becomes the default so chat works immediately.
	if existing, err := c.store.Agents.List(); err == nil && len(existing) == 0 {
		in.IsDefault = true
	}
	a, err := c.store.Agents.Create(in)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if key := strings.TrimSpace(args.APIKey); key != "" {
		enc, ref, err := c.storeAgentKey(a.ID, key)
		if err != nil {
			_ = c.store.Agents.Delete(a.ID)
			return nil, err
		}
		if a, err = c.store.Agents.Update(a.ID, store.UpdateAgentInput{APIKeyEnc: enc, APIKeyRef: ref}); err != nil {
			return nil, mapStoreErr(err)
		}
	}
	c.emitAgentsChanged()
	return json.Marshal(c.agentView(a))
}

// agentsUpdate applies field changes; a supplied apiKey is (re)stored the same way install does.
func (c *Core) agentsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateAgentInput
		APIKey string `json:"apiKey"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if key := strings.TrimSpace(args.APIKey); key != "" {
		enc, ref, err := c.storeAgentKey(args.ID, key)
		if err != nil {
			return nil, err
		}
		args.UpdateAgentInput.APIKeyEnc = enc
		args.UpdateAgentInput.APIKeyRef = ref
	}
	a, err := c.store.Agents.Update(args.ID, args.UpdateAgentInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitAgentsChanged()
	return json.Marshal(c.agentView(a))
}

func (c *Core) agentsRemove(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// Best-effort remove a device-local key; a missing secret store or key is not fatal.
	if a, err := c.store.Agents.Get(args.ID); err == nil && a.APIKeyRef != nil && c.secrets != nil {
		_ = c.secrets.DeleteSecret(*a.APIKeyRef)
	}
	if err := c.store.Agents.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitAgentsChanged()
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) agentsSetDefault(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Agents.SetDefault(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitAgentsChanged()
	return json.Marshal(map[string]bool{"ok": true})
}

// agentsDiscover scans this machine for supported local AI tools. Shells that cannot exec
// (web, mobile) inject no discoverer and get an empty list, which hides the section.
func (c *Core) agentsDiscover() ([]byte, error) {
	if c.discoverer == nil {
		return json.Marshal([]agents.Discovered{})
	}
	found, err := c.discoverer.Discover(context.Background())
	if err != nil {
		return nil, err
	}
	// Mark tools an agent row on this device already points at.
	me, _ := c.store.EnsureDeviceID()
	installed, _ := c.store.Agents.List()
	for i := range found {
		for _, a := range installed {
			if !a.IsHostedBy(me) || string(a.Runtime) != found[i].Runtime {
				continue
			}
			if a.Runtime.IsCLI() && (a.BinaryPath == nil || *a.BinaryPath != found[i].Path) {
				continue
			}
			id := a.ID
			found[i].InstalledAgentID = &id
			break
		}
	}
	return json.Marshal(found)
}

// agentsModels returns the models an agent currently offers: fetched live for HTTP runtimes,
// a curated list for CLI runtimes. Agents hosted elsewhere are asked through the relay.
func (c *Core) agentsModels(payload []byte) ([]byte, error) {
	var args struct {
		AgentID  string `json:"agentId"`
		ConfigID string `json:"configId"` // legacy alias
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.AgentID == "" {
		args.AgentID = args.ConfigID
	}
	a, err := c.resolveAgent(args.AgentID)
	if err != nil {
		return nil, err
	}
	me, _ := c.store.EnsureDeviceID()
	if a.IsLocal() && !a.IsHostedBy(me) {
		return c.remoteModels(a)
	}
	models, err := c.localModels(a)
	if err != nil {
		return nil, err
	}
	return json.Marshal(models)
}

// localModels lists models for an agent this device can reach directly.
func (c *Core) localModels(a *domain.Agent) ([]string, error) {
	if a.Runtime.IsCLI() {
		runner, err := c.runnerFor(a)
		if err != nil {
			return nil, err
		}
		return runner.ListModels(context.Background())
	}
	provider, err := c.providerFor(a)
	if err != nil {
		return nil, err
	}
	lister, ok := provider.(llm.ModelLister)
	if !ok {
		return nil, fmt.Errorf("%s cannot list models", a.Runtime.Label())
	}
	return lister.ListModels(context.Background())
}

// resolveAgent returns the agent for the given id, or the default when empty.
func (c *Core) resolveAgent(agentID string) (*domain.Agent, error) {
	var (
		a   *domain.Agent
		err error
	)
	if agentID != "" {
		a, err = c.store.Agents.Get(agentID)
	} else {
		a, err = c.store.Agents.Default()
	}
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, errors.New("no LLM configured")
		}
		return nil, err
	}
	return a, nil
}

// storeAgentKey decides where a cloud key lives. With E2EE unlocked the key rides in the synced
// row (encrypted on the wire by the row cipher; plaintext in this device's SQLite, like every
// other synced secret such as calendar feed URLs). Without E2EE it stays in the device secret
// store under a ref, so it never syncs in the clear.
func (c *Core) storeAgentKey(agentID, key string) (enc *string, ref *string, err error) {
	if c.getMasterKey() != nil {
		return &key, nil, nil
	}
	r := "llm." + agentID
	if err := c.storeSecret(r, key); err != nil {
		return nil, nil, err
	}
	return nil, &r, nil
}

// agentAPIKey reads the credential for a cloud agent from whichever storage holds it.
func (c *Core) agentAPIKey(a *domain.Agent) (string, error) {
	if a.APIKeyEnc != nil && *a.APIKeyEnc != "" {
		return *a.APIKeyEnc, nil
	}
	if a.APIKeyRef != nil && *a.APIKeyRef != "" {
		if c.secrets == nil {
			return "", errors.New("this agent needs an API key but no keychain is available on this device")
		}
		key, err := c.secrets.GetSecret(*a.APIKeyRef)
		if err != nil {
			return "", fmt.Errorf("read api key: %w", err)
		}
		return key, nil
	}
	if a.Runtime.NeedsAPIKey() {
		return "", fmt.Errorf("%s has no API key on this device; add it in Settings › AI", a.Name)
	}
	return "", nil
}

// providerFor builds the wire provider for an HTTP agent.
func (c *Core) providerFor(a *domain.Agent) (llm.Provider, error) {
	apiKey, err := c.agentAPIKey(a)
	if err != nil {
		return nil, err
	}
	switch a.Runtime.WireProtocol() {
	case domain.ProviderAnthropic:
		return &llm.AnthropicProvider{BaseURL: a.BaseURL, APIKey: apiKey}, nil
	case domain.ProviderOpenAI:
		return &llm.OpenAIProvider{BaseURL: a.BaseURL, APIKey: apiKey}, nil
	default:
		return nil, fmt.Errorf("%s is not an HTTP agent", a.Runtime.Label())
	}
}

// runnerFor resolves the CLI runner for an agent hosted by this device.
func (c *Core) runnerFor(a *domain.Agent) (agents.Runner, error) {
	if c.runners == nil {
		return nil, fmt.Errorf("%s can only run on the desktop that hosts it", a.Name)
	}
	path := ""
	if a.BinaryPath != nil {
		path = *a.BinaryPath
	}
	return c.runners.RunnerFor(string(a.Runtime), path)
}

// buildEngine assembles the agentic engine for an HTTP agent running the given model.
func (c *Core) buildEngine(a *domain.Agent, model string) (*llm.Engine, error) {
	if strings.TrimSpace(model) == "" {
		return nil, errors.New("no model selected for this chat")
	}
	provider, err := c.providerFor(a)
	if err != nil {
		return nil, err
	}
	registry := llm.NewStoreRegistry(c.store)
	if !a.AllowWrite {
		registry = registry.ReadOnly()
	}
	return &llm.Engine{
		Provider: provider,
		Registry: registry,
		System:   systemPrompt,
		Model:    model,
	}, nil
}

// storeSecret writes an API key to the injected keychain, erroring clearly when the shell
// has not provided one (so a key is never silently dropped).
func (c *Core) storeSecret(ref, value string) error {
	if c.secrets == nil {
		return errors.New("cannot store API key: no keychain available on this device")
	}
	return c.secrets.SetSecret(ref, value)
}

func (c *Core) emitLLMError(chatID string, err error) {
	p, _ := json.Marshal(map[string]string{"chatId": chatID, "error": err.Error()})
	c.emit(eventLLMError, p)
}
