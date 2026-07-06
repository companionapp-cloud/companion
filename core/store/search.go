package store

import (
	"fmt"
	"sort"
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
			Snippet: snippet(row.body, tokens),
		})
	}
	return out, nil
}

// searchRow is a raw match before ranking/snippeting.
type searchRow struct {
	nodeType, id, title, body, updatedAt string
}

// searchTable finds live rows in one table where every token appears in the title or body.
// bodyCol is the table's body column (content_md for notes, notes_md for tasks).
func (r *SearchRepo) searchTable(table, bodyCol, nodeType string, tokens []string) ([]searchRow, error) {
	conds := make([]string, 0, len(tokens))
	args := make([]any, 0, len(tokens))
	for _, tok := range tokens {
		conds = append(conds, fmt.Sprintf("(lower(title) LIKE ? ESCAPE '\\' OR lower(%s) LIKE ? ESCAPE '\\')", bodyCol))
		pat := "%" + escapeLike(tok) + "%"
		args = append(args, pat, pat)
	}
	query := fmt.Sprintf(
		`SELECT id, title, %s, updated_at FROM %s
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
		if err := rows.Scan(&row.id, &row.title, &row.body, &row.updatedAt); err != nil {
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

// snippet returns a short body excerpt centred on the first token match, with ellipses when
// truncated. Falls back to the head of the body when no token is found in it (a title-only
// match). Runs on runes so multibyte text isn't sliced mid-character.
func snippet(body string, tokens []string) string {
	runes := []rune(body)
	lower := strings.ToLower(body)
	idx := -1
	for _, tok := range tokens {
		if i := strings.Index(lower, tok); i >= 0 && (idx < 0 || i < idx) {
			idx = len([]rune(body[:i])) // byte offset -> rune offset
		}
	}
	if idx < 0 {
		if len(runes) <= 2*snippetRadius {
			return body
		}
		return string(runes[:2*snippetRadius]) + "…"
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
	return s
}
