/// <reference path="./wa-sqlite-shims.d.ts" />
import * as SQLite from "wa-sqlite";
import SQLiteAsyncFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

import type { SqliteDriver, SqlValue } from "./types";

export interface WaSqliteOptions {
  /** IndexedDB database + SQLite file name (default "companion"). */
  dbName?: string;
}

/**
 * createWaSqliteDriver builds the browser SQLite backend for the wasm core.
 *
 * It uses wa-sqlite's IndexedDB VFS (IDBBatchAtomicVFS): persistent across reloads,
 * runs on the main thread, and needs no cross-origin-isolation headers. OPFS
 * (PLAN §3.2/§10) is the documented upgrade — it is faster but requires a dedicated
 * worker + COOP/COEP headers, which this driver deliberately avoids for milestone 2.
 */
export async function createWaSqliteDriver(opts: WaSqliteOptions = {}): Promise<SqliteDriver> {
  const dbName = opts.dbName ?? "companion";
  const module = await SQLiteAsyncFactory();
  const sqlite3 = SQLite.Factory(module);

  // The connection is replaceable: see reopen below.
  let vfs: InstanceType<typeof IDBBatchAtomicVFS>;
  let db: number;
  let generation = 0;

  async function open(): Promise<void> {
    vfs = new IDBBatchAtomicVFS(dbName);
    // wa-sqlite refuses to register a VFS name twice, so every reopen registers under a
    // fresh name. The IndexedDB database (keyed by dbName, fixed in the constructor) and
    // the file path are unchanged, so each generation sees the same data.
    if (generation > 0) vfs.name = `${dbName}-${generation}`;
    generation++;
    sqlite3.vfs_register(vfs, false);
    db = await sqlite3.open_v2(
      `${dbName}.db`,
      SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
      vfs.name,
    );
    // Use an in-memory rollback journal. The IndexedDB VFS's on-disk journal open
    // path (opening "<db>-journal" without CREATE for hot-journal checks) is
    // unreliable; an in-memory journal avoids it and is faster for this workload.
    await run("PRAGMA journal_mode=MEMORY;", [], false);
  }

  // reopen replaces a broken connection. The IndexedDB VFS never recovers from an IDB
  // failure on its own: it caches one IDBDatabase forever (iOS Safari closes it when a
  // PWA is suspended — "Connection to Indexed Database server lost"), and a single
  // aborted transaction leaves its commit chain rejected, so every later write returns
  // SQLITE_IOERR ("disk I/O error") until the page reloads. A fresh VFS gets a fresh IDB
  // connection. Batch-atomic writes mean the stored file is never half-written.
  async function reopen(): Promise<void> {
    const [oldDb, oldVfs] = [db, vfs];
    const bestEffort = (p: Promise<unknown>) =>
      Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await bestEffort(Promise.resolve().then(() => sqlite3.close(oldDb)));
    await bestEffort(Promise.resolve().then(() => oldVfs.close()));
    await open();
  }

  // wa-sqlite (Asyncify) is NOT reentrant: a second call while another is suspended
  // mid-await corrupts the wasm stack. The Go core dispatches each Invoke on its own
  // goroutine, so concurrent invokes (e.g. a mutation plus the notes.changed refresh)
  // can interleave here. Serialize every SQLite operation through a promise chain.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = tail.then(op, op);
    tail = result.catch(() => undefined);
    return result;
  }

  // withRecovery runs op, and on an I/O error reopens the connection. Outside an explicit
  // transaction the statement is retried once (every write is an autocommit statement, and
  // the sync repos' writes are idempotent upserts). Inside one (Store.Batch, migrations)
  // the transaction died with the old connection, so the error propagates and the caller's
  // ROLLBACK is a harmless no-op on the new connection.
  async function withRecovery<T>(op: () => Promise<T>): Promise<T> {
    const autocommit = sqlite3.get_autocommit(db) !== 0;
    try {
      return await op();
    } catch (err) {
      if (!isIOError(err)) throw err;
      console.warn("sqlite: I/O error, reopening IndexedDB connection", err);
      await reopen();
      if (!autocommit) throw err;
      return await op();
    }
  }

  // run prepares each statement in sql (migrations are multi-statement), binds the
  // positional params to the single statement when present, and steps to completion.
  async function run(sql: string, params: SqlValue[], collect: boolean): Promise<SqlValue[][]> {
    const rows: SqlValue[][] = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        if (collect) rows.push(sqlite3.row(stmt) as SqlValue[]);
      }
    }
    return rows;
  }

  await open();

  return {
    exec: (sql, params) =>
      serialize(() =>
        withRecovery(async () => {
          await run(sql, params, false);
          return { rowsAffected: sqlite3.changes(db) };
        }),
      ),
    query: (sql, params) =>
      serialize(() => withRecovery(async () => ({ rows: await run(sql, params, true) }))),
    close: () =>
      serialize(async () => {
        await sqlite3.close(db);
        await vfs.close();
      }),
  };
}

// isIOError reports whether err is SQLITE_IOERR or one of its extended codes.
function isIOError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && (code & 0xff) === SQLite.SQLITE_IOERR;
}
