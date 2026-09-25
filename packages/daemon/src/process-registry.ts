import Database from 'better-sqlite3';

/**
 * The durable record of live session process groups — the boot-time orphan
 * reaper's only source of truth (blueprint: "Kill semantics": process-group
 * ids journaled; boot-time reap). Written on every spawn and on every group
 * change a connector reports, deleted the moment a session exits cleanly;
 * a row that survives into the next daemon boot is, by definition, an
 * orphaned agent process. Same SQLite file as the event journal (the
 * daemon's single state of record), own mutable table — see migration 002.
 */

export interface SessionProcessRow {
  sessionId: string;
  pgid: number;
  runtimeId: string;
  cwd: string;
  startedAt: number;
}

interface RegistryRow {
  session_id: string;
  pgid: number;
  runtime_id: string;
  cwd: string;
  started_at: number;
}

export class ProcessRegistry {
  private readonly upsertStmt: Database.Statement<[string, number, string, string, number]>;
  private readonly deleteStmt: Database.Statement<[string]>;
  private readonly getStmt: Database.Statement<[string], RegistryRow>;
  private readonly listStmt: Database.Statement<[], RegistryRow>;

  constructor(private readonly db: Database.Database) {
    this.upsertStmt = this.db.prepare(
      `INSERT INTO session_processes (session_id, pgid, runtime_id, cwd, started_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         pgid = excluded.pgid,
         runtime_id = excluded.runtime_id,
         cwd = excluded.cwd,
         started_at = excluded.started_at`,
    );
    this.deleteStmt = this.db.prepare('DELETE FROM session_processes WHERE session_id = ?');
    this.getStmt = this.db.prepare(
      'SELECT session_id, pgid, runtime_id, cwd, started_at FROM session_processes WHERE session_id = ?',
    );
    this.listStmt = this.db.prepare(
      'SELECT session_id, pgid, runtime_id, cwd, started_at FROM session_processes ORDER BY started_at ASC, session_id ASC',
    );
  }

  /** Records (or updates) the live process group for a session. */
  record(sessionId: string, pgid: number, runtimeId: string, cwd: string): void {
    this.upsertStmt.run(sessionId, pgid, runtimeId, cwd, Date.now());
  }

  /** The session exited — its group is no longer the reaper's business. */
  remove(sessionId: string): void {
    this.deleteStmt.run(sessionId);
  }

  get(sessionId: string): SessionProcessRow | undefined {
    const row = this.getStmt.get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** Every live process group, oldest first — the reaper's worklist. */
  list(): SessionProcessRow[] {
    return this.listStmt.all().map(toRow);
  }
}

function toRow(row: RegistryRow): SessionProcessRow {
  return {
    sessionId: row.session_id,
    pgid: row.pgid,
    runtimeId: row.runtime_id,
    cwd: row.cwd,
    startedAt: row.started_at,
  };
}
