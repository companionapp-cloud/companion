package term

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
)

const newUsage = `usage:
  companion new note TITLE [--body TEXT] [--json]
  companion new task TITLE [--due WHEN] [--start WHEN] [--body TEXT] [--json]

WHEN is plain words, such as "tomorrow 5pm" or "fri". --title TEXT can stand in for TITLE.`

// RunNew is `companion new note|task`: creates one note or task and reports it.
func RunNew(c *Client, args []string, out io.Writer) error {
	if len(args) == 0 || (args[0] != "note" && args[0] != "task") {
		return errors.New(newUsage)
	}
	kind := args[0]
	fs := flag.NewFlagSet("companion new "+kind, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	titleFlag := fs.String("title", "", "")
	body := fs.String("body", "", "")
	due := fs.String("due", "", "")
	start := fs.String("start", "", "")
	asJSON := fs.Bool("json", false, "")
	words, err := parseInterspersed(fs, args[1:])
	if err != nil {
		return fmt.Errorf("%v\n%s", err, newUsage)
	}
	title := strings.TrimSpace(*titleFlag)
	if title == "" {
		title = strings.TrimSpace(strings.Join(words, " "))
	}
	if title == "" {
		return errors.New("a title is required\n" + newUsage)
	}

	var created struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	switch kind {
	case "note":
		if *due != "" || *start != "" {
			return errors.New("--due and --start are for tasks")
		}
		err = c.Invoke("notes.create", map[string]any{"title": title, "contentMd": *body}, &created)
	case "task":
		payload := map[string]any{"title": title, "notesMd": *body}
		for key, text := range map[string]string{"dueAt": *due, "startAt": *start} {
			if strings.TrimSpace(text) == "" {
				continue
			}
			at, err := ParseDate(c, text)
			if err != nil {
				return err
			}
			payload[key] = at
		}
		err = c.Invoke("tasks.create", payload, &created)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(out).Encode(map[string]string{"kind": kind, "id": created.ID, "title": created.Title})
	}
	_, err = fmt.Fprintf(out, "Created %s “%s”\n", kind, created.Title)
	return err
}

// parseInterspersed lets flags come before, between or after the title's words.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var words []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return words, nil
		}
		words = append(words, args[0])
		args = args[1:]
	}
}
