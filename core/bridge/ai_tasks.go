package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"companion/core/domain"
)

// The editor-assist tasks (ai.go): each turns an ai.run request into a system prompt and a
// user message, and the structured ones (grammar, metadata) parse the model's JSON answer.

const (
	aiTaskGenerate     = "generate"
	aiTaskReadingLevel = "readingLevel"
	aiTaskGrammar      = "grammar"
	aiTaskSummarize    = "summarize"
	aiTaskTranslate    = "translate"
	aiTaskCritique     = "critique"
	aiTaskMetadata     = "metadata"
)

// aiCursorMarker marks the insertion point in the document the editor sends with generate.
// Mirrors AI_CURSOR_MARKER in packages/editor/src/ai.ts.
const aiCursorMarker = "⟦CURSOR⟧"

type aiTask struct {
	name   string
	system string
	user   string
	// stream sends ai.delta events as text arrives; off for tasks whose output is JSON.
	stream bool
	// parse turns the final text into the structured result carried by ai.done.
	parse func(text string) (any, error)
}

// aiEditorPreamble frames every task: the output is dropped straight into a markdown note, so
// no chatter, and Companion's [[…]] references must survive untouched.
const aiEditorPreamble = `You are a writing assistant built into Companion, a markdown note-taking app.
Notes are Markdown (CommonMark + GFM tables, task lists "- [ ]"). References to other items look like [[note:<id>|Label]], [[task:<id>|Label]] or ![[doc:<id>]]; always keep any you are given exactly as written, and never invent new ones.`

// aiRawOutput is appended to tasks whose answer is inserted into the note verbatim.
const aiRawOutput = `Respond with only the resulting Markdown: no preamble, no explanation, no closing remarks, and do not wrap it in a code fence.`

func (c *Core) buildAITask(a aiRunArgs) (*aiTask, error) {
	text := a.Text
	scope := "note"
	if a.Selection {
		scope = "passage"
	}
	needText := func() error {
		if strings.TrimSpace(text) == "" {
			if a.Selection {
				return errors.New("the selection is empty")
			}
			return errors.New("this note is empty")
		}
		return nil
	}

	switch a.Task {
	case aiTaskGenerate:
		if strings.TrimSpace(a.Prompt) == "" {
			return nil, errors.New("tell the assistant what to write")
		}
		var u strings.Builder
		writeTitle(&u, a.Title)
		if a.Selection {
			u.WriteString("The writer selected this passage, and your output will replace it:\n\n")
			fence(&u, "selection", text)
			if doc := strings.TrimSpace(a.Document); doc != "" {
				u.WriteString("For context, the whole note:\n\n")
				fence(&u, "note", clip(doc))
			}
		} else if doc := strings.TrimSpace(a.Document); doc != "" && doc != aiCursorMarker {
			fmt.Fprintf(&u, "The note so far; your output will be inserted at %s:\n\n", aiCursorMarker)
			fence(&u, "note", clip(doc))
		} else {
			u.WriteString("The note is empty; your output will be its content.\n\n")
		}
		fmt.Fprintf(&u, "Instruction: %s", strings.TrimSpace(a.Prompt))
		return &aiTask{
			name:   a.Task,
			stream: true,
			system: aiEditorPreamble + "\n\nWrite what the writer asks for, matching the note's voice, language and formatting. Write only the new content, not the surrounding note.\n" + aiRawOutput,
			user:   u.String(),
		}, nil

	case aiTaskReadingLevel:
		if err := needText(); err != nil {
			return nil, err
		}
		if a.Grade < 1 || a.Grade > 20 {
			return nil, errors.New("pick a reading level")
		}
		var u strings.Builder
		writeTitle(&u, a.Title)
		fmt.Fprintf(&u, "Rewrite this %s for %s.\n\n", scope, gradeLabel(a.Grade))
		fence(&u, scope, text)
		return &aiTask{
			name:   a.Task,
			stream: true,
			system: aiEditorPreamble + `

Rewrite text for a target reading level (US grade, as measured by Flesch-Kincaid). Adjust vocabulary, sentence length and structure to fit; explain or replace jargon for younger readers, and allow precise terms and denser sentences for advanced ones. Keep every fact, the meaning, the language, and the Markdown structure (headings, lists, tables, references).
` + aiRawOutput,
			user: u.String(),
		}, nil

	case aiTaskGrammar:
		if err := needText(); err != nil {
			return nil, err
		}
		var u strings.Builder
		fmt.Fprintf(&u, "Check this %s:\n\n", scope)
		fence(&u, scope, text)
		return &aiTask{
			name: a.Task,
			system: aiEditorPreamble + `

Proofread text for spelling, grammar, punctuation and clear word-usage errors. Do not change style, tone, meaning, formatting, or anything that is a matter of taste; leave correct text alone.
Reply with only a JSON object, no code fence:
{"corrected": "<the full text with every fix applied, Markdown intact>", "issues": [{"original": "<exact erroneous words>", "suggestion": "<replacement>", "explanation": "<short reason>"}]}
When there is nothing to fix, return the text unchanged with an empty issues list.`,
			user:  u.String(),
			parse: parseGrammar,
		}, nil

	case aiTaskSummarize:
		if err := needText(); err != nil {
			return nil, err
		}
		var u strings.Builder
		writeTitle(&u, a.Title)
		fmt.Fprintf(&u, "Summarize this %s:\n\n", scope)
		fence(&u, scope, text)
		return &aiTask{
			name:   a.Task,
			stream: true,
			system: aiEditorPreamble + `

Summarize text faithfully and concisely: a one-sentence gist, then the key points as a short bulleted list (skip the list for very short text). Include decisions, dates and action items when present. Use the text's language. Don't add a heading.
` + aiRawOutput,
			user: u.String(),
		}, nil

	case aiTaskTranslate:
		if err := needText(); err != nil {
			return nil, err
		}
		lang := strings.TrimSpace(a.Language)
		if lang == "" {
			return nil, errors.New("pick a language")
		}
		var u strings.Builder
		fmt.Fprintf(&u, "Translate this %s into %s.\n\n", scope, lang)
		fence(&u, scope, text)
		return &aiTask{
			name:   a.Task,
			stream: true,
			system: aiEditorPreamble + `

Translate text naturally and accurately, as a fluent native writer would, keeping tone and register. Keep the Markdown structure, code, URLs and references unchanged; translate only the prose (a reference's label after "|" may be left as is).
` + aiRawOutput,
			user: u.String(),
		}, nil

	case aiTaskCritique:
		if err := needText(); err != nil {
			return nil, err
		}
		var u strings.Builder
		writeTitle(&u, a.Title)
		if a.Selection {
			u.WriteString("Critique this passage from the note:\n\n")
		} else {
			u.WriteString("Critique this note:\n\n")
		}
		fence(&u, scope, text)
		return &aiTask{
			name:   a.Task,
			stream: true,
			system: aiEditorPreamble + `

Act as a candid, constructive editor. Assess the writing's clarity, structure, argument and evidence, tone, and concision. Reply in Markdown: open with one or two sentences on what works, then "**Suggestions**" as a bulleted list of the most important, specific, actionable improvements (quote the words you mean), most important first. Be brief; don't rewrite the text.`,
			user: u.String(),
		}, nil

	case aiTaskMetadata:
		if err := needText(); err != nil {
			return nil, err
		}
		return c.metadataTask(a)
	}
	return nil, fmt.Errorf("unknown assist %q", a.Task)
}

// metadataTask asks the model for the entity's structured props (PLAN §6.3). With a type set it
// fills that type's fields; without one it also picks the best-fitting type for the kind.
// Reference fields are left out: the model can't know which ids exist.
func (c *Core) metadataTask(a aiRunArgs) (*aiTask, error) {
	kind := a.Kind
	if kind == "" {
		kind = domain.AppliesToNote
	}
	var candidates []*domain.ObjectType
	if a.ObjectTypeID != "" {
		ot, err := c.store.ObjectTypes.Get(a.ObjectTypeID)
		if err != nil {
			return nil, mapStoreErr(err)
		}
		candidates = []*domain.ObjectType{ot}
	} else {
		all, err := c.store.ObjectTypes.List()
		if err != nil {
			return nil, err
		}
		for _, ot := range all {
			if domain.AppliesToKind(ot.AppliesTo, kind) {
				candidates = append(candidates, ot)
			}
		}
		if len(candidates) == 0 {
			return nil, fmt.Errorf("there are no object types for %ss yet; create one in Settings › Objects", kind)
		}
	}
	schemas := map[string]domain.ObjectSchema{}
	var types strings.Builder
	for _, ot := range candidates {
		schema, err := ot.Schema()
		if err != nil {
			continue
		}
		schemas[ot.ID] = schema
		fmt.Fprintf(&types, "Type %q (id %s):\n", ot.Name, ot.ID)
		n := 0
		for _, f := range schema.Fields {
			if f.Type == domain.FieldReference {
				continue
			}
			n++
			fmt.Fprintf(&types, "- %s: %s", f.Key, describeField(f))
			if f.Label != "" && f.Label != f.Key {
				fmt.Fprintf(&types, " (%q)", f.Label)
			}
			types.WriteString("\n")
		}
		if n == 0 {
			types.WriteString("- (no fields)\n")
		}
	}
	if len(schemas) == 0 {
		return nil, errors.New("this type's fields couldn't be read")
	}

	choose := "The note already has its type; use it."
	if a.ObjectTypeID == "" {
		choose = "Pick the one type that best fits the text, or null when none clearly fits."
	}
	var u strings.Builder
	writeTitle(&u, a.Title)
	fmt.Fprintf(&u, "Today is %s.\n\n", time.Now().Format("2006-01-02 (Monday)"))
	u.WriteString(types.String())
	u.WriteString("\n")
	source := kind
	if a.Selection {
		source = "passage"
	}
	fmt.Fprintf(&u, "Fill in the fields from this %s:\n\n", source)
	fence(&u, "text", a.Text)

	return &aiTask{
		name: aiTaskMetadata,
		system: aiEditorPreamble + `

Extract structured metadata from text. ` + choose + ` Fill a field only when the text states or clearly implies its value; leave it out otherwise, never guess. Dates are YYYY-MM-DD (resolve relative dates against today), numbers are JSON numbers, checkboxes are true/false, select values must be one of the listed options exactly, multi-select values are arrays of listed options.
Reply with only a JSON object, no code fence:
{"typeId": "<the chosen type's id, or null>", "props": {"<field key>": <value>}}`,
		user: u.String(),
		parse: func(text string) (any, error) {
			return parseMetadata(text, a.ObjectTypeID, schemas)
		},
	}, nil
}

// aiGrammarResult is ai.done's result for the grammar task.
type aiGrammarResult struct {
	Corrected string           `json:"corrected"`
	Issues    []aiGrammarIssue `json:"issues"`
}

type aiGrammarIssue struct {
	Original    string `json:"original"`
	Suggestion  string `json:"suggestion"`
	Explanation string `json:"explanation"`
}

func parseGrammar(text string) (any, error) {
	var out aiGrammarResult
	if err := decodeModelJSON(text, &out); err != nil {
		return nil, err
	}
	issues := out.Issues[:0]
	for _, is := range out.Issues {
		if strings.TrimSpace(is.Original) != "" && is.Original != is.Suggestion {
			issues = append(issues, is)
		}
	}
	out.Issues = issues
	if out.Issues == nil {
		out.Issues = []aiGrammarIssue{}
	}
	return out, nil
}

// aiMetadataResult is ai.done's result for the metadata task: the type and the validated props.
type aiMetadataResult struct {
	ObjectTypeID string         `json:"objectTypeId"`
	Props        map[string]any `json:"props"`
}

func parseMetadata(text, fixedType string, schemas map[string]domain.ObjectSchema) (any, error) {
	var raw struct {
		TypeID *string        `json:"typeId"`
		Props  map[string]any `json:"props"`
	}
	if err := decodeModelJSON(text, &raw); err != nil {
		return nil, err
	}
	typeID := fixedType
	if typeID == "" {
		if raw.TypeID == nil || *raw.TypeID == "" {
			return nil, errors.New("none of your object types fits this text")
		}
		typeID = *raw.TypeID
	}
	schema, ok := schemas[typeID]
	if !ok {
		return nil, errors.New("the model picked a type that doesn't exist")
	}
	return aiMetadataResult{ObjectTypeID: typeID, Props: sanitizeProps(raw.Props, schema)}, nil
}

// sanitizeProps keeps only the model's values that fit the schema, coercing near misses (a
// numeric string, an option in the wrong case, a date in another layout) and dropping the rest,
// so applying the result can never fail validation.
func sanitizeProps(in map[string]any, schema domain.ObjectSchema) map[string]any {
	out := map[string]any{}
	for _, f := range schema.Fields {
		v, ok := in[f.Key]
		if !ok || v == nil {
			continue
		}
		var val any
		switch f.Type {
		case domain.FieldText:
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				val = strings.TrimSpace(s)
			}
		case domain.FieldURL:
			if s, ok := v.(string); ok && (strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")) {
				val = strings.TrimSpace(s)
			}
		case domain.FieldNumber:
			switch n := v.(type) {
			case float64:
				val = n
			case string:
				if p, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(n), ",", ""), 64); err == nil {
					val = p
				}
			}
			if n, ok := val.(float64); ok && (math.IsNaN(n) || math.IsInf(n, 0)) {
				val = nil
			}
		case domain.FieldDate:
			if s, ok := v.(string); ok {
				if d, ok := normalizeDate(s); ok {
					val = d
				}
			}
		case domain.FieldCheckbox:
			switch b := v.(type) {
			case bool:
				val = b
			case string:
				if p, err := strconv.ParseBool(strings.TrimSpace(b)); err == nil {
					val = p
				}
			}
		case domain.FieldSelect:
			if s, ok := v.(string); ok {
				if o, ok := matchOption(f.Options, s); ok {
					val = o
				}
			}
		case domain.FieldMultiSelect:
			items, _ := v.([]any)
			if s, ok := v.(string); ok {
				items = []any{s}
			}
			var picked []string
			seen := map[string]bool{}
			for _, it := range items {
				s, _ := it.(string)
				if o, ok := matchOption(f.Options, s); ok && !seen[o] {
					seen[o] = true
					picked = append(picked, o)
				}
			}
			if len(picked) > 0 {
				val = picked
			}
		}
		if val == nil {
			continue
		}
		// Belt and braces: the core validates props on write with the same rules.
		one, _ := json.Marshal(map[string]any{f.Key: val})
		if domain.ValidateProps(one, domain.ObjectSchema{Fields: []domain.ObjectField{{Key: f.Key, Type: f.Type, Options: f.Options}}}) == nil {
			out[f.Key] = val
		}
	}
	return out
}

func matchOption(options []string, s string) (string, bool) {
	s = strings.TrimSpace(s)
	for _, o := range options {
		if strings.EqualFold(o, s) {
			return o, true
		}
	}
	return "", false
}

var dateLayouts = []string{"2006-01-02", time.RFC3339, "2006-01-02T15:04:05", "2006/01/02", "January 2, 2006", "Jan 2, 2006", "2 January 2006", "02 Jan 2006"}

func normalizeDate(s string) (string, bool) {
	s = strings.TrimSpace(s)
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.Format("2006-01-02"), true
		}
	}
	return "", false
}

// decodeModelJSON reads a JSON object out of a model reply, tolerating a code fence or stray
// prose around it.
func decodeModelJSON(text string, v any) error {
	s := strings.TrimSpace(text)
	start, end := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return errors.New("the model's answer wasn't in the expected format; try again")
	}
	if err := json.Unmarshal([]byte(s[start:end+1]), v); err != nil {
		return errors.New("the model's answer wasn't in the expected format; try again")
	}
	return nil
}

func describeField(f domain.ObjectField) string {
	switch f.Type {
	case domain.FieldSelect:
		return "one of " + quoteList(f.Options)
	case domain.FieldMultiSelect:
		return "any of " + quoteList(f.Options)
	case domain.FieldDate:
		return "date"
	case domain.FieldCheckbox:
		return "checkbox"
	case domain.FieldURL:
		return "URL"
	default:
		return f.Type
	}
}

func quoteList(items []string) string {
	q := make([]string, len(items))
	for i, s := range items {
		q[i] = strconv.Quote(s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// gradeLabel names a US grade level for the prompt; 13+ are post-secondary.
func gradeLabel(g int) string {
	switch {
	case g <= 12:
		return fmt.Sprintf("a US grade %d reading level", g)
	case g <= 16:
		return "a college reading level"
	default:
		return "a graduate / professional reading level"
	}
}

func writeTitle(b *strings.Builder, title string) {
	if t := strings.TrimSpace(title); t != "" {
		fmt.Fprintf(b, "Note title: %s\n\n", t)
	}
}

// fence wraps text in XML-ish tags so the model can tell the material from the instruction.
func fence(b *strings.Builder, tag, text string) {
	fmt.Fprintf(b, "<%s>\n%s\n</%s>\n\n", tag, strings.TrimSpace(text), tag)
}

// clip bounds context text to aiDocumentMax bytes, keeping the window around the cursor marker
// when there is one (that is where generated text lands).
func clip(s string) string {
	if len(s) <= aiDocumentMax {
		return s
	}
	start := 0
	if at := strings.Index(s, aiCursorMarker); at > aiDocumentMax/2 {
		start = min(at-aiDocumentMax/2, len(s)-aiDocumentMax)
	}
	end := start + aiDocumentMax
	// Stay on UTF-8 boundaries.
	for start > 0 && !utf8.RuneStart(s[start]) {
		start--
	}
	for end < len(s) && !utf8.RuneStart(s[end]) {
		end--
	}
	out := s[start:end]
	if start > 0 {
		out = "…\n" + out
	}
	if end < len(s) {
		out += "\n…"
	}
	return out
}
