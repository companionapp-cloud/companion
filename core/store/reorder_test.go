//go:build !js

package store

import "testing"

func TestAreaCreateAppendsAndReorders(t *testing.T) {
	s := newTestStore(t, nil)
	a, _ := s.Areas.Create(CreateAreaInput{Name: "A"})
	b, _ := s.Areas.Create(CreateAreaInput{Name: "B"})
	c, _ := s.Areas.Create(CreateAreaInput{Name: "C"})

	// New areas append in creation order (distinct, increasing sort_order).
	if got := areaOrder(t, s); got != "A,B,C" {
		t.Fatalf("initial area order = %q, want A,B,C", got)
	}

	// Reorder to C, A, B.
	if err := s.Areas.Reorder([]string{c.ID, a.ID, b.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got := areaOrder(t, s); got != "C,A,B" {
		t.Errorf("after reorder = %q, want C,A,B", got)
	}
}

func TestProjectOrderIsScopedToArea(t *testing.T) {
	s := newTestStore(t, nil)
	work, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	home, _ := s.Areas.Create(CreateAreaInput{Name: "Home"})

	w1, _ := s.Projects.Create(CreateProjectInput{AreaID: work.ID, Name: "W1"})
	w2, _ := s.Projects.Create(CreateProjectInput{AreaID: work.ID, Name: "W2"})
	// A project in a different area starts its own 0-based order.
	h1, _ := s.Projects.Create(CreateProjectInput{AreaID: home.ID, Name: "H1"})
	if w1.SortOrder != 0 || w2.SortOrder != 1 || h1.SortOrder != 0 {
		t.Fatalf("orders = %d,%d,%d; want 0,1,0", w1.SortOrder, w2.SortOrder, h1.SortOrder)
	}

	// Reordering Work's projects doesn't touch Home's.
	if err := s.Projects.Reorder(work.ID, []string{w2.ID, w1.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	sb, _ := s.Sidebar()
	var workNames, homeNames string
	for _, ar := range sb.Areas {
		for _, p := range ar.Projects {
			if ar.ID == work.ID {
				workNames += p.Name
			} else if ar.ID == home.ID {
				homeNames += p.Name
			}
		}
	}
	if workNames != "W2W1" {
		t.Errorf("work project order = %q, want W2W1", workNames)
	}
	if homeNames != "H1" {
		t.Errorf("home project order = %q, want H1", homeNames)
	}
}

func areaOrder(t *testing.T, s *Store) string {
	t.Helper()
	areas, err := s.Areas.List()
	if err != nil {
		t.Fatalf("list areas: %v", err)
	}
	out := ""
	for i, a := range areas {
		if i > 0 {
			out += ","
		}
		out += a.Name
	}
	return out
}
