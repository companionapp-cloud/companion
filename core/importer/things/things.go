// Package things imports a Things 3 library — areas, projects, headings, to-dos with their
// checklists, notes, tags, dates, reminders and repeats — from Things' own SQLite database
// (PLAN §6.12). It reads the file with sqlitefile, so the import runs the same on every
// platform, maps it onto Companion's areas, projects, lists and tasks, and writes through the
// normal store path, so link extraction, sync and encryption apply as to anything the user
// makes. It is one-way and keeps no provenance: running it twice imports twice.
package things

import (
	"context"
	"time"

	"companion/core/importer/sqlitefile"
	"companion/core/store"
)

// Options shape an import.
type Options struct {
	// IncludeCompleted also imports the Logbook: completed and canceled to-dos, and finished
	// projects (archived).
	IncludeCompleted bool
	// TimeZone is the user's IANA zone. Things' dates are wall-clock dates, so they become
	// instants there; empty means this device's zone.
	TimeZone string
	// Selection limits a run to what the user chose; nil imports everything.
	Selection *Selection
}

// Selection is what the user chose to import — whole containers, never single to-dos: the
// Inbox (with every to-do in no area or project), areas (each with its own to-dos), and
// projects. A chosen project brings its area along, since Companion projects need one.
type Selection struct {
	Inbox    bool     `json:"inbox"`
	Areas    []string `json:"areas"`
	Projects []string `json:"projects"`
}

// Counts describe a container's to-dos: open ones (Someday included), finished ones (the
// Logbook — completed or canceled, imported only on request), and repeating ones.
type Counts struct {
	Tasks     int `json:"tasks"`
	Completed int `json:"completed"`
	Repeating int `json:"repeating"`
}

// AreaOutline is an area as a scan found it: its own to-dos, and its projects.
type AreaOutline struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Counts
	Projects []ProjectOutline `json:"projects"`
}

// ProjectOutline is a project as a scan found it.
type ProjectOutline struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Finished is set for a completed or canceled project (in Things' Logbook).
	Finished bool `json:"finished"`
	Headings  int  `json:"headings"`
	Counts
}

// Preview is what a scan found, for the user to choose from: the Inbox, every area with its
// projects, and the projects in no area. Nothing is written.
type Preview struct {
	Version  int              `json:"version"`
	Inbox    Counts           `json:"inbox"`
	Areas    []AreaOutline    `json:"areas"`
	NoArea   []ProjectOutline `json:"noArea"`
	Tags     int              `json:"tags"`
	Warnings []string         `json:"warnings"`
}

// Summary is what a run created.
type Summary struct {
	Areas     int      `json:"areas"`
	Projects  int      `json:"projects"`
	Lists     int      `json:"lists"`
	Headings  int      `json:"headings"`
	Tasks     int      `json:"tasks"`
	Repeating int      `json:"repeating"`
	Notes     int      `json:"notes"`
	Warnings  []string `json:"warnings"`
	// Cancelled is set when the run was stopped part-way; what was written stays.
	Cancelled bool `json:"cancelled"`
}

// Progress reports how far a run has got: a stage ("areas", "projects", "tasks", "lists",
// "links") and how many of the run's steps are done.
type Progress func(stage string, done, total int)

// Scan reads the library and outlines what's in it, writing nothing.
func Scan(src Source, opts Options) (*Preview, error) {
	lib, err := open(src)
	if err != nil {
		return nil, err
	}
	opts.Selection = nil
	p := buildPlan(lib, opts, location(opts.TimeZone), time.Now())
	return &p.outline, nil
}

// Run imports the library into st. Cancelling ctx stops it between batches; what was written
// stays, and the summary says so.
func Run(ctx context.Context, st *store.Store, src Source, opts Options, progress Progress) (*Summary, error) {
	lib, err := open(src)
	if err != nil {
		return nil, err
	}
	return write(ctx, st, buildPlan(lib, opts, location(opts.TimeZone), time.Now()), progress)
}

func open(src Source) (*library, error) {
	main, wal, err := load(src)
	if err != nil {
		return nil, err
	}
	db, err := sqlitefile.OpenBytes(main, wal)
	if err != nil {
		return nil, err
	}
	return readLibrary(db)
}

// location resolves the user's zone, falling back to this device's. (The web build embeds the
// zone database for this: its time.Local is a fixed offset with no daylight saving.)
func location(name string) *time.Location {
	if name != "" {
		if loc, err := time.LoadLocation(name); err == nil {
			return loc
		}
	}
	return time.Local
}
