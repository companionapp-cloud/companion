package syncserver

import (
	"database/sql"
	"log"
	"time"

	"companion/core/domain"
)

// Repeating projects (PLAN-scheduling.md §3). A repeating project is a chain of ordinary
// projects; the newest copy carries the repeat definition. When its next turn comes — a fixed
// interval after it is completed (repeat_after), or on its schedule (repeat_rule) — the server
// spawns the next copy and moves the definition onto it, all in one transaction:
//
//   - the project row is copied (its encrypted name/icon/description verbatim — field
//     encryption is bound to entity type + field, never the row id), open, with its dates
//     moved to the new turn;
//   - its plain tasks are copied, reset to open, their dates moved by the same amount, and its
//     lists are copied around them;
//   - everything else filed in it — notes, canvases, calendars, repeating-task seeds — is
//     re-filed into the new copy, since an item lives in one container and reference material
//     should follow the live project. Task occurrences already made stay where they are.
//
// Like task occurrences, copies are made just in time and only here, so two devices can never
// each make one. Every id is derived from the previous copy's (domain.NextProjectID …), so a
// retried spawn converges on the same rows.

// spawnAllProjects checks every live repeating project across all users, spawning the copies
// whose turn has come. It returns the rows written and the max server_seq per user.
func (s *Server) spawnAllProjects(maxSeqByUser map[string]int64) (int, error) {
	type ref struct{ uid, id string }
	var heads []ref
	rows, err := s.query(
		`SELECT user_id, id FROM projects
		 WHERE (repeat_rule IS NOT NULL OR (repeat_after IS NOT NULL AND completed_at IS NOT NULL))
		   AND deleted_at IS NULL;`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.uid, &r.id); err != nil {
			rows.Close()
			return 0, err
		}
		heads = append(heads, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	written := 0
	for _, h := range heads {
		n, seq, err := s.spawnProject(h.uid, h.id)
		if err != nil {
			return written, err
		}
		written += n
		if seq > maxSeqByUser[h.uid] {
			maxSeqByUser[h.uid] = seq
		}
	}
	return written, nil
}

// projectRepeats reports whether p is a live project carrying a repeat definition.
func projectRepeats(p *domain.Project) bool { return p != nil && p.DeletedAt == nil && p.Repeats() }

// nextProjectTurn decides whether project p's next copy is due at `now`, returning the instant
// the copy is placed at (its start — or its deadline, when p has only a deadline), or nil.
func nextProjectTurn(p *domain.Project, now time.Time) *time.Time {
	anchor := p.ScheduleAnchor()
	switch {
	case p.RepeatAfter != nil:
		if p.CompletedAt == nil {
			return nil
		}
		after, err := domain.ParseRepeatAfter(*p.RepeatAfter)
		if err != nil {
			return nil
		}
		next := domain.NextAfterCompletion(after, *p.CompletedAt, anchor)
		return &next
	case p.RepeatRule != nil:
		// A project with no dates of its own runs its schedule from when it was made.
		from := p.CreatedAt
		if anchor != nil {
			from = *anchor
		}
		deadlineOnly := p.StartAt == nil && p.DueAt != nil
		next, err := domain.NextScheduled(*p.RepeatRule, from, now, deadlineOnly)
		if err != nil {
			// A malformed rule slipped past validation: skip quietly rather than wedge the sweep.
			log.Printf("project repeat: %s: %v", p.ID, err)
			return nil
		}
		return next
	}
	return nil
}

// spawnProject makes project `id`'s next copy if its turn has come, and nothing otherwise. It
// returns the number of rows written and the max server_seq assigned, but does NOT publish —
// callers batch the hub notification.
func (s *Server) spawnProject(uid, id string) (int, int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	prev, _, err := scanServerProject(tx.QueryRow(s.rebind(`SELECT `+projectCols+` FROM projects WHERE id = ? AND user_id = ?;`), id, uid))
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	if !projectRepeats(prev) {
		return 0, 0, nil
	}
	now := s.clock.Now().UTC()
	turn := nextProjectTurn(prev, now)
	if turn == nil {
		return 0, 0, nil
	}

	written := 0
	var maxSeq int64
	seq := func() (int64, error) {
		n, err := s.nextSeq(tx, uid)
		if err == nil {
			written++
			maxSeq = n
		}
		return n, err
	}
	nowTS := now.Format(timeFormat)

	// How far every date moves: the new turn, less the instant the old copy hung off.
	ref := prev.CreatedAt
	switch {
	case prev.ScheduleAnchor() != nil:
		ref = *prev.ScheduleAnchor()
	case prev.CompletedAt != nil && prev.RepeatAfter != nil:
		ref = *prev.CompletedAt
	}
	delta := turn.Sub(ref)
	shift := func(t *time.Time) *time.Time {
		if t == nil {
			return nil
		}
		moved := t.Add(delta)
		return &moved
	}

	// 1. The copy: open, carrying the repeat definition on. A project with no dates of its own
	// starts at its turn.
	nextID := domain.NextProjectID(prev.ID, *turn)
	startAt, dueAt := shift(prev.StartAt), shift(prev.DueAt)
	if startAt == nil && dueAt == nil {
		startAt = turn
	}
	n, err := seq()
	if err != nil {
		return 0, 0, err
	}
	res, err := tx.Exec(s.rebind(
		`INSERT INTO projects (id, user_id, area_id, name, color, icon, cover_document_id, description_md, sort_order, archived_at,
		   start_at, due_at, someday, completed_at, repeat_rule, repeat_after, created_at, updated_at, deleted_at, version, server_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, ?, ?, ?, NULL, 1, ?)
		 ON CONFLICT (id) DO NOTHING;`),
		nextID, uid, prev.AreaID, prev.Name, prev.Color, prev.Icon, prev.CoverDocumentID, prev.DescriptionMd, prev.SortOrder,
		fmtTime(startAt), fmtTime(dueAt), prev.RepeatRule, prev.RepeatAfter, nowTS, nowTS, n)
	if err != nil {
		return 0, 0, err
	}
	if made, _ := res.RowsAffected(); made == 0 {
		// This turn's copy already exists (in any state — a copy the user deleted is not
		// resurrected). Leave everything as it is.
		return 0, 0, nil
	}

	// 2. The definition moves on: the old copy is an ordinary project from here.
	if n, err = seq(); err != nil {
		return 0, 0, err
	}
	if _, err := tx.Exec(s.rebind(
		`UPDATE projects SET repeat_rule = NULL, repeat_after = NULL, updated_at = ?, version = version + 1, server_seq = ?
		 WHERE id = ? AND user_id = ?;`), nowTS, n, prev.ID, uid); err != nil {
		return 0, 0, err
	}

	// 3. Its plain tasks, reset to open. Cancelled ones were dropped on purpose; seeds and
	// occurrences are handled below.
	type member struct{ id, entityType, entityID string }
	var plain []string
	var movers []member
	rows, err := tx.Query(s.rebind(
		`SELECT m.id, m.entity_type, m.entity_id,
		        CASE WHEN m.entity_type = 'task' THEN
		          CASE WHEN t.id IS NULL OR t.repeat_seed_id IS NOT NULL THEN 'stay'
		               WHEN t.repeat_rule IS NOT NULL THEN 'move'
		               WHEN t.deleted_at IS NOT NULL OR t.deleting_at IS NOT NULL OR t.status = 'cancelled' THEN 'stay'
		               ELSE 'copy' END
		        ELSE 'move' END
		 FROM project_members m
		 LEFT JOIN tasks t ON m.entity_type = 'task' AND t.id = m.entity_id AND t.user_id = m.user_id
		 WHERE m.user_id = ? AND m.project_id = ? AND m.container_type = 'project' AND m.deleted_at IS NULL
		 ORDER BY m.created_at, m.id;`), uid, prev.ID)
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var m member
		var what string
		if err := rows.Scan(&m.id, &m.entityType, &m.entityID, &what); err != nil {
			rows.Close()
			return 0, 0, err
		}
		switch what {
		case "copy":
			plain = append(plain, m.entityID)
		case "move":
			movers = append(movers, m)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()

	file := func(entityType, entityID string) error {
		n, err := seq()
		if err != nil {
			return err
		}
		_, err = tx.Exec(s.rebind(
			`INSERT INTO project_members (id, user_id, project_id, container_type, entity_type, entity_id, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, 'project', ?, ?, ?, ?, NULL, 1, ?)
			 ON CONFLICT (project_id, entity_type, entity_id) DO NOTHING;`),
			domain.MemberID(nextID, entityType, entityID), uid, nextID, entityType, entityID, nowTS, nowTS, n)
		return err
	}

	copied := map[string]string{} // old task id → its copy's
	for _, taskID := range plain {
		task, _, err := scanServerTask(tx.QueryRow(s.rebind(`SELECT `+taskCols+` FROM tasks WHERE id = ? AND user_id = ?;`), taskID, uid))
		if err != nil {
			return 0, 0, err
		}
		copyID := domain.CopiedTaskID(nextID, taskID)
		if n, err = seq(); err != nil {
			return 0, 0, err
		}
		if _, err := tx.Exec(s.rebind(
			`INSERT INTO tasks (id, user_id, title, notes_md, status, start_at, someday, due_at, reminders_json, completed_at,
			   repeat_rule, repeat_seed_id, object_type_id, props_json, created_at, updated_at, deleting_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 1, ?)
			 ON CONFLICT (id) DO NOTHING;`),
			copyID, uid, task.Title, task.NotesMD, domain.TaskOpen, fmtTime(shift(task.StartAt)), boolInt(task.Someday), fmtTime(shift(task.DueAt)),
			remindersJSON(domain.ShiftReminders(task.Reminders, delta)), task.ObjectTypeID, propsOrDefault(task.Props), nowTS, nowTS, n); err != nil {
			return 0, 0, err
		}
		if err := file("task", copyID); err != nil {
			return 0, 0, err
		}
		copied[taskID] = copyID
	}

	// 4. Its lists, rebuilt around the copied tasks. An item for a task that wasn't copied
	// (cancelled, trashed, an occurrence) is left out.
	if err := s.copyProjectLists(tx, uid, prev.ID, nextID, copied, nowTS, seq); err != nil {
		return 0, 0, err
	}

	// 5. Everything else follows the live project: the old filing is tombstoned first, so a
	// client applying the pull in order never sees the item in two containers.
	for _, m := range movers {
		if n, err = seq(); err != nil {
			return 0, 0, err
		}
		if _, err := tx.Exec(s.rebind(
			`UPDATE project_members SET deleted_at = ?, updated_at = ?, version = version + 1, server_seq = ?
			 WHERE id = ? AND user_id = ?;`), nowTS, nowTS, n, m.id, uid); err != nil {
			return 0, 0, err
		}
		if err := file(m.entityType, m.entityID); err != nil {
			return 0, 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return written, maxSeq, nil
}

// copyProjectLists copies a project's live lists into its next copy: headings as they are, task
// items pointed at the copied tasks.
func (s *Server) copyProjectLists(tx *sql.Tx, uid, prevID, nextID string, copied map[string]string, nowTS string, seq func() (int64, error)) error {
	type list struct {
		id, name  string
		sortOrder int64
	}
	var lists []list
	rows, err := tx.Query(s.rebind(
		`SELECT id, name, sort_order FROM lists WHERE user_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY sort_order, id;`), uid, prevID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var l list
		if err := rows.Scan(&l.id, &l.name, &l.sortOrder); err != nil {
			rows.Close()
			return err
		}
		lists = append(lists, l)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, l := range lists {
		listID := l.id
		nextListID := domain.CopiedListID(nextID, listID)
		n, err := seq()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(s.rebind(
			`INSERT INTO lists (id, user_id, project_id, name, sort_order, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
			 ON CONFLICT (id) DO NOTHING;`), nextListID, uid, nextID, l.name, l.sortOrder, nowTS, nowTS, n); err != nil {
			return err
		}

		type item struct {
			id, kind, title string
			taskID          sql.NullString
			sortOrder       int64
		}
		var items []item
		irows, err := tx.Query(s.rebind(
			`SELECT id, kind, task_id, title, sort_order FROM list_items WHERE user_id = ? AND list_id = ? AND deleted_at IS NULL ORDER BY sort_order, id;`), uid, listID)
		if err != nil {
			return err
		}
		for irows.Next() {
			var it item
			if err := irows.Scan(&it.id, &it.kind, &it.taskID, &it.title, &it.sortOrder); err != nil {
				irows.Close()
				return err
			}
			items = append(items, it)
		}
		if err := irows.Err(); err != nil {
			irows.Close()
			return err
		}
		irows.Close()

		for _, it := range items {
			var itemID string
			var taskID any
			if it.kind == domain.ListItemTask {
				copyID, ok := copied[it.taskID.String]
				if !ok {
					continue
				}
				itemID, taskID = domain.ListTaskItemID(nextListID, copyID), copyID
			} else {
				itemID = domain.CopiedHeadingID(nextListID, it.id)
			}
			if n, err = seq(); err != nil {
				return err
			}
			if _, err := tx.Exec(s.rebind(
				`INSERT INTO list_items (id, user_id, list_id, kind, task_id, title, sort_order, created_at, updated_at, deleted_at, version, server_seq)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
				 ON CONFLICT (id) DO NOTHING;`), itemID, uid, nextListID, it.kind, taskID, it.title, it.sortOrder, nowTS, nowTS, n); err != nil {
				return err
			}
		}
	}
	return nil
}
