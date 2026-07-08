package store

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"companion/core/domain"
)

// SearchRepo runs substring search over note and task titles and bodies (PLAN §6.8). It
// backs the LLM search_notes tool and, later, the in-app search boxes.
//
// It uses portable `LIKE` matching rather than FTS5: FTS5 is compiled into modernc (native)
// but NOT into the web build's wa-sqlite, so an FTS5 index would break the cross-platform
// invariant the same way a vector extension would. LIKE runs identically on every SQLite
// build. At personal-knowledgebase scale a scan over the (small, indexed-by-id) note/task
// tables is inexpensive; if it ever isn't, the graph already narrows most "ask my data"
// queries first.
type SearchRepo struct {
	db Driver
}

const (
	searchLimitDefault = 20
	searchLimitMax     = 50
	snippetRadius      = 60 // characters of body context on each side of the first match
)

// Search returns live notes and tasks matching query, title matches first then most-recent,
// capped at limit (0 or out-of-range falls back to the default). Every whitespace token
// must appear (in the title or body); an empty or punctuation-only query returns no rows.
func (r *SearchRepo) Search(query string, limit int) ([]domain.SearchHit, error) {
	tokens := searchTokens(query)
	if len(tokens) == 0 {
		return []domain.SearchHit{}, nil
	}
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitDefault
	}

	notes, err := r.searchTable("notes", "content_md", domain.NodeNote, tokens)
	if err != nil {
		return nil, err
	}
	tasks, err := r.searchTable("tasks", "notes_md", domain.NodeTask, tokens)
	if err != nil {
		return nil, err
	}
	rows := append(notes, tasks...)

	// Rank: title matches (the whole query appears in the title) before body-only matches,
	// then most-recently-updated first — a stable, explainable order without BM25.
	q := strings.ToLower(strings.Join(tokens, " "))
	sort.SliceStable(rows, func(i, j int) bool {
		ti := strings.Contains(strings.ToLower(rows[i].title), q)
		tj := strings.Contains(strings.ToLower(rows[j].title), q)
		if ti != tj {
			return ti
		}
		return rows[i].updatedAt > rows[j].updatedAt
	})

	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]domain.SearchHit, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.SearchHit{
			Type:    row.nodeType,
			ID:      row.id,
			Title:   row.title,
			Snippet: snippet(tokens, row.body, row.props),
		})
	}
	return out, nil
}

// QueryObjects lists live notes and/or tasks archetyped with objectTypeID, optionally
// narrowed to those whose props match every filter, most-recently-updated first and capped at
// limit. A filter is a field key → wanted value; a row matches a filter when the field's
// value, stringified, contains the wanted value case-insensitively (so "berlin" matches a
// "city" of "Berlin, Germany"), and it must match ALL filters (AND).
//
// This is the structured counterpart to Search (keyword full-text): it answers "list all my
// Books" or "which People are in Berlin" — questions Search can't, because it can't pin the
// object *type* or match a *specific* field. Filtering runs in Go over the parsed props (not
// SQL/JSON1) to stay portable across every SQLite build, the same reason Search uses LIKE;
// at personal-knowledgebase scale the set of one type's objects is small.
func (r *SearchRepo) QueryObjects(objectTypeID string, filters map[string]string, limit int) ([]domain.ObjectHit, error) {
	objectTypeID = strings.TrimSpace(objectTypeID)
	if objectTypeID == "" {
		return []domain.ObjectHit{}, nil
	}
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitDefault
	}
	// Lowercase the wanted values once for case-insensitive comparison.
	lowFilters := make(map[string]string, len(filters))
	for k, v := range filters {
		lowFilters[k] = strings.ToLower(v)
	}

	notes, err := r.queryObjectTable("notes", domain.NodeNote, objectTypeID, lowFilters)
	if err != nil {
		return nil, err
	}
	tasks, err := r.queryObjectTable("tasks", domain.NodeTask, objectTypeID, lowFilters)
	if err != nil {
		return nil, err
	}
	rows := append(notes, tasks...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].updatedAt > rows[j].updatedAt })
	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]domain.ObjectHit, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.ObjectHit{
			Type:  row.nodeType,
			ID:    row.id,
			Title: row.title,
			Props: json.RawMessage(row.props),
		})
	}
	return out, nil
}

// queryObjectTable returns the live rows of one table archetyped with objectTypeID whose props
// satisfy every filter (see QueryObjects).
func (r *SearchRepo) queryObjectTable(table, nodeType, objectTypeID string, filters map[string]string) ([]searchRow, error) {
	rows, err := r.db.Query(fmt.Sprintf(
		`SELECT id, title, props_json, updated_at FROM %s
		 WHERE deleted_at IS NULL AND deleting_at IS NULL AND object_type_id = ?;`, table), objectTypeID)
	if err != nil {
		return nil, fmt.Errorf("query %s objects: %w", table, err)
	}
	defer rows.Close()
	out := []searchRow{}
	for rows.Next() {
		row := searchRow{nodeType: nodeType}
		if err := rows.Scan(&row.id, &row.title, &row.props, &row.updatedAt); err != nil {
			return nil, fmt.Errorf("scan object row: %w", err)
		}
		if propsMatch(row.props, filters) {
			out = append(out, row)
		}
	}
	return out, rows.Err()
}

// propsMatch reports whether a props_json blob satisfies every filter: the named field exists
// and its stringified value contains the (already-lowercased) wanted value case-insensitively.
// An unparseable or empty props blob matches only when there are no filters.
func propsMatch(propsJSON string, filters map[string]string) bool {
	if len(filters) == 0 {
		return true
	}
	var props map[string]any
	if err := json.Unmarshal([]byte(propsJSON), &props); err != nil || props == nil {
		return false
	}
	for key, want := range filters {
		v, ok := props[key]
		if !ok {
			return false
		}
		if !strings.Contains(strings.ToLower(propValueString(v)), want) {
			return false
		}
	}
	return true
}

// propValueString renders a decoded JSON prop value as searchable text: scalars directly,
// and arrays (e.g. a multi_select) as their space-joined members.
func propValueString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			parts = append(parts, propValueString(e))
		}
		return strings.Join(parts, " ")
	case nil:
		return ""
	default:
		return fmt.Sprint(t)
	}
}

// searchRow is a raw match before ranking/snippeting.
type searchRow struct {
	nodeType, id, title, body, props, updatedAt string
}

// searchTable finds live rows in one table where every token appears in the title, body, or
// the object's structured metadata (props_json). bodyCol is the table's body column
// (content_md for notes, notes_md for tasks). Searching props_json is what lets the LLM (and
// the in-app search) find a note/task by an archetype field — e.g. a Person's email or a
// Book's author — not just its prose body (PLAN §6.3, §6.8).
func (r *SearchRepo) searchTable(table, bodyCol, nodeType string, tokens []string) ([]searchRow, error) {
	conds := make([]string, 0, len(tokens))
	args := make([]any, 0, len(tokens))
	for _, tok := range tokens {
		conds = append(conds, fmt.Sprintf(
			"(lower(title) LIKE ? ESCAPE '\\' OR lower(%s) LIKE ? ESCAPE '\\' OR lower(props_json) LIKE ? ESCAPE '\\')",
			bodyCol,
		))
		pat := "%" + escapeLike(tok) + "%"
		args = append(args, pat, pat, pat)
	}
	query := fmt.Sprintf(
		`SELECT id, title, %s, props_json, updated_at FROM %s
		 WHERE deleted_at IS NULL AND deleting_at IS NULL AND %s;`,
		bodyCol, table, strings.Join(conds, " AND "),
	)
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("search %s: %w", table, err)
	}
	defer rows.Close()
	out := []searchRow{}
	for rows.Next() {
		row := searchRow{nodeType: nodeType}
		if err := rows.Scan(&row.id, &row.title, &row.body, &row.props, &row.updatedAt); err != nil {
			return nil, fmt.Errorf("scan search row: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// searchTokens lowercases the query and splits it into alphanumeric tokens, dropping
// punctuation so it can't affect the LIKE patterns.
func searchTokens(query string) []string {
	return strings.FieldsFunc(strings.ToLower(query), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
}

// snippet returns a short excerpt centred on the first token match, with ellipses when
// truncated, searching each source in order (body, then the object's props metadata) and
// snippeting from the first one that contains a match. This way a note/task matched only on
// an archetype field still shows the matched metadata rather than an unrelated body head.
// Falls back to the head of the first non-empty source when no token is found (a title-only
// match). Runs on runes so multibyte text isn't sliced mid-character.
func snippet(tokens []string, sources ...string) string {
	for _, src := range sources {
		if s, ok := snippetFrom(src, tokens); ok {
			return s
		}
	}
	// No token found in any source (title-only match): show the head of the first content.
	for _, src := range sources {
		if strings.TrimSpace(src) == "" || src == "{}" {
			continue
		}
		runes := []rune(src)
		if len(runes) <= 2*snippetRadius {
			return src
		}
		return string(runes[:2*snippetRadius]) + "…"
	}
	return ""
}

// snippetFrom returns an excerpt of body centred on its first token match, and whether any
// token matched. Runs on runes so multibyte text isn't sliced mid-character.
func snippetFrom(body string, tokens []string) (string, bool) {
	runes := []rune(body)
	lower := strings.ToLower(body)
	idx := -1
	for _, tok := range tokens {
		if i := strings.Index(lower, tok); i >= 0 && (idx < 0 || i < idx) {
			idx = len([]rune(body[:i])) // byte offset -> rune offset
		}
	}
	if idx < 0 {
		return "", false
	}
	start := idx - snippetRadius
	if start < 0 {
		start = 0
	}
	end := idx + snippetRadius
	if end > len(runes) {
		end = len(runes)
	}
	s := string(runes[start:end])
	if start > 0 {
		s = "…" + s
	}
	if end < len(runes) {
		s = s + "…"
	}
	return s, true
}
