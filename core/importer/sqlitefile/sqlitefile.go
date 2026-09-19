// Package sqlitefile reads SQLite database files directly — read-only, rowid tables only, with
// the write-ahead log replayed (PLAN §6.12). It lets an importer read another app's database
// the same way on every platform, including the browser, where core has no SQLite of its own
// (web's store is wa-sqlite, in JS). It is not a SQL engine: it lists tables and streams rows.
//
// The format is https://www.sqlite.org/fileformat2.html. What it reads: the 100-byte header,
// the schema table, table B-trees (interior and leaf pages), overflow chains, every record
// serial type, UTF-8 and UTF-16 text, simple column DEFAULTs (for rows written before an
// ALTER TABLE ADD COLUMN), and the WAL's committed frames. What it refuses: WITHOUT ROWID
// tables and tables with generated columns, whose records don't map 1:1 to declared columns.
package sqlitefile

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
)

// ErrNotSQLite is returned when the main file isn't a SQLite database.
var ErrNotSQLite = errors.New("not a SQLite database")

// ErrCorrupt wraps structural problems found while walking the file.
var ErrCorrupt = errors.New("malformed SQLite database")

// ErrSchema means a row holds more values than its table's parsed column list: the CREATE TABLE
// statement was misread, so values can't be matched to columns.
var ErrSchema = errors.New("table definition couldn’t be read")

// maxDepth bounds B-tree recursion; a real tree of 4 KiB pages holding billions of rows is
// under ten levels deep, so anything deeper is a cycle in a corrupt file.
const maxDepth = 40

// DB is an opened database file. It holds no locks and caches nothing but the schema, so the
// readers it was opened on must stay valid while it is used.
type DB struct {
	main     io.ReaderAt
	mainSize int64
	wal      io.ReaderAt
	walPages map[uint32]int64 // page → offset of its latest committed image in the WAL
	pageSize int
	usable   int
	nPages   uint32
	encoding uint32 // 1 UTF-8, 2 UTF-16le, 3 UTF-16be
	tables   map[string]*Table
	order    []*Table
}

// Table describes one table: its columns in declaration order.
type Table struct {
	Name    string
	Columns []string

	root        uint32
	index       map[string]int // lower-cased column name → position
	defaults    []any          // per column: the DEFAULT literal, or nil
	real        []bool         // per column: REAL affinity (see decode)
	rowidCol    int            // the INTEGER PRIMARY KEY column (an alias for the rowid), or -1
	unsupported string         // why rows can't be decoded column-for-column, or ""
}

// HasColumn reports whether the table declares a column (case-insensitive).
func (t *Table) HasColumn(name string) bool {
	_, ok := t.index[strings.ToLower(name)]
	return ok
}

// Row is one table row. Values are nil, int64, float64, string or []byte.
type Row struct {
	RowID  int64
	table  *Table
	values []any
}

// Value returns a column's raw value, or nil when the column is NULL or doesn't exist.
func (r Row) Value(col string) any {
	i, ok := r.table.index[strings.ToLower(col)]
	if !ok || i >= len(r.values) {
		return nil
	}
	return r.values[i]
}

// Null reports whether a column is NULL (or absent from the table).
func (r Row) Null(col string) bool { return r.Value(col) == nil }

// String returns a column as text: TEXT and BLOB values as-is, numbers formatted, NULL as "".
func (r Row) String(col string) string {
	switch v := r.Value(col).(type) {
	case string:
		return v
	case []byte:
		return string(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64)
	default:
		return ""
	}
}

// Int returns a column as an integer: REALs truncate, numeric TEXT parses, anything else is 0.
func (r Row) Int(col string) int64 {
	switch v := r.Value(col).(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		return n
	default:
		return 0
	}
}

// Float returns a column as a float: INTEGERs convert, numeric TEXT parses, anything else is 0.
func (r Row) Float(col string) float64 {
	switch v := r.Value(col).(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f
	default:
		return 0
	}
}

// Bytes returns a column's BLOB (or TEXT) bytes, or nil.
func (r Row) Bytes(col string) []byte {
	switch v := r.Value(col).(type) {
	case []byte:
		return v
	case string:
		return []byte(v)
	default:
		return nil
	}
}

// OpenBytes opens a database held in memory; wal may be nil.
func OpenBytes(main, wal []byte) (*DB, error) {
	var walR io.ReaderAt
	if len(wal) > 0 {
		walR = bytes.NewReader(wal)
	}
	return Open(bytes.NewReader(main), int64(len(main)), walR, int64(len(wal)))
}

// Open reads the header and the schema. wal may be nil or empty when there is no write-ahead
// log; otherwise its committed frames are overlaid on the main file, exactly as SQLite reads
// them. An invalid log is ignored, as SQLite ignores it.
func Open(main io.ReaderAt, mainSize int64, wal io.ReaderAt, walSize int64) (*DB, error) {
	if mainSize < 100 {
		return nil, ErrNotSQLite
	}
	var hdr [100]byte
	if err := readFull(main, hdr[:], 0); err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	if string(hdr[:16]) != "SQLite format 3\x00" {
		return nil, ErrNotSQLite
	}
	pageSize := int(binary.BigEndian.Uint16(hdr[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	if pageSize < 512 || pageSize&(pageSize-1) != 0 {
		return nil, fmt.Errorf("%w: page size %d", ErrNotSQLite, pageSize)
	}
	db := &DB{
		main:     main,
		mainSize: mainSize,
		pageSize: pageSize,
		usable:   pageSize - int(hdr[20]),
		encoding: binary.BigEndian.Uint32(hdr[56:60]),
		nPages:   uint32(mainSize / int64(pageSize)),
	}
	if db.usable < 480 {
		return nil, fmt.Errorf("%w: usable page size %d", ErrCorrupt, db.usable)
	}
	if db.encoding < 1 || db.encoding > 3 {
		db.encoding = 1
	}
	// The in-header page count is authoritative when the version-valid-for number matches the
	// change counter (written by SQLite ≥ 3.7.0); otherwise fall back to the file size.
	if n := binary.BigEndian.Uint32(hdr[28:32]); n > 0 && binary.BigEndian.Uint32(hdr[24:28]) == binary.BigEndian.Uint32(hdr[92:96]) {
		db.nPages = n
	}
	if wal != nil && walSize > 0 {
		if err := db.loadWAL(wal, walSize); err != nil {
			return nil, err
		}
	}
	if err := db.loadSchema(); err != nil {
		return nil, err
	}
	return db, nil
}

// Table returns a table by name (case-insensitive), or nil.
func (db *DB) Table(name string) *Table { return db.tables[strings.ToLower(name)] }

// Tables lists the tables in schema order.
func (db *DB) Tables() []*Table { return db.order }

// Scan streams a table's rows in rowid order. Returning an error from fn stops the scan and
// returns that error.
func (db *DB) Scan(table string, fn func(Row) error) error {
	t := db.Table(table)
	if t == nil {
		return fmt.Errorf("no table %q", table)
	}
	if t.unsupported != "" {
		return fmt.Errorf("table %s: %s", t.Name, t.unsupported)
	}
	return db.walk(t, t.root, 0, fn)
}

// --- write-ahead log ------------------------------------------------------

// loadWAL indexes the log's committed frames: the latest image of each page as of the last
// commit, stopping at the first frame whose salt or cumulative checksum doesn't match (the
// log's torn or stale tail, which SQLite ignores the same way).
func (db *DB) loadWAL(wal io.ReaderAt, size int64) error {
	if size < 32 {
		return nil
	}
	var hdr [32]byte
	if err := readFull(wal, hdr[:], 0); err != nil {
		return fmt.Errorf("read wal header: %w", err)
	}
	var order binary.ByteOrder
	switch binary.BigEndian.Uint32(hdr[0:4]) {
	case 0x377f0682:
		order = binary.LittleEndian
	case 0x377f0683:
		order = binary.BigEndian
	default:
		return nil
	}
	if int(binary.BigEndian.Uint32(hdr[8:12])) != db.pageSize {
		return nil
	}
	s0, s1 := walChecksum(order, hdr[:24], 0, 0)
	if s0 != binary.BigEndian.Uint32(hdr[24:28]) || s1 != binary.BigEndian.Uint32(hdr[28:32]) {
		return nil
	}
	salt1, salt2 := hdr[16:20], hdr[20:24]
	frame := make([]byte, 24+db.pageSize)
	pending := map[uint32]int64{}
	committed := map[uint32]int64{}
	var nPages uint32
	for off := int64(32); off+int64(len(frame)) <= size; off += int64(len(frame)) {
		if err := readFull(wal, frame, off); err != nil {
			return fmt.Errorf("read wal frame: %w", err)
		}
		if !bytes.Equal(frame[8:12], salt1) || !bytes.Equal(frame[12:16], salt2) {
			break
		}
		s0, s1 = walChecksum(order, frame[:8], s0, s1)
		s0, s1 = walChecksum(order, frame[24:], s0, s1)
		if s0 != binary.BigEndian.Uint32(frame[16:20]) || s1 != binary.BigEndian.Uint32(frame[20:24]) {
			break
		}
		pending[binary.BigEndian.Uint32(frame[0:4])] = off + 24
		if commit := binary.BigEndian.Uint32(frame[4:8]); commit != 0 {
			for p, o := range pending {
				committed[p] = o
			}
			clear(pending)
			nPages = commit
		}
	}
	if len(committed) > 0 {
		db.wal, db.walPages, db.nPages = wal, committed, nPages
	}
	return nil
}

// walChecksum continues SQLite's WAL checksum over b (a multiple of 8 bytes).
func walChecksum(order binary.ByteOrder, b []byte, s0, s1 uint32) (uint32, uint32) {
	for i := 0; i+8 <= len(b); i += 8 {
		s0 += order.Uint32(b[i:]) + s1
		s1 += order.Uint32(b[i+4:]) + s0
	}
	return s0, s1
}

// --- pages, B-trees, records ----------------------------------------------

// page reads page n (1-based): its latest committed WAL image, else the main file's.
func (db *DB) page(n uint32) ([]byte, error) {
	if n == 0 || n > db.nPages {
		return nil, fmt.Errorf("%w: page %d out of range (%d pages)", ErrCorrupt, n, db.nPages)
	}
	buf := make([]byte, db.pageSize)
	if off, ok := db.walPages[n]; ok {
		return buf, readFull(db.wal, buf, off)
	}
	off := int64(n-1) * int64(db.pageSize)
	if off+int64(db.pageSize) > db.mainSize {
		return nil, fmt.Errorf("%w: page %d is past the end of the file", ErrCorrupt, n)
	}
	return buf, readFull(db.main, buf, off)
}

// walk visits a table B-tree rooted at pgno in key (rowid) order.
func (db *DB) walk(t *Table, pgno uint32, depth int, fn func(Row) error) error {
	if depth > maxDepth {
		return fmt.Errorf("%w: B-tree deeper than %d levels", ErrCorrupt, maxDepth)
	}
	pg, err := db.page(pgno)
	if err != nil {
		return err
	}
	h := 0
	if pgno == 1 {
		h = 100 // page 1 starts with the database header
	}
	if len(pg) < h+12 {
		return fmt.Errorf("%w: page %d too small", ErrCorrupt, pgno)
	}
	cells := int(binary.BigEndian.Uint16(pg[h+3:]))
	cell := func(i, hdrLen int) (int, error) {
		p := h + hdrLen + 2*i
		if p+2 > len(pg) {
			return 0, fmt.Errorf("%w: cell pointer past page %d", ErrCorrupt, pgno)
		}
		off := int(binary.BigEndian.Uint16(pg[p:]))
		if off < h+hdrLen || off >= len(pg) {
			return 0, fmt.Errorf("%w: cell offset %d on page %d", ErrCorrupt, off, pgno)
		}
		return off, nil
	}
	switch pg[h] {
	case 0x0D: // table leaf: (payload size, rowid, payload)
		for i := 0; i < cells; i++ {
			off, err := cell(i, 8)
			if err != nil {
				return err
			}
			size, n := varint(pg[off:])
			if n == 0 {
				return fmt.Errorf("%w: cell on page %d", ErrCorrupt, pgno)
			}
			rowid, m := varint(pg[off+n:])
			if m == 0 {
				return fmt.Errorf("%w: cell on page %d", ErrCorrupt, pgno)
			}
			payload, err := db.payload(pg, off+n+m, size)
			if err != nil {
				return err
			}
			row, err := t.decode(int64(rowid), payload, db.encoding)
			if err != nil {
				return fmt.Errorf("table %s, rowid %d: %w", t.Name, int64(rowid), err)
			}
			if err := fn(row); err != nil {
				return err
			}
		}
		return nil
	case 0x05: // table interior: (left child, key) cells, then the right-most child
		for i := 0; i < cells; i++ {
			off, err := cell(i, 12)
			if err != nil {
				return err
			}
			if off+4 > len(pg) {
				return fmt.Errorf("%w: interior cell on page %d", ErrCorrupt, pgno)
			}
			if err := db.walk(t, binary.BigEndian.Uint32(pg[off:]), depth+1, fn); err != nil {
				return err
			}
		}
		return db.walk(t, binary.BigEndian.Uint32(pg[h+8:]), depth+1, fn)
	default:
		return fmt.Errorf("%w: table %s: page %d has type %#x, not a table page", ErrCorrupt, t.Name, pgno, pg[h])
	}
}

// payload assembles a leaf cell's payload of `total` bytes starting at pg[off], following its
// overflow chain when it doesn't fit on the page.
func (db *DB) payload(pg []byte, off int, total uint64) ([]byte, error) {
	u := db.usable
	x := u - 35
	local := int(total)
	if total > uint64(x) {
		m := (u-12)*32/255 - 23
		k := m + int((total-uint64(m))%uint64(u-4))
		local = m
		if k <= x {
			local = k
		}
	}
	if total > uint64(db.nPages)*uint64(db.pageSize) || off+local > len(pg) {
		return nil, fmt.Errorf("%w: payload of %d bytes overruns its page", ErrCorrupt, total)
	}
	out := make([]byte, 0, total)
	out = append(out, pg[off:off+local]...)
	if uint64(local) == total {
		return out, nil
	}
	if off+local+4 > len(pg) {
		return nil, fmt.Errorf("%w: missing overflow pointer", ErrCorrupt)
	}
	next := binary.BigEndian.Uint32(pg[off+local:])
	for hops := uint32(0); uint64(len(out)) < total; hops++ {
		if next == 0 || hops > db.nPages {
			return nil, fmt.Errorf("%w: broken overflow chain", ErrCorrupt)
		}
		ov, err := db.page(next)
		if err != nil {
			return nil, err
		}
		n := min(uint64(u-4), total-uint64(len(out)))
		out = append(out, ov[4:4+n]...)
		next = binary.BigEndian.Uint32(ov[0:4])
	}
	return out, nil
}

// serialSizes are the byte widths of the integer serial types 1–6.
var serialSizes = [7]int{0, 1, 2, 3, 4, 6, 8}

// decode splits a record into the table's columns. Columns a short record lacks (added by
// ALTER TABLE after it was written) take their declared DEFAULT, and the rowid-alias column
// takes the rowid, both as SQLite would return them.
func (t *Table) decode(rowid int64, p []byte, enc uint32) (Row, error) {
	hdrLen, n := varint(p)
	if n == 0 || hdrLen > uint64(len(p)) {
		return Row{}, fmt.Errorf("%w: record header", ErrCorrupt)
	}
	vals := make([]any, len(t.Columns))
	copy(vals, t.defaults)
	body := int(hdrLen)
	for pos, col := n, 0; pos < int(hdrLen); col++ {
		st, k := varint(p[pos:hdrLen])
		if k == 0 {
			return Row{}, fmt.Errorf("%w: record header", ErrCorrupt)
		}
		pos += k
		var v any
		size := 0
		switch {
		case st == 0:
		case st <= 6:
			size = serialSizes[st]
			if body+size > len(p) {
				return Row{}, fmt.Errorf("%w: record body", ErrCorrupt)
			}
			v = bigEndianInt(p[body : body+size])
		case st == 7:
			size = 8
			if body+size > len(p) {
				return Row{}, fmt.Errorf("%w: record body", ErrCorrupt)
			}
			v = math.Float64frombits(binary.BigEndian.Uint64(p[body:]))
		case st == 8:
			v = int64(0)
		case st == 9:
			v = int64(1)
		case st >= 12:
			size = int((st - 12) / 2)
			if body+size > len(p) {
				return Row{}, fmt.Errorf("%w: record body", ErrCorrupt)
			}
			if st%2 == 0 {
				v = append([]byte(nil), p[body:body+size]...)
			} else {
				v = decodeText(p[body:body+size], enc)
			}
		default:
			return Row{}, fmt.Errorf("%w: reserved serial type %d", ErrCorrupt, st)
		}
		body += size
		if col >= len(vals) {
			// A record never holds more values than its table has columns; if it does, the
			// column list was misread, and every value after it would land in the wrong column.
			return Row{}, fmt.Errorf("%w: %s has more values than its %d columns", ErrSchema, t.Name, len(vals))
		}
		vals[col] = v
	}
	// SQLite stores a whole-number REAL as an integer to save space and turns it back into a
	// REAL on read, because the column has REAL affinity; do the same.
	for i, v := range vals {
		if n, ok := v.(int64); ok && i < len(t.real) && t.real[i] {
			vals[i] = float64(n)
		}
	}
	if t.rowidCol >= 0 {
		vals[t.rowidCol] = rowid
	}
	return Row{RowID: rowid, table: t, values: vals}, nil
}

// bigEndianInt reads a 1–8 byte big-endian two's-complement integer.
func bigEndianInt(b []byte) int64 {
	var v int64
	if len(b) > 0 && b[0]&0x80 != 0 {
		v = -1
	}
	for _, c := range b {
		v = v<<8 | int64(c)
	}
	return v
}

// varint decodes a SQLite varint (1–9 bytes, big-endian); n is 0 when b is too short.
func varint(b []byte) (v uint64, n int) {
	for i := 0; i < 8; i++ {
		if i >= len(b) {
			return 0, 0
		}
		v = v<<7 | uint64(b[i]&0x7f)
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
	}
	if len(b) < 9 {
		return 0, 0
	}
	return v<<8 | uint64(b[8]), 9
}

func decodeText(b []byte, enc uint32) string {
	if enc == 1 {
		return string(b)
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		if enc == 2 {
			u[i] = binary.LittleEndian.Uint16(b[2*i:])
		} else {
			u[i] = binary.BigEndian.Uint16(b[2*i:])
		}
	}
	return string(utf16.Decode(u))
}

// readFull reads len(buf) bytes at off, treating a final io.EOF with a full read as success.
func readFull(r io.ReaderAt, buf []byte, off int64) error {
	n, err := r.ReadAt(buf, off)
	if n == len(buf) {
		return nil
	}
	if err == nil || err == io.EOF {
		err = io.ErrUnexpectedEOF
	}
	return err
}

// --- schema ----------------------------------------------------------------

// loadSchema reads sqlite_schema (the table rooted at page 1) for every table's root page
// and column list.
func (db *DB) loadSchema() error {
	schema := &Table{Name: "sqlite_schema", Columns: []string{"type", "name", "tbl_name", "rootpage", "sql"}, root: 1, rowidCol: -1}
	schema.finish()
	db.tables = map[string]*Table{}
	return db.walk(schema, 1, 0, func(r Row) error {
		if r.String("type") != "table" || r.Int("rootpage") <= 0 {
			return nil // indexes, views, triggers, virtual tables
		}
		t := parseCreateTable(r.String("name"), r.String("sql"))
		t.root = uint32(r.Int("rootpage"))
		db.tables[strings.ToLower(t.Name)] = t
		db.order = append(db.order, t)
		return nil
	})
}

func (t *Table) finish() {
	t.index = make(map[string]int, len(t.Columns))
	for i, c := range t.Columns {
		t.index[strings.ToLower(c)] = i
	}
	if len(t.defaults) < len(t.Columns) {
		t.defaults = append(t.defaults, make([]any, len(t.Columns)-len(t.defaults))...)
	}
	if len(t.real) < len(t.Columns) {
		t.real = append(t.real, make([]bool, len(t.Columns)-len(t.real))...)
	}
}

// realAffinity applies SQLite's affinity rules to a declared type: REAL affinity is a type
// containing REAL, FLOA or DOUB and not INT (INT wins).
func realAffinity(typ string) bool {
	up := strings.ToUpper(typ)
	if strings.Contains(up, "INT") {
		return false
	}
	return strings.Contains(up, "REAL") || strings.Contains(up, "FLOA") || strings.Contains(up, "DOUB")
}

// parseCreateTable reads the column list from a CREATE TABLE statement. A statement it can't
// read yields a table marked unsupported rather than an error, so one odd table doesn't stop
// the others from being read.
func parseCreateTable(name, sql string) *Table {
	t := &Table{Name: name, rowidCol: -1}
	defer t.finish()
	// SQLite keeps the statement as written, comments included (Things annotates its columns:
	// "startDate" INTEGER, -- REAL -> INTEGER), so comments go before anything is split.
	sql = stripComments(sql)
	open := strings.IndexByte(sql, '(')
	if open < 0 {
		t.unsupported = "its definition has no column list"
		return t
	}
	parts, rest, ok := splitColumnDefs(sql[open+1:])
	if !ok {
		t.unsupported = "its column list couldn't be read"
		return t
	}
	if strings.Contains(strings.ToUpper(rest), "WITHOUT ROWID") {
		t.unsupported = "WITHOUT ROWID tables aren't supported"
	}
	pkCols := ""
	var types []string
	for _, part := range parts {
		toks := tokenize(part)
		if len(toks) == 0 {
			continue
		}
		switch strings.ToUpper(toks[0]) {
		case "CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN":
			// A table constraint: note a single-column PRIMARY KEY for the rowid alias.
			up := strings.ToUpper(strings.Join(toks, " "))
			if i := strings.Index(up, "PRIMARY KEY"); i >= 0 {
				if cols := parenContents(toks); len(cols) == 1 {
					pkCols = unquote(cols[0])
				}
			}
			continue
		}
		col := unquote(toks[0])
		t.Columns = append(t.Columns, col)
		typ, constraints := columnType(toks[1:])
		types = append(types, typ)
		t.real = append(t.real, realAffinity(typ))
		up := strings.ToUpper(strings.Join(constraints, " "))
		if strings.Contains(up, "GENERATED") || strings.HasPrefix(up, "AS ") || strings.Contains(up, " AS (") {
			t.unsupported = "generated columns aren't supported"
		}
		if strings.EqualFold(typ, "INTEGER") && strings.Contains(up, "PRIMARY KEY") && !strings.Contains(up, "PRIMARY KEY DESC") {
			t.rowidCol = len(t.Columns) - 1
		}
		t.defaults = append(t.defaults, defaultValue(constraints))
	}
	if pkCols != "" {
		for i, c := range t.Columns {
			if strings.EqualFold(c, pkCols) && strings.EqualFold(types[i], "INTEGER") {
				t.rowidCol = i
			}
		}
	}
	return t
}

// stripComments replaces SQL comments — "--" to the end of the line, and /* … */ — with a space,
// leaving quoted strings and identifiers (which may contain either) untouched.
func stripComments(sql string) string {
	var b strings.Builder
	for i := 0; i < len(sql); {
		c := sql[i]
		switch {
		case c == '\'' || c == '"' || c == '`' || c == '[':
			end := c
			if c == '[' {
				end = ']'
			}
			j := i + 1
			for j < len(sql) {
				if sql[j] == end {
					// A doubled quote is an escaped one and doesn't end the token.
					if end != ']' && j+1 < len(sql) && sql[j+1] == end {
						j += 2
						continue
					}
					break
				}
				j++
			}
			j = min(j+1, len(sql))
			b.WriteString(sql[i:j])
			i = j
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			j := strings.IndexByte(sql[i:], '\n')
			if j < 0 {
				return b.String()
			}
			b.WriteByte(' ')
			i += j
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
			j := strings.Index(sql[i+2:], "*/")
			if j < 0 {
				return b.String()
			}
			b.WriteByte(' ')
			i += j + 4
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

// splitColumnDefs splits the text after CREATE TABLE's "(" into its top-level comma-separated
// definitions, returning them and whatever follows the matching ")".
func splitColumnDefs(s string) (parts []string, rest string, ok bool) {
	depth, start := 0, 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\'', '"', '`':
			j := strings.IndexByte(s[i+1:], c)
			if j < 0 {
				return nil, "", false
			}
			i += j + 1
		case '[':
			j := strings.IndexByte(s[i+1:], ']')
			if j < 0 {
				return nil, "", false
			}
			i += j + 1
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return append(parts, strings.TrimSpace(s[start:i])), s[i+1:], true
			}
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(s[start:i]))
				start = i + 1
			}
		}
	}
	return nil, "", false
}

// tokenize splits a column definition into identifiers, keywords, literals and single
// punctuation characters, keeping quoted tokens (with their quotes) whole.
func tokenize(s string) []string {
	var out []string
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '\'' || c == '"' || c == '`' || c == '[':
			end := c
			if c == '[' {
				end = ']'
			}
			// The token runs to the closing quote; a doubled quote inside is an escaped one.
			j := i + 1
			for {
				k := strings.IndexByte(s[j:], end)
				if k < 0 {
					return append(out, s[i:])
				}
				j += k + 1
				if end == ']' || j >= len(s) || s[j] != end {
					break
				}
				j++
			}
			out = append(out, s[i:j])
			i = j
		case c == '(' || c == ')' || c == ',':
			out = append(out, string(c))
			i++
		default:
			j := i
			for j < len(s) && !strings.ContainsRune(" \t\n\r'\"`[(),", rune(s[j])) {
				j++
			}
			out = append(out, s[i:j])
			i = j
		}
	}
	return out
}

// columnType separates a column's type name (up to the first constraint keyword) from its
// constraints.
func columnType(toks []string) (typ string, constraints []string) {
	for i, tok := range toks {
		switch strings.ToUpper(tok) {
		case "CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS":
			return strings.Join(toks[:i], " "), toks[i:]
		}
	}
	return strings.Join(toks, " "), nil
}

// defaultValue reads a column's DEFAULT literal (number, string, NULL, TRUE/FALSE); an
// expression default reads as NULL.
func defaultValue(constraints []string) any {
	for i, tok := range constraints {
		if !strings.EqualFold(tok, "DEFAULT") || i+1 >= len(constraints) {
			continue
		}
		v := constraints[i+1]
		sign := ""
		if (v == "-" || v == "+") && i+2 < len(constraints) {
			sign, v = v, constraints[i+2]
		}
		switch {
		case strings.HasPrefix(v, "'"):
			return unquote(v)
		case strings.EqualFold(v, "TRUE"):
			return int64(1)
		case strings.EqualFold(v, "FALSE"):
			return int64(0)
		}
		if n, err := strconv.ParseInt(sign+v, 10, 64); err == nil {
			return n
		}
		if f, err := strconv.ParseFloat(sign+v, 64); err == nil {
			return f
		}
		return nil
	}
	return nil
}

// parenContents returns the tokens between the first "(" and its ")", minus commas.
func parenContents(toks []string) []string {
	var out []string
	in := false
	for _, tok := range toks {
		switch {
		case tok == "(":
			in = true
		case tok == ")":
			return out
		case in && tok != ",":
			out = append(out, tok)
		}
	}
	return out
}

func unquote(s string) string {
	if len(s) >= 2 {
		switch s[0] {
		case '"', '\'', '`':
			if s[len(s)-1] == s[0] {
				return strings.ReplaceAll(s[1:len(s)-1], string(s[0])+string(s[0]), string(s[0]))
			}
		case '[':
			if s[len(s)-1] == ']' {
				return s[1 : len(s)-1]
			}
		}
	}
	return s
}
