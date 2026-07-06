package bridge

import (
	"encoding/json"
	"errors"
	"fmt"

	"companion/core/domain"
	"companion/core/llm"
	"companion/core/store"
)

// LLM bridge methods (PLAN §6.8). Config CRUD manages the user's providers; llm.chat runs
// the on-device agentic loop, streaming assistant text and tool actions out as events while
// it works and returning the final transcript.

// systemPrompt frames the assistant: it is grounded in the user's own data via tools and
// acts on their behalf, reporting actions with the wikilinks the tools return. It is
// deliberately strict about two failure modes: fabricating an action it didn't perform, and
// answering from a snippet or memory instead of a note's real, full content.
const systemPrompt = `You are Companion, an assistant embedded in the user's personal notes, tasks, and projects. You act by calling tools — you cannot change anything by just describing it.

Dates — never guess the current date:
- For anything involving "today", "now", "tomorrow", "this week", "next Friday", or any relative date, and before you set a task's due date, call get_date first. Your own idea of the current date is unreliable — always get it from the tool.

Grounding — never invent the user's content:
- To read, quote, summarize, or copy a note or task, first call get_note / get_task to load its FULL body by id. search_notes returns only a short snippet — never treat a snippet, a title, or your own memory as the note's content.
- Typical flow to reuse content: search_notes to find the id -> get_note(id) to read the real body -> then act. Example: "create Note B with the content of Note A" means get_note(A) first, then create_note(B) using exactly that returned content. Do not make up B's content.

Acting — never claim an action you did not perform:
- Creating or updating a note/task ONLY happens when you call create_note / update_note / create_task / update_task and the tool returns success. Do NOT say you created, updated, or saved anything unless you actually called the tool this turn and saw the result.
- Never print a note's or task's new content inline as a substitute for saving it. If the user wants it saved, call the write tool with that content — don't just show it.
- update_note / update_task require the entity's id; get it from search_notes / get_note / list_tasks first.
- A task has ONE due date (dueAt) and, separately, ONE reminder time (remindAt). "Remind me to X on Sunday, and an hour before" is a SINGLE task with dueAt = Sunday and remindAt = one hour before that — never two tasks. Call get_date, compute both timestamps, and pass them to one create_task.
` + webToolsPrompt + `
Showing a note:
- When you want to show the user a note's content, call render_note with its id to display an inline, clickable preview in the chat. Do this instead of pasting the note's Markdown into your message. Add a sentence of commentary if useful, but don't duplicate the body you just rendered.

After a successful write, briefly say what you did and reference the entity with the wikilink the tool returned (e.g. [[note:...]] or [[task:...]]). Be concise and direct.`

// llm token/tool event names streamed to the shell during a chat turn, plus a config-change
// hint so open chat surfaces can refresh their provider list.
const (
	eventLLMToken          = "llm.token"
	eventLLMTool           = "llm.tool"
	eventLLMError          = "llm.error"
	eventLLMConfigsChanged = "llm.configs.changed"
)

// emitConfigsChanged notifies subscribers that the provider list changed (add/edit/remove/
// default), so a chat screen can re-fetch and show/hide its selector without a remount.
func (c *Core) emitConfigsChanged() { c.emit(eventLLMConfigsChanged, nil) }

func (c *Core) llmConfigsList() ([]byte, error) {
	configs, err := c.store.LLMConfigs.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(configs)
}

// llmConfigsCreate creates a provider config. For cloud providers an apiKey may be supplied;
// it is written to the keychain under a generated ref and only the ref is persisted.
func (c *Core) llmConfigsCreate(payload []byte) ([]byte, error) {
	var args struct {
		store.CreateLLMConfigInput
		APIKey string `json:"apiKey"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	cfg, err := c.store.LLMConfigs.Create(args.CreateLLMConfigInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if args.APIKey != "" {
		ref := "llm." + cfg.ID
		if err := c.storeSecret(ref, args.APIKey); err != nil {
			return nil, err
		}
		if cfg, err = c.store.LLMConfigs.Update(cfg.ID, store.UpdateLLMConfigInput{APIKeyRef: &ref}); err != nil {
			return nil, mapStoreErr(err)
		}
	}
	c.emitConfigsChanged()
	return json.Marshal(cfg)
}

// llmConfigsUpdate applies field changes; a supplied apiKey is (re)written to the keychain.
func (c *Core) llmConfigsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateLLMConfigInput
		APIKey string `json:"apiKey"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.APIKey != "" {
		existing, err := c.store.LLMConfigs.Get(args.ID)
		if err != nil {
			return nil, mapStoreErr(err)
		}
		ref := "llm." + args.ID
		if existing.APIKeyRef != nil {
			ref = *existing.APIKeyRef
		}
		if err := c.storeSecret(ref, args.APIKey); err != nil {
			return nil, err
		}
		args.UpdateLLMConfigInput.APIKeyRef = &ref
	}
	cfg, err := c.store.LLMConfigs.Update(args.ID, args.UpdateLLMConfigInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitConfigsChanged()
	return json.Marshal(cfg)
}

func (c *Core) llmConfigsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// Best-effort remove the stored key; a missing secret store or key is not fatal.
	if cfg, err := c.store.LLMConfigs.Get(args.ID); err == nil && cfg.APIKeyRef != nil && c.secrets != nil {
		_ = c.secrets.DeleteSecret(*cfg.APIKeyRef)
	}
	if err := c.store.LLMConfigs.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitConfigsChanged()
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) llmConfigsSetDefault(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.LLMConfigs.SetDefault(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitConfigsChanged()
	return json.Marshal(map[string]bool{"ok": true})
}

// buildEngine assembles the agentic engine for a config (the given id, or the default when
// empty): a provider wired to the config's base URL and keychain key, plus the store-backed
// tool registry.
func (c *Core) buildEngine(configID string) (*llm.Engine, error) {
	var (
		cfg *domain.LLMConfig
		err error
	)
	if configID != "" {
		cfg, err = c.store.LLMConfigs.Get(configID)
	} else {
		cfg, err = c.store.LLMConfigs.Default()
	}
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, errors.New("no LLM configured")
		}
		return nil, err
	}

	apiKey := ""
	if cfg.APIKeyRef != nil {
		if c.secrets == nil {
			return nil, errors.New("this provider needs an API key but no keychain is available on this device")
		}
		if apiKey, err = c.secrets.GetSecret(*cfg.APIKeyRef); err != nil {
			return nil, fmt.Errorf("read api key: %w", err)
		}
	}

	var provider llm.Provider
	switch cfg.Provider {
	case domain.ProviderAnthropic:
		provider = &llm.AnthropicProvider{BaseURL: cfg.BaseURL, APIKey: apiKey}
	case domain.ProviderOpenAI:
		provider = &llm.OpenAIProvider{BaseURL: cfg.BaseURL, APIKey: apiKey}
	default:
		return nil, fmt.Errorf("unknown provider %q", cfg.Provider)
	}

	return &llm.Engine{
		Provider: provider,
		Registry: llm.NewStoreRegistry(c.store),
		System:   systemPrompt,
		Model:    cfg.Model,
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
