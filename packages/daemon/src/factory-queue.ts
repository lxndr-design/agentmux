import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_RUNTIME_ID, RUNTIME_IDS, type RuntimeId } from './runtime.js';

/**
 * The code-factory ticket queue (blueprint: "The code factory"). The
 * automation API ships the write edge — `enqueue` — plus point reads;
 * claiming, concurrency slots, budget enforcement, and the
 * `queued → … → pr-opened/failed` state machine live in the scheduler
 * (factory-scheduler.ts, migration 004's scheduler-owned columns) — this
 * store exposes no claim or transition API.
 *
 * Same SQLite file as the event journal (the daemon's single state of
 * record), own mutable table — see migration 003. Ticket text is untrusted
 * input by policy (risk R10): it is stored verbatim and drives nothing here.
 */

export const TICKET_POLICY_CLASSES = ['guarded', 'supervised'] as const;
export type TicketPolicyClass = (typeof TICKET_POLICY_CLASSES)[number];

/** The full factory state model; v1 only ever writes the first entry. */
export const TICKET_STATES = [
  'queued',
  'claimed',
  'running',
  'blocked',
  'verifying',
  'pr-opened',
  'failed',
  'cancelled',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export interface EnqueueTicketInput {
  title: string;
  /** Acceptance criteria — untrusted text, stored verbatim (risk R10). */
  spec: string;
  repo?: string;
  baseBranch?: string;
  runtime?: RuntimeId;
  policyClass?: TicketPolicyClass;
  budgetUsd?: number;
  retries?: number;
  bestOfN?: number;
  /** Budget cap: total tokens (in + out) across the ticket's session. */
  maxTokens?: number;
  /** Budget cap: tool-use steps across the ticket's session. */
  maxSteps?: number;
  /**
   * Verification gate — the operator-authored definition of done, run in the
   * session worktree before the ticket may complete (e.g. "npm test").
   * Operator-authored by construction: it must never be derived from ticket
   * text (risk R10 applies to the future issue-import path twice over).
   */
  verifyCommand?: string;
}

export interface FactoryTicket {
  readonly id: string;
  readonly title: string;
  readonly spec: string;
  readonly repo: string | null;
  readonly baseBranch: string | null;
  readonly runtime: RuntimeId;
  readonly policyClass: TicketPolicyClass;
  readonly budgetUsd: number | null;
  readonly retries: number;
  readonly bestOfN: number;
  readonly maxTokens: number | null;
  readonly maxSteps: number | null;
  readonly verifyCommand: string | null;
  readonly state: TicketState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface QueueRow {
  id: string;
  title: string;
  spec: string;
  repo: string | null;
  base_branch: string | null;
  runtime: string;
  policy_class: string;
  budget_usd: number | null;
  retries: number;
  best_of_n: number;
  max_tokens: number | null;
  max_steps: number | null;
  verify_command: string | null;
  state: string;
  created_at: number;
  updated_at: number;
}

/**
 * The queue-authored column list — INSERT here, and the prefix of every
 * scheduler SELECT (factory-scheduler.ts appends its own columns).
 */
export const TICKET_COLUMNS = `id, title, spec, repo, base_branch, runtime, policy_class,
  budget_usd, retries, best_of_n, max_tokens, max_steps, verify_command,
  state, created_at, updated_at`;

const INSERT_COLUMNS = `(${TICKET_COLUMNS})`;

export class FactoryQueue {
  private readonly insertStmt: Database.Statement<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      number | null,
      number,
      number,
      number | null,
      number | null,
      string | null,
      string,
      number,
      number,
    ]
  >;
  private readonly getStmt: Database.Statement<[string], QueueRow>;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(
      `INSERT INTO factory_tickets ${INSERT_COLUMNS}
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = this.db.prepare(
      `SELECT id, title, spec, repo, base_branch, runtime, policy_class,
              budget_usd, retries, best_of_n, max_tokens, max_steps,
              verify_command, state, created_at, updated_at
       FROM factory_tickets WHERE id = ?`,
    );
  }

  /**
   * Writes one queued ticket — the automation API's enqueue edge, and the
   * queue's entire v1 surface. Defaults are the blueprint ticket schema's
   * own: worktree runtime, `guarded` policy class, 2 retries, 1 candidate.
   */
  enqueue(input: EnqueueTicketInput): FactoryTicket {
    const now = Date.now();
    const runtime = input.runtime ?? (DEFAULT_RUNTIME_ID as RuntimeId);
    const row: QueueRow = {
      id: `tkt_${randomBytes(8).toString('hex')}`,
      title: input.title,
      spec: input.spec,
      repo: input.repo ?? null,
      base_branch: input.baseBranch ?? null,
      runtime,
      policy_class: input.policyClass ?? 'guarded',
      budget_usd: input.budgetUsd ?? null,
      retries: input.retries ?? 2,
      best_of_n: input.bestOfN ?? 1,
      max_tokens: input.maxTokens ?? null,
      max_steps: input.maxSteps ?? null,
      verify_command: input.verifyCommand ?? null,
      state: 'queued',
      created_at: now,
      updated_at: now,
    };
    this.insertStmt.run(
      row.id,
      row.title,
      row.spec,
      row.repo,
      row.base_branch,
      row.runtime,
      row.policy_class,
      row.budget_usd,
      row.retries,
      row.best_of_n,
      row.max_tokens,
      row.max_steps,
      row.verify_command,
      row.state,
      row.created_at,
      row.updated_at,
    );
    return toTicket(row);
  }

  /** One ticket by id, or undefined. */
  get(id: string): FactoryTicket | undefined {
    const row = this.getStmt.get(id);
    return row === undefined ? undefined : toTicket(row);
  }
}

export function toTicket(row: QueueRow): FactoryTicket {
  return {
    id: row.id,
    title: row.title,
    spec: row.spec,
    repo: row.repo,
    baseBranch: row.base_branch,
    runtime: (RUNTIME_IDS as readonly string[]).includes(row.runtime)
      ? (row.runtime as RuntimeId)
      : DEFAULT_RUNTIME_ID,
    policyClass: row.policy_class === 'supervised' ? 'supervised' : 'guarded',
    budgetUsd: row.budget_usd,
    retries: row.retries,
    bestOfN: row.best_of_n,
    maxTokens: row.max_tokens,
    maxSteps: row.max_steps,
    verifyCommand: row.verify_command,
    state: (TICKET_STATES as readonly string[]).includes(row.state)
      ? (row.state as TicketState)
      : 'queued',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
