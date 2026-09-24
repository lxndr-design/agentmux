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
