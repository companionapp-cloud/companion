package store

import "fmt"

// Sidebar data (PLAN §6.6): area headings, each with its projects and two live
// indicators. Computed in core so every client renders identical numbers.
//
// taskProgress and habitHealth are pointers so "no data yet" is a real null (the ring /
// fire icon is hidden) rather than a misleading 0. They light up as later milestones
// land: taskProgress once member tasks exist (Tasks milestone), habitHealth once streak
// math exists (Habits milestone).
type SidebarProject struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Color        *string  `json:"color,omitempty"`
	TaskProgress *float64 `json:"taskProgress"` // 0..1: done / (open+done) member tasks; null if none
	HabitHealth  *float64 `json:"habitHealth"`  // 0..1: mean member-habit streak health; null if none
}

// SidebarArea is one heading and its projects, in sort order.
type SidebarArea struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Color    *string          `json:"color,omitempty"`
	Projects []SidebarProject `json:"projects"`
}

// SidebarData is the whole navigation tree: areas plus an "Unsorted" bucket for
// projects whose area_id dangles (its area was deleted — PLAN §6.6).
type SidebarData struct {
	Areas    []SidebarArea    `json:"areas"`
	Unsorted []SidebarProject `json:"unsorted"`
}

// Sidebar builds the navigation tree with per-project indicators. taskProgress is a
// single grouped aggregate over project_members ⋈ tasks (no bodies loaded);
// habitHealth stays null until streak math lands.
func (s *Store) Sidebar() (*SidebarData, error) {
	areas, err := s.Areas.List()
	if err != nil {
		return nil, err
	}
	projects, err := s.Projects.List()
	if err != nil {
		return nil, err
	}
	progress, err := s.taskProgressByProject()
	if err != nil {
		return nil, err
	}

	live := make(map[string]bool, len(areas))
	byArea := make(map[string][]SidebarProject, len(areas))
	for _, a := range areas {
		live[a.ID] = true
	}
	// Always non-nil so it marshals to [] not null (the UI maps/reads .length on it).
	unsorted := []SidebarProject{}
	for _, p := range projects {
		sp := SidebarProject{ID: p.ID, Name: p.Name, Color: p.Color, TaskProgress: progress[p.ID]}
		if live[p.AreaID] {
			byArea[p.AreaID] = append(byArea[p.AreaID], sp)
		} else {
			unsorted = append(unsorted, sp) // dangling area_id -> "Unsorted"
		}
	}

	out := &SidebarData{Areas: make([]SidebarArea, 0, len(areas)), Unsorted: unsorted}
	for _, a := range areas {
		ps := byArea[a.ID]
		if ps == nil {
			ps = []SidebarProject{} // non-nil for the same reason
		}
		out.Areas = append(out.Areas, SidebarArea{ID: a.ID, Name: a.Name, Color: a.Color, Projects: ps})
	}
	return out, nil
}

// taskProgressByProject returns done/(open+done) member-task fractions keyed by project
// id. Projects with no member tasks are absent (their ring is hidden). Cancelled tasks
// are excluded from both numerator and denominator. Uses SUM(CASE …) rather than the
// FILTER clause for portability across the native and wasm SQLite builds.
func (s *Store) taskProgressByProject() (map[string]*float64, error) {
	rows, err := s.db.Query(
		`SELECT pm.project_id,
		        SUM(CASE WHEN t.status IN ('open','done') THEN 1 ELSE 0 END) AS total,
		        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)           AS done
		 FROM project_members pm
		 JOIN tasks t ON t.id = pm.entity_id AND t.deleted_at IS NULL
		 WHERE pm.entity_type = 'task' AND pm.deleted_at IS NULL
		 GROUP BY pm.project_id;`)
	if err != nil {
		return nil, fmt.Errorf("task progress: %w", err)
	}
	defer rows.Close()
	out := map[string]*float64{}
	for rows.Next() {
		var id string
		var total, done int
		if err := rows.Scan(&id, &total, &done); err != nil {
			return nil, fmt.Errorf("scan progress: %w", err)
		}
		if total == 0 {
			continue
		}
		v := float64(done) / float64(total)
		out[id] = &v
	}
	return out, rows.Err()
}
