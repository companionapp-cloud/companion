package bridge

import (
	"encoding/json"
	"errors"

	"companion/core/domain"
	"companion/core/store"
)

// listsChangedEvent signals the lists UI to refetch after any list or list-item mutation.
// Payload: {projectId, listId} (either may be empty on bulk changes). Emitted alongside the
// granular data.changed so the graph and other subscribers refresh too.
const listsChangedEvent = "lists.changed"

func (c *Core) emitListsChanged(projectID, listID string) {
	payload, _ := json.Marshal(map[string]string{"projectId": projectID, "listId": listID})
	c.emit(listsChangedEvent, payload)
	c.emitDataChanged("list", listID)
}

// listDetail is the wire shape of lists.get: the list plus its ordered items.
type listDetail struct {
	List  *domain.List       `json:"list"`
	Items []*domain.ListItem `json:"items"`
}

// ---- lists ----------------------------------------------------------------

// listsList returns a project's lists in their user-defined order.
func (c *Core) listsList(payload []byte) ([]byte, error) {
	var args struct {
		ProjectID string `json:"projectId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	lists, err := c.store.Lists.ListForProject(args.ProjectID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(lists)
}

// listsGet returns one list with its ordered items.
func (c *Core) listsGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	items, err := c.store.ListItems.ListForList(args.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(listDetail{List: l, Items: items})
}

func (c *Core) listsCreate(payload []byte) ([]byte, error) {
	var in store.CreateListInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	if _, err := c.store.Projects.Get(in.ProjectID); err != nil {
		return nil, mapStoreErr(err)
	}
	l, err := c.store.Lists.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(l)
}

func (c *Core) listsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateListInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Update(args.ID, args.UpdateListInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(l)
}

// listsReorder persists a new top-to-bottom order for one project's lists.
func (c *Core) listsReorder(payload []byte) ([]byte, error) {
	var args struct {
		ProjectID string   `json:"projectId"`
		IDs       []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Lists.Reorder(args.ProjectID, args.IDs); err != nil {
		return nil, err
	}
	c.emitListsChanged(args.ProjectID, "")
	return json.Marshal(map[string]bool{"ok": true})
}

// listsDelete removes a list and tombstones its items. The tasks themselves are untouched:
// a list only orders tasks, it never owns them.
func (c *Core) listsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if err := c.deleteList(l.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// deleteList tombstones a list's items then the list itself.
func (c *Core) deleteList(id string) error {
	if err := c.store.ListItems.DeleteForList(id); err != nil {
		return err
	}
	return c.store.Lists.Delete(id)
}

// deleteListsForProject removes every list of a project (projects.delete cascade).
func (c *Core) deleteListsForProject(projectID string) error {
	lists, err := c.store.Lists.ListForProject(projectID)
	if err != nil {
		return err
	}
	for _, l := range lists {
		if err := c.deleteList(l.ID); err != nil {
			return err
		}
	}
	return nil
}

// ---- items ----------------------------------------------------------------

// listsItems returns a list's live items in display order.
func (c *Core) listsItems(payload []byte) ([]byte, error) {
	var args struct {
		ListID string `json:"listId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	items, err := c.store.ListItems.ListForList(args.ListID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(items)
}

// addTaskToList appends a task to a list, ensuring the task is a member of the list's
// project first (a list only ever holds its project's tasks).
func (c *Core) addTaskToList(l *domain.List, taskID string) (*domain.ListItem, error) {
	if _, err := c.store.Tasks.Get(taskID); err != nil {
		return nil, mapStoreErr(err)
	}
	if _, err := c.store.ProjectMembers.Add(l.ProjectID, domain.NodeTask, taskID); err != nil {
		return nil, err
	}
	return c.store.ListItems.AddTask(l.ID, taskID)
}

func (c *Core) listsAddTask(payload []byte) ([]byte, error) {
	var args struct {
		ListID string `json:"listId"`
		TaskID string `json:"taskId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ListID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	item, err := c.addTaskToList(l, args.TaskID)
	if err != nil {
		return nil, err
	}
	c.emit(navChangedEvent, nil)
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(item)
}

// listsAddTasks appends several tasks to a list in one call (multiselect "add to list").
func (c *Core) listsAddTasks(payload []byte) ([]byte, error) {
	var args struct {
		ListID  string   `json:"listId"`
		TaskIDs []string `json:"taskIds"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ListID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	items := make([]*domain.ListItem, 0, len(args.TaskIDs))
	for _, taskID := range args.TaskIDs {
		item, err := c.addTaskToList(l, taskID)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	c.emit(navChangedEvent, nil)
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(items)
}

// listsCreateTask creates a brand-new task, makes it a member of the list's project, and
// appends it to the list — the "new task" affordance inside a list, as one call.
func (c *Core) listsCreateTask(payload []byte) ([]byte, error) {
	var args struct {
		ListID string `json:"listId"`
		store.CreateTaskInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ListID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	t, err := c.store.Tasks.Create(args.CreateTaskInput)
	if err != nil {
		return nil, err
	}
	item, err := c.addTaskToList(l, t.ID)
	if err != nil {
		return nil, err
	}
	c.emitTaskChanged(t.ID)
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(struct {
		Task *domain.Task     `json:"task"`
		Item *domain.ListItem `json:"item"`
	}{t, item})
}

func (c *Core) listsAddHeading(payload []byte) ([]byte, error) {
	var args struct {
		ListID string `json:"listId"`
		Title  string `json:"title"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	l, err := c.store.Lists.Get(args.ListID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	item, err := c.store.ListItems.AddHeading(l.ID, args.Title)
	if err != nil {
		return nil, err
	}
	c.emitListsChanged(l.ProjectID, l.ID)
	return json.Marshal(item)
}

func (c *Core) listsUpdateItem(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateListItemInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	item, err := c.store.ListItems.Update(args.ID, args.UpdateListItemInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitListsChanged(c.projectIDForList(item.ListID), item.ListID)
	return json.Marshal(item)
}

func (c *Core) listsRemoveItem(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	item, err := c.store.ListItems.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if err := c.store.ListItems.Remove(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitListsChanged(c.projectIDForList(item.ListID), item.ListID)
	return json.Marshal(map[string]bool{"ok": true})
}

// listsReorderItems persists a new top-to-bottom order for one list's items — the
// drag-and-drop write path. Headings and tasks share the single order, so dragging a task
// under a heading is just a position change.
func (c *Core) listsReorderItems(payload []byte) ([]byte, error) {
	var args struct {
		ListID string   `json:"listId"`
		IDs    []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.ListItems.Reorder(args.ListID, args.IDs); err != nil {
		return nil, err
	}
	c.emitListsChanged(c.projectIDForList(args.ListID), args.ListID)
	return json.Marshal(map[string]bool{"ok": true})
}

// listsForTask returns the ids of the lists a task appears in (powers "in list" badges).
func (c *Core) listsForTask(payload []byte) ([]byte, error) {
	var args struct {
		TaskID string `json:"taskId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ids, err := c.store.ListItems.ListIDsForTask(args.TaskID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(ids)
}

// projectIDForList resolves a list's project for change events; empty if the list is gone.
func (c *Core) projectIDForList(listID string) string {
	l, err := c.store.Lists.GetAny(listID)
	if err != nil || errors.Is(err, store.ErrNotFound) {
		return ""
	}
	return l.ProjectID
}
