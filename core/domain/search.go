package domain

import "encoding/json"

// SearchHit is one full-text search result: a live note or task whose title or body
// matched a query, with a short snippet of the match for context (PLAN §6.8). It is what
// the LLM's search_notes retrieval tool returns and what the in-app search box renders.
// Type is NodeNote or NodeTask.
type SearchHit struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

// ObjectHit is one structured object (a note or task carrying an archetype's props) returned
// by a query over an object type's data fields — what the LLM's query_objects tool returns.
// Unlike SearchHit (a keyword full-text match with a snippet), it carries the entity's full
// Props so the caller can read and compare field values directly. Type is NodeNote or
// NodeTask.
type ObjectHit struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Title string          `json:"title"`
	Props json.RawMessage `json:"props"`
}
