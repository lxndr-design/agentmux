import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentmux/protocol';
import { CodexConnector } from './connector.js';
import { CodexExecSession } from './exec-session.js';
import { CodexSession } from './session.js';
import type { SessionEventSink } from '../types.js';

/**
 * Integration tests over a real PTY against the fake CLI fixture — the full
 * round-trip (spawn → handshake → events → prompt → decision → resume →
 * kill) with no real codex binary and no ChatGPT credentials, ever (brief:
 * testing WITHOUT a real codex binary).
 */

const FAKE_CLI = new URL('./fixtures/fake-codex.mjs', import.meta.url);

interface Harness {
  session: CodexSession;
  events: AgentEvent[];
}

let cleanupDirs: string[] = [];

async function spawnFake(extraArgs: string[] = []): Promise<Harness> {
  const events: AgentEvent[] = [];
  const sink: SessionEventSink = { onEvent: (event) => events.push(event) };
  // command = the current node binary; the fake CLI ignores the connector's
  // own subcommand, so no argument surgery is needed.
  const session = await CodexSession.spawn(
    {
      sessionId: 'test-session',
      cwd: process.cwd(),
      command: process.execPath,
      extraArgs: [FAKE_CLI.pathname, ...extraArgs],
    },
    sink,
  );
  return { session, events };
}

async function until(
  description: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const stateChanges = (events: AgentEvent[]) =>
  events.filter(
    (event): event is Extract<AgentEvent, { kind: 'state_change' }> =>
      event.kind === 'state_change',
  );
type TurnEvent = Extract<AgentEvent, { kind: 'turn' }>;
const turns = (events: AgentEvent[]): TurnEvent[] =>
  events.filter((event): event is TurnEvent => event.kind === 'turn');

beforeEach(() => {
  delete process.env.FAKE_SIGNALS_FILE;
  delete process.env.FAKE_IGNORE_SIGINT;
  delete process.env.FAKE_CHILD_MARKER;
  delete process.env.FAKE_APPSERVER_APPROVAL;
  delete process.env.FAKE_ARGV_FILE;
});

afterEach(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

describe('CodexSession over a real PTY (fake CLI, app-server)', () => {
  it(
    'drives handshake → turn → approval decision → completion → kill end to end',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agentmux-codex-'));
      cleanupDirs.push(dir);
      process.env.FAKE_SIGNALS_FILE = path.join(dir, 'signals.log');
      process.env.FAKE_APPSERVER_APPROVAL = '1';
      const { session, events } = await spawnFake();
      try {
        // Handshake: initialize + thread/start completed before ready.
        await until('session ready', () => session.state === 'ready');
        expect(session.getThreadId()).toBe('thr_fake');

        session.send('fix the auth bug');
        await until('turn sent → working', () => session.state === 'working');
        const userTurn = turns(events).find((turn) => turn.role === 'user');
        expect(userTurn?.text).toBe('fix the auth bug');

        // The CLI streams reasoning deltas as thinking events.
        await until('thinking deltas arrive', () =>
          events.some((event) => event.kind === 'thinking' && !event.done),
        );

        // The dangerous command surfaces as a full-disclosure approval card.
        await until('waiting-approval', () => session.state === 'waiting-approval');
        const waiting = stateChanges(events).find((change) => change.to === 'waiting-approval');
        expect(waiting?.request.tool).toBe('shell');
        expect(waiting?.request.command).toBe('rm -rf ./dist');
        expect(waiting?.request.risk).toBe('high');

        // The decision is written to stdin as an {id, result} frame and the
        // turn resumes to completion — the column is the only approval path.
        session.respondToApproval({
          requestId: waiting?.request.requestId ?? '',
          decision: 'approve',
        });
        await until('assistant turn completes after the decision', () =>
          turns(events).some((turn) => turn.role === 'assistant' && turn.done),
        );
        // The machine resumes to 'working' — 'ready' is entered once at init
        // (pinned protocol contract; the Claude connector behaves the same).
        expect(session.state).toBe('working');
        const signalLog = await readFile(path.join(dir, 'signals.log'), 'utf8');
        expect(signalLog).toContain('DECISION:accept');
        expect(turns(events).some((turn) => turn.role === 'assistant' && turn.done)).toBe(true);
        expect(events.some((event) => event.kind === 'usage')).toBe(true);

        // "Stop this agent": SIGINT to the group, tombstone with reason.
        const exit = await session.kill();
        expect(exit.reason).toBe('killed');
        expect(session.state).toBe('stopped');
        const signalLogAfterKill = await readFile(path.join(dir, 'signals.log'), 'utf8');
        expect(signalLogAfterKill).toContain('SIGINT');
      } finally {
        if (session.state !== 'stopped' && session.state !== 'crashed') await session.kill();
      }
    },
  );

  it(
    'escalates to SIGKILL when the CLI ignores SIGINT, and takes the process group with it',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agentmux-codex-'));
      cleanupDirs.push(dir);
      process.env.FAKE_SIGNALS_FILE = path.join(dir, 'signals.log');
      process.env.FAKE_IGNORE_SIGINT = '1';
      process.env.FAKE_CHILD_MARKER = path.join(dir, 'child.pid');
      const { session, events } = await spawnFake();
      try {
        await until('session ready', () => session.state === 'ready');
        const childPid = Number(await readFile(path.join(dir, 'child.pid'), 'utf8'));
        expect(Number.isFinite(childPid)).toBe(true);

        const exit = await session.kill();
        expect(exit.reason).toBe('killed');
        expect(session.state).toBe('stopped');
        await until('child process died with the group', () => {
          try {
            process.kill(childPid, 0);
            return false;
          } catch {
            return true;
          }
        });
        expect(stateChanges(events).some((change) => change.to === 'stopped')).toBe(true);
      } finally {
        if (session.state !== 'stopped' && session.state !== 'crashed') await session.kill();
      }
    },
  );
});

describe('CodexExecSession over a real PTY (fake CLI, exec JSONL)', () => {
  it(
    'runs per-turn exec processes and resumes with the prior thread id',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agentmux-codex-exec-'));
      cleanupDirs.push(dir);
      process.env.FAKE_ARGV_FILE = path.join(dir, 'argv.log');
      const events: AgentEvent[] = [];
      const sink: SessionEventSink = { onEvent: (event) => events.push(event) };
      const session = CodexExecSession.spawn(
        {
          sessionId: 'exec-session',
          cwd: process.cwd(),
          command: process.execPath,
          extraArgs: [FAKE_CLI.pathname],
        },
        sink,
      );
      try {
        // No handshake on this surface — the container is ready at once.
        expect(session.state).toBe('ready');

        session.send('first task');
        await until('first assistant turn arrives', () =>
          events.some((event) => event.kind === 'turn' && event.role === 'assistant' && event.done),
        );
        expect(session.state).toBe('working');
        expect(events.some((event) => event.kind === 'usage')).toBe(true);

        // The second turn resumes the thread the first one announced.
        session.send('second task');
        await until(
          'second assistant turn arrives',
          () => turns(events).filter((turn) => turn.role === 'assistant' && turn.done).length >= 2,
        );
        const argvLog = await readFile(path.join(dir, 'argv.log'), 'utf8');
        const argvLines = argvLog
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        // Turn 1 fresh; turn 2 resumes the thread the first one announced.
        expect(argvLines).toHaveLength(2);
        expect(argvLines[0]).not.toContain('resume');
        expect(argvLines[1]?.slice(0, 3)).toEqual(['exec', 'resume', 'thr_exec_9']);

        // Kill with no turn running tombstones immediately.
        const exit = await session.kill();
        expect(exit.reason).toBe('killed');
        expect(session.state).toBe('stopped');
      } finally {
        if (session.state !== 'stopped' && session.state !== 'crashed') await session.kill();
      }
    },
  );
});

describe('CodexConnector', () => {
  it('refuses to spawn an unauthenticated CLI with the fix in the message', async () => {
    const connector = new CodexConnector('definitely-not-a-real-codex-binary');
    const events: AgentEvent[] = [];
    const sink: SessionEventSink = { onEvent: (event) => events.push(event) };
    await expect(
      connector.spawn(
        { sessionId: 's', cwd: process.cwd(), command: undefined, extraArgs: undefined },
        sink,
      ),
    ).rejects.toThrow(/codex login/);
  });
});
