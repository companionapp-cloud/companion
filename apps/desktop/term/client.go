// Package term holds Companion's terminal programs: `companion tui` and `companion new`. They
// run as their own processes and reach the desktop app through the terminal-agents server
// (core/bridge/terminal.go), whose /invoke route allows reads, and note and task writes when
// the user turned write tools on.
package term

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"companion/core/mcp"
)

// Client calls the running app. Launch, when set, starts the app the first time it can't be
// reached; the client then waits for it to publish its endpoint.
type Client struct {
	ConfigPath string
	Launch     func() error

	launchOnce sync.Once
}

var errDown = errors.New(mcp.MsgAppDown)

var httpClient = &http.Client{Timeout: 60 * time.Second}

func (c *Client) endpoint() (base, token string, err error) {
	cfg, err := mcp.ReadTerminalConfig(c.ConfigPath)
	if err != nil {
		return "", "", err
	}
	if !cfg.Enabled {
		return "", "", errors.New("Companion's terminal access is switched off. Turn it on in Companion › Settings › AI › Terminal agents.")
	}
	return strings.TrimSuffix(cfg.URL, "/mcp"), cfg.Token, nil
}

// Invoke runs one core method and decodes its result into out (when non-nil).
func (c *Client) Invoke(method string, payload, out any) error {
	body, err := json.Marshal(map[string]any{"method": method, "payload": payload})
	if err != nil {
		return err
	}
	data, err := c.post(body)
	if errors.Is(err, errDown) && c.Launch != nil {
		c.launchOnce.Do(func() { _ = c.Launch() })
		for deadline := time.Now().Add(30 * time.Second); errors.Is(err, errDown) && time.Now().Before(deadline); {
			time.Sleep(300 * time.Millisecond)
			data, err = c.post(body)
		}
	}
	if err != nil || out == nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (c *Client) post(body []byte) ([]byte, error) {
	base, token, err := c.endpoint()
	if err != nil {
		return nil, err
	}
	if base == "" {
		return nil, errDown
	}
	req, err := http.NewRequest(http.MethodPost, base+"/invoke", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, errDown
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return data, nil
	case http.StatusUnauthorized:
		// A token from an app that has since restarted: wait for the new one.
		return nil, errDown
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil && e.Error != "" {
		return nil, errors.New(e.Error)
	}
	return nil, fmt.Errorf("companion: %s", resp.Status)
}

// Events streams the names of the app's change events until ctx ends, reconnecting when the
// app restarts. A slow reader misses events rather than holding up the stream.
func (c *Client) Events(ctx context.Context) <-chan string {
	ch := make(chan string, 8)
	go func() {
		defer close(ch)
		for ctx.Err() == nil {
			c.stream(ctx, ch)
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}()
	return ch
}

func (c *Client) stream(ctx context.Context, ch chan<- string) {
	base, token, err := c.endpoint()
	if err != nil || base == "" {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/events", nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if name, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
			select {
			case ch <- name:
			default:
			}
		}
	}
}

// ParseDate reads a natural-language date ("tomorrow 5pm", "fri") the way Companion's own
// fields do.
func ParseDate(c *Client, text string) (time.Time, error) {
	var res *struct {
		At time.Time `json:"at"`
	}
	if err := c.Invoke("dates.parse", map[string]string{"text": text}, &res); err != nil {
		return time.Time{}, err
	}
	if res == nil {
		return time.Time{}, fmt.Errorf("couldn't read %q as a date. Try something like \"tomorrow 5pm\" or \"fri\".", text)
	}
	return res.At, nil
}
