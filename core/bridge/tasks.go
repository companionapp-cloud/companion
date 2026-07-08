package bridge

import (
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/notify"
	"companion/core/store"
)

// tasksChangedEvent lets task lists refresh; data.changed refreshes the graph and any
// embedded-task views; nav.changed recomputes the sidebar's per-project progress ring,
// which is a function of member-task status (PLAN §6.4, §6.6).
const tasksChangedEvent = "tasks.changed"

func (c *Core) emitTaskChanged(id string) {
	c.emit(tasksChangedEvent, nil)
	c.emitDataChanged("task", id)
	c.emit(navChangedEvent, nil)
}

func (c *Core) tasksList() ([]byte, error) {
	tasks, err := c.store.Tasks.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(tasks)
}

// RepeatingTask is a seed paired with its next computed occurrence — what the "Repeating"
// UI renders, and the only thing a client with no server can show since occurrences never
// materialize locally (PLAN §6.4). NextOccurrence is nil when the rule is exhausted.
type RepeatingTask struct {
	*domain.Task
	NextOccurrence *time.Time `json:"nextOccurrence"`
}

// tasksListSeeds returns the repeating-task definitions, each with its next occurrence
// computed from core so every client previews the same date.
func (c *Core) tasksListSeeds() ([]byte, error) {
	seeds, err := c.store.Tasks.ListSeeds()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	out := make([]RepeatingTask, 0, len(seeds))
	for _, s := range seeds {
		item := RepeatingTask{Task: s}
		if s.RepeatRule != nil {
			// A malformed rule shouldn't nuke the whole list; just leave its preview nil.
			if next, err := domain.NextOccurrence(*s.RepeatRule, domain.RepeatAnchor(s), now); err == nil {
				item.NextOccurrence = next
			}
		}
		out = append(out, item)
	}
	return json.Marshal(out)
}

// tasksParseRepeat turns a typed natural-language cadence ("every monday", "the third
// wednesday of the month", "weekdays until aug 1") into an RRULE (PLAN §6.4), parsed in Go
// so every platform understands the same phrases. `ref` is the caller's local now (RFC3339)
// anchoring any trailing "until …" bound; it defaults to the core's now. Returns {rule:null}
// when the phrase isn't a recognizable recurrence, so the UI can show inline feedback.
func (c *Core) tasksParseRepeat(payload []byte) ([]byte, error) {
	var args struct {
		Text string `json:"text"`
		Ref  string `json:"ref"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ref := time.Now()
	if args.Ref != "" {
		if parsed, err := time.Parse(time.RFC3339, args.Ref); err == nil {
			ref = parsed
		}
	}
	rule, err := domain.ParseRepeatPhrase(args.Text, ref)
	if err != nil {
		return nil, err
	}
	if rule == "" {
		return json.Marshal(map[string]any{"rule": nil})
	}
	return json.Marshal(map[string]any{"rule": rule})
}

// tasksRepeatPreview validates a candidate RRULE and returns its next few occurrences from
// an anchor — powering the live "repeats every … · next …" hint in the task editor before
// the seed is saved. Returns {valid:false} for a malformed rule rather than erroring, so the
// form can show inline feedback while the user types.
func (c *Core) tasksRepeatPreview(payload []byte) ([]byte, error) {
	var args struct {
		Rule   string `json:"rule"`
		Anchor string `json:"anchor"` // RFC3339; defaults to now
		Count  int    `json:"count"`  // how many upcoming occurrences to preview
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.Count <= 0 || args.Count > 20 {
		args.Count = 3
	}
	anchor := time.Now().UTC()
	if args.Anchor != "" {
		if parsed, err := time.Parse(time.RFC3339, args.Anchor); err == nil {
			anchor = parsed.UTC()
		}
	}
	if err := domain.ValidateRepeatRule(&args.Rule); err != nil {
		return json.Marshal(map[string]any{"valid": false})
	}
	// Preview occurrences strictly after the anchor, walking forward Count times.
	occ := []time.Time{}
	cursor := anchor
	for i := 0; i < args.Count; i++ {
		next, err := domain.NextOccurrence(args.Rule, anchor, cursor)
		if err != nil || next == nil {
			break
		}
		occ = append(occ, *next)
		cursor = *next
	}
	return json.Marshal(map[string]any{"valid": true, "occurrences": occ})
}

func (c *Core) tasksGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	t, err := c.store.Tasks.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	return json.Marshal(t)
}

func (c *Core) tasksCreate(payload []byte) ([]byte, error) {
	var in store.CreateTaskInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	t, err := c.store.Tasks.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitTaskChanged(t.ID)
	return json.Marshal(t)
}

func (c *Core) tasksUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateTaskInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	t, err := c.store.Tasks.Update(args.ID, args.UpdateTaskInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitTaskChanged(t.ID)
	return json.Marshal(t)
}

// tasksDelete moves a task to the Trash (PLAN §4.3), like notes.delete. "Delete forever"
// and "Restore" go through the trash.* methods.
func (c *Core) tasksDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Tasks.Trash(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitTaskChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// notifyPlan returns the reminder/due notifications due to fire over a rolling window
// (default 30 days), computed in core from the live tasks (PLAN §6.4). The shell schedules
// them per-platform.
func (c *Core) notifyPlan(payload []byte) ([]byte, error) {
	var args struct {
		HorizonDays int `json:"horizonDays"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.HorizonDays <= 0 {
		args.HorizonDays = 30
	}
	tasks, err := c.store.Tasks.List()
	if err != nil {
		return nil, err
	}
	plan := notify.PlanTasks(tasks, time.Now().UTC(), time.Duration(args.HorizonDays)*24*time.Hour)
	return json.Marshal(plan)
}

// notifyDismissed returns the ids of settled tasks (done/cancelled/trashed/deleted) whose
// reminder already fired, so the shell can clear their lingering OS notification (PLAN §6.4).
// Pending fires are cancelled by re-planning; this covers already-surfaced ones.
func (c *Core) notifyDismissed(payload []byte) ([]byte, error) {
	var args struct {
		HorizonDays int `json:"horizonDays"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.HorizonDays <= 0 {
		args.HorizonDays = 30
	}
	tasks, err := c.store.Tasks.List()
	if err != nil {
		return nil, err
	}
	ids := notify.SettledReminderIDs(tasks, time.Now().UTC(), time.Duration(args.HorizonDays)*24*time.Hour)
	return json.Marshal(ids)
}
