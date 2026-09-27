import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startDaemon,
  type AgentConnector,
  type AgentSession,
  type DaemonHandle,
} from '@agentmux/daemon';
import type { ExitInfo, SessionState } from '@agentmux/protocol';
import { main, type CliIo } from './bin.js';

/**
 * CLI e2e against a real test daemon: `main()` runs in-process but every
 * command goes over real loopback HTTP to a daemon booted with a fake
 * connector — no real CLI, no API keys, no sockets beyond loopback.
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
  const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-cli-'));
  dirs.push(repo);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', [...GIT_IDENTITY, 'init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'add', '.'], { cwd: repo });
  await execFileAsync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

function fakeConnector(): { connector: AgentConnector; sent: string[] } {
  const sent: string[] = [];
  const settle = new Map<string, (info: ExitInfo) => void>();
  const connector: AgentConnector = {
    id: 'fake',
    detect: async () => ({ installed: true, version: 'fake-1' }),
    spawn: async (config, sink) => {
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
          sent.push(text);
        },
        respondToApproval: () => undefined,
        kill: async () => {
          state = 'stopped';
          sink.onEvent({ kind: 'state_change', from: 'ready', to: 'stopped', exit: { code: 0 } });
          settle.get(sessionId)?.({ code: 0 });
          return { code: 0 };
        },
        exit: new Promise<ExitInfo>((resolve) => {
          settle.set(sessionId, resolve);
        }),
      };
      return session;
    },
  };
  return { connector, sent };
}

interface TestIo extends CliIo {
  stdoutText(): string;
  stderrText(): string;
}

function testIo(env: Record<string, string | undefined>): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env,
    stdout: { write: (text) => void out.push(text) },
    stderr: { write: (text) => void err.push(text) },
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

async function boot(): Promise<{ handle: DaemonHandle; sent: string[] }> {
  const { connector, sent } = fakeConnector();
  const handle = await startDaemon({
    port: 0,
    workspaceRoot: await tempRepo(),
    connectors: new Map([['fake', connector]]),
  });
  openDaemons.push(handle);
  return { handle, sent };
}

function envFor(handle: DaemonHandle, token?: string): Record<string, string | undefined> {
  return {
    AGENTMUX_URL: `http://127.0.0.1:${handle.address().port}`,
    ...(token === undefined ? {} : { AGENTMUX_TOKEN: token }),
  };
}

async function waitFor(
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

describe('agentmux run — e2e against a test daemon', () => {
  it('spawns a session, delivers the task, and prints the stream pointer', async () => {
    const { handle, sent } = await boot();
    const io = testIo(envFor(handle, handle.token));

    const code = await main(
      ['run', '--session=cli-e2e-1', '--connector=fake', 'fix the flaky auth test'],
      io,
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain('session cli-e2e-1 is ready');
    expect(io.stdoutText()).toContain(`stream: ws://127.0.0.1:${handle.address().port}`);
    expect(io.stdoutText()).toContain('replay from seq 1');
    // The task reached the agent through the daemon's dispatch path.
    await waitFor('initial task delivery', () => sent.length === 1);
    expect(sent).toEqual(['fix the flaky auth test']);
  });

  it('rejects an empty task as a usage error (exit 2)', async () => {
    const { handle } = await boot();
    const io = testIo(envFor(handle, handle.token));

    const code = await main(['run', '   '], io);

    expect(code).toBe(2);
    expect(io.stderrText()).toContain('non-empty task is required');
    expect(handle.supervisor.list()).toEqual([]);
  });

  it('fails with guidance when the token is missing (exit 1)', async () => {
    const { handle } = await boot();
    const io = testIo(envFor(handle)); // no AGENTMUX_TOKEN

    const code = await main(['run', 'some task'], io);

    expect(code).toBe(1);
    expect(io.stderrText()).toContain('AGENTMUX_TOKEN');
    expect(handle.supervisor.list()).toEqual([]);
  });

  it('fails with the 401 hint when the token is wrong (exit 1)', async () => {
    const { handle } = await boot();
    const io = testIo(envFor(handle, 'wrong-token-entirely'));

    const code = await main(['run', 'some task'], io);

    expect(code).toBe(1);
    expect(io.stderrText()).toContain('401');
    expect(handle.supervisor.list()).toEqual([]);
  });

  it('fails with a reachability message when no daemon listens (exit 1)', async () => {
    // Bind and close a socket to claim a port that is deterministically dead.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const io = testIo({
      AGENTMUX_URL: `http://127.0.0.1:${deadPort}`,
      AGENTMUX_TOKEN: 'whatever',
    });
    const code = await main(['run', 'some task'], io);

    expect(code).toBe(1);
    expect(io.stderrText()).toContain('cannot reach the daemon');
  });
});

describe('agentmux factory enqueue — e2e against a test daemon', () => {
  it('queues a ticket the daemon stores', async () => {
    const { handle } = await boot();
    const io = testIo(envFor(handle, handle.token));

    const code = await main(
      [
        'factory',
        'enqueue',
        '--title=Add cursor pagination to /users',
        '--spec=cursor pagination, tests green',
        '--budget=4',
      ],
      io,
    );

    expect(code).toBe(0);
    const ticketId = (io.stdoutText().match(/ticket (tkt_[0-9a-f]+) queued/) ?? [])[1];
    expect(ticketId).toBeDefined();
    // The write landed in the daemon's state of record, not just the response.
    const stored = handle.factory.get(ticketId!);
    expect(stored?.title).toBe('Add cursor pagination to /users');
    expect(stored?.budgetUsd).toBe(4);
    expect(stored?.state).toBe('queued');
  });

  it('rejects a ticket without --spec as a usage error (exit 2)', async () => {
    const { handle } = await boot();
    const io = testIo(envFor(handle, handle.token));

    const code = await main(['factory', 'enqueue', '--title=no spec'], io);

    expect(code).toBe(2);
    expect(io.stderrText()).toContain('ticket spec is required');
  });
});

describe('agentmux usage', () => {
  it('prints usage for help and exits 0', async () => {
    const io = testIo({});
    const code = await main(['help'], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain('agentmux run');
    expect(io.stdoutText()).toContain('factory enqueue');
  });

  it('exits 2 on an unknown command, with usage on stderr', async () => {
    const io = testIo({});
    const code = await main(['teleport'], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unknown command 'teleport'");
    expect(io.stderrText()).toContain('agentmux run');
  });
});
