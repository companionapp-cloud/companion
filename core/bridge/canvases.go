package bridge

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"companion/core/domain"
	"companion/core/store"
	"companion/core/unfurl"
)

// canvasesChangedEvent signals the canvas UI to refetch after any board, node, or edge
// mutation. Payload: {canvasId} (empty on bulk changes). Emitted alongside the granular
// data.changed so the graph, sidebar, and other subscribers refresh too.
const canvasesChangedEvent = "canvases.changed"

func (c *Core) emitCanvasChanged(canvasID string) {
	payload, _ := json.Marshal(map[string]string{"canvasId": canvasID})
	c.emit(canvasesChangedEvent, payload)
	c.emitDataChanged("canvas", canvasID)
}

// canvasNoteRef / canvasTaskRef / canvasEventRef / canvasDocumentRef are the hydrated
// summaries of the entities a board embeds, resolved by the core in one call so the
// renderer (which on mobile runs inside a WebView with no providers) never has to fetch
// them one by one. A trashed or deleted target is reported as Missing so the node can
// render a "gone" state instead of vanishing.
type canvasNoteRef struct {
	Title        string  `json:"title"`
	Excerpt      string  `json:"excerpt"`
	ObjectTypeID *string `json:"objectTypeId,omitempty"`
	Missing      bool    `json:"missing,omitempty"`
}
type canvasTaskRef struct {
	Title   string     `json:"title"`
	Status  string     `json:"status"`
	DueAt   *time.Time `json:"dueAt,omitempty"`
	Missing bool       `json:"missing,omitempty"`
}
type canvasEventRef struct {
	Title    string     `json:"title"`
	StartsAt time.Time  `json:"startsAt"`
	EndsAt   *time.Time `json:"endsAt,omitempty"`
	AllDay   bool       `json:"allDay"`
	Location *string    `json:"location,omitempty"`
	Missing  bool       `json:"missing,omitempty"`
}
type canvasDocumentRef struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Missing  bool   `json:"missing,omitempty"`
}

type canvasRefs struct {
	Notes     map[string]canvasNoteRef     `json:"notes"`
	Tasks     map[string]canvasTaskRef     `json:"tasks"`
	Events    map[string]canvasEventRef    `json:"events"`
	Documents map[string]canvasDocumentRef `json:"documents"`
}

// canvasDocument is the wire shape of canvases.get: the board, its nodes and edges, the
// hydrated references, and this device's saved viewport (nil if never opened here).
type canvasDocument struct {
	Canvas *domain.Canvas       `json:"canvas"`
	Nodes  []*domain.CanvasNode `json:"nodes"`
	Edges  []*domain.CanvasEdge `json:"edges"`
	Refs   canvasRefs           `json:"refs"`
	View   *store.CanvasView    `json:"view,omitempty"`
}

// ---- boards ----------------------------------------------------------------------------

func (c *Core) canvasesList() ([]byte, error) {
	canvases, err := c.store.Canvases.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(canvases)
}

func (c *Core) canvasesCreate(payload []byte) ([]byte, error) {
	var in store.CreateCanvasInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	cv, err := c.store.Canvases.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitCanvasChanged(cv.ID)
	return json.Marshal(cv)
}

func (c *Core) canvasesUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateCanvasInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	cv, err := c.store.Canvases.Update(args.ID, args.UpdateCanvasInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitCanvasChanged(cv.ID)
	return json.Marshal(cv)
}

// canvasesDelete moves a board to the Trash (PLAN §4.3); its nodes and edges ride along
// and return with it on restore.
func (c *Core) canvasesDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Canvases.Trash(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitCanvasChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) canvasesDeleteMany(payload []byte) ([]byte, error) {
	var args struct {
		IDs []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Canvases.TrashMany(args.IDs)
	if err != nil {
		return nil, err
	}
	c.emit(canvasesChangedEvent, nil)
	c.emitDataChanged("", "")
	return json.Marshal(map[string]int64{"count": n})
}

// canvasesGet returns a board with its nodes, edges, hydrated references, and viewport.
func (c *Core) canvasesGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	cv, err := c.store.Canvases.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	nodes, err := c.store.CanvasNodes.ListForCanvas(cv.ID)
	if err != nil {
		return nil, err
	}
	edges, err := c.store.CanvasEdges.ListForCanvas(cv.ID)
	if err != nil {
		return nil, err
	}
	refs, err := c.hydrateCanvasRefs(nodes)
	if err != nil {
		return nil, err
	}
	view, err := c.store.Canvases.GetView(cv.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(canvasDocument{Canvas: cv, Nodes: nodes, Edges: edges, Refs: refs, View: view})
}

// hydrateCanvasRefs resolves every referenced entity to its summary, once per id.
func (c *Core) hydrateCanvasRefs(nodes []*domain.CanvasNode) (canvasRefs, error) {
	refs := canvasRefs{
		Notes:     map[string]canvasNoteRef{},
		Tasks:     map[string]canvasTaskRef{},
		Events:    map[string]canvasEventRef{},
		Documents: map[string]canvasDocumentRef{},
	}
	for _, n := range nodes {
		if n.RefType == nil || n.RefID == nil {
			continue
		}
		id := *n.RefID
		switch *n.RefType {
		case domain.NodeNote:
			if _, done := refs.Notes[id]; done {
				continue
			}
			note, err := c.store.Notes.Get(id)
			if errors.Is(err, store.ErrNotFound) {
				refs.Notes[id] = canvasNoteRef{Missing: true}
				continue
			} else if err != nil {
				return refs, err
			}
			refs.Notes[id] = canvasNoteRef{Title: note.Title, Excerpt: excerpt(note.ContentMD, 300), ObjectTypeID: note.ObjectTypeID}
		case domain.NodeTask:
			if _, done := refs.Tasks[id]; done {
				continue
			}
			task, err := c.store.Tasks.Get(id)
			if errors.Is(err, store.ErrNotFound) {
				refs.Tasks[id] = canvasTaskRef{Missing: true}
				continue
			} else if err != nil {
				return refs, err
			}
			refs.Tasks[id] = canvasTaskRef{Title: task.Title, Status: task.Status, DueAt: task.DueAt}
		case "event":
			if _, done := refs.Events[id]; done {
				continue
			}
			ev, err := c.store.CalendarEvents.GetAny(id)
			if errors.Is(err, store.ErrNotFound) || (err == nil && ev.DeletedAt != nil) {
				refs.Events[id] = canvasEventRef{Missing: true}
				continue
			} else if err != nil {
				return refs, err
			}
			refs.Events[id] = canvasEventRef{Title: ev.Title, StartsAt: ev.StartsAt, EndsAt: ev.EndsAt, AllDay: ev.AllDay, Location: ev.Location}
		case domain.NodeDocument:
			if _, done := refs.Documents[id]; done {
				continue
			}
			doc, err := c.store.Documents.Get(id)
			if errors.Is(err, store.ErrNotFound) {
				refs.Documents[id] = canvasDocumentRef{Missing: true}
				continue
			} else if err != nil {
				return refs, err
			}
			refs.Documents[id] = canvasDocumentRef{Filename: doc.Filename, Mime: doc.Mime}
		}
	}
	return refs, nil
}

// excerpt returns the first max runes of a markdown body, whitespace-collapsed, with
// wikilink syntax reduced to its alias (or dropped) so ids never show in a preview.
func excerpt(md string, max int) string {
	s := domain.StripRefs(md)
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// ---- nodes ----------------------------------------------------------------------------

func (c *Core) canvasesNodesUpsert(payload []byte) ([]byte, error) {
	var args struct {
		CanvasID string                  `json:"canvasId"`
		Nodes    []store.CanvasNodeInput `json:"nodes"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Canvases.Get(args.CanvasID); err != nil {
		return nil, mapStoreErr(err)
	}
	nodes, err := c.store.CanvasNodes.UpsertMany(args.CanvasID, args.Nodes)
	if err != nil {
		return nil, err
	}
	if err := c.store.Canvases.Touch(args.CanvasID); err != nil {
		return nil, err
	}
	c.emitCanvasChanged(args.CanvasID)
	return json.Marshal(nodes)
}

// canvasesNodesDelete tombstones nodes and every edge attached to them.
func (c *Core) canvasesNodesDelete(payload []byte) ([]byte, error) {
	var args struct {
		CanvasID string   `json:"canvasId"`
		IDs      []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	edgeIDs, err := c.store.CanvasEdges.DeleteForNodes(args.IDs)
	if err != nil {
		return nil, err
	}
	n, err := c.store.CanvasNodes.DeleteMany(args.IDs)
	if err != nil {
		return nil, err
	}
	if args.CanvasID != "" {
		if err := c.store.Canvases.Touch(args.CanvasID); err != nil {
			return nil, err
		}
	}
	c.emitCanvasChanged(args.CanvasID)
	if edgeIDs == nil {
		edgeIDs = []string{}
	}
	return json.Marshal(map[string]any{"count": n, "edgeIds": edgeIDs})
}

// ---- edges ----------------------------------------------------------------------------

func (c *Core) canvasesEdgesUpsert(payload []byte) ([]byte, error) {
	var args struct {
		CanvasID string                  `json:"canvasId"`
		Edges    []store.CanvasEdgeInput `json:"edges"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Canvases.Get(args.CanvasID); err != nil {
		return nil, mapStoreErr(err)
	}
	// Both endpoints must be live nodes of this board.
	for _, e := range args.Edges {
		for _, id := range []string{e.FromNodeID, e.ToNodeID} {
			n, err := c.store.CanvasNodes.Get(id)
			if err != nil {
				return nil, mapStoreErr(err)
			}
			if n.CanvasID != args.CanvasID {
				return nil, errors.Join(domain.ErrInvalidCanvas, errors.New("edge endpoint on another canvas"))
			}
		}
	}
	edges, err := c.store.CanvasEdges.UpsertMany(args.CanvasID, args.Edges)
	if err != nil {
		return nil, err
	}
	if err := c.store.Canvases.Touch(args.CanvasID); err != nil {
		return nil, err
	}
	c.emitCanvasChanged(args.CanvasID)
	return json.Marshal(edges)
}

func (c *Core) canvasesEdgesDelete(payload []byte) ([]byte, error) {
	var args struct {
		CanvasID string   `json:"canvasId"`
		IDs      []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.CanvasEdges.DeleteMany(args.IDs)
	if err != nil {
		return nil, err
	}
	if args.CanvasID != "" {
		if err := c.store.Canvases.Touch(args.CanvasID); err != nil {
			return nil, err
		}
	}
	c.emitCanvasChanged(args.CanvasID)
	return json.Marshal(map[string]int64{"count": n})
}

// ---- viewport (local-only) --------------------------------------------------------------

func (c *Core) canvasesViewSet(payload []byte) ([]byte, error) {
	var args struct {
		CanvasID string `json:"canvasId"`
		store.CanvasView
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.Zoom <= 0 {
		args.Zoom = 1
	}
	if err := c.store.Canvases.SetView(args.CanvasID, args.CanvasView); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// ---- backlinks -------------------------------------------------------------------------

// canvasesForEntity lists the live boards that embed an entity ("on canvas …").
func (c *Core) canvasesForEntity(payload []byte) ([]byte, error) {
	var args struct {
		EntityType string `json:"entityType"`
		EntityID   string `json:"entityId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ids, err := c.store.CanvasNodes.CanvasIDsReferencing(args.EntityType, args.EntityID)
	if err != nil {
		return nil, err
	}
	out := []*domain.Canvas{}
	for _, id := range ids {
		cv, err := c.store.Canvases.Get(id)
		if errors.Is(err, store.ErrNotFound) {
			continue
		} else if err != nil {
			return nil, err
		}
		out = append(out, cv)
	}
	return json.Marshal(out)
}

// purgeCanvas tombstones a trashed board and every node/edge on it so they stop syncing
// (the server's collector does the same when retention elapses).
func (c *Core) purgeCanvas(id string) error {
	if err := c.store.CanvasEdges.DeleteForCanvas(id); err != nil {
		return err
	}
	if err := c.store.CanvasNodes.DeleteForCanvas(id); err != nil {
		return err
	}
	return c.store.Canvases.Delete(id)
}

// ---- link previews ---------------------------------------------------------------------

// canvasesLinkPreview fetches a URL and extracts its Open Graph / Twitter card metadata
// for a link node (PLAN-canvases.md §4.3). Parsing is shared; only the fetch differs per
// platform (direct on native, the server's blind proxy on web). A page that can't be
// fetched or isn't HTML still yields a preview carrying the URL, so the node renders.
func (c *Core) canvasesLinkPreview(payload []byte) ([]byte, error) {
	var args struct {
		URL string `json:"url"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	u := unfurl.Normalize(args.URL)
	if u == "" {
		return nil, errors.New("not a valid http(s) url")
	}
	final, body, err := c.fetchPage(u)
	if err != nil {
		// Best effort: an unreachable page still gets a minimal card, with the reason so
		// the UI can say why there's no title or image (on web: no sync server to proxy
		// the fetch through).
		return json.Marshal(linkPreviewResult{Preview: unfurl.Parse(u, nil), Error: err.Error()})
	}
	if len(body) == 0 {
		return json.Marshal(linkPreviewResult{Preview: unfurl.Parse(final, nil)})
	}
	return json.Marshal(linkPreviewResult{Preview: unfurl.Parse(final, body)})
}

// linkPreviewResult is the wire shape of canvases.linkPreview: the parsed metadata plus
// the fetch error, if the page couldn't be read.
type linkPreviewResult struct {
	unfurl.Preview
	Error string `json:"error,omitempty"`
}
