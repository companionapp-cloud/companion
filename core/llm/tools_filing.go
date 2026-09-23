package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"companion/core/domain"
	"companion/core/store"
)

// Filing (PLAN-areas.md §2.1): the write tools can file what they create or update in a
// project, in one of a project's lists (tasks only), or directly in an area. Content lives in
// ONE place, so filing moves the entity out of whatever project or area held it.

// Schema fragments for the filing arguments, spliced into each write tool's properties. The
// update tools take the nullable forms: null takes the entity out of that kind of container.
const (
	projectIDProp = `"projectId":{"type":"string","description":"Optional project id (from list_projects) to file it in. Moves it out of any other project or area."}`
	areaIDProp    = `"areaId":{"type":"string","description":"Optional area id (from list_areas) to file it directly in. Moves it out of any project or other area. Not together with projectId."}`
	listIDProp    = `"listId":{"type":"string","description":"Optional list id (from list_lists) to add the task to. Also files it in that list's project."}`

	projectIDNullableProp = `"projectId":{"type":["string","null"],"description":"Project id (from list_projects) to move it into, or null to take it out of its project."}`
	areaIDNullableProp    = `"areaId":{"type":["string","null"],"description":"Area id (from list_areas) to move it directly into, or null to take it out of its area. Don't set both projectId and areaId to ids."}`
	listIDNullableProp    = `"listId":{"type":["string","null"],"description":"List id (from list_lists) to add the task to — also moves it into that list's project — or null to take it off every list (it stays in its project)."}`
)

// nullableID is a filing argument that tells apart absent (leave it), null (clear it) and an
// id (file it there).
type nullableID struct {
	ID   string
	Null bool
}

func (n *nullableID) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*n = nullableID{Null: true}
		return nil
	}
	*n = nullableID{}
	return json.Unmarshal(b, &n.ID)
}

// filing is where a write tool files its entity. The zero value changes nothing.
type filing struct {
	ProjectID nullableID `json:"projectId"`
	ListID    nullableID `json:"listId"`
	AreaID    nullableID `json:"areaId"`
}

// resolve checks the ids exist and fit together BEFORE anything is written, so a bad id fails
// the call without leaving a half-filed entity behind. A list fills in its project.
func (f *filing) resolve(s *store.Store) error {
	if f.AreaID.ID != "" && (f.ProjectID.ID != "" || f.ListID.ID != "") {
		return errors.New("an item lives in one place: give areaId, or projectId/listId — not both")
	}
	if f.ListID.ID != "" {
		if f.ProjectID.Null {
			return errors.New("a task on a list is in that list's project: don't clear projectId while setting listId")
		}
		l, err := s.Lists.Get(f.ListID.ID)
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no list with id %q — use list_lists to find it", f.ListID.ID)
		}
		if err != nil {
			return err
		}
		if f.ProjectID.ID != "" && f.ProjectID.ID != l.ProjectID {
			return fmt.Errorf("list %q belongs to project %q, not %q — omit projectId or pick a list in that project", l.ID, l.ProjectID, f.ProjectID.ID)
		}
		f.ProjectID.ID = l.ProjectID
	}
	if f.ProjectID.ID != "" {
		if _, err := s.Projects.Get(f.ProjectID.ID); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no project with id %q — use list_projects to find it", f.ProjectID.ID)
		} else if err != nil {
			return err
		}
	}
	if f.AreaID.ID != "" {
		if _, err := s.Areas.Get(f.AreaID.ID); errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("no area with id %q — use list_areas to find it", f.AreaID.ID)
		} else if err != nil {
			return err
		}
	}
	return nil
}

// apply files the entity as resolved: clears first, then the move, then (for a task) taking
// it off its lists. A list is only for tasks; its project membership comes first, since a list
// only ever holds its project's tasks.
func (f filing) apply(s *store.Store, entityType, id string) error {
	if f.ProjectID.Null || f.AreaID.Null {
		members, err := s.ProjectMembers.ListForEntity(entityType, id)
		if err != nil {
			return err
		}
		for _, m := range members {
			if (m.Container() == domain.ContainerProject && f.ProjectID.Null) || (m.Container() == domain.ContainerArea && f.AreaID.Null) {
				// Removing a task's project membership takes it off that project's lists too.
				if err := s.ProjectMembers.Remove(m.ProjectID, entityType, id); err != nil && !errors.Is(err, store.ErrNotFound) {
					return err
				}
			}
		}
	}
	switch {
	case f.ProjectID.ID != "":
		if _, err := s.ProjectMembers.Add(f.ProjectID.ID, entityType, id); err != nil {
			return err
		}
		if f.ListID.ID != "" && entityType == domain.NodeTask {
			if _, err := s.ListItems.AddTask(f.ListID.ID, id); err != nil {
				return err
			}
		}
	case f.AreaID.ID != "":
		if _, err := s.ProjectMembers.AddToArea(f.AreaID.ID, entityType, id); err != nil {
			return err
		}
	}
	if f.ListID.Null && entityType == domain.NodeTask {
		listIDs, err := s.ListItems.ListIDsForTask(id)
		if err != nil {
			return err
		}
		for _, listID := range listIDs {
			if err := s.ListItems.Remove(domain.ListTaskItemID(listID, id)); err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
		}
	}
	return nil
}

// parseFiling reads the filing arguments out of a tool call and resolves them.
func parseFiling(s *store.Store, args json.RawMessage) (filing, error) {
	var f filing
	if err := json.Unmarshal(args, &f); err != nil {
		return f, err
	}
	return f, f.resolve(s)
}

func addFilingTools(r *Registry, s *store.Store) {
	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_areas",
			Description: "List the user's areas — the broad \"areas of life\" (e.g. Work, Health, Home) that group projects and can hold notes, tasks and canvases directly. Call this when the user mentions an area or wants something filed under one, to get the areaId the write tools take.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{}}`),
		},
		Handler: func(_ context.Context, _ json.RawMessage) (string, error) {
			areas, err := s.Areas.List()
			if err != nil {
				return "", err
			}
			out := make([]map[string]string, 0, len(areas))
			for _, a := range areas {
				out = append(out, map[string]string{"id": a.ID, "name": a.Name})
			}
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_lists",
			Description: "List a project's lists — ordered, project-scoped collections of tasks. Call this when the user wants a task put on a specific list, to get the listId create_task / update_task take. Requires a project id (from list_projects).",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{"projectId":{"type":"string","description":"The project's id (from list_projects)."}},
				"required":["projectId"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ProjectID string `json:"projectId"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			if a.ProjectID == "" {
				return "", fmt.Errorf("projectId is required — call list_projects to find it")
			}
			lists, err := s.Lists.ListForProject(a.ProjectID)
			if err != nil {
				return "", err
			}
			out := make([]map[string]string, 0, len(lists))
			for _, l := range lists {
				out = append(out, map[string]string{"id": l.ID, "name": l.Name, "projectId": l.ProjectID})
			}
			return jsonResult(out)
		},
	})
}
