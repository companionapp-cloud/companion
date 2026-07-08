//go:build js && wasm

package blob

import (
	"fmt"
	"syscall/js"
)

// NewJSStore adapts a JS-provided blob store (OPFS + fetch in the browser, PLAN §6.9) to the
// Store port. Bytes never enter wasm memory: every method delegates to the JS object, which
// owns OPFS storage and the fetch transfer. The JS object must expose four async methods
// returning Promises:
//
//	has(sha256: string)                  -> boolean
//	upload(sha256, url, token: string)   -> void
//	download(sha256, url, token: string) -> void
//	delete(sha256: string)               -> void
//
// Every call is awaited from Go; the core dispatches Invoke/sync on goroutines, so a
// goroutine blocked on a JS Promise yields to the browser event loop rather than deadlocking
// it — the same discipline the wa-sqlite driver relies on (store.NewJSDriver).
func NewJSStore(blobs js.Value) Store { return &jsStore{js: blobs} }

type jsStore struct{ js js.Value }

func (s *jsStore) Has(sha string) (bool, error) {
	v, err := awaitJS(s.js.Call("has", sha))
	if err != nil {
		return false, fmt.Errorf("js blob has: %w", err)
	}
	return v.Truthy(), nil
}

func (s *jsStore) Upload(sha, url, token string) error {
	if _, err := awaitJS(s.js.Call("upload", sha, url, token)); err != nil {
		return fmt.Errorf("js blob upload: %w", err)
	}
	return nil
}

func (s *jsStore) Download(sha, url, token string) error {
	if _, err := awaitJS(s.js.Call("download", sha, url, token)); err != nil {
		return fmt.Errorf("js blob download: %w", err)
	}
	return nil
}

func (s *jsStore) Delete(sha string) error {
	if _, err := awaitJS(s.js.Call("delete", sha)); err != nil {
		return fmt.Errorf("js blob delete: %w", err)
	}
	return nil
}

// awaitJS blocks the current goroutine until a JS Promise settles (mirrors the store
// driver's await). A non-thenable is returned as-is.
func awaitJS(p js.Value) (js.Value, error) {
	if p.Type() != js.TypeObject || p.Get("then").Type() != js.TypeFunction {
		return p, nil
	}
	resCh := make(chan js.Value, 1)
	errCh := make(chan js.Value, 1)
	then := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resCh <- firstArg(args)
		return nil
	})
	defer then.Release()
	catch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		errCh <- firstArg(args)
		return nil
	})
	defer catch.Release()
	p.Call("then", then).Call("catch", catch)
	select {
	case v := <-resCh:
		return v, nil
	case e := <-errCh:
		return js.Undefined(), fmt.Errorf("%s", jsErrString(e))
	}
}

func firstArg(args []js.Value) js.Value {
	if len(args) > 0 {
		return args[0]
	}
	return js.Undefined()
}

func jsErrString(e js.Value) string {
	if e.Type() == js.TypeObject {
		if msg := e.Get("message"); msg.Type() == js.TypeString {
			return msg.String()
		}
	}
	return e.Call("toString").String()
}

var _ Store = (*jsStore)(nil)
