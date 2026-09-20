package bridge

import (
	"encoding/json"
	"errors"

	"companion/core/domain"
	"companion/core/store"
)

// navChangedEvent signals the sidebar (areas/projects + indicators) to recompute after
// an area, project, or membership mutation (PLAN §6.6). Emitted alongside the granular
// data.changed so the graph and membership pickers refresh too.
const navChangedEvent = "nav.changed"

func (c *Core) emitNavChanged(entityType, id string) {
	c.emit(navChangedEvent, nil)
	c.emitDataChanged(entityType, id)
}

// ---- areas ---------------------------------------------------------------

func (c *Core) areasList() ([]byte, error) {
	areas, err := c.store.Areas.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(areas)
}

func (c *Core) areasCreate(payload []byte) ([]byte, error) {
	var in store.CreateAreaInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	a, err := c.store.Areas.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitNavChanged("area", a.ID)
	return json.Marshal(a)
}

func (c *Core) areasUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateAreaInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	a, err := c.store.Areas.Update(args.ID, args.UpdateAreaInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("area", a.ID)
	return json.Marshal(a)
}

// areasReorder persists a new top-to-bottom order for the areas (PLAN §6.6 drag-and-drop).
func (c *Core) areasReorder(payload []byte) ([]byte, error) {
	var args struct {
		IDs []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Areas.Reorder(args.IDs); err != nil {
		return nil, err
	}
	c.emitNavChanged("area", "")
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) areasDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		// DeleteContent trashes the notes/tasks filed directly in the area too; otherwise they
		// keep living and fall back to "Unsorted", like a deleted project's (PLAN-areas.md §2).
		DeleteContent bool `json:"deleteContent"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// An area is only deletable once empty of projects, so they aren't silently orphaned into
	// "Unsorted". The client hides the affordance until then; this is the backstop (PLAN §6.6).
	n, err := c.store.Projects.CountForArea(args.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, store.ErrAreaNotEmpty
	}
	members, err := c.store.ProjectMembers.ListForArea(args.ID)
	if err != nil {
		return nil, err
	}
	if args.DeleteContent {
		if err := c.trashProjectMembers(members); err != nil {
			return nil, err
		}
	}
	if err := c.store.ProjectMembers.DeleteForProject(args.ID); err != nil {
		return nil, err
	}
	if err := c.store.Areas.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("area", args.ID)
	if args.DeleteContent && len(members) > 0 {
		c.emit(notesChangedEvent, nil)
		c.emit(tasksChangedEvent, nil)
		c.emitDataChanged("", "")
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// ---- projects ------------------------------------------------------------

func (c *Core) projectsList() ([]byte, error) {
	projects, err := c.store.Projects.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(projects)
}

func (c *Core) projectsCreate(payload []byte) ([]byte, error) {
	var in store.CreateProjectInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	p, err := c.store.Projects.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitNavChanged("project", p.ID)
	return json.Marshal(p)
}

func (c *Core) projectsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateProjectInput
		// CompleteTasks, sent alongside completed:true, finishes the project's open tasks with
		// it (PLAN-scheduling.md §2): the UI confirms first, then the whole project lands in
		// the Logbook together.
		CompleteTasks bool `json:"completeTasks"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	completing := args.Completed != nil && *args.Completed && args.CompleteTasks
	var p *domain.Project
	err := c.store.Batch(func() error {
		if completing {
			if err := c.completeProjectTasks(args.ID); err != nil {
				return err
			}
		}
		var err error
		p, err = c.store.Projects.Update(args.ID, args.UpdateProjectInput)
		return err
	})
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if completing {
		c.emit(tasksChangedEvent, nil)
	}
	c.emitNavChanged("project", p.ID)
	return json.Marshal(p)
}

// completeProjectTasks marks every open task filed in the project done. Repeating seeds are
// definitions, not to-dos, and are left alone.
func (c *Core) completeProjectTasks(projectID string) error {
	members, err := c.store.ProjectMembers.ListForProject(projectID)
	if err != nil {
		return err
	}
	done := domain.TaskDone
	for _, m := range members {
		if m.EntityType != domain.NodeTask {
			continue
		}
		t, err := c.store.Tasks.Get(m.EntityID)
		if errors.Is(err, store.ErrNotFound) {
			continue // trashed or gone: nothing to finish
		}
		if err != nil {
			return err
		}
		if t.Status != domain.TaskOpen || t.IsRepeatSeed() {
			continue
		}
		if _, err := c.store.Tasks.Update(t.ID, store.UpdateTaskInput{Status: &done}); err != nil {
			return err
		}
	}
	return nil
}

// projectsReorder persists a new top-to-bottom order for a single area's projects (PLAN
// §6.6 drag-and-drop). Project order is scoped to the area.
func (c *Core) projectsReorder(payload []byte) ([]byte, error) {
	var args struct {
		AreaID string   `json:"areaId"`
		IDs    []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Projects.Reorder(args.AreaID, args.IDs); err != nil {
		return nil, err
	}
	c.emitNavChanged("project", "")
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) projectsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		// DeleteContent trashes the project's member notes/tasks too; otherwise they keep
		// living and fall back to "Unsorted" (PLAN §6.6).
		DeleteContent bool `json:"deleteContent"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// Snapshot the memberships before DeleteForProject drops their edges — the optional
	// content trash below walks them.
	members, err := c.store.ProjectMembers.ListForProject(args.ID)
	if err != nil {
		return nil, err
	}
	if args.DeleteContent {
		if err := c.trashProjectMembers(members); err != nil {
			return nil, err
		}
	}
	// Tombstone the project's memberships (dropping their edges) and its lists.
	if err := c.store.ProjectMembers.DeleteForProject(args.ID); err != nil {
		return nil, err
	}
	if err := c.deleteListsForProject(args.ID); err != nil {
		return nil, err
	}
	if err := c.store.Projects.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("project", args.ID)
	if args.DeleteContent {
		// The member notes/tasks moved to the Trash — refresh those lists and the graph.
		c.emit(notesChangedEvent, nil)
		c.emit(tasksChangedEvent, nil)
		c.emitDataChanged("", "")
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// trashProjectMembers moves a deleted project's member entities to the Trash (the
// "delete content" branch of projects.delete — PLAN §6.6). Notes cascade to their embedded
// documents, matching notes.delete; tasks trash directly. Habits have no repo yet, so they
// are skipped. A member already gone (ErrNotFound) is ignored so a partially-deleted
// project still cleans up.
func (c *Core) trashProjectMembers(members []*domain.ProjectMember) error {
	for _, m := range members {
		switch m.EntityType {
		case domain.NodeNote:
			docIDs, err := c.store.Links.EmbeddedDocumentIDs(domain.NodeNote, m.EntityID)
			if err != nil {
				return err
			}
			if err := c.store.Notes.Trash(m.EntityID); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					continue
				}
				return err
			}
			if err := c.cascadeTrashDocuments(docIDs); err != nil {
				return err
			}
		case domain.NodeTask:
			if err := c.store.Tasks.Trash(m.EntityID); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					continue
				}
				return err
			}
		}
	}
	return nil
}

// ---- membership ----------------------------------------------------------

// memberArgs identifies a membership by its (project, entity) tuple.
type memberArgs struct {
	ProjectID  string `json:"projectId"`
	EntityType string `json:"entityType"`
	EntityID   string `json:"entityId"`
}

// checkMemberTarget refuses to file a calendar, or a calendar account, that isn't here (a picker
// left open while it was removed on another device). Content members are not checked: a dangling
// one is tolerated like any dangling reference (PLAN §6.6).
func (c *Core) checkMemberTarget(entityType, entityID string) error {
	var err error
	switch entityType {
	case domain.MemberCalendar:
		_, err = c.store.CalendarFeeds.Get(entityID)
	case domain.MemberCalendarAccount:
		_, err = c.store.CalendarAccounts.Get(entityID)
	}
	return mapStoreErr(err)
}

// taskListProjects snapshots the projects the given tasks are filed in, before a move. Filing
// a task somewhere else takes it out of those projects' lists (the store does that), so the
// caller announces lists.changed for each afterwards.
func (c *Core) taskListProjects(entityType string, entityIDs []string) (map[string]bool, error) {
	out := map[string]bool{}
	if entityType != domain.NodeTask {
		return out, nil
	}
	for _, id := range entityIDs {
		members, err := c.store.ProjectMembers.ListForEntity(entityType, id)
		if err != nil {
			return nil, err
		}
		for _, m := range members {
			if !m.InArea() {
				out[m.ProjectID] = true
			}
		}
	}
	return out, nil
}

// emitMoved announces the lists a move emptied a task out of; keepID is the project the task
// now lives in (its lists are untouched).
func (c *Core) emitMoved(left map[string]bool, keepID string) {
	for projectID := range left {
		if projectID != keepID {
			c.emitListsChanged(projectID, "")
		}
	}
}

// projectsAddMember files an entity in a project. Content lives in one place, so this MOVES a
// note/task/habit/canvas out of whatever project or area held it (PLAN-areas.md §2.1).
func (c *Core) projectsAddMember(payload []byte) ([]byte, error) {
	var args memberArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.checkMemberTarget(args.EntityType, args.EntityID); err != nil {
		return nil, err
	}
	left, err := c.taskListProjects(args.EntityType, []string{args.EntityID})
	if err != nil {
		return nil, err
	}
	m, err := c.store.ProjectMembers.Add(args.ProjectID, args.EntityType, args.EntityID)
	if err != nil {
		return nil, err
	}
	c.emitMoved(left, args.ProjectID)
	c.emitNavChanged(args.EntityType, args.EntityID)
	return json.Marshal(m)
}

// projectsAddMembers assigns several entities to one project in a single call (bulk
// multiselect "assign to project" — PLAN §6.6), so the UI issues one request. Emits one
// nav.changed + bulk data.changed after the batch.
func (c *Core) projectsAddMembers(payload []byte) ([]byte, error) {
	var args struct {
		ProjectID  string   `json:"projectId"`
		EntityType string   `json:"entityType"`
		EntityIDs  []string `json:"entityIds"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	for _, id := range args.EntityIDs {
		if err := c.checkMemberTarget(args.EntityType, id); err != nil {
			return nil, err
		}
	}
	left, err := c.taskListProjects(args.EntityType, args.EntityIDs)
	if err != nil {
		return nil, err
	}
	members, err := c.store.ProjectMembers.AddMany(args.ProjectID, args.EntityType, args.EntityIDs)
	if err != nil {
		return nil, err
	}
	c.emitMoved(left, args.ProjectID)
	c.emit(navChangedEvent, nil)
	c.emitDataChanged("", "")
	return json.Marshal(members)
}

func (c *Core) projectsRemoveMember(payload []byte) ([]byte, error) {
	var args memberArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.ProjectMembers.Remove(args.ProjectID, args.EntityType, args.EntityID); err != nil {
		return nil, mapStoreErr(err)
	}
	// A list only holds its project's tasks, so a task leaving the project left its lists
	// (ProjectMembersRepo.Remove).
	if args.EntityType == domain.NodeTask {
		c.emitListsChanged(args.ProjectID, "")
	}
	c.emitNavChanged(args.EntityType, args.EntityID)
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) projectsMembers(payload []byte) ([]byte, error) {
	var args struct {
		ProjectID string `json:"projectId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	members, err := c.store.ProjectMembers.ListForProject(args.ProjectID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(members)
}

// projectsForEntity lists the memberships of one entity — powers the membership picker
// in a note/task/habit detail view (which projects am I in?).
func (c *Core) projectsForEntity(payload []byte) ([]byte, error) {
	var args struct {
		EntityType string `json:"entityType"`
		EntityID   string `json:"entityId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if !domain.MemberEntityTypes[args.EntityType] {
		return json.Marshal([]*domain.ProjectMember{})
	}
	members, err := c.store.ProjectMembers.ListForEntity(args.EntityType, args.EntityID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(members)
}

// projectsMemberEntityIds returns the ids of entities of a type that belong to at least one
// project — the "sorted" set the browse lists subtract to show "Unsorted" vs "All" (§6.6).
func (c *Core) projectsMemberEntityIds(payload []byte) ([]byte, error) {
	var args struct {
		EntityType string `json:"entityType"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if !domain.MemberEntityTypes[args.EntityType] {
		return json.Marshal([]string{})
	}
	ids, err := c.store.ProjectMembers.MemberEntityIDs(args.EntityType)
	if err != nil {
		return nil, err
	}
	return json.Marshal(ids)
}

// ---- area membership (PLAN-areas.md §2) -----------------------------------

// areaMemberArgs identifies a membership filed directly in an area.
type areaMemberArgs struct {
	AreaID     string `json:"areaId"`
	EntityType string `json:"entityType"`
	EntityID   string `json:"entityId"`
}

// areasAddMember files a note, task or canvas directly in an area, moving it out of whatever
// project or area held it.
func (c *Core) areasAddMember(payload []byte) ([]byte, error) {
	var args areaMemberArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Areas.Get(args.AreaID); err != nil {
		return nil, mapStoreErr(err)
	}
	left, err := c.taskListProjects(args.EntityType, []string{args.EntityID})
	if err != nil {
		return nil, err
	}
	m, err := c.store.ProjectMembers.AddToArea(args.AreaID, args.EntityType, args.EntityID)
	if err != nil {
		return nil, err
	}
	c.emitMoved(left, "")
	c.emitNavChanged(args.EntityType, args.EntityID)
	return json.Marshal(m)
}

// areasAddMembers is the bulk form (multiselect "move to area").
func (c *Core) areasAddMembers(payload []byte) ([]byte, error) {
	var args struct {
		AreaID     string   `json:"areaId"`
		EntityType string   `json:"entityType"`
		EntityIDs  []string `json:"entityIds"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Areas.Get(args.AreaID); err != nil {
		return nil, mapStoreErr(err)
	}
	left, err := c.taskListProjects(args.EntityType, args.EntityIDs)
	if err != nil {
		return nil, err
	}
	members, err := c.store.ProjectMembers.AddManyToArea(args.AreaID, args.EntityType, args.EntityIDs)
	if err != nil {
		return nil, err
	}
	c.emitMoved(left, "")
	c.emit(navChangedEvent, nil)
	c.emitDataChanged("", "")
	return json.Marshal(members)
}

func (c *Core) areasRemoveMember(payload []byte) ([]byte, error) {
	var args areaMemberArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.ProjectMembers.Remove(args.AreaID, args.EntityType, args.EntityID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged(args.EntityType, args.EntityID)
	return json.Marshal(map[string]bool{"ok": true})
}

// areasMembers lists what is filed directly in an area, or — with tree — that plus the content
// of every project in it, which is what the area's overview rolls up (PLAN-areas.md §3).
func (c *Core) areasMembers(payload []byte) ([]byte, error) {
	var args struct {
		AreaID string `json:"areaId"`
		Tree   bool   `json:"tree"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	list := c.store.ProjectMembers.ListForArea
	if args.Tree {
		list = c.store.ProjectMembers.ListForAreaTree
	}
	members, err := list(args.AreaID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(members)
}

// ---- sidebar -------------------------------------------------------------

func (c *Core) navSidebar() ([]byte, error) {
	data, err := c.store.Sidebar()
	if err != nil {
		return nil, err
	}
	return json.Marshal(data)
}

// projectsSomedayTaskIds lists the tasks filed in a Someday project, which the task lists hide
// along with it (PLAN-scheduling.md §1).
func (c *Core) projectsSomedayTaskIds() ([]byte, error) {
	ids, err := c.store.ProjectMembers.SomedayTaskIDs()
	if err != nil {
		return nil, err
	}
	return json.Marshal(ids)
}
