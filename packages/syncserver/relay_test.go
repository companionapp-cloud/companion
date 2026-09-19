package syncserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// authedReq builds a request with the bearer token and device header the relay expects.
func authedReq(t *testing.T, method, url, token, device string, body any) *http.Request {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if device != "" {
		req.Header.Set(deviceHeader, device)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func registerDevice(t *testing.T, base, token, id, name string, canHost bool) {
	t.Helper()
	res, err := http.DefaultClient.Do(authedReq(t, http.MethodPost, base+"/v1/devices", token, id, map[string]any{
		"id": id, "name": name, "platform": "test", "canHost": canHost,
	}))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("register device %s: %d", id, res.StatusCode)
	}
}

// sseFrames reads data frames off an SSE body into ch until the body ends.
func sseFrames(body *bufio.Scanner, ch chan<- relayFrame) {
	for body.Scan() {
		line := body.Text()
		if strings.HasPrefix(line, "data:") {
			var f relayFrame
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &f) == nil {
				ch <- f
			}
		}
	}
	close(ch)
}

func TestDevicesRegisterListAndOwnership(t *testing.T) {
	ts := newServer(t)
	tokA := register(t, ts.URL, "a@x.co", "password")
	tokB := register(t, ts.URL, "b@x.co", "password")
	registerDevice(t, ts.URL, tokA, "mac-1", "enc$v1$name", true)
	registerDevice(t, ts.URL, tokA, "phone-1", "Phone", false)

	res, err := http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/devices", tokA, "", nil))
	if err != nil {
		t.Fatal(err)
	}
	var list []deviceWire
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	if len(list) != 2 {
		t.Fatalf("devices = %+v", list)
	}
	for _, d := range list {
		if d.Online {
			t.Errorf("no inbox is open, %s should be offline", d.ID)
		}
		if d.ID == "mac-1" && (!d.CanHost || d.Name != "enc$v1$name") {
			t.Errorf("mac-1 = %+v", d)
		}
	}

	// Another account may not claim A's device id, and sees none of A's devices.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/devices", tokB, "mac-1", map[string]any{"id": "mac-1", "platform": "test"}))
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Errorf("cross-account claim status = %d, want 409", res.StatusCode)
	}
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/devices", tokB, "", nil))
	var other []deviceWire
	json.NewDecoder(res.Body).Decode(&other)
	res.Body.Close()
	if len(other) != 0 {
		t.Errorf("B sees A's devices: %+v", other)
	}
}

func TestRelayEndToEnd(t *testing.T) {
	ts := newServer(t)
	tok := register(t, ts.URL, "r@x.co", "password")
	tokOther := register(t, ts.URL, "o@x.co", "password")
	registerDevice(t, ts.URL, tok, "host", "Host", true)
	registerDevice(t, ts.URL, tok, "caller", "Caller", false)

	// No inbox yet: a request is refused as host_offline.
	res, _ := http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/request", tok, "caller", map[string]any{
		"toDeviceId": "host", "method": "chats.send", "payload": "sealed",
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("request without host status = %d, want 409", res.StatusCode)
	}

	// Host opens its inbox.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inboxReq := authedReq(t, http.MethodGet, ts.URL+"/v1/relay/inbox", tok, "host", nil).WithContext(ctx)
	inboxRes, err := http.DefaultClient.Do(inboxReq)
	if err != nil {
		t.Fatal(err)
	}
	defer inboxRes.Body.Close()
	if inboxRes.StatusCode != http.StatusOK {
		t.Fatalf("inbox status = %d", inboxRes.StatusCode)
	}
	inbox := make(chan relayFrame, 8)
	go sseFrames(bufio.NewScanner(inboxRes.Body), inbox)
	time.Sleep(50 * time.Millisecond)

	// Presence flips to online.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/devices", tok, "", nil))
	var list []deviceWire
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	online := false
	for _, d := range list {
		if d.ID == "host" && d.Online {
			online = true
		}
	}
	if !online {
		t.Fatalf("host should be online with an open inbox: %+v", list)
	}

	// A different account cannot target this host.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/request", tokOther, "x", map[string]any{
		"toDeviceId": "host", "method": "chats.send", "payload": "p",
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("cross-account request status = %d, want 403", res.StatusCode)
	}

	// Caller posts a request; host receives it on the inbox.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/request", tok, "caller", map[string]any{
		"toDeviceId": "host", "method": "chats.send", "payload": "sealed-request",
	}))
	var ack struct {
		RequestID string `json:"requestId"`
	}
	json.NewDecoder(res.Body).Decode(&ack)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || ack.RequestID == "" {
		t.Fatalf("request status = %d ack=%+v", res.StatusCode, ack)
	}
	var got relayFrame
	select {
	case got = <-inbox:
	case <-time.After(3 * time.Second):
		t.Fatal("host never received the request frame")
	}
	if got.Type != relayFrameRequest || got.RequestID != ack.RequestID || got.Method != "chats.send" || got.Payload != "sealed-request" || got.FromDeviceID != "caller" {
		t.Fatalf("frame = %+v", got)
	}

	// Caller opens the response stream; host posts delta + done frames; only the host may post.
	respReq := authedReq(t, http.MethodGet, ts.URL+"/v1/relay/response/"+ack.RequestID, tok, "caller", nil).WithContext(ctx)
	respRes, err := http.DefaultClient.Do(respReq)
	if err != nil {
		t.Fatal(err)
	}
	defer respRes.Body.Close()
	frames := make(chan relayFrame, 8)
	go sseFrames(bufio.NewScanner(respRes.Body), frames)
	time.Sleep(50 * time.Millisecond)

	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+ack.RequestID, tok, "caller", map[string]any{
		"frames": []map[string]any{{"type": "delta", "payload": "x"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("non-host response status = %d, want 403", res.StatusCode)
	}
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+ack.RequestID, tok, "host", map[string]any{
		"frames": []map[string]any{{"type": "delta", "payload": "d1"}, {"type": "tool", "payload": "t1"}, {"type": "done"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host response status = %d", res.StatusCode)
	}
	var types []string
	deadline := time.After(3 * time.Second)
	for len(types) < 3 {
		select {
		case f, ok := <-frames:
			if !ok {
				deadline = time.After(0)
				break
			}
			types = append(types, f.Type+":"+f.Payload)
		case <-deadline:
			t.Fatalf("frames so far: %v", types)
		}
	}
	if strings.Join(types, ",") != "delta:d1,tool:t1,done:" {
		t.Errorf("frames = %v", types)
	}
	// The request is finished: a late post is rejected and the row is done.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+ack.RequestID, tok, "host", map[string]any{
		"frames": []map[string]any{{"type": "delta", "payload": "late"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("late post status = %d, want 404", res.StatusCode)
	}
	_, api := ts, (*Server)(nil)
	_ = api

	// Cancel from the caller reaches the host inbox.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/request", tok, "caller", map[string]any{
		"toDeviceId": "host", "method": "chats.send", "payload": "second",
	}))
	json.NewDecoder(res.Body).Decode(&ack)
	res.Body.Close()
	<-inbox // the request frame
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/cancel/"+ack.RequestID, tok, "caller", map[string]any{}))
	res.Body.Close()
	select {
	case f := <-inbox:
		if f.Type != relayFrameCancel || f.RequestID != ack.RequestID {
			t.Errorf("cancel frame = %+v", f)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("host never received the cancel frame")
	}

	// Closing the inbox takes the host offline.
	cancel()
	time.Sleep(50 * time.Millisecond)
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/devices", tok, "", nil))
	list = nil
	json.NewDecoder(res.Body).Decode(&list)
	res.Body.Close()
	for _, d := range list {
		if d.ID == "host" && d.Online {
			t.Error("host should be offline after its inbox closed")
		}
	}
}

// openInbox connects a host's relay inbox and returns its frames.
func openInbox(t *testing.T, ctx context.Context, base, token, device string) <-chan relayFrame {
	t.Helper()
	res, err := http.DefaultClient.Do(authedReq(t, http.MethodGet, base+"/v1/relay/inbox", token, device, nil).WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox status = %d", res.StatusCode)
	}
	frames := make(chan relayFrame, 8)
	go sseFrames(bufio.NewScanner(res.Body), frames)
	time.Sleep(50 * time.Millisecond)
	return frames
}

// postRelayRequest sends a caller's request, waits for the host to receive it, and returns its id.
func postRelayRequest(t *testing.T, base, token string, inbox <-chan relayFrame) string {
	t.Helper()
	res, err := http.DefaultClient.Do(authedReq(t, http.MethodPost, base+"/v1/relay/request", token, "caller", map[string]any{
		"toDeviceId": "host", "method": "agents.models", "payload": "sealed",
	}))
	if err != nil {
		t.Fatal(err)
	}
	var ack struct {
		RequestID string `json:"requestId"`
	}
	json.NewDecoder(res.Body).Decode(&ack)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || ack.RequestID == "" {
		t.Fatalf("request status = %d ack=%+v", res.StatusCode, ack)
	}
	select {
	case <-inbox:
	case <-time.After(3 * time.Second):
		t.Fatal("host never received the request frame")
	}
	return ack.RequestID
}

// A host may answer before the caller has opened its response stream: agents.models on a CLI
// agent is a canned list, so the host's POST routinely beats the caller's GET. The answer waits
// for the caller instead of vanishing with the request (which the caller saw as a 404).
func TestRelayHoldsAnAnswerThatBeatsTheCallersStream(t *testing.T) {
	ts := newServer(t)
	tok := register(t, ts.URL, "fast@x.co", "password")
	registerDevice(t, ts.URL, tok, "host", "Host", true)
	registerDevice(t, ts.URL, tok, "caller", "Caller", false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inbox := openInbox(t, ctx, ts.URL, tok, "host")
	id := postRelayRequest(t, ts.URL, tok, inbox)

	// The host answers before the caller asks for the response.
	res, _ := http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+id, tok, "host", map[string]any{
		"frames": []map[string]any{{"type": "done", "payload": "models"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host response status = %d", res.StatusCode)
	}
	// The request is finished: the host can't add to it and the caller can't cancel it.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+id, tok, "host", map[string]any{
		"frames": []map[string]any{{"type": "delta", "payload": "late"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("late post status = %d, want 404", res.StatusCode)
	}

	respRes, err := http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/relay/response/"+id, tok, "caller", nil).WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer respRes.Body.Close()
	if respRes.StatusCode != http.StatusOK {
		t.Fatalf("response stream status = %d, want 200", respRes.StatusCode)
	}
	frames := make(chan relayFrame, 8)
	go sseFrames(bufio.NewScanner(respRes.Body), frames)
	select {
	case f := <-frames:
		if f.Type != relayFrameDone || f.Payload != "models" {
			t.Fatalf("frame = %+v, want the host's done frame", f)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("caller never got the host's answer")
	}

	// Collected: a second stream for the same request finds nothing.
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/relay/response/"+id, tok, "caller", nil))
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("second stream status = %d, want 404", res.StatusCode)
	}
}

// A request whose caller never opens its response stream is forgotten after a while rather
// than held forever.
func TestRelayForgetsAnUnclaimedRequest(t *testing.T) {
	defer func(d time.Duration) { relayUnclaimedTTL = d }(relayUnclaimedTTL)
	relayUnclaimedTTL = 100 * time.Millisecond

	ts := newServer(t)
	tok := register(t, ts.URL, "gone@x.co", "password")
	registerDevice(t, ts.URL, tok, "host", "Host", true)
	registerDevice(t, ts.URL, tok, "caller", "Caller", false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	inbox := openInbox(t, ctx, ts.URL, tok, "host")
	id := postRelayRequest(t, ts.URL, tok, inbox)

	time.Sleep(300 * time.Millisecond)
	res, _ := http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/relay/response/"+id, tok, "host", map[string]any{
		"frames": []map[string]any{{"type": "done"}},
	}))
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("host post after expiry status = %d, want 404", res.StatusCode)
	}
	res, _ = http.DefaultClient.Do(authedReq(t, http.MethodGet, ts.URL+"/v1/relay/response/"+id, tok, "caller", nil))
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("stream after expiry status = %d, want 404", res.StatusCode)
	}
}
