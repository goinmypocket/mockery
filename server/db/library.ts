// =============================================================================
// Per-user contract library (engine spec §5.4).
//
// Lives in `${DATA_DIR}/mockery.db` — Mockery owns its own SQLite file
// alongside the platform's `platform.db`. Game modules don't import
// from `platform/`, and the platform doesn't expose its DB handle, so
// owning a sibling file is the cleanest seam.
//
// Lazy: the DB is opened on first use and lives for the process. If
// `DATA_DIR` is unset (e.g. in tests), the library falls back to an
// in-memory store so behaviour is exercisable without filesystem
// dependencies.
// =============================================================================

import { join } from "node:path";

import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";

import type { UserId } from "../../shared/ids";

export interface LibraryEntry {
  readonly id: number;
  readonly userId: UserId;
  readonly name: string;
  readonly description: string;
  readonly payoffSource: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContractLibrary {
  forScope?(scope: string): ContractLibrary;
  list(userId: UserId): readonly LibraryEntry[];
  save(userId: UserId, args: { name: string; description: string; payoffSource: string }): LibraryEntry;
  update(userId: UserId, id: number, args: { name?: string; description?: string; payoffSource?: string }): LibraryEntry | null;
  remove(userId: UserId, id: number): boolean;
}

let cached: ContractLibrary | null = null;
let cachedDb: Database | null = null;

/** Singleton accessor. The first call opens (or creates) the DB; later
 *  calls reuse it. Tests can override by passing `forceMemory`. */
export function getLibrary(opts?: { forceMemory?: boolean }): ContractLibrary {
  if (cached && !opts?.forceMemory) return cached;

  const dataDir = process.env["DATA_DIR"];
  const useFile = !!dataDir && !opts?.forceMemory;
  const db: Database = useFile
    ? new BetterSqlite3(join(dataDir!, "mockery.db"))
    : new BetterSqlite3(":memory:");

  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const lib: ContractLibrary = {
    forScope(scope) {
      const owner = (id: UserId): UserId => {
        const key = JSON.stringify([scope, id]) as UserId;
        // Copy historical templates once into each table that already holds
        // this opaque participant ID. Future edits stay within that table.
        db.transaction(() => {
          const created = db.prepare("INSERT OR IGNORE INTO library_scope_imports (owner) VALUES (?)").run(key);
          if (created.changes) db.prepare(`INSERT INTO mockery_user_contract_library (user_id, name, description, payoff_source, created_at, updated_at) SELECT ?, name, description, payoff_source, created_at, updated_at FROM mockery_user_contract_library WHERE user_id = ?`).run(key, id);
        })();
        return key;
      };
      return {
        list(id) { return lib.list(owner(id)).map(e => ({ ...e, userId: id })); },
        save(id, args) { return { ...lib.save(owner(id), args), userId: id }; },
        update(id, entry, args) { const result = lib.update(owner(id), entry, args); return result && { ...result, userId: id }; },
        remove(id, entry) { return lib.remove(owner(id), entry); },
      };
    },
    list(userId) {
      const rows = db
        .prepare(`
          SELECT id, user_id, name, description, payoff_source, created_at, updated_at
          FROM mockery_user_contract_library
          WHERE user_id = ?
          ORDER BY name COLLATE NOCASE
        `)
        .all(userId) as Array<{
          id: number; user_id: string; name: string; description: string;
          payoff_source: string; created_at: number; updated_at: number;
        }>;
      return rows.map(rowToEntry);
    },
    save(userId, args) {
      const now = Date.now();
      const info = db
        .prepare(`
          INSERT INTO mockery_user_contract_library
            (user_id, name, description, payoff_source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(userId, args.name, args.description, args.payoffSource, now, now);
      return {
        id: info.lastInsertRowid as number,
        userId, name: args.name, description: args.description,
        payoffSource: args.payoffSource, createdAt: now, updatedAt: now,
      };
    },
    update(userId, id, args) {
      const existing = db
        .prepare(`
          SELECT id, user_id, name, description, payoff_source, created_at, updated_at
          FROM mockery_user_contract_library
          WHERE id = ? AND user_id = ?
        `)
        .get(id, userId) as {
          id: number; user_id: string; name: string; description: string;
          payoff_source: string; created_at: number; updated_at: number;
        } | undefined;
      if (!existing) return null;
      const now = Date.now();
      const next = {
        name: args.name ?? existing.name,
        description: args.description ?? existing.description,
        payoffSource: args.payoffSource ?? existing.payoff_source,
      };
      db.prepare(`
        UPDATE mockery_user_contract_library
        SET name = ?, description = ?, payoff_source = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(next.name, next.description, next.payoffSource, now, id, userId);
      return {
        id, userId, name: next.name, description: next.description,
        payoffSource: next.payoffSource,
        createdAt: existing.created_at, updatedAt: now,
      };
    },
    remove(userId, id) {
      const info = db
        .prepare(`DELETE FROM mockery_user_contract_library WHERE id = ? AND user_id = ?`)
        .run(id, userId);
      return info.changes > 0;
    },
  };

  if (!opts?.forceMemory) {
    cached = lib;
    cachedDb = db;
  }
  return lib;
}

/** Test-only: drop the cached singleton so the next getLibrary opens fresh. */
export function resetLibraryForTesting(): void {
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
  cached = null;
}

/** Close the singleton DB connection. Used by integration tests
 *  before tearing down their tmpdir on Windows (where open file
 *  handles block rmdir). */
export function closeLibrary(): void {
  if (cachedDb) {
    try { cachedDb.close(); } catch { /* ignore */ }
    cachedDb = null;
  }
  cached = null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS library_scope_imports (owner TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS mockery_user_contract_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    payoff_source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mockery_user_contract_library_user_id_idx
    ON mockery_user_contract_library (user_id);
`;

function rowToEntry(row: {
  id: number; user_id: string; name: string; description: string;
  payoff_source: string; created_at: number; updated_at: number;
}): LibraryEntry {
  return {
    id: row.id,
    userId: row.user_id as UserId,
    name: row.name,
    description: row.description,
    payoffSource: row.payoff_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
