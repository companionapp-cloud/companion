//go:build !js

package oauth

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// Loopback receives the authorization redirect on desktop (RFC 8252 §7.3): a one-shot HTTP
// listener on 127.0.0.1 with a port picked by the OS. It binds the loopback interface only, so
// nothing off this machine can reach it, and it answers a single matching request and closes.
type Loopback struct {
	ln     net.Listener
	srv    *http.Server
	result chan callback
}

type callback struct {
	state, code, err string
}

// ListenLoopback opens the listener. Call RedirectURI for the value to register with the flow.
func ListenLoopback() (*Loopback, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("oauth: open loopback listener: %w", err)
	}
	l := &Loopback{ln: ln, result: make(chan callback, 1)}
	mux := http.NewServeMux()
	mux.HandleFunc("/", l.handle)
	l.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = l.srv.Serve(ln) }()
	return l, nil
}

// RedirectURI is http://127.0.0.1:<port>, which Google accepts for desktop clients on any port.
func (l *Loopback) RedirectURI() string {
	return fmt.Sprintf("http://127.0.0.1:%d", l.ln.Addr().(*net.TCPAddr).Port)
}

func (l *Loopback) handle(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if r.URL.Path != "/" || (q.Get("code") == "" && q.Get("error") == "") {
		http.NotFound(w, r) // favicon and friends
		return
	}
	select {
	case l.result <- callback{state: q.Get("state"), code: q.Get("code"), err: q.Get("error")}:
	default: // already answered; ignore a replay
	}
	// A fixed page: nothing from the request is reflected into it.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(donePage))
}

// Wait blocks until the browser comes back, the context ends, or the user declines.
func (l *Loopback) Wait(ctx context.Context) (state, code string, err error) {
	select {
	case cb := <-l.result:
		if cb.err != "" {
			if cb.err == "access_denied" {
				return "", "", errors.New("sign-in was cancelled")
			}
			return "", "", fmt.Errorf("oauth: the provider reported %q", cb.err)
		}
		return cb.state, cb.code, nil
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
}

// Close stops the listener. Safe to call more than once.
func (l *Loopback) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = l.srv.Shutdown(ctx)
}

const donePage = `<!doctype html><meta charset="utf-8"><title>Companion</title>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#222">
<div style="text-align:center"><h2 style="margin:0 0 8px">You can close this tab</h2>
<p style="margin:0;color:#666">Head back to Companion to finish.</p></div>`
