//go:build !js

package sqlitefile

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// These tests write databases with real SQLite (modernc) and check the reader returns exactly
// what SQLite's own SELECT does.

func openSQL(t *testing.T, path string, pragmas ...string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	return db
}

func exec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// selectAll reads a table through SQLite, normalized to the reader's value types.
func selectAll(t *testing.T, db *sql.DB, table string, cols []string) map[int64][]any {
	t.Helper()
	rows, err := db.Query(fmt.Sprintf(`SELECT rowid, %s FROM %q`, quoteCols(cols), table))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64][]any{}
	for rows.Next() {
		dest := make([]any, len(cols)+1)
		ptrs := make([]any, len(dest))
		for i := range dest {
			ptrs[i] = &dest[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		out[dest[0].(int64)] = dest[1:]
	}
	return out
}

func quoteCols(cols []string) string {
	q := make([]string, len(cols))
	for i, c := range cols {
		q[i] = `"` + strings.ReplaceAll(c, `"`, `""`) + `"`
	}
	return strings.Join(q, ", ")
}

// readAll reads a table through the reader.
func readAll(t *testing.T, db *DB, table string, cols []string) map[int64][]any {
	t.Helper()
	out := map[int64][]any{}
	if err := db.Scan(table, func(r Row) error {
		vals := make([]any, len(cols))
		for i, c := range cols {
			vals[i] = r.Value(c)
		}
		out[r.RowID] = vals
		return nil
	}); err != nil {
		t.Fatalf("scan %s: %v", table, err)
	}
	return out
}

func openFile(t *testing.T, path string, withWAL bool) *DB {
	t.Helper()
	main, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var wal []byte
	if withWAL {
		wal, _ = os.ReadFile(path + "-wal")
	}
	db, err := OpenBytes(main, wal)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return db
}

func sameRows(t *testing.T, got, want map[int64][]any) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d", len(got), len(want))
	}
	for id, w := range want {
		g, ok := got[id]
		if !ok {
			t.Fatalf("rowid %d missing", id)
		}
		if !reflect.DeepEqual(g, w) {
			t.Fatalf("rowid %d = %#v, want %#v", id, g, w)
		}
	}
}

func TestReadsEveryValueKindAndOverflow(t *testing.T) {
	for _, pageSize := range []int{512, 1024, 4096, 65536} {
		t.Run(fmt.Sprint(pageSize), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "db.sqlite")
			db := openSQL(t, path, fmt.Sprintf("PRAGMA page_size=%d", pageSize))
			exec(t, db, `CREATE TABLE 'kinds' ('id' TEXT PRIMARY KEY, "i" INTEGER, [r] REAL, `+"`t`"+` TEXT, b BLOB, "odd name" TEXT)`)
			ints := []int64{0, 1, -1, 127, -128, 255, 32767, -32768, 1 << 23, -(1 << 23), 1 << 31, -(1 << 31), 1 << 47, -(1 << 47), 1<<62 + 5, -(1 << 62)}
			for i, n := range ints {
				exec(t, db, `INSERT INTO kinds VALUES (?, ?, ?, ?, ?, ?)`, fmt.Sprint("k", i), n, float64(n)/3, fmt.Sprintf("row %d ✓ ünïcödé", i), []byte{byte(i), 0, 0xff}, nil)
			}
			// Payloads that overflow: long text and a long blob, both past several pages.
			long := strings.Repeat("the quick brown fox jumps over the lazy dog · ", 4000)
			blob := bytes.Repeat([]byte{1, 2, 3, 4, 5, 6, 7}, 30000)
			exec(t, db, `INSERT INTO kinds VALUES ('long', NULL, NULL, ?, ?, 'x')`, long, blob)
			// Enough rows for interior pages at every page size.
			for i := 0; i < 3000; i++ {
				exec(t, db, `INSERT INTO kinds (id, i, t) VALUES (?, ?, ?)`, fmt.Sprint("bulk", i), i, strings.Repeat("y", i%300))
			}

			cols := []string{"id", "i", "r", "t", "b", "odd name"}
			r := openFile(t, path, false)
			got := readAll(t, r, "kinds", cols)
			sameRows(t, got, selectAll(t, db, "kinds", cols))
			var longRow []any
			for _, v := range got {
				if v[0] == "long" {
					longRow = v
				}
			}
			if longRow == nil || longRow[3] != long || !bytes.Equal(longRow[4].([]byte), blob) {
				t.Fatal("overflowed payloads didn't round-trip")
			}
		})
	}
}

func TestRowidAliasDefaultsAndSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db := openSQL(t, path)
	exec(t, db, `CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
	exec(t, db, `CREATE TABLE pairs (a INTEGER, b TEXT, PRIMARY KEY (a))`)
	exec(t, db, `CREATE INDEX people_name ON people(name)`)
	exec(t, db, `CREATE VIEW v AS SELECT * FROM people`)
	exec(t, db, `INSERT INTO people (id, name) VALUES (7, 'Ada'), (42, 'Grace')`)
	exec(t, db, `INSERT INTO pairs VALUES (3, 'three')`)
	// Columns added after rows exist: old rows read the DEFAULT, as SQLite returns it.
	exec(t, db, `ALTER TABLE people ADD COLUMN visible INTEGER DEFAULT 1`)
	exec(t, db, `ALTER TABLE people ADD COLUMN note TEXT DEFAULT 'it''s new'`)
	exec(t, db, `ALTER TABLE people ADD COLUMN score REAL DEFAULT -2.5`)
	exec(t, db, `ALTER TABLE people ADD COLUMN plain TEXT`)
	exec(t, db, `INSERT INTO people (id, name, visible, note, score, plain) VALUES (43, 'Edsger', 0, 'x', 1.5, 'p')`)

	r := openFile(t, path, false)
	if names := tableNames(r); !reflect.DeepEqual(names, []string{"people", "pairs"}) {
		t.Fatalf("tables = %v, want only the two tables (no index/view)", names)
	}
	cols := []string{"id", "name", "visible", "note", "score", "plain"}
	sameRows(t, readAll(t, r, "people", cols), selectAll(t, db, "people", cols))
	sameRows(t, readAll(t, r, "pairs", []string{"a", "b"}), selectAll(t, db, "pairs", []string{"a", "b"}))
	if !r.Table("PEOPLE").HasColumn("Visible") || r.Table("people").HasColumn("missing") {
		t.Error("HasColumn should be case-insensitive and exact")
	}
	if err := r.Scan("nope", func(Row) error { return nil }); err == nil {
		t.Error("scanning a missing table should fail")
	}
}

// TestCommentsInSchema: SQLite keeps CREATE TABLE as written, comments and all — Things
// annotates its columns this way ("deadline" INTEGER, -- Renamed from "dueDate", REAL -> INTEGER).
// Comments hold commas, quotes and parentheses; "--" inside a string or a name isn't one.
func TestCommentsInSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db := openSQL(t, path)
	exec(t, db, `CREATE TABLE commented ( -- the table (for testing), with "quotes"
		"uuid" TEXT PRIMARY KEY,
		"startDate" INTEGER,   -- REAL -> INTEGER
		"deadline"  INTEGER,   -- Renamed from "dueDate", REAL -> INTEGER
		/* a block comment, spanning
		   lines, with (parens) and 'quotes' */ "area" TEXT,
		"a--b" TEXT DEFAULT 'x -- not a comment', -- it's a comment, don't split
		[c/*d*/] TEXT /* trailing */
	)`)
	exec(t, db, `INSERT INTO commented (uuid, startDate, deadline, area, "a--b", [c/*d*/]) VALUES ('u1', 1, 2, 'A', 'dash', 'bracket')`)
	exec(t, db, `INSERT INTO commented (uuid, area) VALUES ('u2', 'B')`)
	r := openFile(t, path, false)
	if cols := r.Table("commented").Columns; !reflect.DeepEqual(cols, []string{"uuid", "startDate", "deadline", "area", "a--b", "c/*d*/"}) {
		t.Fatalf("columns = %q", cols)
	}
	cols := []string{"uuid", "startDate", "deadline", "area", "a--b", "c/*d*/"}
	sameRows(t, readAll(t, r, "commented", cols), selectAll(t, db, "commented", cols))
}

// TestMisreadSchemaIsAnError: a row with more values than the parsed columns means the column
// list was misread; reading on would shift every value into the wrong column, so it's an error.
func TestMisreadSchemaIsAnError(t *testing.T) {
	tbl := parseCreateTable("t", "CREATE TABLE t (a TEXT)")
	record := []byte{3, 0x0f, 0x0f, 'x', 'y'} // header: 3 bytes, two 1-byte TEXT values
	if _, err := tbl.decode(1, record, 1); !errors.Is(err, ErrSchema) {
		t.Errorf("decode = %v, want ErrSchema", err)
	}
}

func TestUnsupportedTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db := openSQL(t, path)
	exec(t, db, `CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`)
	exec(t, db, `CREATE TABLE g (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL)`)
	exec(t, db, `CREATE TABLE ok (a TEXT)`)
	exec(t, db, `INSERT INTO ok VALUES ('fine')`)
	r := openFile(t, path, false)
	for _, name := range []string{"kv", "g"} {
		if err := r.Scan(name, func(Row) error { return nil }); err == nil {
			t.Errorf("scanning %s should be refused", name)
		}
	}
	// The odd tables don't stop the others from being read.
	sameRows(t, readAll(t, r, "ok", []string{"a"}), selectAll(t, db, "ok", []string{"a"}))
}

func TestUTF16(t *testing.T) {
	for _, enc := range []string{"UTF-16le", "UTF-16be"} {
		t.Run(enc, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "db.sqlite")
			db := openSQL(t, path, fmt.Sprintf("PRAGMA encoding = '%s'", enc))
			exec(t, db, `CREATE TABLE "täble" ("naïve" TEXT)`)
			exec(t, db, `INSERT INTO "täble" VALUES ('héllo 🌍'), (?)`, strings.Repeat("ü", 5000))
			r := openFile(t, path, false)
			sameRows(t, readAll(t, r, "täble", []string{"naïve"}), selectAll(t, db, "täble", []string{"naïve"}))
		})
	}
}

// TestWAL: the reader overlays the log's committed frames, ignores the log when asked, and
// ignores a torn tail — the unfinished transaction a crash (or a copy mid-write) leaves.
func TestWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db := openSQL(t, path, "PRAGMA page_size=1024", "PRAGMA journal_mode=WAL", "PRAGMA wal_autocheckpoint=0")
	exec(t, db, `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
	for i := 0; i < 200; i++ {
		exec(t, db, `INSERT INTO t VALUES (?, ?)`, i, fmt.Sprint("base ", i))
	}
	exec(t, db, `PRAGMA wal_checkpoint(TRUNCATE)`) // everything so far is in the main file
	base := selectAll(t, db, "t", []string{"v"})

	// Committed changes that live only in the WAL: updates, deletes, inserts that split pages,
	// and a new table.
	exec(t, db, `UPDATE t SET v = 'changed' WHERE id % 7 = 0`)
	exec(t, db, `DELETE FROM t WHERE id % 11 = 0`)
	for i := 200; i < 900; i++ {
		exec(t, db, `INSERT INTO t VALUES (?, ?)`, i, strings.Repeat("w", i%50))
	}
	exec(t, db, `CREATE TABLE later (x TEXT)`)
	exec(t, db, `INSERT INTO later VALUES ('only in the wal')`)
	current := selectAll(t, db, "t", []string{"v"})

	main, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	wal, err := os.ReadFile(path + "-wal")
	if err != nil || len(wal) == 0 {
		t.Fatalf("expected a WAL: %v", err)
	}

	withWAL, err := OpenBytes(main, wal)
	if err != nil {
		t.Fatal(err)
	}
	sameRows(t, readAll(t, withWAL, "t", []string{"v"}), current)
	sameRows(t, readAll(t, withWAL, "later", []string{"x"}), selectAll(t, db, "later", []string{"x"}))

	withoutWAL, err := OpenBytes(main, nil)
	if err != nil {
		t.Fatal(err)
	}
	sameRows(t, readAll(t, withoutWAL, "t", []string{"v"}), base)
	if withoutWAL.Table("later") != nil {
		t.Error("a table created only in the WAL shouldn't exist without it")
	}

	// A torn tail: one more transaction, then the log cut mid-way through its frames. The
	// reader must fall back to the last complete commit — the state before that transaction.
	exec(t, db, `UPDATE t SET v = 'torn' WHERE id < 400`)
	wal2, err := os.ReadFile(path + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	frame := 24 + 1024
	cut := len(wal) + (len(wal2)-len(wal))/frame/2*frame
	if cut <= len(wal) || cut >= len(wal2) {
		t.Fatalf("expected the last transaction to span several frames (wal %d → %d)", len(wal), len(wal2))
	}
	torn, err := OpenBytes(main, wal2[:cut])
	if err != nil {
		t.Fatal(err)
	}
	sameRows(t, readAll(t, torn, "t", []string{"v"}), current)

	// A log whose salt doesn't match (a stale log from before a reset) is ignored whole.
	stale := append([]byte(nil), wal...)
	stale[16] ^= 0xff
	ignored, err := OpenBytes(main, stale)
	if err != nil {
		t.Fatal(err)
	}
	sameRows(t, readAll(t, ignored, "t", []string{"v"}), base)
}

func TestNotSQLite(t *testing.T) {
	for _, b := range [][]byte{nil, []byte("hello"), bytes.Repeat([]byte("x"), 200)} {
		if _, err := OpenBytes(b, nil); !errors.Is(err, ErrNotSQLite) {
			t.Errorf("OpenBytes(%q...) = %v, want ErrNotSQLite", b[:min(len(b), 8)], err)
		}
	}
}

// TestCorruptionIsAnError flips bytes all over a real database: every open or scan must end in
// an error or a result — never a panic or a hang.
func TestCorruptionIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db := openSQL(t, path, "PRAGMA page_size=1024")
	exec(t, db, `CREATE TABLE t (a TEXT, b INTEGER)`)
	for i := 0; i < 400; i++ {
		exec(t, db, `INSERT INTO t VALUES (?, ?)`, strings.Repeat("z", i%700), i)
	}
	clean, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 100; i < len(clean); i += 97 {
		broken := append([]byte(nil), clean...)
		broken[i] ^= 0xa5
		r, err := OpenBytes(broken, nil)
		if err != nil {
			continue
		}
		_ = r.Scan("t", func(Row) error { return nil })
	}
}

func tableNames(db *DB) []string {
	var out []string
	for _, t := range db.Tables() {
		out = append(out, t.Name)
	}
	return out
}
