// Command seed populates a user's account with a large, interconnected set of notes so
// the graph view has something realistic to render. Connections are wikilinks
// ([[note:<id>]]) embedded in note content — the exact form the client parses into graph
// edges (see core/domain/links.go). Edges are undirected in the graph, so a note's graph
// "cluster" is a connected component; this tool controls the component count by
// partitioning the notes into K groups and only linking *within* each group.
//
// Usage:
//
//	go run ./cmd/seed -email you@example.com
//	go run ./cmd/seed -email you@example.com -notes 1000 -min-clusters 10 -max-clusters 100
//	COMPANION_DB=companion-server.db go run ./cmd/seed -user <user-id> -seed 42
//
// The DB is resolved the same way the server resolves it: -db flag, else DATABASE_URL,
// else COMPANION_DB, else ./companion-server.db. Postgres and SQLite are both supported.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib" // Postgres
	_ "modernc.org/sqlite"             // SQLite
)

const timeFormat = time.RFC3339Nano

func main() {
	var (
		dsn         = flag.String("db", "", "DB DSN (default: $DATABASE_URL, else $COMPANION_DB, else companion-server.db)")
		email       = flag.String("email", "", "seed the user with this email")
		userID      = flag.String("user", "", "seed the user with this id (alternative to -email)")
		noteCount   = flag.Int("notes", 1000, "number of notes to create")
		minClusters = flag.Int("min-clusters", 10, "minimum number of connected clusters")
		maxClusters = flag.Int("max-clusters", 100, "maximum number of connected clusters")
		seed        = flag.Int64("seed", 0, "RNG seed (0 = time-based, non-deterministic)")
	)
	flag.Parse()

	if (*email == "") == (*userID == "") {
		log.Fatal("provide exactly one of -email or -user")
	}
	if *noteCount < 1 {
		log.Fatal("-notes must be >= 1")
	}
	if *minClusters < 1 || *maxClusters < *minClusters || *maxClusters > *noteCount {
		log.Fatalf("need 1 <= min-clusters (%d) <= max-clusters (%d) <= notes (%d)", *minClusters, *maxClusters, *noteCount)
	}

	rng := rand.New(rand.NewSource(*seed))
	if *seed == 0 {
		rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	}

	db, dialect, err := openDB(resolveDSN(*dsn))
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	uid, err := resolveUser(db, dialect, *userID, *email)
	if err != nil {
		log.Fatalf("resolve user: %v", err)
	}

	// Pick a cluster count in range, then partition the notes: seed one note into each
	// cluster (so none is empty and the component count is exactly K), then scatter the
	// rest at random. Random cluster sizes give the uneven blobs the renderer clusters on.
	k := *minClusters
	if *maxClusters > *minClusters {
		k += rng.Intn(*maxClusters - *minClusters + 1)
	}
	ids := make([]string, *noteCount)
	for i := range ids {
		ids[i] = newID()
	}
	clusters := make([][]int, k) // cluster -> note indices
	for i := 0; i < k; i++ {
		clusters[i] = append(clusters[i], i) // one guaranteed member each
	}
	for i := k; i < *noteCount; i++ {
		c := rng.Intn(k)
		clusters[c] = append(clusters[c], i)
	}

	// Build outgoing links per note. Within each cluster: a random spanning tree makes it
	// one connected component (member m links back to a random earlier member), plus a few
	// random extra intra-cluster links so degrees — and therefore node sizes — vary.
	links := make([][]int, *noteCount)
	edgeCount := 0
	for _, members := range clusters {
		for m := 1; m < len(members); m++ {
			target := members[rng.Intn(m)]
			links[members[m]] = append(links[members[m]], target)
			edgeCount++
		}
		extra := rng.Intn(len(members)) // 0..len-1 extra links
		for e := 0; e < extra && len(members) > 1; e++ {
			a := members[rng.Intn(len(members))]
			b := members[rng.Intn(len(members))]
			if a != b && !contains(links[a], b) {
				links[a] = append(links[a], b)
				edgeCount++
			}
		}
	}

	if err := insertNotes(db, dialect, uid, ids, links, rng); err != nil {
		log.Fatalf("insert notes: %v", err)
	}

	sizes := make([]int, len(clusters))
	for i, c := range clusters {
		sizes[i] = len(c)
	}
	log.Printf("seeded %d notes for user %s: %d clusters (sizes %d..%d), ~%d links",
		*noteCount, uid, k, minOf(sizes), maxOf(sizes), edgeCount)
}

// insertNotes writes all notes in one transaction, assigning each a fresh per-user
// server_seq so existing clients pull them on the next sync (mirrors Server.nextSeq).
func insertNotes(db *sql.DB, dialect, uid string, ids []string, links [][]int, rng *rand.Rand) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Advance the per-user sequence by the batch size and take the block for ourselves.
	if _, err := tx.Exec(bind(dialect,
		`INSERT INTO user_seq (user_id, seq) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING;`), uid); err != nil {
		return err
	}
	var base int64
	if err := tx.QueryRow(bind(dialect, `SELECT seq FROM user_seq WHERE user_id = ?;`), uid).Scan(&base); err != nil {
		return err
	}
	if _, err := tx.Exec(bind(dialect, `UPDATE user_seq SET seq = seq + ? WHERE user_id = ?;`), int64(len(ids)), uid); err != nil {
		return err
	}

	now := time.Now().UTC().Format(timeFormat)
	stmt := bind(dialect, `INSERT INTO notes
		(id, user_id, title, content_md, date, created_at, updated_at, deleted_at, version, server_seq)
		VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 1, ?)
		ON CONFLICT (id) DO UPDATE SET
		  title = excluded.title, content_md = excluded.content_md,
		  updated_at = excluded.updated_at, version = excluded.version, server_seq = excluded.server_seq;`)
	for i, id := range ids {
		title := fmt.Sprintf("Seed Note %04d", i+1)
		if _, err := tx.Exec(stmt, id, uid, title, noteBody(title, links[i], ids, rng), now, now, base+int64(i)+1); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// noteBody renders a note's markdown: a line of filler plus a "Related" list of wikilinks
// to its targets — the [[note:<id>]] form core/domain.ParseRefs turns into graph edges.
func noteBody(title string, targets []int, ids []string, rng *rand.Rand) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n%s\n", title, lorem[rng.Intn(len(lorem))])
	if len(targets) > 0 {
		b.WriteString("\n## Related\n\n")
		for _, t := range targets {
			fmt.Fprintf(&b, "- [[note:%s]]\n", ids[t])
		}
	}
	return b.String()
}

var lorem = []string{
	"A short thought captured here, linking out to related ideas.",
	"Notes on the current line of work; see the connections below.",
	"Reference material and follow-ups worth revisiting later.",
	"Loose ends and open questions gathered in one place.",
	"Context for a decision, with pointers to the surrounding notes.",
}

// resolveUser returns the user id, looking it up by email when -email was given.
func resolveUser(db *sql.DB, dialect, userID, email string) (string, error) {
	if userID != "" {
		var got string
		err := db.QueryRow(bind(dialect, `SELECT id FROM users WHERE id = ?;`), userID).Scan(&got)
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("no user with id %q", userID)
		}
		return got, err
	}
	var got string
	err := db.QueryRow(bind(dialect, `SELECT id FROM users WHERE email = ?;`), email).Scan(&got)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("no user with email %q (register first)", email)
	}
	return got, err
}

func resolveDSN(flagDSN string) string {
	if flagDSN != "" {
		return flagDSN
	}
	if v := os.Getenv("DATABASE_URL"); v != "" {
		return v
	}
	if v := os.Getenv("COMPANION_DB"); v != "" {
		return v
	}
	return "companion-server.db"
}

// openDB mirrors the server's driver selection: a postgres:// URL uses pgx, anything else
// is treated as a SQLite path.
func openDB(dsn string) (*sql.DB, string, error) {
	dialect, driver := "sqlite", "sqlite"
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		dialect, driver = "postgres", "pgx"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, "", err
	}
	if dialect == "sqlite" {
		db.SetMaxOpenConns(1)
	}
	return db, dialect, db.Ping()
}

// bind converts '?' placeholders to Postgres' '$N' form (no-op on SQLite), matching the
// server's rebind. Our SQL never contains a literal '?'.
func bind(dialect, query string) string {
	if dialect != "postgres" {
		return query
	}
	var b strings.Builder
	n := 0
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(query[i])
	}
	return b.String()
}

func newID() string {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}
	return id.String()
}

func contains(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func minOf(xs []int) int {
	m := xs[0]
	for _, x := range xs {
		if x < m {
			m = x
		}
	}
	return m
}

func maxOf(xs []int) int {
	m := xs[0]
	for _, x := range xs {
		if x > m {
			m = x
		}
	}
	return m
}
