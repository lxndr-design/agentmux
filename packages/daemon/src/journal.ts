import Database from 'better-sqlite3';
import {
  agentEventEnvelopeSchema,
  agentEventSchema,
  createAgentEventEnvelope,
  type AgentEvent,
  type AgentEventEnvelope,
} from '@agentmux/protocol';
import { migrate } from './migrations.js';

interface JournalRow {
  seq: number;
  ts: number;
  kind: string;
  payload: string;
}

interface MaxSeqRow {
  maxSeq: number | null;
}

/**
 * Append-only event journal — the daemon's state of record (blueprint:
 * "Sequencing and replay"). Every envelope is validated against the protocol
 * schema on the way in, stamped with a gapless per-session seq, and stored
 * before anything fans out. Seq assignment happens inside the insert
 * transaction, so counters can never race, and database-level triggers (see
 * migrations) reject any UPDATE or DELETE: once written, history is fixed.
 */
export class EventJournal {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<[string, number, number, string, string]>;
  private readonly replayStmt: Database.Statement<[string, number], JournalRow>;
  private readonly maxSeqStmt: Database.Statement<[string], MaxSeqRow>;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    migrate(this.db);
    this.insertStmt = this.db.prepare(
      'INSERT INTO events (session_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)',
    );
    this.replayStmt = this.db.prepare(
      'SELECT seq, ts, kind, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
    );
    this.maxSeqStmt = this.db.prepare('SELECT MAX(seq) AS maxSeq FROM events WHERE session_id = ?');
  }

  /** Validates the event, then journals it as the session's next envelope. */
  append(sessionId: string, event: AgentEvent): AgentEventEnvelope {
    // Parse before opening the transaction — a protocol violation must throw
    // before anything is written, and the parsed value is what gets stored.
    const parsed = agentEventSchema.parse(event);
    return this.db.transaction(() => {
      const seq = (this.maxSeqStmt.get(sessionId)?.maxSeq ?? -1) + 1;
      const envelope = createAgentEventEnvelope(sessionId, seq, parsed);
      this.insertStmt.run(
        envelope.sessionId,
        envelope.seq,
        envelope.ts,
        parsed.kind,
        JSON.stringify(parsed),
      );
      return envelope;
    })();
  }

  /**
   * Ordered envelopes with seq > fromSeq — the replay-cursor contract. The
   * sentinel for "before the beginning" is -1 (never a legal seq, which the
   * protocol pins to nonnegative integers), so a caller that has seen nothing
   * at all replays seq 0 too.
   */
  replay(sessionId: string, fromSeq = -1): AgentEventEnvelope[] {
    return this.replayStmt.all(sessionId, fromSeq).map((row) =>
      agentEventEnvelopeSchema.parse({
        sessionId,
        seq: row.seq,
        ts: row.ts,
        // Round-trip every stored payload through the protocol schema, so a
        // corrupted journal fails loudly here instead of leaking bad data.
        payload: JSON.parse(row.payload) as unknown,
      }),
    );
  }

  /** Highest journaled seq for the session; undefined when nothing is stored. */
  latestSeq(sessionId: string): number | undefined {
    return this.maxSeqStmt.get(sessionId)?.maxSeq ?? undefined;
  }

  /** Session ids present in the journal, sorted. */
  sessions(): string[] {
    const stmt = this.db.prepare<[], { id: string }>(
      'SELECT DISTINCT session_id AS id FROM events ORDER BY id ASC',
    );
    return stmt.all().map((row) => row.id);
  }

  close(): void {
    this.db.close();
  }
}
