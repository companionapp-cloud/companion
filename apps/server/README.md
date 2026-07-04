# Companion — Server (auth + sync)

Milestone 3 (Server + sync). A Go HTTP API that authenticates users and syncs their
rows via **push/pull with optimistic concurrency** (PLAN §5). It reuses `core/domain`
entities and the `core/sync/protocol` wire types, and keeps its own store — it never
touches the client SQLite store or the client sync engine (PLAN §7).

## Endpoints

```
POST /v1/auth/register  {email, password}      -> {token, userId}
POST /v1/auth/login     {email, password}      -> {token, userId}
GET  /v1/sync/pull?cursor=N&limit=500          -> {changes:[{entityType,row,serverSeq}], nextCursor}
POST /v1/sync/push       {changes:[…]}         -> {results:[{id,status,version?,serverRow?}]}
```

- **Push** (`applyPush`, PLAN §5.2): per row, in a transaction —
  insert (version 1) / apply if `version == baseVersion` (version++) / on a stale push
  the **server wins only if it's at least as new**, else the client's newer row is
  applied. Every write bumps a per-user monotonic `server_seq`.
- **Pull** (PLAN §5.1): `WHERE user_id = ? AND server_seq > cursor ORDER BY server_seq
  LIMIT n`, returning `next_cursor`. Tombstones (`deleted_at`) propagate.
- Client-side conflict resolution + **conflicted copies** live in `core/sync`
  (shared by every client).

## Storage

The driver is chosen from the DSN: a `postgres://` URL uses **pgx** (production,
PLAN §4.2); anything else is a **SQLite** path (`modernc.org/sqlite`) for zero-config
dev and fast headless tests. The queries are written once with `?` placeholders and
rebound to `$N` on Postgres; the schema (TEXT / BIGINT / BYTEA + `ON CONFLICT …
EXCLUDED`) is valid on both. Passwords are bcrypt-hashed; sessions are opaque tokens.

```bash
make db-up                # start the compose Postgres (compose.yaml / .env)
make server-run           # loads .env -> DATABASE_URL, so it runs on Postgres
# or explicitly:
DATABASE_URL=postgres://companion:companion@localhost:5432/companion?sslmode=disable go run ./apps/server
```

Precedence: `DATABASE_URL` (Postgres) → `COMPANION_DB` (SQLite path) → a default
SQLite file. `make test-go` runs on in-memory SQLite; set `COMPANION_TEST_DB` to a
`postgres://` URL to run the same suite against Postgres.

## Run / test

```bash
make test-go                              # includes ./apps/server/... (e2e sync test)
COMPANION_ADDR=:8080 go run ./apps/server # or: go build -o build/companion-server ./apps/server
```

`apps/server/sync_test.go` is the end-to-end proof: two client stores (`core/store`)
driving the real `core/sync` engine over HTTP against this server — verifying
propagation, tombstone deletes, and conflicted copies converge.
