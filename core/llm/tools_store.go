package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/store"
	"companion/core/sync/protocol"
)

// NewStoreRegistry builds the tool set the model can call against the local SQLite store
// (PLAN §6.8): read-only retrieval tools for "ask my data", plus write tools that create
// and update notes and tasks. Write tools return the new entity's wikilink so the model
// can reference it back to the user as a clickable chip.
//
// Descriptions are prescriptive about *when* to call each tool — recent models reach for
// tools conservatively, and trigger conditions in the description measurably improve
// should-call accuracy.
func NewStoreRegistry(s *store.Store) *Registry {
	r := NewRegistry()

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_date",
			Description: "Get the current date and time in the user's local timezone. ALWAYS call this before reasoning about 'today', 'now', 'tomorrow', 'this week', 'next Friday', or any relative date, and before setting a task's due date — your own sense of the current date is unreliable and often wrong. Returns the local date, weekday, time, and UTC offset.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{}}`),
		},
		Handler: func(_ context.Context, _ json.RawMessage) (string, error) {
			// time.Now() is local: the browser's timezone in the wasm build, the OS timezone
			// on desktop/mobile — i.e. the user's actual local time on every platform.
			now := time.Now()
			return jsonResult(map[string]any{
				"date":      now.Format("2006-01-02"),
				"weekday":   now.Weekday().String(),
				"time":      now.Format("15:04"),
				"iso":       now.Format(time.RFC3339),
				"utcOffset": now.Format("-07:00"),
			})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "search_notes",
			Description: "Full-text search the user's notes and tasks. Call this whenever the user refers to something they have written or asks a question that their own notes/tasks might answer. Returns matching notes and tasks with a snippet; follow up with get_neighborhood for related context.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"query":{"type":"string","description":"Keywords to search for."},
					"limit":{"type":"integer","description":"Max results (default 20)."}
				},
				"required":["query"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Query string `json:"query"`
				Limit int    `json:"limit"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			hits, err := s.Search.Search(a.Query, a.Limit)
			if err != nil {
				return "", err
			}
			return jsonResult(hits)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_tasks",
			Description: "List the user's tasks, optionally filtered by status. Call this when the user asks about their tasks, what's due, or what's outstanding.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"status":{"type":"string","enum":["open","done","cancelled"],"description":"Only tasks in this status."},
					"limit":{"type":"integer","description":"Max results (default 50)."}
				}
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Status string `json:"status"`
				Limit  int    `json:"limit"`
			}
			_ = json.Unmarshal(args, &a)
			tasks, err := s.Tasks.List()
			if err != nil {
				return "", err
			}
			limit := a.Limit
			if limit <= 0 || limit > 200 {
				limit = 50
			}
			out := make([]*domain.Task, 0, len(tasks))
			for _, t := range tasks {
				if a.Status != "" && t.Status != a.Status {
					continue
				}
				out = append(out, t)
				if len(out) >= limit {
					break
				}
			}
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_projects",
			Description: "List the user's projects. Call this when the user asks about their projects or wants to file something under one.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{}}`),
		},
		Handler: func(_ context.Context, _ json.RawMessage) (string, error) {
			projects, err := s.Projects.List()
			if err != nil {
				return "", err
			}
			return jsonResult(projects)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_project_items",
			Description: "List the notes and/or tasks that belong to a specific project. Call this when the user asks what's in a project, e.g. \"what tasks are under the Q3 launch?\" or \"show me the notes filed under X\". Requires a project id (get one from list_projects). Pass type to restrict to just notes or just tasks.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"projectId":{"type":"string","description":"The project's id (from list_projects)."},
					"type":{"type":"string","enum":["note","task"],"description":"Only items of this kind. Omit to return both."}
				},
				"required":["projectId"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ProjectID string `json:"projectId"`
				Type      string `json:"type"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			if a.ProjectID == "" {
				return "", fmt.Errorf("projectId is required")
			}
			members, err := s.ProjectMembers.ListForProject(a.ProjectID)
			if err != nil {
				return "", err
			}
			out := struct {
				Notes []*domain.Note `json:"notes"`
				Tasks []*domain.Task `json:"tasks"`
			}{Notes: []*domain.Note{}, Tasks: []*domain.Task{}}
			for _, m := range members {
				if a.Type != "" && m.EntityType != a.Type {
					continue
				}
				switch m.EntityType {
				case protocol.EntityNote:
					n, err := s.Notes.Get(m.EntityID)
					if errors.Is(err, store.ErrNotFound) {
						continue // trashed or gone; membership outlives the entity
					}
					if err != nil {
						return "", err
					}
					out.Notes = append(out.Notes, n)
				case protocol.EntityTask:
					t, err := s.Tasks.Get(m.EntityID)
					if errors.Is(err, store.ErrNotFound) {
						continue
					}
					if err != nil {
						return "", err
					}
					out.Tasks = append(out.Tasks, t)
				}
			}
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_neighborhood",
			Description: "Return the entities linked to a given note/task/habit/project, out to a depth. Call this for questions about how things connect, e.g. \"what's related to the Q3 launch?\" — usually after search_notes gives you an id.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"type":{"type":"string","enum":["note","task","habit","project"]},
					"id":{"type":"string"},
					"depth":{"type":"integer","description":"Hops to expand (default 2)."}
				},
				"required":["type","id"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Type  string `json:"type"`
				ID    string `json:"id"`
				Depth int    `json:"depth"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			if a.Depth == 0 {
				a.Depth = 2
			}
			g, err := s.Links.Neighborhood(a.Type, a.ID, a.Depth)
			if err != nil {
				return "", err
			}
			return jsonResult(g)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_backlinks",
			Description: "Return the entities that reference a given note/task/habit/project (its \"linked mentions\"). Call this to find what points at something.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"type":{"type":"string","enum":["note","task","habit","project"]},
					"id":{"type":"string"}
				},
				"required":["type","id"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			nodes, err := s.Links.Backlinks(a.Type, a.ID)
			if err != nil {
				return "", err
			}
			return jsonResult(nodes)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_note",
			Description: "Read the FULL body of one note by id. search_notes returns only a short snippet — you MUST call get_note to actually read, quote, summarize, or copy a note's real content. Never rely on a snippet or your own memory for a note's body. Get the id from search_notes.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			n, err := s.Notes.Get(a.ID)
			if errors.Is(err, store.ErrNotFound) {
				return "", fmt.Errorf("no note with id %q — use search_notes to find the right id", a.ID)
			}
			if err != nil {
				return "", err
			}
			return jsonResult(map[string]any{"id": n.ID, "title": n.Title, "contentMd": n.ContentMD, "date": n.Date})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_task",
			Description: "Read one task in full by id (title, notes, status, due date, reminder time). Call this to read a task's real details before summarizing or changing them. Get the id from list_tasks or search_notes.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			t, err := s.Tasks.Get(a.ID)
			if errors.Is(err, store.ErrNotFound) {
				return "", fmt.Errorf("no task with id %q — use list_tasks or search_notes to find it", a.ID)
			}
			if err != nil {
				return "", err
			}
			return jsonResult(map[string]any{"id": t.ID, "title": t.Title, "notesMd": t.NotesMD, "status": t.Status, "dueAt": t.DueAt, "remindAt": t.RemindAt})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "render_note",
			Description: "Show the user an inline, interactive preview of an existing note inside the chat. STRONGLY PREFER this over pasting a note's Markdown into your reply: whenever you would display, quote at length, or 'show' a note's content, call render_note with its id instead of writing the content out. The preview is clickable (the user can open the full note). Get the id from search_notes or get_note. This does not change the note.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			n, err := s.Notes.Get(a.ID)
			if errors.Is(err, store.ErrNotFound) {
				return "", fmt.Errorf("no note with id %q — use search_notes to find it first", a.ID)
			}
			if err != nil {
				return "", err
			}
			// The chat UI renders the actual preview from this tool call; the result just
			// confirms it so the model doesn't also paste the content.
			return fmt.Sprintf("An inline preview of [[note:%s]] (%q) is now shown to the user in the chat. Do not repeat the note's content in your reply — just add any commentary.", n.ID, n.Title), nil
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "create_note",
			Description: "Create a new note. Call this when the user asks you to write down, capture, or draft a note. Use Markdown for the body; link to other entities with [[type:id]] wikilinks.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"title":{"type":"string"},
					"contentMd":{"type":"string","description":"Markdown body."}
				},
				"required":["title"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Title     string `json:"title"`
				ContentMD string `json:"contentMd"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			n, err := s.Notes.Create(store.CreateNoteInput{Title: a.Title, ContentMD: a.ContentMD})
			if err != nil {
				return "", err
			}
			return writeResult(domain.NodeNote, n.ID, n.Title)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "update_note",
			Description: "Update an existing note's title and/or body. Call this only with an id you already know (from search_notes). Omit a field to leave it unchanged.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"id":{"type":"string"},
					"title":{"type":"string"},
					"contentMd":{"type":"string"}
				},
				"required":["id"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID        string  `json:"id"`
				Title     *string `json:"title"`
				ContentMD *string `json:"contentMd"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			n, err := s.Notes.Update(a.ID, store.UpdateNoteInput{Title: a.Title, ContentMD: a.ContentMD})
			if err != nil {
				return "", err
			}
			return writeResult(domain.NodeNote, n.ID, n.Title)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "create_task",
			Description: "Create a single task. A task has an optional due date (dueAt) AND, separately, an optional reminder time (remindAt) — the moment to notify the user, usually a bit before the due date. A reminder is NOT a second task: \"remind me to take out the trash on Sunday, an hour before\" is ONE task with dueAt = Sunday and remindAt = one hour before that. Both are RFC3339 timestamps — call get_date first to compute the real dates in the user's timezone.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"title":{"type":"string"},
					"notesMd":{"type":"string","description":"Optional Markdown details."},
					"dueAt":{"type":"string","description":"Optional RFC3339 due timestamp (when it's due)."},
					"remindAt":{"type":"string","description":"Optional RFC3339 reminder timestamp (when to notify the user; often shortly before dueAt)."}
				},
				"required":["title"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Title    string `json:"title"`
				NotesMD  string `json:"notesMd"`
				DueAt    string `json:"dueAt"`
				RemindAt string `json:"remindAt"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			due, err := optTime(a.DueAt, "dueAt")
			if err != nil {
				return "", err
			}
			remind, err := optTime(a.RemindAt, "remindAt")
			if err != nil {
				return "", err
			}
			t, err := s.Tasks.Create(store.CreateTaskInput{Title: a.Title, NotesMD: a.NotesMD, DueAt: due, RemindAt: remind})
			if err != nil {
				return "", err
			}
			return writeResult(domain.NodeTask, t.ID, t.Title)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "update_task",
			Description: "Update an existing task — retitle it, change its notes, mark it done/cancelled, or set/change its due date (dueAt) or reminder time (remindAt). Due date and reminder are separate fields on the same task. Use clearDueAt / clearRemindAt to remove them. Call this only with an id you already know (from list_tasks or search_notes). Omit a field to leave it unchanged; compute any dates with get_date.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"id":{"type":"string"},
					"title":{"type":"string"},
					"notesMd":{"type":"string"},
					"status":{"type":"string","enum":["open","done","cancelled"]},
					"dueAt":{"type":"string","description":"RFC3339 due timestamp to set."},
					"clearDueAt":{"type":"boolean","description":"Remove the due date."},
					"remindAt":{"type":"string","description":"RFC3339 reminder timestamp to set."},
					"clearRemindAt":{"type":"boolean","description":"Remove the reminder."}
				},
				"required":["id"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID            string  `json:"id"`
				Title         *string `json:"title"`
				NotesMD       *string `json:"notesMd"`
				Status        *string `json:"status"`
				DueAt         string  `json:"dueAt"`
				ClearDueAt    bool    `json:"clearDueAt"`
				RemindAt      string  `json:"remindAt"`
				ClearRemindAt bool    `json:"clearRemindAt"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			due, err := optTime(a.DueAt, "dueAt")
			if err != nil {
				return "", err
			}
			remind, err := optTime(a.RemindAt, "remindAt")
			if err != nil {
				return "", err
			}
			t, err := s.Tasks.Update(a.ID, store.UpdateTaskInput{
				Title: a.Title, NotesMD: a.NotesMD, Status: a.Status,
				DueAt: due, ClearDueAt: a.ClearDueAt, RemindAt: remind, ClearRemindAt: a.ClearRemindAt,
			})
			if err != nil {
				return "", err
			}
			return writeResult(domain.NodeTask, t.ID, t.Title)
		},
	})

	addWebTools(r)

	return r
}

// optTime parses an optional RFC3339 timestamp argument; "" means "not provided" (nil).
func optTime(s, field string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil, fmt.Errorf("%s must be an RFC3339 timestamp: %w", field, err)
	}
	return &t, nil
}

// writeResult is the standard payload a write tool returns: the entity's id, title, and
// canonical wikilink, so the model can cite the created/updated entity back to the user.
func writeResult(nodeType, id, title string) (string, error) {
	return jsonResult(map[string]string{
		"id":       id,
		"type":     nodeType,
		"title":    title,
		"wikilink": fmt.Sprintf("[[%s:%s]]", nodeType, id),
	})
}
