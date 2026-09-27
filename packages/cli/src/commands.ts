import { DaemonClient } from './client.js';
import { CliError } from './errors.js';

/** Views of the daemon's responses — the fields the CLI prints or returns. */
export interface SessionView {
  readonly id: string;
  readonly state: string;
  readonly connectorId: string;
}

export interface StreamPointer {
  readonly sessionId: string;
  readonly transport: string;
  readonly url: string;
  readonly state: string;
  readonly lastSeq: number;
}

export interface TicketView {
  readonly id: string;
  readonly state: string;
  readonly title: string;
  readonly policyClass: string;
}

export interface RunOptions {
  readonly task: string;
  readonly baseUrl?: string;
  readonly token?: string;
  readonly connectorId?: string;
  readonly sessionId?: string;
}

export interface RunResult {
  readonly session: SessionView;
  readonly stream: StreamPointer;
}

export interface EnqueueTicketOptions {
  readonly title?: string;
  readonly spec?: string;
  readonly baseUrl?: string;
  readonly token?: string;
  readonly repo?: string;
  readonly baseBranch?: string;
  readonly policyClass?: string;
  readonly budgetUsd?: number;
  readonly retries?: number;
  readonly bestOfN?: number;
}

export interface EnqueueTicketResult {
  readonly ticket: TicketView;
}

/**
 * One-shot task dispatch: spawn a session, hand it the task, and return the
 * stream pointer. The agent's own git workflow produces the PR; this command
 * is the entry point, not a pipeline — the daemon's scheduler (code factory)
 * owns ticket-to-verified-PR automation.
 */
export async function runTask(options: RunOptions): Promise<RunResult> {
  const task = options.task.trim();
  if (task.length === 0) {
    throw new CliError('a non-empty task is required — agentmux run "fix the failing tests"', 2);
  }
  const client = new DaemonClient({ baseUrl: options.baseUrl, token: options.token });
  const payload = await client.createSession({
    connectorId: options.connectorId ?? 'claude-code',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    initialTask: task,
  });
  return { session: readSession(payload), stream: readStream(payload) };
}

/** Queue-write only (blueprint: the scheduler task owns execution). */
export async function enqueueTicket(options: EnqueueTicketOptions): Promise<EnqueueTicketResult> {
  const title = requireString(
    options.title,
    'a ticket title is required — --title="Add pagination"',
    2,
  );
  const spec = requireString(
    options.spec,
    'a ticket spec is required — --spec="cursor pagination, tests green"',
    2,
  );
  const policyClass = oneOf(options.policyClass, ['guarded', 'supervised'], '--policy');
  const client = new DaemonClient({ baseUrl: options.baseUrl, token: options.token });
  const payload = await client.enqueueTicket({
    title,
    spec,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
    ...(policyClass === undefined ? {} : { policyClass }),
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.bestOfN === undefined ? {} : { bestOfN: options.bestOfN }),
  });
  const ticket = field(payload, 'ticket', 'ticket');
  return {
    ticket: {
      id: requireString(
        field(ticket, 'id', 'ticket id'),
        'unexpected daemon response — ticket id missing',
      ),
      state: requireString(
        field(ticket, 'state', 'ticket state'),
        'unexpected daemon response — ticket state missing',
      ),
      title: requireString(
        field(ticket, 'title', 'ticket title'),
        'unexpected daemon response — ticket title missing',
      ),
      policyClass: requireString(
        field(ticket, 'policyClass', 'ticket policy class'),
        'unexpected daemon response — ticket policyClass missing',
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Response readers — the CLI trusts the daemon it authenticated with for
// everything except the fields it is about to print; those are asserted.
// ---------------------------------------------------------------------------

function readSession(payload: unknown): SessionView {
  const session = field(payload, 'session', 'session');
  return {
    id: requireString(
      field(session, 'id', 'session id'),
      'unexpected daemon response — session id missing',
    ),
    state: requireString(
      field(session, 'state', 'session state'),
      'unexpected daemon response — session state missing',
    ),
    connectorId: requireString(
      field(session, 'connectorId', 'session connector id'),
      'unexpected daemon response — session connectorId missing',
    ),
  };
}

function readStream(payload: unknown): StreamPointer {
  const stream = field(payload, 'stream', 'stream pointer');
  return {
    sessionId: requireString(
      field(stream, 'sessionId', 'stream session id'),
      'unexpected daemon response — stream sessionId missing',
    ),
    transport: requireString(
      field(stream, 'transport', 'stream transport'),
      'unexpected daemon response — stream transport missing',
    ),
    url: requireString(
      field(stream, 'url', 'stream url'),
      'unexpected daemon response — stream url missing',
    ),
    state: requireString(
      field(stream, 'state', 'stream state'),
      'unexpected daemon response — stream state missing',
    ),
    lastSeq: requireNumber(
      field(stream, 'lastSeq', 'stream lastSeq'),
      'unexpected daemon response — stream lastSeq missing',
    ),
  };
}

function field(parent: unknown, key: string, what: string): unknown {
  if (typeof parent !== 'object' || parent === null || !(key in parent)) {
    throw new CliError(`unexpected daemon response — ${what} missing`);
  }
  return (parent as Record<string, unknown>)[key];
}

function requireString(value: unknown, message: string, exitCode: 1 | 2 = 1): string {
  if (typeof value !== 'string' || value.length === 0) throw new CliError(message, exitCode);
  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CliError(message);
  return value;
}

function oneOf(
  value: string | undefined,
  allowed: readonly string[],
  flag: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new CliError(`${flag} must be one of ${allowed.join('|')}, got '${value}'`, 2);
  }
  return value;
}
