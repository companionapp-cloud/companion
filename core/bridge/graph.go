package bridge

import "encoding/json"

// Graph read methods (PLAN §5.2). They project only the link index + graph_nodes, never
// entity bodies, so even graph.full stays small for the whole knowledgebase.

func (c *Core) graphFull() ([]byte, error) {
	g, err := c.store.Links.Full()
	if err != nil {
		return nil, err
	}
	return json.Marshal(g)
}

func (c *Core) graphNeighborhood(payload []byte) ([]byte, error) {
	var args struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Depth int    `json:"depth"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.Depth == 0 {
		args.Depth = 2
	}
	g, err := c.store.Links.Neighborhood(args.Type, args.ID, args.Depth)
	if err != nil {
		return nil, err
	}
	return json.Marshal(g)
}

func (c *Core) graphBacklinks(payload []byte) ([]byte, error) {
	var args struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	nodes, err := c.store.Links.Backlinks(args.Type, args.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(nodes)
}

// graphSearch returns nodes whose title matches the query, across every entity type.
// Powers the editor's wikilink autocomplete (PLAN §5.2).
func (c *Core) graphSearch(payload []byte) ([]byte, error) {
	var args struct {
		Query string `json:"query"`
		Type  string `json:"type"`
		Limit int    `json:"limit"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	nodes, err := c.store.Links.Search(args.Query, args.Type, args.Limit)
	if err != nil {
		return nil, err
	}
	return json.Marshal(nodes)
}

// graphLookup resolves a single node by id (any type), for turning a pasted UUID into a
// typed wikilink. Returns JSON null when nothing matches.
func (c *Core) graphLookup(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	node, err := c.store.Links.LookupNode(args.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(node)
}

// graphRebuild truncates and re-derives the whole index (after migrations/imports or
// to recover from an extractor change). It signals a bulk data change so open graph
// views refresh.
func (c *Core) graphRebuild() ([]byte, error) {
	nodes, edges, err := c.store.Links.Rebuild()
	if err != nil {
		return nil, err
	}
	c.emitDataChanged("", "")
	return json.Marshal(map[string]int{"nodes": nodes, "edges": edges})
}
