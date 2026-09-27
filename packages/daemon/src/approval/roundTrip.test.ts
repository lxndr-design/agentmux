import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentmux/protocol';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { ClaudeCodeSession } from '../connectors/claude-code/session.js';
import { serverMessageSchema, type ServerMessage } from '../wire.js';

/**
 * The full approval round trip with no real claude binary and no API keys:
 * the fake CLI blocks on a permission prompt over the PTY, the daemon's
 * policy engine journals and escalates it, a WS client decides, and the
 * decision re-enters the CLI over stdin — approve resumes the tool, deny
 * with a reason delivers that reason to the agent verbatim.
 */

const FAKE_CLI = new URL('../connectors/claude-code/fixtures/fake-claude.mjs', import.meta.url);
const SESSION_ID = 'roundtrip-1';

const openDaemons: DaemonHandle[] = [];
const openClients: DecideClient[] = [];
const dirs: string[] = [];

/** Minimal schema-validating WS client — decisions out, events in. */
class DecideClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (payload: AgentEvent) => boolean;
    resolve: (message: Extract<ServerMessage, { type: 'event' }>) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const message = serverMessageSchema.parse(JSON.parse(String(data)));
      // Replay batches are flattened into the same inbox as live events so
      // waiters see both through one mechanism.
      if (message.type === 'replay') {
        for (const envelope of message.envelopes) {
          this.inbox.push({ type: 'event', envelope });
        }
      } else if (message.type === 'event') {
        this.inbox.push(message);
      } else {
        return; // replay_end, errors — nothing waiters can match
      }
      this.pump();
    });
  }

  /** Resolves the first waiter whose predicate matches a buffered event. */
  private pump(): void {
    const index = this.waiters.findIndex((waiter) =>
      this.inbox.some(
        (buffered) => buffered.type === 'event' && waiter.predicate(buffered.envelope.payload),
      ),
    );
    if (index < 0) return;
    const waiter = this.waiters[index]!;
    this.waiters.splice(index, 1);
    const matched = this.inbox.findIndex(
      (buffered) => buffered.type === 'event' && waiter.predicate(buffered.envelope.payload),
    );
    clearTimeout(waiter.timer);
    waiter.resolve(this.inbox.splice(matched, 1)[0] as Extract<ServerMessage, { type: 'event' }>);
  }

  static open(handle: DaemonHandle): Promise<DecideClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${handle.address().port}/?token=${encodeURIComponent(handle.token)}`,
      );
      const client = new DecideClient(ws);
      openClients.push(client);
      ws.on('error', reject);
      ws.on('open', () => resolve(client));
    });
  }

  subscribe(sessionId: string): void {
    this.ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  }

  decide(
    sessionId: string,
    requestId: string,
    decision: 'approve' | 'deny',
    reason?: string,
  ): void {
    this.ws.send(
      JSON.stringify({
        type: 'decide',
        sessionId,
        decision: { requestId, decision, ...(reason !== undefined && { reason }) },
      }),
    );
  }

  nextEvent(
    predicate: (payload: AgentEvent) => boolean,
    label: string,
    timeoutMs = 15_000,
  ): Promise<Extract<ServerMessage, { type: 'event' }>> {
    const buffered = this.inbox.findIndex(
      (message) => message.type === 'event' && predicate(message.envelope.payload),
    );
    if (buffered >= 0) {
      return Promise.resolve(
        this.inbox.splice(buffered, 1)[0] as Extract<ServerMessage, { type: 'event' }>,
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: Extract<ServerMessage, { type: 'event' }>) => resolve(message),
        timer: setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/**
 * Spawns the fake CLI with the daemon's sole ingest path as its event sink —
 * the engine sees every event exactly as a real supervised session delivers it.
 */
function spawnThrough(daemon: DaemonHandle): ClaudeCodeSession {
  return ClaudeCodeSession.spawn(
    {
      sessionId: SESSION_ID,
      cwd: process.cwd(),
      command: process.execPath,
      extraArgs: [FAKE_CLI.pathname],
    },
    { onEvent: (event) => daemon.ingest(SESSION_ID, event) },
  );
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

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
  for (const handle of openDaemons.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  delete process.env.FAKE_SIGNALS_FILE;
  delete process.env.FAKE_IGNORE_SIGINT;
  delete process.env.FAKE_CHILD_MARKER;
});

/**
 * A real git repo as the daemon's workspace root — a supervisor spawn runs
 * the worktree/local runtime, whose main-checkout registration runs git in
 * that root.
 */
async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-roundtrip-'));
  dirs.push(repo);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  const execFileAsync = promisify(execFile);
  const identity = ['-c', 'user.name=agentmux-test', '-c', 'user.email=test@agentmux.local'];
  await execFileAsync('git', [...identity, 'init', '-q', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', [...identity, 'add', '.'], { cwd: repo });
  await execFileAsync('git', [...identity, 'commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

describe('approval round trip through the daemon', () => {
  it(
    'prompt pauses the agent, a WS decision resumes it — deny delivers the reason',
    { timeout: 45_000 },
    async () => {
      const daemon = await startDaemon({ port: 0 });
      openDaemons.push(daemon);
      const session = spawnThrough(daemon);
      daemon.approvals.attachSession(SESSION_ID, session);

      try {
        await until('session ready', () => session.state === 'ready');
        const client = await DecideClient.open(daemon);
        client.subscribe(SESSION_ID);

        // The CLI asks: rm -rf → the request pauses the process and surfaces
        // as a journaled, escalated event on the wire.
        session.send('use:Bash rm -rf ./dist');
        const requestEvent = await client.nextEvent(
          (payload) =>
            payload.kind === 'state_change' &&
            payload.to === 'waiting-approval' &&
            payload.request?.tool === 'Bash',
          'waiting-approval event',
        );
        expect(requestEvent.envelope.payload).toMatchObject({
          kind: 'state_change',
          to: 'waiting-approval',
          request: { requestId: 'req_001', tool: 'Bash', risk: 'high', command: 'rm -rf ./dist' },
        });
        expect(session.state).toBe('waiting-approval');

        // The human denies with a reason over the WS decision path.
        client.decide(SESSION_ID, 'req_001', 'deny', 'no filesystem mutation today');

        // The journaled decision event goes back out over the wire…
        await client.nextEvent(
          (payload) => payload.kind === 'approval_decision' && payload.requestId === 'req_001',
          'approval_decision event',
        );
        // …and the CLI resumes, reporting the denial reason verbatim.
        await client.nextEvent(
          (payload) =>
            payload.kind === 'turn' &&
            payload.role === 'assistant' &&
            payload.text.includes('denied: no filesystem mutation today'),
          'denial reason delivered to the agent',
        );

        // Second round: approve this time — the tool actually runs.
        session.send('use:Bash echo hi');
        await client.nextEvent(
          (payload) =>
            payload.kind === 'state_change' &&
            payload.to === 'waiting-approval' &&
            payload.request?.requestId === 'req_002',
          'second waiting-approval event',
        );
        client.decide(SESSION_ID, 'req_002', 'approve');
        await client.nextEvent(
          (payload) => payload.kind === 'tool_result' && payload.output === 'ran: echo hi',
          'approved tool executed',
        );
        expect(session.state).toBe('working');
      } finally {
        await session.kill({ graceMs: 250 }).catch(() => undefined);
        await session.exit;
      }
    },
  );

  it(
    'replays the request → decision → consequence sequence in journal order',
    { timeout: 45_000 },
    async () => {
      const daemon = await startDaemon({ port: 0 });
      openDaemons.push(daemon);
      const session = spawnThrough(daemon);
      daemon.approvals.attachSession(SESSION_ID, session);

      try {
        await until('session ready', () => session.state === 'ready');
        session.send('use:Bash rm -rf ./dist');
        const client = await DecideClient.open(daemon);
        client.subscribe(SESSION_ID);
        await client.nextEvent(
          (payload) => payload.kind === 'state_change' && payload.to === 'waiting-approval',
          'waiting-approval event',
        );
        client.decide(SESSION_ID, 'req_001', 'deny', 'not while I watch');
        await client.nextEvent(
          (payload) =>
            payload.kind === 'turn' &&
            payload.role === 'assistant' &&
            payload.text.includes('denied: not while I watch'),
          'denial delivered',
        );
        await client.close();

        // A fresh subscriber replays the whole story, gapless, in order —
        // up to and including the denial consequence turn.
        const reconnected = await DecideClient.open(daemon);
        reconnected.subscribe(SESSION_ID);
        const story: string[] = [];
        for (;;) {
          const message = await reconnected.nextEvent(
            (payload) =>
              payload.kind === 'state_change' ||
              payload.kind === 'approval_decision' ||
              (payload.kind === 'turn' &&
                payload.role === 'assistant' &&
                payload.text.includes('denied:')),
            'replayed story event',
          );
          const payload = message.envelope.payload;
          if (payload.kind === 'turn') break;
          story.push(
            payload.kind === 'state_change'
              ? `${payload.from}→${payload.to}`
              : `${payload.kind}:${payload.decision}`,
          );
        }
        expect(story).toEqual([
          'created→starting',
          'starting→ready',
          'ready→working',
          'working→waiting-approval',
          'approval_decision:deny',
          // The CLI's own resume transition after the stdin denial — the
          // decision re-enters the agent and it keeps going.
          'waiting-approval→working',
        ]);
      } finally {
        await session.kill({ graceMs: 250 }).catch(() => undefined);
        await session.exit;
      }
    },
  );
});

describe('supervisor-spawned sessions complete the round trip', () => {
  // The PR #8 follow-up: the daemon itself must wire supervisor-spawned
  // sessions into the approval engine — no attachSession call in this test.
  it(
    'a daemon-spawned CLI pauses on approval and resumes on a WS decision',
    { timeout: 45_000 },
    async () => {
      const daemon = await startDaemon({ port: 0, workspaceRoot: await tempRepo() });
      openDaemons.push(daemon);

      // Spawned exactly the way the automation API spawns sessions.
      const started = await daemon.supervisor.start({
        sessionId: 'roundtrip-supervised',
        connectorId: 'claude-code',
        command: process.execPath,
        extraArgs: [FAKE_CLI.pathname],
        useMainCheckout: true,
        initialTask: 'use:Bash rm -rf ./dist',
      });
      expect(started.id).toBe('roundtrip-supervised');

      // The client subscribes after the spawn — replay delivers any events
      // that already fired, including the waiting-approval if the fake CLI
      // ran its approval turn before the client connected.
      const client = await DecideClient.open(daemon);
      client.subscribe('roundtrip-supervised');
      await client.nextEvent(
        (payload) =>
          payload.kind === 'state_change' &&
          payload.to === 'waiting-approval' &&
          payload.request?.tool === 'Bash',
        'waiting-approval event',
      );
      client.decide('roundtrip-supervised', 'req_001', 'deny', 'not from the API path');

      // The denial reason reaches the agent through the wired session and it
      // resumes — the full round trip, no manual attachSession anywhere.
      await client.nextEvent(
        (payload) =>
          payload.kind === 'turn' &&
          payload.role === 'assistant' &&
          payload.text.includes('denied: not from the API path'),
        'denial reason delivered to the agent',
      );
      expect(daemon.supervisor.get('roundtrip-supervised')?.state).toBe('working');

      await daemon.supervisor.kill('roundtrip-supervised', { graceMs: 250 });
    },
  );
});
