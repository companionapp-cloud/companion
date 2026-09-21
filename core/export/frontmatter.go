package export

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// YAML front matter for exported markdown: a document's metadata goes in a `---` block ahead of
// the body, where Obsidian, static-site generators and the like expect it. It matches what the
// app's own File › Export › Markdown writes (packages/app/src/export/frontmatter.ts) — keep the
// two in step, so a scheduled export and a one-off export of the same note read the same.

// field is one front-matter entry. Value is a string, a bool, a number or a []string; empty
// values are left out.
type field struct {
	Key   string
	Value any
}

var (
	yamlISO      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$`)
	yamlPlain    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9 _./()'-]*$`)
	yamlReserved = regexp.MustCompile(`(?i)^(true|false|yes|no|on|off|null|y|n|~)$`)
	yamlKey      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
)

// yamlScalar writes a string bare when that's unambiguous, else double-quoted (JSON's string
// syntax is YAML's).
func yamlScalar(s string) string {
	if yamlISO.MatchString(s) {
		return s
	}
	if yamlPlain.MatchString(s) && !yamlReserved.MatchString(s) && s == strings.TrimSpace(s) {
		return s
	}
	quoted, _ := json.Marshal(s)
	return string(quoted)
}

// frontMatter renders the block, fields in order, first key wins; it ends with a blank line,
// ready for the body.
func frontMatter(fields []field) string {
	var b strings.Builder
	b.WriteString("---\n")
	seen := map[string]bool{}
	for _, f := range fields {
		if seen[f.Key] {
			continue
		}
		key := f.Key
		if !yamlKey.MatchString(key) {
			quoted, _ := json.Marshal(key)
			key = string(quoted)
		}
		switch v := f.Value.(type) {
		case nil:
			continue
		case string:
			if v == "" {
				continue
			}
			b.WriteString(key + ": " + yamlScalar(v) + "\n")
		case bool:
			b.WriteString(key + ": " + strconv.FormatBool(v) + "\n")
		case float64:
			b.WriteString(key + ": " + strconv.FormatFloat(v, 'f', -1, 64) + "\n")
		case []string:
			if len(v) == 0 {
				continue
			}
			b.WriteString(key + ":\n")
			for _, item := range v {
				b.WriteString("  - " + yamlScalar(item) + "\n")
			}
		default:
			continue
		}
		seen[f.Key] = true
	}
	b.WriteString("---\n\n")
	return b.String()
}

// yamlDate writes an instant for front matter. The app keeps a date with no time as local
// midnight, which exports as the plain date it means; anything else keeps its full instant.
func yamlDate(t *time.Time, loc *time.Location) string {
	if t == nil || t.IsZero() {
		return ""
	}
	local := t.In(loc)
	if local.Hour() == 0 && local.Minute() == 0 && local.Second() == 0 {
		return local.Format("2006-01-02")
	}
	return yamlInstant(*t)
}

// yamlInstant is a full UTC timestamp, to the millisecond like the app's own.
func yamlInstant(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
