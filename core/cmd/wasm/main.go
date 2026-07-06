//go:build js && wasm

// Command wasm is the browser build of the core (GOOS=js GOARCH=wasm, PLAN §3.2).
// It exposes the universal bridge (string method + JSON in/out + event stream) to
// JavaScript and receives its SQLite implementation (wa-sqlite/OPFS) from JS via the
// store.Driver seam.
//
// JS contract (see packages/core-bridge):
//
//	globalThis.__companionInit({ sqlite, onEvent }) -> Promise<{ invoke, close }>
//	    sqlite  : object with async exec/query/close (see store.NewJSDriver)
//	    onEvent : (name: string, payloadJson: string) => void
//	    invoke  : (method: string, payloadJson: string) => Promise<string>  // JSON result
//	    close   : () => void
package main

import (
	"syscall/js"

	"companion/core/bridge"
	"companion/core/domain"
	"companion/core/store"
)

func main() {
	js.Global().Set("__companionInit", js.FuncOf(initCore))
	// Keep the Go runtime alive so the exported callbacks stay valid.
	select {}
}

// initCore wires the store over the JS-provided SQLite driver and returns a Promise
// resolving to the invoke/close handle. The work runs on a goroutine because opening
// the store awaits JS Promises (migrations), which must not block the JS call stack.
func initCore(_ js.Value, args []js.Value) any {
	opts := args[0]
	sqlite := opts.Get("sqlite")
	onEvent := opts.Get("onEvent")
	secrets := opts.Get("secrets")

	return newPromise(func(resolve, reject func(any)) {
		go func() {
			st, err := store.New(store.NewJSDriver(sqlite), domain.SystemClock{})
			if err != nil {
				reject(err.Error())
				return
			}
			core := bridge.New(st)
			core.SetEventHandler(jsEventHandler{onEvent: onEvent})
			// LLM API keys (PLAN §6.8): the browser has no OS keychain, so the shell injects
			// a localStorage-backed secrets object. Absent it, only local (no-key) providers work.
			if secrets.Type() == js.TypeObject {
				core.SetSecretStore(jsSecretStore{secrets: secrets})
			}

			handle := js.Global().Get("Object").New()
			handle.Set("invoke", js.FuncOf(func(_ js.Value, a []js.Value) any {
				method := a[0].String()
				payload := []byte(a[1].String())
				return newPromise(func(resolve, reject func(any)) {
					go func() {
						out, err := core.Invoke(method, payload)
						if err != nil {
							reject(err.Error())
							return
						}
						resolve(string(out))
					}()
				})
			}))
			handle.Set("close", js.FuncOf(func(_ js.Value, _ []js.Value) any {
				st.Close()
				return nil
			}))
			resolve(handle)
		}()
	})
}

// jsSecretStore bridges bridge.SecretStore to a JS object with synchronous get/set/delete
// (localStorage-backed on web). js.Value calls from the invoke goroutine are safe.
type jsSecretStore struct{ secrets js.Value }

func (s jsSecretStore) GetSecret(ref string) (string, error) {
	v := s.secrets.Call("get", ref)
	if v.Type() != js.TypeString {
		return "", nil
	}
	return v.String(), nil
}

func (s jsSecretStore) SetSecret(ref, value string) error {
	s.secrets.Call("set", ref, value)
	return nil
}

func (s jsSecretStore) DeleteSecret(ref string) error {
	s.secrets.Call("delete", ref)
	return nil
}

// jsEventHandler forwards core events to the JS onEvent callback.
type jsEventHandler struct{ onEvent js.Value }

func (h jsEventHandler) OnEvent(name string, payload []byte) {
	if h.onEvent.Type() != js.TypeFunction {
		return
	}
	h.onEvent.Invoke(name, string(payload))
}

// newPromise constructs a JS Promise whose executor is driven by Go. The executor
// runs synchronously during construction, so the FuncOf can be released immediately;
// resolve/reject remain valid for later calls from goroutines.
func newPromise(fn func(resolve, reject func(any))) js.Value {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		fn(
			func(v any) { resolve.Invoke(v) },
			func(v any) { reject.Invoke(v) },
		)
		return nil
	})
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}
