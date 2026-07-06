package domain

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
