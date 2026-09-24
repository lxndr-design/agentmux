import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentmux/protocol';
import { ClaudeCodeSession } from './session.js';
import type { SessionEventSink } from '../types.js';

/**
 * Integration tests over a real PTY against the fake CLI fixture — the full
 * round-trip (spawn → events → prompt → decision → resume → kill) with no
 * real claude binary and no API keys, ever (brief: testing WITHOUT a real
 * claude binary).
 */

const FAKE_CLI = new URL('./fixtures/fake-claude.mjs', import.meta.url);

interface Harness {
  session: ClaudeCodeSession;
  events: AgentEvent[];
}

let cleanupDirs: string[] = [];

function spawnFake(): Harness {
  const events: AgentEvent[] = [];
  const sink: SessionEventSink = { onEvent: (event) => events.push(event) };
  // command = the current node binary; the fake CLI ignores the connector's
  // own flags, so no argument surgery is needed.
  const session = ClaudeCodeSession.spawn(
    {
      sessionId: 'test-session',
      cwd: process.cwd(),
      command: process.execPath,
      extraArgs: [FAKE_CLI.pathname],
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
});

afterEach(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

describe('ClaudeCodeSession over a real PTY (fake CLI)', () => {
  it(
    'drives spawn → events → prompt → decision → resume → kill end to end',
    { timeout: 30_000 },
    async () => {
      const { session, events } = spawnFake();
      try {
        // The CLI's own system/init frame drives starting→ready.
        await until('session ready', () => session.state === 'ready');
        expect(stateChanges(events).at(-1)).toMatchObject({ from: 'starting', to: 'ready' });

        // A plain text turn: streamed deltas, done marker, usage.
        session.send('hello');
        await until('turn usage event', () => events.some((event) => event.kind === 'usage'));
        const userTurn = turns(events).find((event) => event.role === 'user');
        expect(userTurn).toMatchObject({ role: 'user', text: 'hello', done: true });
        const assistantChunks = turns(events)
          .filter((event) => event.role === 'assistant' && event.turnId !== userTurn?.turnId)
          .map((event) => (event.kind === 'turn' ? event.text : ''))
          .join('');
        // The complete assistant frame after the stream_events must NOT double-emit.
        expect(assistantChunks).toBe('Echo: hello');

        // An approval turn: tool_use → control_request → waiting-approval card.
        session.send('use:Bash rm -rf ./dist');
        await until('waiting-approval card', () => session.state === 'waiting-approval');
        const toolUse = events.find((event) => event.kind === 'tool_use');
        expect(toolUse).toMatchObject({ tool: 'Bash', detail: { command: 'rm -rf ./dist' } });
        expect(stateChanges(events).at(-1)).toMatchObject({
          from: 'working',
          to: 'waiting-approval',
          request: { requestId: 'req_001', tool: 'Bash', risk: 'high', command: 'rm -rf ./dist' },
        });

        // Approve → the CLI resumes: tool_result, then the model reports the run.
        session.respondToApproval({ requestId: 'req_001', decision: 'approve' });
        await until('tool_result after approval', () =>
          events.some((event) => event.kind === 'tool_result'),
        );
        expect(session.state).toBe('working');
        expect(events.find((event) => event.kind === 'tool_result')).toMatchObject({
          callId: 'toolu_fake01',
          output: 'ran: rm -rf ./dist',
        });
        await until(
          'turn completes after approval',
          () => events.filter((event) => event.kind === 'usage').length >= 2,
        );
        const resumedChunks = turns(events)
          .filter((event) => event.role === 'assistant')
          .map((event) => (event.kind === 'turn' ? event.text : ''))
          .join('');
        expect(resumedChunks).toContain('Echo: ran: rm -rf ./dist');

        // A denied decision: the denial reason is what reaches the model.
        session.send('use:Bash echo hi');
        await until('second waiting-approval card', () => session.state === 'waiting-approval');
        expect(stateChanges(events).at(-1)).toMatchObject({
          to: 'waiting-approval',
          request: { requestId: 'req_002' },
        });
        session.respondToApproval({
          requestId: 'req_002',
          decision: 'deny',
          reason: 'no filesystem mutation today',
        });
        await until('denial reported by the model', () =>
          turns(events).some(
            (event) =>
              event.role === 'assistant' &&
              event.kind === 'turn' &&
              event.text.includes('denied: no filesystem mutation today'),
          ),
        );
        await until(
          'third usage event',
          () => events.filter((event) => event.kind === 'usage').length >= 3,
        );

        // Kill: SIGINT → grace → tombstone with reason 'killed'.
        const exit = await session.kill({ graceMs: 500 });
        expect(exit).toMatchObject({ reason: 'killed' });
        expect(session.state).toBe('stopped');
        expect(stateChanges(events).at(-1)).toMatchObject({
          to: 'stopped',
          exit: { reason: 'killed' },
        });
      } finally {
        await session.kill({ graceMs: 250 }).catch(() => undefined);
        await session.exit;
      }
    },
  );

  it(
    'escalates to SIGKILL when SIGINT is ignored and kills the whole process group',
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'agentmux-kill-'));
      cleanupDirs.push(dir);
      const signalsFile = path.join(dir, 'signals.log');
      const childMarker = path.join(dir, 'child.pid');
      process.env.FAKE_SIGNALS_FILE = signalsFile;
      process.env.FAKE_IGNORE_SIGINT = '1';
      process.env.FAKE_CHILD_MARKER = childMarker;

      const { session, events } = spawnFake();
      try {
        await until('session ready', () => session.state === 'ready');
        session.send('hello');
        await until('turn usage event', () => events.some((event) => event.kind === 'usage'));

        const startedAt = Date.now();
        const exit = await session.kill({ graceMs: 400 });
        const elapsed = Date.now() - startedAt;

        // The grace window was honored before SIGKILL escalated.
        expect(exit.reason).toBe('killed');
        expect(elapsed).toBeGreaterThanOrEqual(350);
        expect(session.state).toBe('stopped');

        // SIGINT was actually delivered (the fake logged it)…
        expect(await readFile(signalsFile, 'utf8')).toContain('SIGINT');
        // …and the spawned child died with the group — a leader-only kill would orphan it.
        const childPid = Number(await readFile(childMarker, 'utf8'));
        expect(Number.isFinite(childPid)).toBe(true);
        let childAlive = false;
        try {
          process.kill(childPid, 0);
          childAlive = true;
        } catch {
          childAlive = false;
        }
        expect(childAlive).toBe(false);
      } finally {
        await session.kill({ graceMs: 100 }).catch(() => undefined);
        await session.exit;
      }
    },
  );
});
