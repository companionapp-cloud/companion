package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"companion/core/domain"
	"companion/core/ink"
	"companion/core/store"
)

// Handwriting tools: the ink drawn over a note or on a notebook page, turned into text.
//
//   - read_ink draws each ink group as a PNG, for agents that read images themselves (Claude
//     Code and Codex over MCP).
//   - transcribe_ink reads it with an on-device OCR engine (Apple Vision, given a Recognizer),
//     for agents that can't see images, or when the user asks for a quick conversion.
//   - convert_ink_to_text writes the text into the note or page where the ink was pinned and
//     removes those strokes.

// WithInkRecognizer enables transcribe_ink, which reads handwriting with rec.
func WithInkRecognizer(rec ink.Recognizer) Option {
	return func(o *storeOptions) { o.ink = rec }
}

// maxInkImages caps the images one read_ink call returns; groupIds pages through the rest.
const maxInkImages = 12

const inkTargetProps = `"noteId":{"type":"string","description":"The note whose ink to read (from search_notes or get_note)."},
					"pageId":{"type":"string","description":"The notebook page whose ink to read (a search_notes hit of type notebook_page), instead of noteId."}`

// inkTarget is the note or notebook page a call is about, with its ink.
type inkTarget struct {
	noteID, pageID string
	title          string
	contentMD      string
	groups         []*ink.Group
	byID           map[string]*ink.Group
}

func (t *inkTarget) kindOf() string {
	if t.pageID != "" {
		return "notebook_page"
	}
	return domain.NodeNote
}

func loadInkTarget(s *store.Store, noteID, pageID string) (*inkTarget, error) {
	noteID, pageID = strings.TrimSpace(noteID), strings.TrimSpace(pageID)
	if (noteID == "") == (pageID == "") {
		return nil, errors.New("pass exactly one of noteId or pageId")
	}
	t := &inkTarget{noteID: noteID, pageID: pageID, byID: map[string]*ink.Group{}}
	type row struct {
		id   string
		data json.RawMessage
	}
	var rows []row
	if noteID != "" {
		n, err := s.Notes.Get(noteID)
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("no note with id %q — use search_notes to find the right id", noteID)
		}
		if err != nil {
			return nil, err
		}
		t.title, t.contentMD = n.Title, n.ContentMD
		groups, err := s.NoteInk.ListForNote(noteID)
		if err != nil {
			return nil, err
		}
		for _, g := range groups {
			rows = append(rows, row{g.ID, g.Data})
		}
	} else {
		p, err := s.NotebookPages.Get(pageID)
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("no notebook page with id %q — use search_notes to find the right id", pageID)
		}
		if err != nil {
			return nil, err
		}
		t.contentMD = p.ContentMD
		if nb, err := s.Notebooks.Get(p.NotebookID); err == nil {
			t.title = nb.Title
		}
		groups, err := s.NotebookInk.ListForPage(pageID)
		if err != nil {
			return nil, err
		}
		for _, g := range groups {
			rows = append(rows, row{g.ID, g.Data})
		}
	}
	for _, r := range rows {
		g, err := ink.Parse(r.id, r.data)
		if err != nil {
			continue // a payload from a newer editor: leave it alone
		}
		t.groups = append(t.groups, g)
		t.byID[g.ID] = g
	}
	return t, nil
}

// pick returns the target's groups that hold writing, limited to ids when given.
func (t *inkTarget) pick(ids []string) ([]*ink.Group, error) {
	var out []*ink.Group
	if len(ids) == 0 {
		for _, g := range t.groups {
			if g.Writing() {
				out = append(out, g)
			}
		}
		return out, nil
	}
	for _, id := range ids {
		g, ok := t.byID[id]
		if !ok {
			return nil, fmt.Errorf("no ink group %q on this %s — call read_ink to list its groups", id, t.kindOf())
		}
		out = append(out, g)
	}
	return out, nil
}

// groupKind says where a group sits, so a model can judge what the writing is for.
func groupKind(g *ink.Group) string {
	switch {
	case g.Anchor.Page:
		return "page"
	case g.Anchor.Before == "" && g.Anchor.After == "":
		return "empty_note"
	case g.Anchor.Free:
		return "beside_line"
	default:
		return "over_text"
	}
}

func inkCount(s *store.Store, noteID, pageID string) int {
	if noteID != "" {
		gs, _ := s.NoteInk.ListForNote(noteID)
		return len(gs)
	}
	gs, _ := s.NotebookInk.ListForPage(pageID)
	return len(gs)
}

type inkArgs struct {
	NoteID   string   `json:"noteId"`
	PageID   string   `json:"pageId"`
	GroupIDs []string `json:"groupIds"`
}

func addInkTools(r *Registry, s *store.Store, rec ink.Recognizer) {
	r.Add(Tool{
		Spec: ToolSpec{
			Name: "read_ink",
			Description: "See the handwriting and drawings (ink) on a note or notebook page as images, to read what the user wrote by hand. " +
				"Call this when get_note or get_page reports inkGroups, or the user asks about their handwriting. A note's ink comes as one image per ink group " +
				"(strokes drawn together), with the text it was written over or beside; a page's ink comes as one image of the whole sheet, with each group's box in page px. " +
				"To turn handwriting into typed text, read it here and call convert_ink_to_text with what it says.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					` + inkTargetProps + `,
					"groupIds":{"type":"array","items":{"type":"string"},"description":"Only these ink groups (to page through a note with many)."}
				}
			}`),
		},
		Rich: func(_ context.Context, args json.RawMessage) (ToolOutput, error) {
			var a inkArgs
			if err := json.Unmarshal(args, &a); err != nil {
				return ToolOutput{}, err
			}
			t, err := loadInkTarget(s, a.NoteID, a.PageID)
			if err != nil {
				return ToolOutput{}, err
			}
			groups, err := t.pick(a.GroupIDs)
			if err != nil {
				return ToolOutput{}, err
			}
			var out ToolOutput
			type groupView struct {
				ID      string   `json:"id"`
				Kind    string   `json:"kind"`
				Before  string   `json:"textBefore,omitempty"`
				After   string   `json:"textAfter,omitempty"`
				Strokes int      `json:"strokes"`
				Image   int      `json:"image,omitempty"`
				Box     *ink.Box `json:"box,omitempty"`
			}
			var views []groupView
			var more []string
			if t.pageID != "" {
				if rend, ok := ink.Render(groups...); ok {
					out.Images = append(out.Images, ToolImage{MIMEType: "image/png", Data: rend.PNG})
				}
				for _, g := range groups {
					v := groupView{ID: g.ID, Kind: groupKind(g), Strokes: len(g.Strokes), Image: 1}
					if b, ok := ink.Bounds(g); ok {
						v.Box = &b
					}
					views = append(views, v)
				}
			} else {
				for _, g := range groups {
					if len(out.Images) == maxInkImages {
						more = append(more, g.ID)
						continue
					}
					v := groupView{ID: g.ID, Kind: groupKind(g), Before: g.Anchor.Before, After: g.Anchor.After, Strokes: len(g.Strokes)}
					if rend, ok := ink.Render(g); ok {
						out.Images = append(out.Images, ToolImage{MIMEType: "image/png", Data: rend.PNG})
						v.Image = len(out.Images)
					}
					views = append(views, v)
				}
			}
			result := map[string]any{
				"type": t.kindOf(), "id": t.noteID + t.pageID, "title": t.title,
				"groups": views, "images": len(out.Images),
			}
			switch {
			case len(groups) == 0:
				result["hint"] = "There is no handwriting here (highlighter marks aren't writing)."
			case len(more) > 0:
				result["moreGroupIds"] = more
				result["hint"] = fmt.Sprintf("Showing %d groups; pass moreGroupIds as groupIds to see the rest.", maxInkImages)
			default:
				result["hint"] = "Image N is the group with image N. Kinds: over_text (written over the words between textBefore and textAfter), " +
					"beside_line (in the margin or empty space next to that line), empty_note, page (on a notebook sheet)."
			}
			if rec != nil {
				result["imagesUnavailable"] = "If you can't see the images, call transcribe_ink to read them on this device."
			}
			text, err := jsonResult(result)
			out.Text = text
			return out, err
		},
	})

	if rec != nil {
		r.Add(Tool{
			Spec: ToolSpec{
				Name: "transcribe_ink",
				Description: "Read the handwriting on a note or notebook page with on-device text recognition, returning what each piece of ink says. " +
					"Call this to convert handwriting to text, or to find out what the user wrote by hand. Pass the result's transcripts to convert_ink_to_text " +
					"(fix any misread words first) to put the text into the note.",
				Schema: json.RawMessage(`{
					"type":"object",
					"additionalProperties":false,
					"properties":{
						` + inkTargetProps + `,
						"groupIds":{"type":"array","items":{"type":"string"},"description":"Only these ink groups."}
					}
				}`),
			},
			Handler: func(ctx context.Context, args json.RawMessage) (string, error) {
				var a inkArgs
				if err := json.Unmarshal(args, &a); err != nil {
					return "", err
				}
				t, err := loadInkTarget(s, a.NoteID, a.PageID)
				if err != nil {
					return "", err
				}
				groups, err := t.pick(a.GroupIDs)
				if err != nil {
					return "", err
				}
				transcripts, unread, err := transcribe(ctx, rec, t, groups)
				if err != nil {
					return "", err
				}
				result := map[string]any{
					"type": t.kindOf(), "id": t.noteID + t.pageID, "title": t.title,
					"transcripts": transcripts,
				}
				if len(unread) > 0 {
					result["unreadGroupIds"] = unread
				}
				if len(transcripts) == 0 {
					result["hint"] = "No text was recognized; the ink may be a drawing rather than writing."
				} else {
					result["hint"] = "To put this text into the " + t.kindOf() + ", call convert_ink_to_text with items made from these transcripts (groupIds and text)."
				}
				return jsonResult(result)
			},
		})
	}

	r.Add(Tool{
		Spec: ToolSpec{
			Name: "convert_ink_to_text",
			Description: "Replace handwriting on a note or notebook page with typed text: each item's text is written into the document where its ink was " +
				"(in the line it was written over, as a paragraph after the line it was written beside, or at the end), and that ink is erased. " +
				"Call this after reading the ink with read_ink or transcribe_ink, when the user wants their handwriting converted. Only convert writing — leave drawings, arrows " +
				"and circles as ink. Write the text as the user wrote it; correct only clear misreadings.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"noteId":{"type":"string","description":"The note the ink is on."},
					"pageId":{"type":"string","description":"The notebook page the ink is on, instead of noteId."},
					"items":{"type":"array","minItems":1,"items":{
						"type":"object","additionalProperties":false,
						"properties":{
							"groupIds":{"type":"array","minItems":1,"items":{"type":"string"},"description":"The ink groups this text replaces (they're erased)."},
							"text":{"type":"string","description":"What the handwriting says, as markdown."}
						},
						"required":["groupIds","text"]
					}}
				},
				"required":["items"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				NoteID string `json:"noteId"`
				PageID string `json:"pageId"`
				Items  []struct {
					GroupIDs []string `json:"groupIds"`
					Text     string   `json:"text"`
				} `json:"items"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			if len(a.Items) == 0 {
				return "", errors.New("items is required")
			}
			t, err := loadInkTarget(s, a.NoteID, a.PageID)
			if err != nil {
				return "", err
			}
			type item struct {
				groups []*ink.Group
				text   string
				top    float64
			}
			items := make([]item, 0, len(a.Items))
			seen := map[string]bool{}
			for i, it := range a.Items {
				if strings.TrimSpace(it.Text) == "" {
					return "", fmt.Errorf("item %d has no text; only convert ink that is writing", i+1)
				}
				if len(it.GroupIDs) == 0 {
					return "", fmt.Errorf("item %d has no groupIds", i+1)
				}
				gs, err := t.pick(it.GroupIDs)
				if err != nil {
					return "", err
				}
				for _, g := range gs {
					if seen[g.ID] {
						return "", fmt.Errorf("ink group %q is in more than one item", g.ID)
					}
					seen[g.ID] = true
				}
				top := 0.0
				if b, ok := ink.Bounds(gs...); ok {
					top = b.Y
				}
				items = append(items, item{gs, it.Text, top})
			}
			// Page ink has no text anchor: its text is added in the order it sits on the sheet.
			if t.pageID != "" {
				sort.SliceStable(items, func(i, j int) bool { return items[i].top < items[j].top })
			}
			placements := make([]ink.Placement, len(items))
			for i, it := range items {
				placements[i] = ink.Placement{Anchor: it.groups[0].Anchor, Text: it.text}
			}
			md, wheres := ink.InsertText(t.contentMD, placements)
			if t.noteID != "" {
				if _, err := s.Notes.Update(t.noteID, store.UpdateNoteInput{ContentMD: &md}); err != nil {
					return "", err
				}
			} else if _, err := s.NotebookPages.Update(t.pageID, store.UpdatePageInput{ContentMD: &md}); err != nil {
				return "", err
			}
			ids := make([]string, 0, len(seen))
			for id := range seen {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			if t.noteID != "" {
				_, err = s.NoteInk.DeleteMany(ids)
			} else {
				_, err = s.NotebookInk.DeleteMany(ids)
			}
			if err != nil {
				return "", fmt.Errorf("text written, but erasing the ink failed: %w", err)
			}
			type placed struct {
				Text  string    `json:"text"`
				Where ink.Where `json:"where"`
			}
			out := make([]placed, len(items))
			for i, it := range items {
				out[i] = placed{strings.TrimSpace(it.text), wheres[i]}
			}
			result := map[string]any{
				"type": t.kindOf(), "id": t.noteID + t.pageID, "title": t.title,
				"converted": out, "erasedGroups": len(ids), "inkGroupsLeft": inkCount(s, t.noteID, t.pageID),
			}
			if t.noteID != "" {
				result["wikilink"] = fmt.Sprintf("[[%s:%s]]", domain.NodeNote, t.noteID)
			}
			return jsonResult(result)
		},
	})
}

// transcribe runs the recognizer over the groups: one image per note group (each has its own
// origin), one image of the whole sheet for page ink (its groups share page coordinates).
func transcribe(ctx context.Context, rec ink.Recognizer, t *inkTarget, groups []*ink.Group) ([]ink.Transcript, []string, error) {
	type job struct {
		groups []*ink.Group
		rend   *ink.Rendering
	}
	var jobs []job
	if t.pageID != "" {
		if rend, ok := ink.Render(groups...); ok {
			jobs = append(jobs, job{groups, rend})
		}
	} else {
		for _, g := range groups {
			if rend, ok := ink.Render(g); ok {
				jobs = append(jobs, job{[]*ink.Group{g}, rend})
			}
		}
	}
	if len(jobs) == 0 {
		return []ink.Transcript{}, nil, nil
	}
	images := make([][]byte, len(jobs))
	for i, j := range jobs {
		images[i] = j.rend.PNG
	}
	results, err := rec.RecognizeInk(ctx, images)
	if err != nil {
		return nil, nil, fmt.Errorf("text recognition: %w", err)
	}
	if len(results) != len(jobs) {
		return nil, nil, fmt.Errorf("text recognition returned %d results for %d images", len(results), len(jobs))
	}
	transcripts := []ink.Transcript{}
	var unread []string
	for i, j := range jobs {
		got, missed := ink.Assign(j.groups, j.rend, results[i])
		transcripts = append(transcripts, got...)
		unread = append(unread, missed...)
	}
	return transcripts, unread, nil
}
