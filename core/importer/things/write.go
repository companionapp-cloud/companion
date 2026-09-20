package things

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"companion/core/domain"
	"companion/core/store"
)

// batchSize is how many steps commit together: small enough that a cancel lands quickly and a
// failed batch is cheap to roll back, large enough that web isn't committing per row.
var batchSize = 40

// step is one unit of the write: creating an area, a project, a task, a list...
type step struct {
	stage string
	run   func() error
}

// write creates the plan through the normal store write path (areas, projects, notes, tasks,
// memberships, lists), in batches. A row core refuses (a validation error) is skipped with a
// warning rather than stopping the import; anything else stops it.
func write(ctx context.Context, st *store.Store, p *plan, progress Progress) (*Summary, error) {
	sum := &Summary{Warnings: []string{}}
	for _, w := range p.warnings {
		sum.Warnings = append(sum.Warnings, w.text)
	}
	skip := func(what string, err error) error {
		if errors.Is(err, domain.ErrInvalidTask) || errors.Is(err, domain.ErrInvalidProject) ||
			errors.Is(err, domain.ErrInvalidArea) || errors.Is(err, domain.ErrInvalidNote) ||
			errors.Is(err, domain.ErrInvalidList) || errors.Is(err, domain.ErrInvalidListItem) {
			sum.Warnings = append(sum.Warnings, fmt.Sprintf("%s wasn’t imported: %v", what, err))
			return nil
		}
		return err
	}
	// createTask creates a to-do and files it where it lived in Things: in a project, directly
	// in an area (an area's own to-dos — PLAN-areas.md §2), or nowhere (the Inbox).
	createTask := func(t *planTask, projectID, areaID string) error {
		created, err := st.Tasks.Create(store.CreateTaskInput{
			Title: t.title, NotesMD: t.notes, Status: t.status, StartAt: t.startAt, Someday: t.someday, DueAt: t.dueAt,
			Reminders: t.reminders, RepeatRule: t.repeatRule, CompletedAt: t.completed,
		})
		if err != nil {
			return skip(fmt.Sprintf("“%s”", orDefault(t.title, "Untitled to-do")), err)
		}
		t.id = created.ID
		if t.repeatRule != nil {
			sum.Repeating++
		} else {
			sum.Tasks++
		}
		switch {
		case projectID != "":
			if _, err := st.ProjectMembers.Add(projectID, domain.NodeTask, t.id); err != nil {
				return err
			}
		case areaID != "":
			if _, err := st.ProjectMembers.AddToArea(areaID, domain.NodeTask, t.id); err != nil {
				return err
			}
		}
		return nil
	}

	var steps []step
	add := func(stage string, run func() error) { steps = append(steps, step{stage, run}) }
	for _, a := range p.areas {
		add("areas", func() error {
			created, err := st.Areas.Create(store.CreateAreaInput{Name: a.name})
			if err != nil {
				return err
			}
			a.id = created.ID
			sum.Areas++
			return nil
		})
		for _, t := range a.own {
			add("tasks", func() error { return createTask(t, "", a.id) })
		}
		for _, pp := range a.projects {
			add("projects", func() error {
				created, err := st.Projects.Create(store.CreateProjectInput{
					AreaID: a.id, Name: pp.name, StartAt: pp.startAt, DueAt: pp.dueAt, Someday: pp.someday, CompletedAt: pp.completed,
				})
				if err != nil {
					return err
				}
				pp.id = created.ID
				sum.Projects++
				if pp.archived {
					archived := true
					if _, err := st.Projects.Update(pp.id, store.UpdateProjectInput{Archived: &archived}); err != nil {
						return err
					}
				}
				if pp.note == "" {
					return nil
				}
				note, err := st.Notes.Create(store.CreateNoteInput{Title: pp.name, ContentMD: pp.note})
				if err != nil {
					return skip(fmt.Sprintf("The note for “%s”", pp.name), err)
				}
				pp.noteID = note.ID
				sum.Notes++
				_, err = st.ProjectMembers.Add(pp.id, domain.NodeNote, note.ID)
				return err
			})
			for _, t := range pp.members {
				add("tasks", func() error { return createTask(t, pp.id, "") })
			}
			if len(pp.list) > 0 {
				add("lists", func() error {
					list, err := st.Lists.Create(store.CreateListInput{ProjectID: pp.id, Name: listName})
					if err != nil {
						return err
					}
					sum.Lists++
					for _, e := range pp.list {
						switch {
						case e.task == nil:
							if _, err := st.ListItems.AddHeading(list.ID, e.heading); err != nil {
								return err
							}
							sum.Headings++
						case e.task.id != "": // a task core refused has no id and no row
							if _, err := st.ListItems.AddTask(list.ID, e.task.id); err != nil {
								return err
							}
						}
					}
					return nil
				})
			}
		}
	}
	for _, t := range p.unfiled {
		add("tasks", func() error { return createTask(t, "", "") })
	}
	// Links between to-dos and projects (things:///show?id=…) become wikilinks once every
	// target has a Companion id.
	targets := linkTargets(p)
	for _, pa := range p.areas {
		for _, t := range pa.own {
			addLinkStep(add, st, t, targets, skip)
		}
		for _, pp := range pa.projects {
			if strings.Contains(pp.note, "things:///") {
				add("links", func() error {
					if pp.noteID == "" {
						return nil
					}
					md := rewriteLinks(pp.note, targets)
					_, err := st.Notes.Update(pp.noteID, store.UpdateNoteInput{ContentMD: &md})
					return skip(fmt.Sprintf("The note for “%s”", pp.name), err)
				})
			}
			for _, t := range pp.members {
				addLinkStep(add, st, t, targets, skip)
			}
		}
	}
	for _, t := range p.unfiled {
		addLinkStep(add, st, t, targets, skip)
	}

	for start := 0; start < len(steps); start += batchSize {
		if ctx.Err() != nil {
			sum.Cancelled = true
			return sum, nil
		}
		end := min(start+batchSize, len(steps))
		if err := st.Batch(func() error {
			for _, s := range steps[start:end] {
				if err := s.run(); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return sum, err
		}
		if progress != nil {
			progress(steps[end-1].stage, end, len(steps))
		}
	}
	return sum, nil
}

func addLinkStep(add func(string, func() error), st *store.Store, t *planTask, targets map[string]linkTarget, skip func(string, error) error) {
	if !strings.Contains(t.notes, "things:///") {
		return
	}
	add("links", func() error {
		if t.id == "" {
			return nil
		}
		md := rewriteLinks(t.notes, targets)
		if md == t.notes {
			return nil
		}
		_, err := st.Tasks.Update(t.id, store.UpdateTaskInput{NotesMD: &md})
		return skip(fmt.Sprintf("Links in “%s”", orDefault(t.title, "Untitled to-do")), err)
	})
}

// linkTarget is what a Things id became: a task or a project (a heading's link goes to its
// project), with the title to show.
type linkTarget struct {
	typ, title string
	id         *string // filled in as the write creates it
}

func linkTargets(p *plan) map[string]linkTarget {
	out := map[string]linkTarget{}
	addTask := func(t *planTask) {
		out[t.thingsID] = linkTarget{typ: domain.NodeTask, title: orDefault(t.title, "Untitled to-do"), id: &t.id}
	}
	for _, pa := range p.areas {
		for _, t := range pa.own {
			addTask(t)
		}
		for _, pp := range pa.projects {
			if pp.thingsID != "" {
				out[pp.thingsID] = linkTarget{typ: domain.NodeProject, title: pp.name, id: &pp.id}
			}
			for _, t := range pp.members {
				addTask(t)
			}
		}
	}
	for _, t := range p.unfiled {
		addTask(t)
	}
	return out
}

// thingsLinkRe matches a Things link — as a markdown link's target, or bare. A bare link stops
// before trailing punctuation, so "see things:///show?id=X." keeps its full stop.
var thingsLinkRe = regexp.MustCompile(`\[([^\]]*)\]\(things:///show\?([^)\s]*)\)|things:///show\?([A-Za-z0-9=&_%.-]*[A-Za-z0-9=&_%-])`)

var thingsIDRe = regexp.MustCompile(`(?:^|&)id=([A-Za-z0-9-]+)`)

// rewriteLinks turns links to imported to-dos and projects into Companion wikilinks, keeping a
// markdown link's text as the alias. Links to anything not imported stay as they are.
func rewriteLinks(md string, targets map[string]linkTarget) string {
	return thingsLinkRe.ReplaceAllStringFunc(md, func(m string) string {
		sub := thingsLinkRe.FindStringSubmatch(m)
		text, query := sub[1], sub[2]
		if query == "" {
			query = sub[3]
		}
		idm := thingsIDRe.FindStringSubmatch(query)
		if idm == nil {
			return m
		}
		t, ok := targets[idm[1]]
		if !ok || t.id == nil || *t.id == "" {
			return m
		}
		if strings.TrimSpace(text) == "" {
			text = t.title
		}
		text = strings.NewReplacer("|", "/", "]", ")", "[", "(").Replace(text)
		return fmt.Sprintf("[[%s:%s|%s]]", t.typ, *t.id, text)
	})
}
