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
)

// Editor AI (the note editor's writing assists): one-shot, tool-free completions over a note or
// a selection of it — generate from a prompt, rewrite for a reading level, check grammar,
// summarize, translate, critique, and fill in the note's structured metadata. Unlike chats
// nothing is persisted: a run streams its text as ai.delta events and ends with a single ai.done
// (carrying the parsed result for the structured tasks) or ai.error, all tagged with the
// caller-chosen run id. The editor decides what to do with the output.
//
// Runs use an agent this device can reach itself (a cloud key, a local server, or a CLI it
// hosts) or, through the relay, one hosted by another device that is online (ai_relay.go).

const (
	eventAIDelta = "ai.delta" // {runId, text}: a chunk of streamed output (text tasks only)
	eventAIDone  = "ai.done"  // {runId, task, text, result?, agent, model}: the run finished
	eventAIError = "ai.error" // {runId, error}: the run failed (not sent when cancelled)
)

// aiDocumentMax bounds the note text sent as context, so a huge note can't blow the model's
// context window (the target text itself is sent whole).
const aiDocumentMax = 60_000

// aiRunArgs is the ai.run payload. Text is what the task acts on: the selection, or the whole
// note when nothing is selected. Document is the whole note for context, sent only with a
// selection or (for generate) with a cursor marker showing where the output will go.
type aiRunArgs struct {
	RunID     string `json:"runId"`
	Task      string `json:"task"`
	Text      string `json:"text"`
	Document  string `json:"document"`
	Title     string `json:"title"`
	Selection bool   `json:"selection"`
	// Task parameters: the instruction (generate), target grade (readingLevel), target
	// language (translate), and the entity's current type (metadata; "" lets the model pick).
	Prompt       string `json:"prompt"`
	Grade        int    `json:"grade"`
	Language     string `json:"language"`
	ObjectTypeID string `json:"objectTypeId"`
	Kind         string `json:"kind"`
	// Optional overrides; by default the editor uses the usable default agent and the model it
	// last chatted on.
	AgentID string `json:"agentId"`
	Model   string `json:"model"`
}

// aiStatus reports whether the editor assists are available on this device, and on which
// agent, so the editor can show or hide its AI controls.
func (c *Core) aiStatus() ([]byte, error) {
	a, err := c.editorAgent("")
	if err != nil {
		return json.Marshal(map[string]any{"enabled": false, "reason": err.Error()})
	}
	return json.Marshal(map[string]any{"enabled": true, "agentId": a.ID, "agentName": a.Name, "runtime": a.Runtime})
}

// aiRun validates the request, builds the task's prompt, and starts the completion on a
// goroutine, returning immediately. Output arrives as ai.* events.
func (c *Core) aiRun(payload []byte) ([]byte, error) {
	var args aiRunArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.RunID) == "" {
		return nil, errors.New("runId is required")
	}
	task, err := c.buildAITask(args)
	if err != nil {
		return nil, err
	}
	agent, err := c.editorAgent(args.AgentID)
	if err != nil {
		return nil, err
	}
	if c.aiRemote(agent) {
		return c.aiRunRemote(args, agent)
	}
	model, err := c.editorModel(agent, args.Model)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.chatMu.Lock()
	if _, busy := c.aiRuns[args.RunID]; busy {
		c.chatMu.Unlock()
		cancel()
		return nil, errors.New("this run is already in progress")
	}
	c.aiRuns[args.RunID] = cancel
	c.chatMu.Unlock()

	go c.runAITask(ctx, args.RunID, agent, model, task)
	return json.Marshal(map[string]any{"ok": true, "runId": args.RunID, "agent": agent.Name, "model": model})
}

// aiCancel aborts a live run; reports whether there was one. A cancelled run emits nothing more.
func (c *Core) aiCancel(payload []byte) ([]byte, error) {
	var args struct {
		RunID string `json:"runId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	c.chatMu.Lock()
	cancel, ok := c.aiRuns[args.RunID]
	c.chatMu.Unlock()
	if ok {
		cancel()
	}
	return json.Marshal(map[string]bool{"ok": true, "cancelled": ok})
}

// runAITask drives one completion to the end and reports it.
func (c *Core) runAITask(ctx context.Context, runID string, agent *domain.Agent, model string, task *aiTask) {
	defer func() {
		c.chatMu.Lock()
		delete(c.aiRuns, runID)
		c.chatMu.Unlock()
	}()
	var onDelta llm.DeltaFunc
	if task.stream {
		onDelta = func(text string) {
			p, _ := json.Marshal(map[string]string{"runId": runID, "text": text})
			c.emit(eventAIDelta, p)
		}
	}
	text, err := c.aiComplete(ctx, agent, model, task.system, task.user, onDelta)
	if ctx.Err() != nil {
		return
	}
	var result any
	if err == nil && task.parse != nil {
		result, err = task.parse(text)
	}
	if err != nil {
		p, _ := json.Marshal(map[string]string{"runId": runID, "error": err.Error()})
		c.emit(eventAIError, p)
		return
	}
	p, _ := json.Marshal(map[string]any{
		"runId": runID, "task": task.name, "text": strings.TrimSpace(text), "result": result,
		"agent": agent.Name, "model": model,
	})
	c.emit(eventAIDone, p)
}

// aiComplete runs one tool-free completion on an agent and returns its full text, streaming
// through onDelta when set. HTTP agents get a single provider round; CLI agents run one fresh,
// read-only turn with the system prompt folded into the message.
func (c *Core) aiComplete(ctx context.Context, a *domain.Agent, model, system, user string, onDelta llm.DeltaFunc) (string, error) {
	if a.Runtime.IsCLI() {
		runner, err := c.runnerFor(a)
		if err != nil {
			return "", err
		}
		cwd, err := c.runners.WorkDir(a.ID)
		if err != nil {
			return "", err
		}
		delta := func(string) {}
		if onDelta != nil {
			delta = onDelta
		}
		res, err := runner.Run(ctx, agents.RunRequest{Prompt: system + "\n\n" + user, Model: model, Cwd: cwd}, delta, func(agents.ToolUse) {})
		if err != nil {
			return "", err
		}
		return res.Text, nil
	}
	provider, err := c.providerFor(a)
	if err != nil {
		return "", err
	}
	resp, err := provider.Chat(ctx, llm.ChatRequest{
		Model:    model,
		System:   system,
		Messages: []llm.Message{{Role: llm.RoleUser, Text: user}},
	}, onDelta)
	if err != nil {
		return "", err
	}
	if resp.StopReason == llm.StopRefusal {
		return "", errors.New("the model declined this request")
	}
	return resp.Message.Text, nil
}

// editorAgent picks the agent for an editor assist: the requested one, else the default when
// it's usable from here, else the first agent that is. Agents this device runs itself come
// first; one hosted by another (online) device is the fallback, reached through the relay.
func (c *Core) editorAgent(agentID string) (*domain.Agent, error) {
	if agentID != "" {
		a, err := c.resolveAgent(agentID)
		if err != nil {
			return nil, err
		}
		if reason := c.aiUnusable(a); reason != "" {
			return nil, errors.New(reason)
		}
		return a, nil
	}
	def, defErr := c.resolveAgent("")
	if defErr == nil && c.aiUnusable(def) == "" {
		return def, nil
	}
	list, err := c.store.Agents.List()
	if err != nil {
		return nil, err
	}
	for _, a := range list {
		if c.aiUnusable(a) == "" && !c.aiRemote(a) {
			return a, nil
		}
	}
	for _, a := range list {
		if c.aiUnusable(a) == "" {
			return a, nil
		}
	}
	if defErr == nil {
		return nil, errors.New(c.aiUnusable(def))
	}
	return nil, errors.New("no LLM configured; add one in Settings › AI")
}

// aiUnusable explains why this device can't run an editor assist on the agent, or "" if it can.
func (c *Core) aiUnusable(a *domain.Agent) string {
	v := c.agentView(a)
	switch {
	case a.IsLocal() && !v.HostedHere && c.relay == nil:
		return fmt.Sprintf("%s runs on %s; sign in to sync on both devices to use it from here", a.Name, agentHost(a))
	case a.IsLocal() && !v.HostedHere && !v.Online:
		return fmt.Sprintf("%s is offline; %s will be available when it is back", agentHost(a), a.Name)
	case a.IsLocal() && !v.HostedHere:
		return "" // reachable through the relay; its host checks the rest (key, binary)
	case !v.Online:
		return fmt.Sprintf("%s isn't available on this device", a.Name)
	case a.Runtime.NeedsAPIKey() && !v.HasKey:
		return fmt.Sprintf("%s has no API key on this device; add it in Settings › AI", a.Name)
	}
	return ""
}

// editorModel picks the model: the requested one, else the one the user last chatted with on
// this agent, else the first the agent offers. CLI agents may run on their own default.
func (c *Core) editorModel(a *domain.Agent, requested string) (string, error) {
	if m := strings.TrimSpace(requested); m != "" {
		return m, nil
	}
	if chats, err := c.store.Chats.List(); err == nil {
		for _, ch := range chats { // most recently active first
			if ch.Model == nil || *ch.Model == "" {
				continue
			}
			pinned := chatDerefStr(ch.ConfigID)
			if pinned == a.ID || (pinned == "" && a.IsDefault) {
				return *ch.Model, nil
			}
		}
	}
	models, err := c.localModels(a)
	if err == nil && len(models) > 0 {
		return models[0], nil
	}
	if a.Runtime.IsCLI() {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("choose a model for %s: %w", a.Name, err)
	}
	return "", fmt.Errorf("%s offers no models right now", a.Name)
}
