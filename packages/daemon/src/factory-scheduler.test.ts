import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ExitInfo } from '@agentmux/protocol';
import type {
  AgentConnector,
  AgentSession,
  ConnectorDetectResult,
  SessionEventSink,
  SessionSpawnConfig,
} from './connectors/types.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { FactoryQueue } from './factory-queue.js';
import {
  ExecVerifyRunner,
  FactoryScheduler,
  backoffDelayMs,
  evaluateBudget,
  type FactoryTicketView,
  type VerifyRequest,
  type VerifyResult,
  type VerifyRunner,
} from './factory-scheduler.js';
import { EventJournal } from './journal.js';
import type { Runtime, RuntimeId, RuntimeProvision, RuntimeRequest } from './runtime.js';
import { ProcessRegistry } from './process-registry.js';
import { Supervisor } from './supervisor.js';

/**
 * The code-factory scheduler's tests. Sessions are scripted connectors (the
 * connector suites cover the real CLIs); the end-to-end case boots the real
 * daemon so enqueue → claim → spawn → journal → verify → outcome is proven
 * over the actual HTTP surface, not against stubs that agree with themselves.
 */

const dirs: string[] = [];
const openDaemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const handle of openDaemons.splice(0)) {
    await handle.close();
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The scheduler's read model — the only surface that carries run state. */
function viewOf(rig: Rig, ticketId: string): FactoryTicketView | undefined {
  return rig.scheduler.listTickets().find((ticket) => ticket.id === ticketId);
}

/** A per-session workspace map — the Runtime contract without git underneath. */
class StubRuntime implements Runtime {
  readonly id: RuntimeId;
  readonly workspaceRoot: string;
  private readonly homes = new Map<string, string>();

  constructor(id: RuntimeId, workspaceRoot: string) {
    this.id = id;
    this.workspaceRoot = workspaceRoot;
  }

  async provision(request: RuntimeRequest): Promise<RuntimeProvision> {
    const existing = this.homes.get(request.sessionId);
    if (existing !== undefined) {
      return {
        sessionId: request.sessionId,
        runtime: this.id,
        cwd: existing,
        branch: null,
        reused: true,
      };
    }
    const cwd = join(this.workspaceRoot, request.sessionId);
    // A real runtime always leaves a usable directory behind — the gate runs
    // here, so the stub must too.
    mkdirSync(cwd, { recursive: true });
    this.homes.set(request.sessionId, cwd);
    return { sessionId: request.sessionId, runtime: this.id, cwd, branch: null, reused: false };
  }

  env(): Record<string, string> {
    return { AGENTMUX_RUNTIME: this.id };
  }

  async release(): Promise<boolean> {
    return false;
  }
}

/**
 * Records spawns and hands out sessions whose events and exits settle on
 * demand. Events flow through the real sink (supervisor ingest → journal),
 * so the scheduler reads exactly what a real connector would have written.
 */
class ScriptedConnector implements AgentConnector {
  readonly id = 'scripted';
  readonly spawned: SessionSpawnConfig[] = [];
  /** User turns delivered per session id — the supervisor forwards initialTask here. */
  readonly sent = new Map<string, string[]>();
  readonly killed: string[] = [];
  private readonly sinks = new Map<string, SessionEventSink>();
  private readonly exits = new Map<string, (info: ExitInfo) => void>();

  async detect(): Promise<ConnectorDetectResult> {
    return { installed: true, version: 'scripted-1' };
  }

  async spawn(config: SessionSpawnConfig, sink: SessionEventSink): Promise<AgentSession> {
    if (this.spawnShouldFail) throw new Error('connector is down');
    this.spawned.push(config);
    this.sinks.set(config.sessionId, sink);
    return {
      id: config.sessionId,
      state: 'ready',
      send: (text: string) => {
        const turns = this.sent.get(config.sessionId) ?? [];
        turns.push(text);
        this.sent.set(config.sessionId, turns);
      },
      respondToApproval: () => {},
      kill: async () => {
        this.killed.push(config.sessionId);
        this.finish(config.sessionId, { code: 0 });
        return { code: 0 };
      },
      exit: new Promise<ExitInfo>((resolve) => {
        this.exits.set(config.sessionId, resolve);
      }),
    };
  }

  /** When set, the next spawn throws — the spawn-failure path. */
  spawnShouldFail = false;

  /** Test seam — journal one normalized event into a live session. */
  emit(sessionId: string, event: AgentEvent): void {
    this.sinks.get(sessionId)?.onEvent(event);
  }

  /** Test seam — the session reaches a terminal state. */
  finish(sessionId: string, exit: ExitInfo = { code: 0 }): void {
    this.sinks.get(sessionId)?.onEvent({
      kind: 'state_change',
      from: 'working',
      to: 'stopped',
      exit,
    });
    this.exits.get(sessionId)?.(exit);
  }
}

/** A controllable gate: scripted results, recorded requests. */
class StubVerifyRunner implements VerifyRunner {
  readonly calls: VerifyRequest[] = [];
  constructor(private readonly results: Array<VerifyResult | Error> = []) {}

  async run(request: VerifyRequest): Promise<VerifyResult> {
    this.calls.push(request);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? { passed: true, output: 'stub gate passed' };
  }
}

const TOOL_USE: AgentEvent = {
  kind: 'tool_use',
  callId: 'c1',
  tool: 'Bash',
  detail: { command: 'ls' },
};

interface Rig {
  clock: { nowMs: number };
  connector: ScriptedConnector;
  journal: EventJournal;
  queue: FactoryQueue;
  scheduler: FactoryScheduler;
  workspaceRoot: string;
}

function makeRig(
  options: {
    concurrency?: number;
    baseBackoffMs?: number;
    verifyRunner?: VerifyRunner;
    pricing?: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
    journalPath?: string;
  } = {},
): Rig {
  const journal = new EventJournal(
    options.journalPath ?? join(tempRoot('agentmux-factory-'), 'j.sqlite3'),
  );
  const connector = new ScriptedConnector();
  const clock = { nowMs: 1_000_000 };
  const workspaceRoot = tempRoot('agentmux-factory-ws-');
  const supervisor = new Supervisor({
    runtimes: { worktree: new StubRuntime('worktree', workspaceRoot) },
    defaultRuntimeId: 'worktree',
    registry: new ProcessRegistry(journal.database),
    ingest: (sessionId, event) => journal.append(sessionId, event),
    connectors: new Map<string, AgentConnector>([['scripted', connector]]),
  });
  const queue = new FactoryQueue(journal.database);
  const scheduler = new FactoryScheduler({
    queue,
    journal,
    supervisor,
    connectorId: 'scripted',
    concurrency: options.concurrency,
    baseBackoffMs: options.baseBackoffMs,
    pricing: options.pricing,
    verifyRunner: options.verifyRunner,
    autoStart: false,
    now: () => clock.nowMs,
  });
  return { clock, connector, journal, queue, scheduler, workspaceRoot };
}

const sessionIdFor = (ticketId: string): string => `factory-${ticketId}`;

async function until<T>(
  probe: () => T | undefined | null | Promise<T | undefined | null>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('backoffDelayMs', () => {
  it('doubles from the base and caps', () => {
    expect(backoffDelayMs(1, 2_000, 60_000)).toBe(2_000);
    expect(backoffDelayMs(2, 2_000, 60_000)).toBe(4_000);
    expect(backoffDelayMs(3, 2_000, 60_000)).toBe(8_000);
    expect(backoffDelayMs(4, 2_000, 10_000)).toBe(10_000);
  });

  it('never produces a delay above the cap, even at extreme attempts', () => {
    expect(backoffDelayMs(30, 2_000, 60_000)).toBe(60_000);
  });
});

describe('evaluateBudget', () => {
  const pricing = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

  it('passes under every cap', () => {
    const verdict = evaluateBudget(
      { tokensIn: 100, tokensOut: 50, steps: 3 },
      { maxTokens: 1_000, maxSteps: 5, budgetUsd: 1 },
      pricing,
    );
    expect(verdict).toEqual({ exceeded: false });
  });

  it('treats being exactly at a cap as within budget', () => {
    const verdict = evaluateBudget(
      { tokensIn: 600, tokensOut: 400, steps: 0 },
      { maxTokens: 1_000 },
      pricing,
    );
    expect(verdict).toEqual({ exceeded: false });
  });

  it('binds the token cap first', () => {
    const verdict = evaluateBudget(
      { tokensIn: 700, tokensOut: 500, steps: 0 },
      { maxTokens: 1_000, maxSteps: 5 },
      pricing,
    );
    expect(verdict.exceeded).toBe(true);
    expect(verdict.cap).toBe('tokens');
    expect(verdict.detail).toContain('token cap 1000');
  });

  it('binds the step cap', () => {
    const verdict = evaluateBudget(
      { tokensIn: 0, tokensOut: 0, steps: 6 },
      { maxSteps: 5 },
      pricing,
    );
    expect(verdict.exceeded).toBe(true);
    expect(verdict.cap).toBe('steps');
  });

  it('binds the cost cap only when pricing is configured', () => {
    // 0.5M in × $3 + 0.1M out × $15 = $3.00 > $2.
    const usage = { tokensIn: 500_000, tokensOut: 100_000, steps: 0 };
    const withPricing = evaluateBudget(usage, { budgetUsd: 2 }, pricing);
    expect(withPricing.exceeded).toBe(true);
    expect(withPricing.cap).toBe('cost');

    const withoutPricing = evaluateBudget(usage, { budgetUsd: 2 }, null);
    expect(withoutPricing).toEqual({ exceeded: false });
  });
});

describe('FactoryScheduler', () => {
  it('claims queued tickets FIFO up to the concurrency limit', async () => {
    const rig = makeRig({ concurrency: 1 });
    const first = rig.queue.enqueue({ title: 'first', spec: 'do a' });
    const second = rig.queue.enqueue({ title: 'second', spec: 'do b' });

    await rig.scheduler.tick();

    expect(viewOf(rig, first.id)?.state).toBe('running');
    expect(viewOf(rig, second.id)?.state).toBe('queued');
    expect(rig.connector.spawned).toHaveLength(1);
    // The spec verbatim is the first attempt's task prompt.
    expect(rig.connector.sent.get(sessionIdFor(first.id))).toEqual(['do a']);

    rig.connector.finish(sessionIdFor(first.id));
    await rig.scheduler.tick();
    expect(viewOf(rig, first.id)?.state).toBe('pr-opened');

    await rig.scheduler.tick();
    expect(viewOf(rig, second.id)?.state).toBe('running');
  });

  it('reflects blocked-on-approval sessions and their return to work', async () => {
    const rig = makeRig();
    const ticket = rig.queue.enqueue({ title: 'gated', spec: 'careful work' });

    await rig.scheduler.tick();
    rig.connector.emit(sessionIdFor(ticket.id), {
      kind: 'state_change',
      from: 'working',
      to: 'waiting-approval',
      request: { requestId: 'r1', tool: 'Bash', risk: 'medium', command: 'rm -rf ./dist' },
    });
    await rig.scheduler.tick();
    expect(viewOf(rig, ticket.id)?.state).toBe('blocked');

    rig.connector.emit(sessionIdFor(ticket.id), {
      kind: 'state_change',
      from: 'waiting-approval',
      to: 'working',
    });
    await rig.scheduler.tick();
    expect(viewOf(rig, ticket.id)?.state).toBe('running');
  });

  it('exhausts a ticket that crosses its step cap and kills the session', async () => {
    const rig = makeRig();
    const ticket = rig.queue.enqueue({ title: 'loopy', spec: 'spin', maxSteps: 2 });

    await rig.scheduler.tick();
    rig.connector.emit(sessionIdFor(ticket.id), TOOL_USE);
    rig.connector.emit(sessionIdFor(ticket.id), TOOL_USE);
    rig.connector.emit(sessionIdFor(ticket.id), TOOL_USE);
    await rig.scheduler.tick();

    const row = viewOf(rig, ticket.id);
    expect(row?.state).toBe('failed');
    expect(row?.outcome).toBe('exhausted');
    expect(row?.outcomeDetail).toContain('step cap 2');
    expect(rig.connector.killed).toContain(sessionIdFor(ticket.id));
  });

  it('exhausts a ticket that crosses its token cap from journaled usage', async () => {
    const rig = makeRig();
    const ticket = rig.queue.enqueue({ title: 'wordy', spec: 'elaborate', maxTokens: 1_000 });

    await rig.scheduler.tick();
    rig.connector.emit(sessionIdFor(ticket.id), { kind: 'usage', tokensIn: 700, tokensOut: 500 });
    await rig.scheduler.tick();

    const row = viewOf(rig, ticket.id);
    expect(row?.outcome).toBe('exhausted');
    expect(row?.outcomeDetail).toContain('token cap 1000');
  });

  it('enforces cost caps only when pricing is configured', async () => {
    const priced = makeRig({ pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
    const ticket = priced.queue.enqueue({ title: 'costly', spec: 'spend', budgetUsd: 1 });
    await priced.scheduler.tick();
    priced.connector.emit(sessionIdFor(ticket.id), {
      kind: 'usage',
      tokensIn: 200_000,
      tokensOut: 100_000,
    });
    await priced.scheduler.tick();
    // 0.2M×$3 + 0.1M×$15 = $2.10 > $1.
    expect(viewOf(priced, ticket.id)?.outcome).toBe('exhausted');
    expect(viewOf(priced, ticket.id)?.outcomeDetail).toContain('cost cap $1');

    const unpriced = makeRig();
    const tolerated = unpriced.queue.enqueue({ title: 'costly', spec: 'spend', budgetUsd: 1 });
    await unpriced.scheduler.tick();
    unpriced.connector.emit(sessionIdFor(tolerated.id), {
      kind: 'usage',
      tokensIn: 200_000,
      tokensOut: 100_000,
    });
    await unpriced.scheduler.tick();
    expect(viewOf(unpriced, tolerated.id)?.outcome).toBeNull();
    expect(viewOf(unpriced, tolerated.id)?.state).toBe('running');
  });

  it('runs the verification gate in the session worktree and records pr-opened', async () => {
    const rig = makeRig();
    const ticket = rig.queue.enqueue({ title: 'clean', spec: 'build it', verifyCommand: 'pwd' });

    await rig.scheduler.tick();
    rig.connector.finish(sessionIdFor(ticket.id), { code: 0 });
    await rig.scheduler.tick();

    const row = viewOf(rig, ticket.id);
    expect(row?.state).toBe('pr-opened');
    expect(row?.outcome).toBe('pr-opened');
    // The gate ran with the session's runtime cwd — the detail echoes pwd's stdout.
    expect(row?.outcomeDetail).toContain(join(rig.workspaceRoot, sessionIdFor(ticket.id)));
  });

  it('fails a red gate, retries with the failure in the prompt, then lands failed', async () => {
    const rig = makeRig({ baseBackoffMs: 0 });
    const ticket = rig.queue.enqueue({
      title: 'flaky',
      spec: 'make it pass',
      verifyCommand: 'false',
      retries: 1,
    });

    await rig.scheduler.tick(); // attempt 1 running
    rig.connector.finish(sessionIdFor(ticket.id), { code: 0 });
    await rig.scheduler.tick(); // gate red → backoff queue
    expect(viewOf(rig, ticket.id)?.state).toBe('queued');
    expect(viewOf(rig, ticket.id)?.attempt).toBe(1);
    expect(viewOf(rig, ticket.id)?.outcomeDetail).toContain('verification failed');

    await rig.scheduler.tick(); // attempt 2 claims immediately (backoff 0)
    expect(viewOf(rig, ticket.id)?.state).toBe('running');
    expect(rig.connector.spawned).toHaveLength(2);
    expect(rig.connector.spawned[1]?.sessionId).toBe(sessionIdFor(ticket.id));
    // The retry prompt carries the previous attempt's failure output.
    const turns = rig.connector.sent.get(sessionIdFor(ticket.id)) ?? [];
    expect(turns).toHaveLength(2);
    expect(turns[0]).toBe('make it pass');
    expect(turns[1]).toContain('make it pass');
    expect(turns[1]).toContain('ended in failure');

    rig.connector.finish(sessionIdFor(ticket.id), { code: 0 });
    await rig.scheduler.tick(); // gate red again → budget exhausted
    const row = viewOf(rig, ticket.id);
    expect(row?.state).toBe('failed');
    expect(row?.outcome).toBe('failed');
    expect(row?.attempt).toBe(2);
  });

  it('records a spawn failure through the retry path', async () => {
    const rig = makeRig({ baseBackoffMs: 0 });
    const ticket = rig.queue.enqueue({ title: 'cursed', spec: 'impossible', retries: 1 });

    rig.connector.spawnShouldFail = true;
    await rig.scheduler.tick();
    expect(viewOf(rig, ticket.id)?.state).toBe('queued');
    expect(viewOf(rig, ticket.id)?.outcomeDetail).toContain('spawn failed: connector is down');

    rig.connector.spawnShouldFail = false;
    await rig.scheduler.tick();
    expect(viewOf(rig, ticket.id)?.state).toBe('running');
  });

  it('fails terminally when the spawn never succeeds', async () => {
    const rig = makeRig({ baseBackoffMs: 0 });
    const ticket = rig.queue.enqueue({ title: 'cursed', spec: 'impossible', retries: 0 });

    rig.connector.spawnShouldFail = true;
    await rig.scheduler.tick();
    const row = viewOf(rig, ticket.id);
    expect(row?.state).toBe('failed');
    expect(row?.outcome).toBe('failed');
    expect(row?.attempt).toBe(1);
    expect(row?.outcomeDetail).toContain('spawn failed');
  });

  it('retries a ticket whose session was lost to a daemon restart', async () => {
    const journalPath = join(tempRoot('agentmux-factory-restart-'), 'j.sqlite3');
    const baseBackoffMs = 5_000;
    const rigA = makeRig({ baseBackoffMs, journalPath });
    const ticket = rigA.queue.enqueue({ title: 'died', spec: 'survive the reboot' });
    await rigA.scheduler.tick(); // claimed + spawned, still "running"
    const spawnCountA = rigA.connector.spawned.length;
    expect(spawnCountA).toBe(1);

    // A brand-new process over the same journal — nothing live anywhere.
    const rigB = makeRig({ baseBackoffMs, journalPath });
    await rigB.scheduler.tick();

    const afterRestart = viewOf(rigB, ticket.id);
    expect(afterRestart?.state).toBe('queued');
    expect(afterRestart?.outcomeDetail).toContain('session lost to a daemon restart');

    // The failed attempt consumed one of the retry budget — the next claim
    // (after backoff) runs as attempt 2.
    rigB.clock.nowMs += baseBackoffMs * 2;
    await rigB.scheduler.tick();
    const row = viewOf(rigB, ticket.id);
    expect(row?.state).toBe('running');
    expect(row?.attempt).toBe(2);
    expect(row?.nextAttemptAt).toBeNull();
  });

  it('gates a ticket whose terminal event landed before the restart', async () => {
    const journalPath = join(tempRoot('agentmux-factory-restart2-'), 'j.sqlite3');
    const rigA = makeRig({ journalPath });
    const ticket = rigA.queue.enqueue({ title: 'done-overnight', spec: 'finish' });
    await rigA.scheduler.tick();
    rigA.connector.finish(sessionIdFor(ticket.id), { code: 0 });
    // rigA never ticks again — the terminal event is in the journal only.

    const rigB = makeRig({ journalPath });
    await rigB.scheduler.tick();
    const row = viewOf(rigB, ticket.id);
    expect(row?.state).toBe('pr-opened');
    expect(row?.outcome).toBe('pr-opened');
  });

  it('retries a ticket found claimed-but-never-spawned at boot', async () => {
    const journalPath = join(tempRoot('agentmux-factory-claim-'), 'j.sqlite3');
    const rigA = makeRig({ journalPath });
    const ticket = rigA.queue.enqueue({ title: 'half-claimed', spec: 'resume me' });

    // Simulate the crash window between claim and spawn: claim without a session.
    rigA.journal.database
      .prepare("UPDATE factory_tickets SET state = 'claimed', attempt = 1 WHERE id = ?")
      .run(ticket.id);

    const rigB = makeRig({ baseBackoffMs: 5_000, journalPath });
    await rigB.scheduler.tick();
    const afterRestart = viewOf(rigB, ticket.id);
    expect(afterRestart?.state).toBe('queued');
    expect(afterRestart?.outcomeDetail).toContain('daemon restarted before the session spawned');

    rigB.clock.nowMs += 10_000;
    await rigB.scheduler.tick();
    const row = viewOf(rigB, ticket.id);
    expect(row?.state).toBe('running');
    expect(row?.attempt).toBe(2);
  });

  it('surfaces status counts and per-ticket usage', async () => {
    const rig = makeRig({ concurrency: 2 });
    const done = rig.queue.enqueue({ title: 'done', spec: 'a' });
    const running = rig.queue.enqueue({ title: 'running', spec: 'b' });

    await rig.scheduler.tick();
    rig.connector.emit(sessionIdFor(done.id), { kind: 'usage', tokensIn: 1200, tokensOut: 340 });
    rig.connector.emit(sessionIdFor(done.id), TOOL_USE);
    rig.connector.finish(sessionIdFor(done.id));
    await rig.scheduler.tick();

    const status = rig.scheduler.status();
    expect(status.running).toBe(false); // autoStart: false — no timer armed
    expect(status.concurrency).toEqual({ limit: 2, active: 1 });
    expect(status.counts['pr-opened']).toBe(1);
    expect(status.counts.running).toBe(1);
    expect(status.pricing).toBeNull();

    const tickets = rig.scheduler.listTickets();
    expect(tickets).toHaveLength(2);
    const doneView = tickets.find((ticket) => ticket.id === done.id);
    expect(doneView?.usage).toEqual({ tokensIn: 1200, tokensOut: 340, steps: 1 });
    expect(doneView?.outcome).toBe('pr-opened');
    expect(tickets.find((ticket) => ticket.id === running.id)?.usage).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      steps: 0,
    });
  });

  it('gates a crashed session through the exit code before any command runs', async () => {
    // The real gate — its exit-code check is what must short-circuit.
    const rig = makeRig();
    const ticket = rig.queue.enqueue({
      title: 'crashy',
      spec: 'explode',
      verifyCommand: 'touch gate-ran.marker',
    });

    await rig.scheduler.tick();
    rig.connector.finish(sessionIdFor(ticket.id), { code: 139, signal: 'SIGKILL' });
    await rig.scheduler.tick();

    // The crash verdict comes from the exit info; the verify command never runs.
    const worktree = join(rig.workspaceRoot, sessionIdFor(ticket.id));
    expect(existsSync(join(worktree, 'gate-ran.marker'))).toBe(false);
    expect(viewOf(rig, ticket.id)?.state).toBe('queued');
    expect(viewOf(rig, ticket.id)?.outcomeDetail).toContain('session exited with code 139');
  });

  it('treats a thrown gate as a failed attempt, not a crash of the scheduler', async () => {
    const gate = new StubVerifyRunner([new Error('gate runner exploded')]);
    const rig = makeRig({ verifyRunner: gate, baseBackoffMs: 0 });
    const ticket = rig.queue.enqueue({ title: 'gated', spec: 'work' });

    await rig.scheduler.tick();
    rig.connector.finish(sessionIdFor(ticket.id));
    await rig.scheduler.tick();

    expect(viewOf(rig, ticket.id)?.state).toBe('queued');
    expect(viewOf(rig, ticket.id)?.outcomeDetail).toContain(
      'verification gate error: gate runner exploded',
    );
  });
});

describe('ExecVerifyRunner', () => {
  it('runs the command in the given cwd and reports exit 0 as a pass', async () => {
    const runner = new ExecVerifyRunner(10_000);
    const cwd = tempRoot('agentmux-verify-');
    const result = await runner.run({
      ticket: {
        id: 't1',
        title: 't',
        spec: 's',
        repo: null,
        baseBranch: null,
        runtime: 'worktree',
        policyClass: 'guarded',
        budgetUsd: null,
        retries: 0,
        bestOfN: 1,
        maxTokens: null,
        maxSteps: null,
        verifyCommand: 'test -d .',
        state: 'running',
        createdAt: 0,
        updatedAt: 0,
      },
      cwd,
      exit: null,
    });
    expect(result.passed).toBe(true);
  });

  it('reports the command output tail on failure', async () => {
    const runner = new ExecVerifyRunner(10_000);
    const result = await runner.run({
      ticket: {
        id: 't1',
        title: 't',
        spec: 's',
        repo: null,
        baseBranch: null,
        runtime: 'worktree',
        policyClass: 'guarded',
        budgetUsd: null,
        retries: 0,
        bestOfN: 1,
        maxTokens: null,
        maxSteps: null,
        verifyCommand: 'echo gate-says-no && exit 3',
        state: 'running',
        createdAt: 0,
        updatedAt: 0,
      },
      cwd: tempRoot('agentmux-verify-'),
      exit: null,
    });
    expect(result.passed).toBe(false);
    expect(result.output).toContain('gate-says-no');
  });
});

describe('factory over the real daemon (end to end)', () => {
  it('enqueues over HTTP, runs a scripted session, and records the outcome', async () => {
    // A fixture git repo as the daemon's workspace — the daemon's worktree
    // runtime derives its worktrees from HERE, never from this repository.
    const workspace = tempRoot('agentmux-factory-e2e-');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'agentmux',
      GIT_AUTHOR_EMAIL: 'agentmux@local',
      GIT_COMMITTER_NAME: 'agentmux',
      GIT_COMMITTER_EMAIL: 'agentmux@local',
    };
    execSync('git init -q', { cwd: workspace, env: gitEnv });
    writeFileSync(join(workspace, 'README.md'), 'fixture\n');
    execSync('git add . && git commit -qm fixture', { cwd: workspace, env: gitEnv });

    const connector = new ScriptedConnector();
    const handle = await startDaemon({
      port: 0,
      workspaceRoot: workspace,
      connectors: new Map<string, AgentConnector>([['scripted', connector]]),
      factory: { connectorId: 'scripted', concurrency: 2, tickMs: 50 },
    });
    openDaemons.push(handle);

    const api = async (
      path: string,
      init?: RequestInit,
    ): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`http://127.0.0.1:${handle.address().port}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
      });
      return { status: response.status, body: await response.json() };
    };

    // The scheduler starts armed — one daemon pass brings the claim→spawn.
    const enqueued = await api('/api/factory/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: 'e2e pagination',
        spec: 'add cursor pagination',
        verifyCommand: 'true',
        maxTokens: 100_000,
      }),
    });
    expect(enqueued.status).toBe(201);
    const ticket = enqueued.body as { ticket: { id: string } };
    const sessionId = `factory-${ticket.ticket.id}`;

    await until(
      () => (connector.spawned.some((spawn) => spawn.sessionId === sessionId) ? true : undefined),
      'the scheduler to claim and spawn the ticket',
    );
    connector.emit(sessionId, { kind: 'usage', tokensIn: 900, tokensOut: 100 });
    connector.emit(sessionId, TOOL_USE);
    connector.finish(sessionId, { code: 0 });

    const tickets = await until(async () => {
      const listing = await api('/api/factory/tickets');
      const body = listing.body as {
        tickets: Array<{
          id: string;
          state: string;
          outcome: string | null;
          usage: { tokensIn: number; tokensOut: number; steps: number };
        }>;
      };
      const row = body.tickets.find((candidate) => candidate.id === ticket.ticket.id);
      if (row?.outcome === 'pr-opened') return row;
      return undefined;
    }, 'the ticket to reach pr-opened');

    expect(tickets.usage).toEqual({ tokensIn: 900, tokensOut: 100, steps: 1 });

    const status = await api('/api/factory');
    expect(status.status).toBe(200);
    expect((status.body as { counts: Record<string, number> }).counts['pr-opened']).toBe(1);
  });
});
