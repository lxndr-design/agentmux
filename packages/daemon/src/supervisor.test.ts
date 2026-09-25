import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ExitInfo } from '@agentmux/protocol';
import { migrate } from './migrations.js';
import { ProcessRegistry } from './process-registry.js';
import type { AgentConnector, AgentSession, SessionSpawnConfig } from './connectors/types.js';
import { InitHookError, type InitHookOptions, type InitHookResult } from './init-hook.js';
import { escalateKillGroup, groupAlive } from './process-group.js';
import { Supervisor, type SupervisorStartRequest } from './supervisor.js';
import { WorktreeRuntime } from './runtime.js';
import { WorktreeManager } from './worktree.js';

/**
 * The supervisor's lifecycle tests. Connectors are fakes (the connector
 * suites cover the real ones); the restart acceptance runs against the REAL
 * worktree runtime over a temp git repo, so "restart into its existing
 * worktree" is proven end-to-end, not against a stub that agrees with itself.
 */

const GIT_IDENTITY = ['-c', 'user.name=agentmux-test', '-c', 'user.email=test@agentmux.local'];
const execFileAsync = promisify(execFile);

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-supervisor-'));
  dirs.push(repo);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', [...GIT_IDENTITY, 'init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'add', '.'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

/** A per-session workspace map — the Runtime contract without git underneath. */
class StubRuntime {
  readonly id: string;
  readonly workspaceRoot: string;
  private readonly homes = new Map<string, string>();

  constructor(id: string, workspaceRoot: string) {
    this.id = id;
    this.workspaceRoot = workspaceRoot;
  }

  async provision(request: { sessionId: string }): Promise<{
    sessionId: string;
    runtime: string;
    cwd: string;
    branch: string | null;
    reused: boolean;
  }> {
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
    const cwd = path.join(this.workspaceRoot, request.sessionId);
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

/** Records spawns and hands out sessions whose exits settle on demand. */
class FakeConnector implements AgentConnector {
  readonly id = 'fake';
  readonly spawned: SessionSpawnConfig[] = [];
  readonly killCalls: Array<{ sessionId: string; graceMs: number | undefined }> = [];

  private readonly settleExit = new Map<string, (info: ExitInfo) => void>();

  async detect(): Promise<{ installed: boolean; version?: string }> {
    return { installed: true, version: 'fake-1' };
  }

  async spawn(config: SessionSpawnConfig): Promise<AgentSession> {
    this.spawned.push(config);
    const sessionId = config.sessionId;
    const session: AgentSession = {
      id: sessionId,
      state: 'ready',
      send: () => {},
      respondToApproval: () => {},
      kill: async (options?: { graceMs?: number }) => {
        this.killCalls.push({ sessionId, graceMs: options?.graceMs });
        this.settleExit.get(sessionId)?.({ code: 0 });
        return { code: 0 };
      },
      exit: new Promise<ExitInfo>((resolve) => {
        this.settleExit.set(sessionId, resolve);
      }),
    };
    // Simulate the connector's first pid report — the PTY leader.
    config.onPidChange?.(42_000 + this.spawned.length);
    return session;
  }
}

interface Fixture {
  supervisor: Supervisor;
  connector: FakeConnector;
  registry: ProcessRegistry;
  ingested: Array<{ sessionId: string; event: AgentEvent }>;
}

function makeSupervisor(
  overrides: {
    runInitHook?: (options: InitHookOptions) => Promise<InitHookResult>;
    connectors?: Map<string, AgentConnector>;
  } = {},
): Fixture {
  const ingested: Array<{ sessionId: string; event: AgentEvent }> = [];
  const db = new Database(':memory:');
  migrate(db);
  const registry = new ProcessRegistry(db);
  const connector = new FakeConnector();
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'agentmux-sup-ws-'));
  dirs.push(workspaceRoot);
  const supervisor = new Supervisor({
    runtimes: { worktree: new StubRuntime('worktree', workspaceRoot) } as never,
    defaultRuntimeId: 'worktree',
    registry,
    runInitHook: overrides.runInitHook ?? (async () => ({ ran: false })),
    ingest(sessionId, event) {
      ingested.push({ sessionId, event });
    },
    connectors: overrides.connectors ?? new Map([['fake', connector]]),
    killGraceMs: 50,
    reapGraceMs: 200,
  });
  return { supervisor, connector, registry, ingested };
}

function request(overrides: Partial<SupervisorStartRequest> = {}): SupervisorStartRequest {
  return { sessionId: 's1', connectorId: 'fake', ...overrides };
}

describe('Supervisor.start', () => {
  it('spawns the connector into the runtime-provisioned workspace with the session env', async () => {
    const { supervisor, connector } = makeSupervisor();

    const view = await supervisor.start(request());

    expect(connector.spawned).toHaveLength(1);
    const config = connector.spawned[0]!;
    expect(config.cwd).toContain('s1');
    expect(config.env).toMatchObject({
      AGENTMUX_RUNTIME: 'worktree',
      AGENTMUX_SESSION_ID: 's1',
    });
    expect(view.cwd).toBe(config.cwd);
    expect(view.workspaceReused).toBe(false);
    expect(view.runtimeId).toBe('worktree');
  });

  it('records the connector-reported process group in the durable registry', async () => {
    const { supervisor, connector, registry } = makeSupervisor();
    await supervisor.start(request());

    const row = registry.get('s1');
    expect(row?.pgid).toBe(42_001);
    expect(row?.cwd).toBe(connector.spawned[0]!.cwd);

    // The connector reports pid 0 between turns — nothing live, row cleared.
    connector.spawned[0]!.onPidChange?.(0);
    expect(registry.get('s1')).toBeUndefined();
  });

  it('fails the start when the init hook fails — tombstone, no spawn', async () => {
    const { supervisor, connector, ingested } = makeSupervisor({
      runInitHook: async () => {
        throw new InitHookError('E_FAILED', 'install failed: no space left on device');
      },
    });

    await expect(supervisor.start(request())).rejects.toThrowError(/no space left on device/);

    // Tombstoned as crashed with the hook's own words as the exit reason;
    // the connector was never spawned — no orphan process behind the crash.
    expect(ingested).toHaveLength(1);
    const event = ingested[0]!.event;
    expect(event.kind).toBe('state_change');
    if (event.kind === 'state_change') {
      expect(event.from).toBe('starting');
      expect(event.to).toBe('crashed');
      expect(event.exit?.reason).toContain('install failed');
      expect(event.exit?.code).toBe(126);
    }
    expect(connector.spawned).toHaveLength(0);
  });

  it('rejects an unknown connector, naming what is known', async () => {
    const { supervisor } = makeSupervisor({ connectors: new Map() });
    await expect(supervisor.start(request({ connectorId: 'gemini' }))).rejects.toThrowError(
      /unknown connector 'gemini' \(known: \)/,
    );
  });

  it('rejects a second start for a live session — restart is the flow', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start(request());
    await expect(supervisor.start(request())).rejects.toThrowError(/restart it instead/);
  });
});

describe('Supervisor.restart — restart-into-worktree', () => {
  it('restarts into the SAME real worktree, killing the old process first', async () => {
    const repoRoot = await tempRepo();
    const worktrees = new WorktreeManager({ workspaceRoot: repoRoot });
    const connector = new FakeConnector();
    const db = new Database(':memory:');
    migrate(db);
    const supervisor = new Supervisor({
      runtimes: {
        worktree: new WorktreeRuntime(worktrees),
        local: new StubRuntime('local', repoRoot),
      } as never,
      defaultRuntimeId: 'worktree',
      registry: new ProcessRegistry(db),
      runInitHook: async () => ({ ran: false }),
      ingest() {},
      connectors: new Map([['fake', connector]]),
      killGraceMs: 50,
    });

    const first = await supervisor.start(request({ sessionId: 's1' }));
    // A worktree-runtime session lands in its own worktree under .agentmux —
    // never the main checkout.
    expect(first.cwd).toContain(path.join('.agentmux', 'worktrees', 's1'));
    expect(first.workspaceReused).toBe(false);

    const second = await supervisor.restart('s1');

    // The kill ran before the re-spawn, with the supervisor's grace default.
    expect(connector.killCalls).toEqual([{ sessionId: 's1', graceMs: 50 }]);
    // Same worktree, second visit: reused, not re-created.
    expect(second.cwd).toBe(first.cwd);
    expect(second.workspaceReused).toBe(true);
    expect(connector.spawned).toHaveLength(2);
    expect(connector.spawned[1]!.cwd).toBe(first.cwd);
    worktrees.close();
  });

  it('refuses to restart a session it never started', async () => {
    const { supervisor } = makeSupervisor();
    await expect(supervisor.restart('ghost')).rejects.toThrowError(
      /restart needs a previous start/,
    );
  });
});

describe('Supervisor.kill', () => {
  it('kills the session, clears the registry, and stays idempotent', async () => {
    const { supervisor, registry } = makeSupervisor();
    await supervisor.start(request());

    await expect(supervisor.kill('s1')).resolves.toEqual({ code: 0 });
    expect(registry.get('s1')).toBeUndefined();
    expect(supervisor.get('s1')).toBeUndefined();

    // Killing again — or a session that never existed — is a no-op.
    await expect(supervisor.kill('s1')).resolves.toBeNull();
    await expect(supervisor.kill('ghost')).resolves.toBeNull();
  });
});

describe('Supervisor.reapOrphans', () => {
  it('kills the process group a crashed daemon left behind and clears the row', async () => {
    const { supervisor, registry } = makeSupervisor();

    // Simulate the crash: a live process group registered in the journal DB,
    // with no supervisor entry (the owning daemon died).
    const pgid = spawnDetachedGroup();
    try {
      registry.record('s-crashed', pgid, 'worktree', '/tmp/whatever');
      expect(groupAlive(pgid)).toBe(true);

      const reports = await supervisor.reapOrphans();

      expect(reports).toEqual([
        { sessionId: 's-crashed', pgid, runtimeId: 'worktree', outcome: 'flushed' },
      ]);
      expect(groupAlive(pgid)).toBe(false);
      expect(registry.get('s-crashed')).toBeUndefined();
    } finally {
      await escalateKillGroup(pgid, { graceMs: 200 });
    }
  }, 15_000);

  it('reports a stale row for an already-dead group as already-gone and clears it', async () => {
    const { supervisor, registry } = makeSupervisor();
    registry.record('s-fake', 999_999_999, 'worktree', '/tmp/whatever');

    const reports = await supervisor.reapOrphans();

    expect(reports).toEqual([
      { sessionId: 's-fake', pgid: 999_999_999, runtimeId: 'worktree', outcome: 'already-gone' },
    ]);
    expect(registry.get('s-fake')).toBeUndefined();
  });
});

describe('Supervisor.shutdown', () => {
  it('kills every live session and settles', async () => {
    const { supervisor, connector } = makeSupervisor();
    await supervisor.start(request({ sessionId: 's1' }));
    await supervisor.start(request({ sessionId: 's2' }));

    const exits = await supervisor.shutdown();

    expect(exits).toEqual([
      { sessionId: 's1', exit: { code: 0 } },
      { sessionId: 's2', exit: { code: 0 } },
    ]);
    expect(connector.killCalls).toHaveLength(2);
    expect(supervisor.list()).toEqual([]);
  });
});

/** A live detached process group (`sleep 300 & sleep 300`) for reaper fixtures. */
function spawnDetachedGroup(): number {
  const child = spawn('bash', ['-c', 'sleep 300 & sleep 300'], {
    detached: true,
    stdio: 'ignore',
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('spawn did not report a pid');
  return pgid;
}
