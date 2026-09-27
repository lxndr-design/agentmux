import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision, ExitInfo, SessionState } from '@agentmux/protocol';
import { startDaemon, type DaemonHandle } from './daemon.js';
import type {
  AgentConnector,
  AgentSession,
  SessionEventSink,
  SessionSpawnConfig,
} from './connectors/types.js';

/**
 * Integration tests for the daemon's automation API (blueprint: "Scripting /
 * automation API"). Auth comes first — a missing or wrong token is a 401
 * before any routing — then the four routes, against a fake connector so no
 * real CLI and no API keys are ever involved.
 */

const GIT_IDENTITY = ['-c', 'user.name=agentmux-test', '-c', 'user.email=test@agentmux.local'];
const execFileAsync = promisify(execFile);

const dirs: string[] = [];
const openDaemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const handle of openDaemons.splice(0)) {
    for (const session of handle.supervisor.list()) {
      await handle.supervisor.kill(session.id).catch(() => undefined);
    }
    await handle.close();
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-http-'));
  dirs.push(repo);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', [...GIT_IDENTITY, 'init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'add', '.'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

/**
 * A connector whose sessions boot to ready synchronously inside spawn (the
 * post-spawn dispatch path), record what they are sent and told, and die on
 * demand. The event-driven ready path is covered in the supervisor tests.
 */
class FakeConnector implements AgentConnector {
  readonly id = 'fake';
  readonly sent: string[] = [];
  readonly decisions: ApprovalDecision[] = [];
  private readonly settle = new Map<string, (info: ExitInfo) => void>();

  async detect(): Promise<{ installed: boolean; version?: string }> {
    return { installed: true, version: 'fake-1' };
  }

  async spawn(config: SessionSpawnConfig, sink: SessionEventSink): Promise<AgentSession> {
    const sessionId = config.sessionId;
    let state: SessionState = 'starting';
    sink.onEvent({ kind: 'state_change', from: 'created', to: 'starting' });
    state = 'ready';
    sink.onEvent({ kind: 'state_change', from: 'starting', to: 'ready' });

    const session: AgentSession = {
      id: sessionId,
      get state() {
        return state;
      },
      send: (text: string) => {
        this.sent.push(text);
      },
      respondToApproval: (decision: ApprovalDecision) => {
        this.decisions.push(decision);
      },
      kill: async () => {
        state = 'stopped';
        sink.onEvent({ kind: 'state_change', from: 'ready', to: 'stopped', exit: { code: 0 } });
        this.settle.get(sessionId)?.({ code: 0 });
        return { code: 0 };
      },
      exit: new Promise<ExitInfo>((resolve) => {
        this.settle.set(sessionId, resolve);
      }),
    };
    return session;
  }
}

async function boot(
  fake = new FakeConnector(),
): Promise<{ handle: DaemonHandle; fake: FakeConnector }> {
  const handle = await startDaemon({
    port: 0,
    workspaceRoot: await tempRepo(),
    connectors: new Map([['fake', fake]]),
  });
  openDaemons.push(handle);
  return { handle, fake };
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  handle: DaemonHandle,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const response = await fetch(`http://127.0.0.1:${handle.address().port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as unknown as Record<string, unknown>),
  };
}

function authorized(handle: DaemonHandle): Record<string, string> {
  return { authorization: `Bearer ${handle.token}` };
}

async function until(
  description: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('automation API auth', () => {
  it('answers 401 on a missing token — before any routing, with nothing done', async () => {
    const { handle } = await boot();
    const bare = await api(handle, 'GET', '/api/sessions');
    expect(bare.status).toBe(401);

    const create = await api(handle, 'POST', '/api/sessions', { connectorId: 'fake' });
    expect(create.status).toBe(401);

    const enqueue = await api(handle, 'POST', '/api/factory/tickets', {
      title: 't',
      spec: 's',
    });
    expect(enqueue.status).toBe(401);

    // A rejected request must not have touched the daemon's state.
    expect(handle.supervisor.list()).toEqual([]);
  });

  it('answers 401 on a wrong token and on a non-bearer scheme', async () => {
    const { handle } = await boot();
    const wrong = await api(handle, 'GET', '/api/sessions', undefined, {
      authorization: `Bearer ${'A'.repeat(handle.token.length)}`,
    });
    expect(wrong.status).toBe(401);

    const basic = await api(handle, 'GET', '/api/sessions', undefined, {
      authorization: `Basic ${handle.token}`,
    });
    expect(basic.status).toBe(401);
  });
});

describe('automation API loopback bind', () => {
  it('binds 127.0.0.1 and refuses to boot on a non-loopback host', async () => {
    const { handle } = await boot();
    expect(handle.address().host).toBe('127.0.0.1');
    // The refusal happens at option resolution — before any socket exists
    // (the socket-level proof that loopback is unreachable externally lives
    // in integration.test.ts).
    await expect(startDaemon({ port: 0, host: '0.0.0.0' })).rejects.toThrowError(/loopback only/);
  });
});

describe('session routes', () => {
  it('creates a session and hands back its stream pointer', async () => {
    const { handle } = await boot();
    const created = await api(
      handle,
      'POST',
      '/api/sessions',
      {
        connectorId: 'fake',
        sessionId: 'api-1',
      },
      authorized(handle),
    );
    expect(created.status).toBe(201);
    expect(created.body.session).toMatchObject({
      id: 'api-1',
      connectorId: 'fake',
      state: 'ready',
    });
    expect(created.body.stream).toMatchObject({
      sessionId: 'api-1',
      transport: 'ws',
      url: `ws://127.0.0.1:${handle.address().port}/`,
      state: 'ready',
    });
    // Two boot transitions journaled before the pointer was taken.
    expect(created.body.stream).toMatchObject({ lastSeq: 1 });

    const list = await api(handle, 'GET', '/api/sessions', undefined, authorized(handle));
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(1);

    const pointer = await api(
      handle,
      'GET',
      '/api/sessions/api-1/stream',
      undefined,
      authorized(handle),
    );
    expect(pointer.status).toBe(200);
    expect(pointer.body.state).toBe('ready');
  });

  it('delivers the initial task exactly once', async () => {
    const { handle, fake } = await boot();
    const created = await api(
      handle,
      'POST',
      '/api/sessions',
      {
        connectorId: 'fake',
        sessionId: 'api-task',
        initialTask: 'fix the flaky auth test',
      },
      authorized(handle),
    );
    expect(created.status).toBe(201);

    await until('initial task delivered', () => fake.sent.length > 0);
    // Give a duplicate dispatch every chance to misfire, then assert once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toEqual(['fix the flaky auth test']);
  });

  it('maps start failures: 409 duplicate, 400 unknown connector, 404 pointer', async () => {
    const { handle } = await boot();
    await api(
      handle,
      'POST',
      '/api/sessions',
      { connectorId: 'fake', sessionId: 'dup-1' },
      authorized(handle),
    );
    const duplicate = await api(
      handle,
      'POST',
      '/api/sessions',
      {
        connectorId: 'fake',
        sessionId: 'dup-1',
      },
      authorized(handle),
    );
    expect(duplicate.status).toBe(409);

    const unknownConnector = await api(
      handle,
      'POST',
      '/api/sessions',
      {
        connectorId: 'gemini',
      },
      authorized(handle),
    );
    expect(unknownConnector.status).toBe(400);

    const pointer = await api(
      handle,
      'GET',
      '/api/sessions/nope/stream',
      undefined,
      authorized(handle),
    );
    expect(pointer.status).toBe(404);
  });

  it('rejects malformed and schema-invalid bodies with 400', async () => {
    const { handle } = await boot();
    const response = await fetch(`http://127.0.0.1:${handle.address().port}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorized(handle) },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);

    const missingConnector = await api(handle, 'POST', '/api/sessions', {}, authorized(handle));
    expect(missingConnector.status).toBe(400);

    const badMode = await api(
      handle,
      'POST',
      '/api/sessions',
      {
        connectorId: 'fake',
        permissionMode: 'bypassPermissions',
      },
      authorized(handle),
    );
    expect(badMode.status).toBe(400);
  });

  it('answers 404 for unknown API routes and non-API paths', async () => {
    const { handle } = await boot();
    const unknown = await api(handle, 'GET', '/api/unknown', undefined, authorized(handle));
    expect(unknown.status).toBe(404);
    const outside = await api(handle, 'GET', '/definitely/not/api', undefined, authorized(handle));
    expect(outside.status).toBe(404);
  });
});

describe('factory ticket enqueue', () => {
  it('enqueues a ticket with the blueprint defaults', async () => {
    const { handle } = await boot();
    const { status, body } = await api(
      handle,
      'POST',
      '/api/factory/tickets',
      {
        title: 'Add cursor pagination to /users',
        spec: 'Acceptance: cursor pagination, tests green, wire format unchanged.',
      },
      authorized(handle),
    );
    expect(status).toBe(201);
    expect(body.ticket).toMatchObject({
      state: 'queued',
      runtime: 'worktree',
      policyClass: 'guarded',
      retries: 2,
      bestOfN: 1,
      repo: null,
      budgetUsd: null,
    });
    const id = (body.ticket as { id: string }).id;
    expect(id).toMatch(/^tkt_/);
    // The write landed in the daemon's state of record, not just the response.
    expect(handle.factory.get(id)?.title).toBe('Add cursor pagination to /users');
  });

  it('rejects an invalid ticket with 400', async () => {
    const { handle } = await boot();
    const noSpec = await api(
      handle,
      'POST',
      '/api/factory/tickets',
      {
        title: 'no spec',
      },
      authorized(handle),
    );
    expect(noSpec.status).toBe(400);

    const badPolicy = await api(
      handle,
      'POST',
      '/api/factory/tickets',
      {
        title: 't',
        spec: 's',
        policyClass: 'unattended',
      },
      authorized(handle),
    );
    expect(badPolicy.status).toBe(400);
  });
});
