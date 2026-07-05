package bridge

import (
	"encoding/json"
	"time"

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
