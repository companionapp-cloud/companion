//go:build js && wasm

package store

import (
	"database/sql"
	"fmt"
	"syscall/js"
)

// NewJSDriver adapts a JS-provided SQLite implementation (wa-sqlite over OPFS in the
// browser, PLAN §3.2) to the Driver interface. The JS object must expose three
// async methods returning Promises:
//
//	exec(sql: string, params: any[])  -> { rowsAffected: number }
//	query(sql: string, params: any[]) -> { rows: any[][] }   // NULL encoded as JS null
//	close()                           -> void
//
// params/values cross as JS strings, numbers, null, or Uint8Array. Every call is
// awaited from Go, which is why the wasm shell runs Invoke on a goroutine and returns
// a Promise to JS (see core/cmd/wasm): a Go goroutine blocked on a JS Promise yields
// to the browser event loop instead of deadlocking it.
func NewJSDriver(sqlite js.Value) Driver { return &wasmDriver{js: sqlite} }

type wasmDriver struct{ js js.Value }

func (d *wasmDriver) Exec(query string, args ...any) (Result, error) {
	res, err := await(d.js.Call("exec", query, argsToJS(args)))
	if err != nil {
		return nil, fmt.Errorf("js exec: %w", err)
	}
	var affected int64
	if ra := res.Get("rowsAffected"); ra.Type() == js.TypeNumber {
		affected = int64(ra.Float())
	}
	return wasmResult{affected: affected}, nil
}

func (d *wasmDriver) Query(query string, args ...any) (Rows, error) {
	res, err := await(d.js.Call("query", query, argsToJS(args)))
	if err != nil {
		return nil, fmt.Errorf("js query: %w", err)
	}
	rowsJS := res.Get("rows")
	n := rowsJS.Length()
	data := make([][]js.Value, n)
	for i := 0; i < n; i++ {
		rowJS := rowsJS.Index(i)
		m := rowJS.Length()
		row := make([]js.Value, m)
		for j := 0; j < m; j++ {
			row[j] = rowJS.Index(j)
		}
		data[i] = row
	}
	return &wasmRows{data: data, idx: -1}, nil
}

func (d *wasmDriver) Close() error {
	_, err := await(d.js.Call("close"))
	return err
}

type wasmResult struct{ affected int64 }

func (r wasmResult) RowsAffected() (int64, error) { return r.affected, nil }

type wasmRows struct {
	data [][]js.Value
	idx  int
}

func (r *wasmRows) Next() bool {
	r.idx++
	return r.idx < len(r.data)
}

func (r *wasmRows) Err() error { return nil }

func (r *wasmRows) Close() error { return nil }

func (r *wasmRows) Scan(dest ...any) error {
	if r.idx < 0 || r.idx >= len(r.data) {
		return fmt.Errorf("scan: no current row")
	}
	row := r.data[r.idx]
	if len(dest) != len(row) {
		return fmt.Errorf("scan: %d targets for %d columns", len(dest), len(row))
	}
	for i, d := range dest {
		if err := assign(d, row[i]); err != nil {
			return fmt.Errorf("scan column %d: %w", i, err)
		}
	}
	return nil
}

// assign copies a single JS column value into a supported Go pointer target.
func assign(dest any, v js.Value) error {
	isNull := v.IsNull() || v.IsUndefined()
	switch p := dest.(type) {
	case *string:
		if isNull {
			*p = ""
		} else {
			*p = v.String()
		}
	case *int:
		if isNull {
			*p = 0
		} else {
			*p = int(v.Float())
		}
	case *int64:
		if isNull {
			*p = 0
		} else {
			*p = int64(v.Float())
		}
	case *float64:
		if isNull {
			*p = 0
		} else {
			*p = v.Float()
		}
	case *sql.NullString:
		if isNull {
			*p = sql.NullString{}
		} else {
			*p = sql.NullString{String: v.String(), Valid: true}
		}
	default:
		return fmt.Errorf("unsupported scan target %T", dest)
	}
	return nil
}

// argsToJS builds a JS array of bind parameters from Go values, dereferencing
// pointers (nil -> JS null) so the same repo code (which passes *string for nullable
// columns) works on both backends.
func argsToJS(args []any) js.Value {
	arr := js.Global().Get("Array").New(len(args))
	for i, a := range args {
		arr.SetIndex(i, jsParam(a))
	}
	return arr
}

func jsParam(a any) any {
	switch v := a.(type) {
	case nil:
		return js.Null()
	case *string:
		if v == nil {
			return js.Null()
		}
		return *v
	case string:
		return v
	case int:
		return v
	case int64:
		return float64(v)
	case float64:
		return v
	case bool:
		return v
	case []byte:
		u8 := js.Global().Get("Uint8Array").New(len(v))
		js.CopyBytesToJS(u8, v)
		return u8
	default:
		return js.ValueOf(fmt.Sprintf("%v", v))
	}
}

// await blocks the current goroutine until the JS Promise settles. A non-thenable is
// returned as-is. Errors are surfaced with the rejection's message/string.
func await(p js.Value) (js.Value, error) {
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
