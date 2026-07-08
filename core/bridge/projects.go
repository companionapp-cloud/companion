package bridge

import (
	"encoding/json"

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
	// Deletion does not cascade: the area's projects keep their now-dangling area_id
	// and render under "Unsorted" (PLAN §6.6).
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
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	// Tombstone the project's memberships (dropping their edges); member entities are
	// never touched (PLAN §6.6).
	if err := c.store.ProjectMembers.DeleteForProject(args.ID); err != nil {
		return nil, err
	}
	if err := c.store.Projects.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNavChanged("project", args.ID)
	return json.Marshal(map[string]bool{"ok": true})
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
