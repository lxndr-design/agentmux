import { exec } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { AgentEvent, ExitInfo } from '@agentmux/protocol';
import {
  TICKET_COLUMNS,
  TICKET_STATES,
  toTicket,
  type FactoryTicket,
  type TicketState,
} from './factory-queue.js';
import type { EventJournal } from './journal.js';
import type { Supervisor } from './supervisor.js';

/**
 * The code-factory scheduler (blueprint: "The code factory" — assumption
 * A-factory): claims queued tickets under a bounded concurrency, spawns each
 * one as a supervised session whose first turn is the ticket spec, enforces
 * per-ticket budget caps against the journaled usage events, runs the
 * ticket's verification gate before it may complete, retries failures with
 * exponential backoff, and records the outcome back on the queue row.
 *
 * Design invariants carried over from the surrounding workstreams:
 *
 * - The journal is the state of record for everything an agent did; the
 *   scheduler derives usage, steps, blocked-state, and exit purely by
 *   replaying it — never by trusting the agent. A scheduler restart
 *   reconstructs all of it, so enforcement survives the daemon.
 * - One session per ticket for its whole life (`factory-<ticketId>`), so a
 *   retry re-enters the SAME worktree and sees its previous attempt's work —
 *   the re-prompt is "fix what you did", not "start over".
 * - Ticket text is untrusted input (risk R10): it drives the agent's task
 *   prompt, never the scheduler's decisions. The verify command is
 *   operator-authored at enqueue time and must stay that way — the future
 *   issue-import path must never map issue text into it.
 * - Budget caps are hard stops with poll-latency overshoot: enforcement
 *   reads journaled usage on each tick, so the cap is crossed by at most one
 *   tick of spend before the session is killed. This is inherent to
 *   post-hoc enforcement, not a tuning parameter to hide.
 *
 * The tick loop is deliberately synchronous against SQLite (single writer,
 * transactional claim) and fires spawns/gates as tracked promises; `tick()`
 * resolves only when everything it fired has settled, which makes the loop
 * deterministic under test with the autoStart timer off.
 */

/** How the factory prices tokens, when the operator configures it. */
export interface TokenPricing {
  /** USD per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** USD per million output tokens. */
  readonly outputUsdPerMTok: number;
}

/** Terminal outcomes. The scheduler writes `pr-opened`/`failed`/`exhausted`; `merged` is recorded externally after a PR merges; `cancelled` is the fleet kill switch's. */
export const TICKET_OUTCOMES = ['pr-opened', 'merged', 'failed', 'exhausted', 'cancelled'] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

/** What one ticket's session has spent, as measured from the journal. */
export interface UsageSnapshot {
  tokensIn: number;
  tokensOut: number;
  /** Tool-use events — the natural unit for a "step" cap. */
  steps: number;
}

const ZERO_USAGE: UsageSnapshot = { tokensIn: 0, tokensOut: 0, steps: 0 };

/** Exponential backoff with a cap: attempt 1 → base, attempt n → base·2ⁿ⁻¹. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt <= 1) return Math.min(baseMs, maxMs);
  const exponent = Math.min(attempt - 1, 16); // 2^16 is far past any real cap
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

export interface BudgetVerdict {
  exceeded: boolean;
  /** Which cap bound first, when exceeded. */
  cap?: 'tokens' | 'steps' | 'cost';
  detail?: string;
}

/**
 * Pure budget evaluation: which cap (if any) has the usage crossed. Checks
 * run tokens → steps → cost so the cheapest, least ambiguous cap reports
 * first. A `budgetUsd` cap without configured pricing is not silently
 * ignored — the scheduler surfaces pricing state in `status()` and warns at
 * boot; it is never invented here.
 */
export function evaluateBudget(
  usage: UsageSnapshot,
  caps: { maxTokens?: number | null; maxSteps?: number | null; budgetUsd?: number | null },
  pricing: TokenPricing | null,
): BudgetVerdict {
  const tokens = usage.tokensIn + usage.tokensOut;
  if (caps.maxTokens !== null && caps.maxTokens !== undefined && tokens > caps.maxTokens) {
    return {
      exceeded: true,
      cap: 'tokens',
      detail: `token cap ${caps.maxTokens} exceeded (used ${tokens})`,
    };
  }
  if (caps.maxSteps !== null && caps.maxSteps !== undefined && usage.steps > caps.maxSteps) {
    return {
      exceeded: true,
      cap: 'steps',
      detail: `step cap ${caps.maxSteps} exceeded (used ${usage.steps})`,
    };
  }
  if (caps.budgetUsd !== null && caps.budgetUsd !== undefined) {
    if (pricing === null) return { exceeded: false };
    const cost =
      (usage.tokensIn * pricing.inputUsdPerMTok + usage.tokensOut * pricing.outputUsdPerMTok) /
      1_000_000;
    if (cost > caps.budgetUsd) {
      return {
        exceeded: true,
        cap: 'cost',
        detail: `cost cap $${caps.budgetUsd} exceeded (estimated $${cost.toFixed(4)})`,
      };
    }
  }
  return { exceeded: false };
}

/** Everything the gate needs to judge one attempt. */
export interface VerifyRequest {
  ticket: FactoryTicket;
  /** The session's worktree — the gate runs here, not in the main checkout. */
  cwd: string;
  /** The session's terminal exit, when the journal recorded one. */
  exit: ExitInfo | null;
}

export interface VerifyResult {
  passed: boolean;
  /** Output tail — the retry prompt's "what failed" context. */
  output: string;
}

export interface VerifyRunner {
  run(request: VerifyRequest): Promise<VerifyResult>;
}

/**
 * The production gate: a crashed run fails outright; otherwise a ticket's
 * verify command (operator-authored — see the enqueue schema) runs in the
 * worktree, and exit code 0 passes. A ticket with no command gates on the
 * session's own clean exit — the weakest honest gate.
 */
export class ExecVerifyRunner implements VerifyRunner {
  constructor(private readonly timeoutMs: number) {}

  async run(request: VerifyRequest): Promise<VerifyResult> {
    const { ticket, cwd, exit } = request;
    if (exit !== null && exit.code !== 0) {
      const reason = exit.reason === undefined ? '' : ` (${exit.reason})`;
      return { passed: false, output: `session exited with code ${exit.code}${reason}` };
    }
    const command = ticket.verifyCommand;
    if (command === null) {
      return { passed: true, output: 'session exited cleanly (no verify command configured)' };
    }
    return new Promise<VerifyResult>((resolve) => {
      // Shell execution is deliberate: the operator wrote this command and
      // may need PATH resolution, pipes, and chaining, exactly as typed.
      exec(
        command,
        { cwd, timeout: this.timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (error === null) {
            resolve({ passed: true, output: output === '' ? `exit 0` : tail(output) });
            return;
          }
          const timedOut = error.killed === true;
          const body = output === '' ? error.message : tail(output);
          resolve({
            passed: false,
            output: timedOut ? `${body}\n(verification command timed out)` : body,
          });
        },
      );
    });
  }
}

export interface FactorySchedulerConfig {
  /** Concurrent tickets, each holding one runtime slot. Default 4 (Q9). */
  concurrency?: number;
  /** Journal poll cadence. Default 500ms. */
  tickMs?: number;
  /** Backoff base after attempt n's failure: base·2ⁿ⁻¹. Default 2s. */
  baseBackoffMs?: number;
  /** Backoff ceiling. Default 60s. */
  maxBackoffMs?: number;
  /** Verify-command budget. Default 120s. */
  verifyTimeoutMs?: number;
  /** Which installed connector runs factory sessions. Default 'claude-code'. */
  connectorId?: string;
  /** Optional model passthrough to every factory session. */
  model?: string;
  /**
   * Token pricing for `budgetUsd` enforcement. Null (the default) means
   * cost caps cannot be computed and are surfaced as unenforced — token and
   * step caps still work without it.
   */
  pricing?: TokenPricing | null;
  /** Arm the tick timer at construction. Tests drive `tick()` manually. */
  autoStart?: boolean;
}

export interface ResolvedFactoryConfig extends Required<
  Omit<FactorySchedulerConfig, 'pricing' | 'model'>
> {
  pricing: TokenPricing | null;
  model: string | undefined;
}

export function resolveFactoryConfig(config: FactorySchedulerConfig = {}): ResolvedFactoryConfig {
  const concurrency = config.concurrency ?? 4;
  const tickMs = config.tickMs ?? 500;
  const baseBackoffMs = config.baseBackoffMs ?? 2_000;
  const maxBackoffMs = config.maxBackoffMs ?? 60_000;
  const verifyTimeoutMs = config.verifyTimeoutMs ?? 120_000;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`factory concurrency must be a positive integer, got ${concurrency}`);
  }
  if (tickMs <= 0 || baseBackoffMs < 0 || maxBackoffMs < baseBackoffMs) {
    throw new Error('factory tickMs must be positive and maxBackoffMs >= baseBackoffMs >= 0');
  }
  if (verifyTimeoutMs <= 0) throw new Error('factory verifyTimeoutMs must be positive');
  return {
    concurrency,
    tickMs,
    baseBackoffMs,
    maxBackoffMs,
    verifyTimeoutMs,
    connectorId: config.connectorId ?? 'claude-code',
    model: config.model,
    pricing: config.pricing ?? null,
    autoStart: config.autoStart ?? true,
  };
}

export interface FactorySchedulerOptions extends FactorySchedulerConfig {
  queue: unknown;
  journal: EventJournal;
  supervisor: Supervisor;
  /** Clock seam — tests pin time instead of sleeping. */
  now?: () => number;
  verifyRunner?: VerifyRunner;
}

export interface FactoryStatus {
  /** True while the tick timer is armed. */
  running: boolean;
  concurrency: { limit: number; active: number };
  counts: Record<TicketState, number>;
  /** Null when unset: `budgetUsd` cost caps are surfaced as unenforced. */
  pricing: TokenPricing | null;
}

/** A ticket plus everything the scheduler knows about its run. */
export interface FactoryTicketView {
  id: string;
  title: string;
  spec: string;
  repo: string | null;
  baseBranch: string | null;
  runtime: string;
  policyClass: string;
  budgetUsd: number | null;
  retries: number;
  bestOfN: number;
  maxTokens: number | null;
  maxSteps: number | null;
  verifyCommand: string | null;
  state: TicketState;
  createdAt: number;
  updatedAt: number;
  attempt: number;
  sessionId: string | null;
  sessionCwd: string | null;
  /** Earliest time the next attempt may be claimed (backoff), null when now. */
  nextAttemptAt: number | null;
  outcome: TicketOutcome | null;
  /** The last attempt's closing note — failure reason, or the success line. */
  outcomeDetail: string | null;
  usage: UsageSnapshot;
}

interface SchedulerRow {
  id: string;
  attempt: number;
  session_id: string | null;
  session_cwd: string | null;
  next_attempt_at: number | null;
  outcome: string | null;
  outcome_detail: string | null;
  // queue-authored columns, parsed by toTicket
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

interface UsageTracker extends UsageSnapshot {
  lastSeq: number;
}

const SCHEDULER_COLUMNS = `${TICKET_COLUMNS}, attempt, session_id, session_cwd, next_attempt_at, outcome, outcome_detail`;
const ACTIVE_STATES: readonly TicketState[] = ['claimed', 'running', 'blocked', 'verifying'];
const DETAIL_TAIL_CHARS = 4_000;

function tail(text: string, max = DETAIL_TAIL_CHARS): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/** Folds one journaled event into a usage snapshot. */
function accumulateUsage(usage: UsageSnapshot, event: AgentEvent): void {
  if (event.kind === 'usage') {
    usage.tokensIn += event.tokensIn;
    usage.tokensOut += event.tokensOut;
  } else if (event.kind === 'tool_use') {
    usage.steps += 1;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FactoryScheduler {
  private readonly db: Database.Database;
  private readonly journal: EventJournal;
  private readonly supervisor: Supervisor;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly tickMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pricing: TokenPricing | null;
  private readonly connectorId: string;
  private readonly model: string | undefined;
  private readonly verifyRunner: VerifyRunner;

  private readonly rowStmt: Database.Statement<[string], SchedulerRow>;
  private readonly listStmt: Database.Statement<[], SchedulerRow>;
  private readonly countStmt: Database.Statement<[], { state: string; n: number }>;
  private readonly claimSelectStmt: Database.Statement<[number], SchedulerRow>;
  private readonly claimUpdateStmt: Database.Statement<[number, string]>;
  private readonly updateStmt: Database.Statement<
    [
      string,
      string | null,
      string | null,
      number | null,
      string | null,
      string | null,
      number,
      string,
    ]
  >;

  private readonly trackers = new Map<string, UsageTracker>();
  /** Tickets with a spawn in flight — the guard against double-spawning. */
  private readonly spawning = new Set<string>();
  /** Tickets with a verification gate in flight. */
  private readonly verifying = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private reconciledBoot = false;

  constructor(options: FactorySchedulerOptions) {
    const resolved = resolveFactoryConfig(options);
    this.db = options.journal.database;
    this.journal = options.journal;
    this.supervisor = options.supervisor;
    this.now = options.now ?? Date.now;
    this.concurrency = resolved.concurrency;
    this.tickMs = resolved.tickMs;
    this.baseBackoffMs = resolved.baseBackoffMs;
    this.maxBackoffMs = resolved.maxBackoffMs;
    this.pricing = resolved.pricing;
    this.connectorId = resolved.connectorId;
    this.model = resolved.model;
    this.verifyRunner = options.verifyRunner ?? new ExecVerifyRunner(resolved.verifyTimeoutMs);

    this.rowStmt = this.db.prepare(`SELECT ${SCHEDULER_COLUMNS} FROM factory_tickets WHERE id = ?`);
    this.listStmt = this.db.prepare(
      `SELECT ${SCHEDULER_COLUMNS} FROM factory_tickets ORDER BY created_at, id`,
    );
    this.countStmt = this.db.prepare(
      'SELECT state, COUNT(*) AS n FROM factory_tickets GROUP BY state',
    );
    this.claimSelectStmt = this.db.prepare(
      `SELECT ${SCHEDULER_COLUMNS} FROM factory_tickets
       WHERE state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, id LIMIT 1`,
    );
    this.claimUpdateStmt = this.db.prepare(
      `UPDATE factory_tickets
       SET state = 'claimed', attempt = attempt + 1, next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.updateStmt = this.db.prepare(
      `UPDATE factory_tickets
       SET state = ?, session_id = ?, session_cwd = ?, next_attempt_at = ?,
           outcome = ?, outcome_detail = ?, updated_at = ?
       WHERE id = ?`,
    );

    if (this.pricing === null) {
      const priced = this.db
        .prepare('SELECT COUNT(*) AS n FROM factory_tickets WHERE budget_usd IS NOT NULL')
        .get() as { n: number } | undefined;
      if ((priced?.n ?? 0) > 0) {
        console.warn(
          'agentmux: factory tickets carry budgetUsd but no token pricing is configured — cost caps are not enforced (token and step caps are); configure factory.pricing to enable them',
        );
      }
    }

    // void — options.queue is carried for identity in the daemon handle; all
    // queue access here is through this scheduler's own statements.
    void options.queue;

    if (resolved.autoStart) this.start();
  }

  /** Arms the tick timer. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
  }

  /** Disarms the tick timer; in-flight spawns and gates finish on their own. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One scheduler pass: poll the journal for every in-flight ticket (usage,
   * steps, blocked state, exits — and act on all of them), then claim queued
   * tickets into free slots. Resolves after everything this pass spawned or
   * gated has settled, so a test driving `tick()` sees a quiescent machine.
   */
  async tick(): Promise<void> {
    this.fireTick();
    await this.idle();
  }

  /** Resolves when no spawn or verification gate is in flight. */
  idle(): Promise<unknown> {
    return Promise.allSettled([...this.pending]);
  }

  /** Factory status — GET /api/factory's body. */
  status(): FactoryStatus {
    const counts = zeroedCounts();
    for (const row of this.countStmt.all()) {
      if ((TICKET_STATES as readonly string[]).includes(row.state)) {
        counts[row.state as TicketState] = row.n;
      }
    }
    const active = ACTIVE_STATES.reduce((sum, state) => sum + counts[state], 0);
    return {
      running: this.timer !== null,
      concurrency: { limit: this.concurrency, active },
      counts,
      pricing: this.pricing,
    };
  }

  /** Every ticket with scheduler state and measured usage — GET /api/factory/tickets. */
  listTickets(): FactoryTicketView[] {
    return this.listStmt.all().map((row) => this.toView(row));
  }

  // ── tick phases ──────────────────────────────────────────────────────────

  private fireTick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcileBootOnce();
      this.pollInFlight();
      this.claimUpToConcurrency();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Once per process: tickets found in flight at boot belong to a previous
   * daemon run. One whose session already reached a terminal state still
   * gets its verification gate (the worktree survived); one that died with
   * the daemon — or that was claimed but never spawned — goes through the
   * ordinary failure path. Live sessions (impossible in a fresh supervisor,
   * but true when reconcile runs in-process during tests) are left alone.
   */
  private reconcileBootOnce(): void {
    if (this.reconciledBoot) return;
    this.reconciledBoot = true;
    for (const row of this.listStmt.all()) {
      if (!(ACTIVE_STATES as readonly string[]).includes(row.state)) continue;
      if (this.spawning.has(row.id) || this.verifying.has(row.id)) continue;
      if (row.state === 'claimed' || row.session_id === null) {
        this.failAttempt(row, 'daemon restarted before the session spawned');
        continue;
      }
      const sessionId = row.session_id;
      const terminal = this.findTerminalEvent(sessionId);
      if (terminal !== null) {
        this.beginVerification(row, terminal.exit);
        continue;
      }
      if (this.supervisor.get(sessionId) !== undefined) continue;
      this.failAttempt(row, 'session lost to a daemon restart');
    }
  }

  private pollInFlight(): void {
    for (const row of this.listStmt.all()) {
      if (row.state !== 'running' && row.state !== 'blocked') continue;
      if (row.session_id === null) continue; // unreachable: running implies a session
      this.pollSession(row);
    }
  }

  /**
   * Replays the session's journal tail into the usage tracker, then applies
   * the batch in priority order: a crossed budget cap outranks everything
   * (hard stop, even if the batch also carried the terminal event); a
   * terminal event dispatches the verification gate; otherwise the last
   * phase change is reflected onto the ticket (waiting-approval → blocked).
   */
  private pollSession(row: SchedulerRow): void {
    const sessionId = row.session_id as string;
    // The cursor starts empty and the loop below consumes the WHOLE backlog —
    // a tracker must never skip events it has not processed (a fresh tracker
    // that fast-forwards to the journal's newest seq would swallow exactly
    // the terminal/budget events this poll exists to see).
    const tracker = this.pollTracker(sessionId);
    let phase: 'running' | 'blocked' | null = null;
    let terminal: { exit: ExitInfo | null } | null = null;
    for (const envelope of this.journal.replay(sessionId)) {
      if (envelope.seq <= tracker.lastSeq) continue;
      tracker.lastSeq = envelope.seq;
      accumulateUsage(tracker, envelope.payload);
      const event = envelope.payload;
      if (event.kind === 'state_change') {
        if (event.to === 'waiting-approval') phase = 'blocked';
        else if (event.to === 'working' || event.to === 'ready') phase = 'running';
        if (event.to === 'stopped' || event.to === 'crashed') {
          terminal = { exit: event.exit ?? null };
        }
      }
    }

    const verdict = evaluateBudget(
      { tokensIn: tracker.tokensIn, tokensOut: tracker.tokensOut, steps: tracker.steps },
      { maxTokens: row.max_tokens, maxSteps: row.max_steps, budgetUsd: row.budget_usd },
      this.pricing,
    );
    if (verdict.exceeded) {
      this.exhaustTicket(row, verdict);
      return;
    }
    if (terminal !== null) {
      this.beginVerification(row, terminal.exit);
      return;
    }
    if (phase === 'blocked' && row.state !== 'blocked') {
      this.transition(row.id, { state: 'blocked' });
    } else if (phase === 'running' && row.state !== 'running') {
      this.transition(row.id, { state: 'running' });
    }
  }

  // ── claim + spawn ────────────────────────────────────────────────────────

  private claimUpToConcurrency(): void {
    while (this.activeCount() < this.concurrency) {
      const row = this.claimNext();
      if (row === undefined) return;
      this.spawnTicket(row);
    }
  }

  private activeCount(): number {
    const counts = this.status().counts;
    return ACTIVE_STATES.reduce((sum, state) => sum + counts[state], 0);
  }

  /**
   * The concurrency-safe claim: select the oldest eligible queued ticket and
   * bump its attempt inside one transaction (better-sqlite3 is synchronous —
   * nothing can interleave inside the closure). The attempt counter advances
   * at claim time, so a crash between claim and spawn honestly consumed an
   * attempt of the retry budget.
   */
  private claimNext(): SchedulerRow | undefined {
    const nowMs = this.now();
    return this.db.transaction(() => {
      const row = this.claimSelectStmt.get(nowMs);
      if (row === undefined) return undefined;
      this.claimUpdateStmt.run(nowMs, row.id);
      return this.rowStmt.get(row.id);
    })();
  }

  private spawnTicket(row: SchedulerRow): void {
    const sessionId = `factory-${row.id}`;
    this.spawning.add(row.id);
    const previousFailure = row.outcome_detail;
    const op = (async () => {
      // Idempotent by the connector contract (a settled session's kill is a
      // no-op) — clears the previous attempt's supervisor entry so start()
      // can re-enter the same worktree under the same session id.
      await this.supervisor.kill(sessionId).catch(() => undefined);
      const view = await this.supervisor.start({
        sessionId,
        connectorId: this.connectorId,
        permissionMode: 'default',
        model: this.model,
        useMainCheckout: row.runtime === 'local',
        initialTask: this.composeTask(row, previousFailure),
      });
      this.transition(row.id, {
        state: 'running',
        sessionId,
        sessionCwd: view.cwd,
        outcomeDetail: null,
      });
    })()
      .catch((error: unknown) => {
        const current = this.rowStmt.get(row.id);
        if (current !== undefined) this.failAttempt(current, `spawn failed: ${describe(error)}`);
      })
      .finally(() => {
        this.spawning.delete(row.id);
      });
    this.track(op);
  }

  /**
   * The task prompt: the spec verbatim on the first attempt; on a retry, the
   * spec plus the last failure's tail — the blueprint's "re-prompt with the
   * failing output". Never anything derived from the spec itself (risk R10).
   */
  private composeTask(row: SchedulerRow, previousFailure: string | null): string {
    if (previousFailure === null || row.attempt <= 1) return row.spec;
    return `${row.spec}\n\n---\nYour previous attempt (attempt ${row.attempt - 1} of ${row.retries + 1}) ended in failure:\n${tail(previousFailure, 2_000)}\nFix what failed and complete the task.`;
  }

  // ── endings ──────────────────────────────────────────────────────────────

  /**
   * The failure path, shared by spawn errors, crashes, and red gates:
   * another attempt if the retry budget allows (queued with exponential
   * backoff), otherwise terminal `failed`.
   */
  private failAttempt(row: SchedulerRow, reason: string): void {
    const attemptsMade = row.attempt;
    if (attemptsMade > row.retries) {
      this.transition(row.id, { state: 'failed', outcome: 'failed', outcomeDetail: reason });
      return;
    }
    const delay = backoffDelayMs(attemptsMade, this.baseBackoffMs, this.maxBackoffMs);
    this.transition(row.id, {
      state: 'queued',
      nextAttemptAt: this.now() + delay,
      outcomeDetail: reason,
    });
  }

  /** Budget cap crossed: kill the session, record `exhausted`. No retry — a ticket over budget stays over budget. */
  private exhaustTicket(row: SchedulerRow, verdict: BudgetVerdict): void {
    if (row.session_id !== null) {
      void this.supervisor.kill(row.session_id).catch(() => undefined);
    }
    this.transition(row.id, {
      state: 'failed',
      outcome: 'exhausted',
      outcomeDetail: `budget exhausted — ${verdict.detail ?? 'cap crossed'}`,
    });
  }

  private beginVerification(row: SchedulerRow, exit: ExitInfo | null): void {
    const sessionId = row.session_id;
    if (sessionId === null || row.session_cwd === null) {
      // Unreachable: a running ticket always carries both (set at spawn).
      this.failAttempt(row, 'verification skipped — session record incomplete');
      return;
    }
    this.transition(row.id, { state: 'verifying' });
    this.verifying.add(row.id);
    const op = this.verifyRunner
      .run({ ticket: toTicket(row), cwd: row.session_cwd, exit })
      .then((result) => {
        const current = this.rowStmt.get(row.id);
        if (current === undefined) return;
        if (result.passed) {
          this.transition(current.id, {
            state: 'pr-opened',
            outcome: 'pr-opened',
            outcomeDetail: `verified — ${result.output}`,
          });
        } else {
          this.failAttempt(current, `verification failed: ${tail(result.output)}`);
        }
      })
      .catch((error: unknown) => {
        const current = this.rowStmt.get(row.id);
        if (current !== undefined) {
          this.failAttempt(current, `verification gate error: ${describe(error)}`);
        }
      })
      .finally(() => {
        this.verifying.delete(row.id);
      });
    this.track(op);
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private transition(
    id: string,
    fields: {
      state: TicketState;
      sessionId?: string | null;
      sessionCwd?: string | null;
      nextAttemptAt?: number | null;
      outcome?: TicketOutcome | null;
      outcomeDetail?: string | null;
    },
  ): void {
    const row = this.rowStmt.get(id);
    if (row === undefined) return;
    this.db.transaction(() => {
      this.updateStmt.run(
        fields.state,
        fields.sessionId !== undefined ? fields.sessionId : row.session_id,
        fields.sessionCwd !== undefined ? fields.sessionCwd : row.session_cwd,
        fields.nextAttemptAt !== undefined ? fields.nextAttemptAt : row.next_attempt_at,
        fields.outcome !== undefined ? fields.outcome : row.outcome,
        fields.outcomeDetail !== undefined ? fields.outcomeDetail : row.outcome_detail,
        this.now(),
        id,
      );
    })();
  }

  /** The poll cursor for a session — empty on first sight, never fast-forwarded. */
  private pollTracker(sessionId: string): UsageTracker {
    let tracker = this.trackers.get(sessionId);
    if (tracker === undefined) {
      tracker = { lastSeq: -1, tokensIn: 0, tokensOut: 0, steps: 0 };
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /** Fresh usage snapshot straight from the journal — the read model's view. */
  private usageFor(sessionId: string): UsageSnapshot {
    const usage: UsageSnapshot = { tokensIn: 0, tokensOut: 0, steps: 0 };
    for (const envelope of this.journal.replay(sessionId)) {
      accumulateUsage(usage, envelope.payload);
    }
    return usage;
  }

  /** The session's terminal state_change, when the journal has one. */
  private findTerminalEvent(sessionId: string): { exit: ExitInfo | null } | null {
    for (const envelope of this.journal.replay(sessionId)) {
      const event = envelope.payload;
      if (event.kind === 'state_change' && (event.to === 'stopped' || event.to === 'crashed')) {
        return { exit: event.exit ?? null };
      }
    }
    return null;
  }

  private toView(row: SchedulerRow): FactoryTicketView {
    const usage = row.session_id === null ? ZERO_USAGE : this.usageFor(row.session_id);
    return {
      ...toTicket(row),
      attempt: row.attempt,
      sessionId: row.session_id,
      sessionCwd: row.session_cwd,
      nextAttemptAt: row.next_attempt_at,
      outcome: (TICKET_OUTCOMES as readonly string[]).includes(row.outcome ?? '')
        ? (row.outcome as TicketOutcome)
        : null,
      outcomeDetail: row.outcome_detail,
      usage: { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, steps: usage.steps },
    };
  }

  private track(promise: Promise<unknown>): void {
    const wrapped = promise
      .catch((error: unknown) => {
        // Handler bugs must surface, not take the daemon down.
        console.warn(
          `agentmux: factory scheduler operation failed unexpectedly: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.pending.delete(wrapped);
      });
    this.pending.add(wrapped);
  }
}

function zeroedCounts(): Record<TicketState, number> {
  const counts = {} as Record<TicketState, number>;
  for (const state of TICKET_STATES) counts[state] = 0;
  return counts;
}
