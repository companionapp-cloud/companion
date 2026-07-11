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
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// An area is only deletable once empty, so its projects aren't silently orphaned into
	// "Unsorted". The client hides the affordance until the area is empty; this is the
	// backstop (PLAN §6.6).
	n, err := c.store.Projects.CountForArea(args.ID)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, store.ErrAreaNotEmpty
	}
	if err := c.store.Areas.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("area", args.ID)
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
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, err := c.store.Projects.Update(args.ID, args.UpdateProjectInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("project", p.ID)
	return json.Marshal(p)
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
	// Tombstone the project's memberships (dropping their edges).
	if err := c.store.ProjectMembers.DeleteForProject(args.ID); err != nil {
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

func (c *Core) projectsAddMember(payload []byte) ([]byte, error) {
	var args memberArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	m, err := c.store.ProjectMembers.Add(args.ProjectID, args.EntityType, args.EntityID)
	if err != nil {
		return nil, err
	}
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
	members, err := c.store.ProjectMembers.AddMany(args.ProjectID, args.EntityType, args.EntityIDs)
	if err != nil {
		return nil, err
	}
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

// ---- sidebar -------------------------------------------------------------

func (c *Core) navSidebar() ([]byte, error) {
	data, err := c.store.Sidebar()
	if err != nil {
		return nil, err
	}
	return json.Marshal(data)
}
