package sync

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"companion/core/sync/protocol"
)

// HTTPTransport is the net/http implementation of Transport used by native clients
// (desktop, mobile). The wasm client injects a fetch-backed transport with the same
// shape.
type HTTPTransport struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// NewHTTPTransport builds a transport for a server base URL and bearer token.
func NewHTTPTransport(baseURL, token string) *HTTPTransport {
	return &HTTPTransport{BaseURL: baseURL, Token: token, Client: http.DefaultClient}
}

// Push sends dirty rows to POST /v1/sync/push.
func (t *HTTPTransport) Push(changes []protocol.PushChange) (*protocol.PushResponse, error) {
	var out protocol.PushResponse
	if err := t.do(http.MethodPost, "/v1/sync/push", protocol.PushRequest{Changes: changes}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Pull fetches changes after cursor from GET /v1/sync/pull.
func (t *HTTPTransport) Pull(cursor int64, limit int) (*protocol.PullResponse, error) {
	var out protocol.PullResponse
	path := fmt.Sprintf("/v1/sync/pull?cursor=%d&limit=%d", cursor, limit)
	if err := t.do(http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RefreshCalendars asks the server to re-fetch this account's ICS feeds now (PLAN §6.7),
// so a following Pull sees the freshly-cloned events. Server-owned; there is nothing to
// send but the bearer token.
func (t *HTTPTransport) RefreshCalendars() error {
	var out map[string]int
	return t.do(http.MethodPost, "/v1/calendar/refresh", struct{}{}, &out)
}

func (t *HTTPTransport) do(method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, t.BaseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	client := t.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("sync %s: %s: %s", path, resp.Status, msg)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
