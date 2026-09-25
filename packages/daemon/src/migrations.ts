import type { Database } from 'better-sqlite3';

/**
 * Versioned schema migrations, applied in order at boot. `PRAGMA user_version`
 * records how many have applied; each runs in its own transaction, so a failed
 * migration never leaves the journal half-migrated.
 *
 * 001 — the event journal. The composite primary key (session_id, seq) turns a
 * duplicate seq into a storage error rather than a rebind bug, and the two
 * triggers make the journal append-only at the database level: the API surface
 * is the first guard, these are the second.
 *
 * 002 — the live session process registry. The daemon journals every live
 * process group here so a crashed daemon's orphaned agent processes can be
 * identified and reaped at the next boot (blueprint: "Kill semantics" —
 * "Process-group ids journaled; boot-time reap"). Unlike `events` this table
 * is mutable: rows are upserted on spawn and deleted on clean exit.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    ts         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;

  CREATE TRIGGER events_append_only_update
    BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'agentmux journal is append-only');
  END;

  CREATE TRIGGER events_append_only_delete
    BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'agentmux journal is append-only');
  END;
  `,
  `
  CREATE TABLE session_processes (
    session_id TEXT PRIMARY KEY,
    pgid       INTEGER NOT NULL,
    runtime_id TEXT    NOT NULL,
    cwd        TEXT    NOT NULL,
    started_at INTEGER NOT NULL
  );
  `,
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const [offset, migration] of MIGRATIONS.entries()) {
    const version = offset + 1;
    if (current >= version) continue;
    db.transaction(() => {
      db.exec(migration);
      db.pragma(`user_version = ${version}`, { simple: true });
    })();
  }
}
