import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { networkInterfaces, tmpdir, type NetworkInterfaceInfoIPv4 } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@agentmux/protocol';
import { startDaemon, type DaemonHandle, type DaemonOptions } from './daemon.js';
import { serverMessageSchema, type ServerMessage } from './wire.js';

const turn = (text: string): AgentEvent => ({
  kind: 'turn',
  turnId: 't1',
  role: 'assistant',
  text,
  done: false,
});

function sampleEvents(): AgentEvent[] {
  return [
    { kind: 'state_change', from: 'created', to: 'starting' },
    { kind: 'state_change', from: 'starting', to: 'ready' },
    { kind: 'turn', turnId: 't1', role: 'user', text: 'fix the flaky auth test', done: true },
    {
      kind: 'thinking',
      text: 'the retry loop never resets its backoff…',
      done: true,
      turnId: 't1',
    },
    { kind: 'tool_use', callId: 'c1', tool: 'Bash', detail: { command: 'npx vitest run' } },
    { kind: 'tool_result', callId: 'c1', output: '48 passed', truncated: false },
    {
      kind: 'state_change',
      from: 'working',
      to: 'waiting-approval',
      request: { requestId: 'r1', tool: 'Bash', risk: 'medium', command: 'rm -rf ./dist' },
    },
    { kind: 'state_change', from: 'waiting-approval', to: 'working' },
    { kind: 'usage', tokensIn: 1200, tokensOut: 340 },
    { kind: 'turn', turnId: 't2', role: 'assistant', text: 'patched ', done: false },
    { kind: 'turn', turnId: 't2', role: 'assistant', text: 'src/auth.ts', done: true },
  ];
}

function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentmux-daemon-')), 'journal.sqlite3');
}

const openDaemons: DaemonHandle[] = [];
const openClients: GatewayClient[] = [];

function boot(options: DaemonOptions = {}): Promise<DaemonHandle> {
  return startDaemon({ port: 0, ...options }).then((handle) => {
    openDaemons.push(handle);
    return handle;
  });
}

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    await client.close();
  }
  for (const handle of openDaemons.splice(0)) {
    await handle.close();
  }
});

/** Raw WS upgrade probe — resolves with the HTTP status the daemon answered. */
const WS_UPGRADE_HEADERS = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
};

function upgradeStatus(
  port: number,
  options: { path?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/',
        headers: { ...WS_UPGRADE_HEADERS, ...options.headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on('error', reject);
    request.end();
  });
}

type ConnectOutcome = { connected: true } | { connected: false; code: string | undefined };

function probeConnect(host: string, port: number): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const settle = (outcome: ConnectOutcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(2_000);
    socket.on('connect', () => settle({ connected: true }));
    socket.on('timeout', () => settle({ connected: false, code: 'ETIMEDOUT' }));
    socket.on('error', (error) => settle({ connected: false, code: error.code }));
  });
}

/** Test WS client: schema-validates every message and buffers them for asserts. */
class GatewayClient {
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = serverMessageSchema.parse(JSON.parse(String(data)));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        // A waiter owns this message — hand it over without buffering it,
        // or the next buffered scan would serve it a second time.
        const waiter = this.waiters[index];
        if (waiter === undefined) return;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.inbox.push(message);
    });
  }

  static open(
    port: number,
    auth: { query?: string; header?: string } = {},
  ): Promise<GatewayClient> {
    const suffix = auth.query === undefined ? '' : `?token=${encodeURIComponent(auth.query)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/${suffix}`, {
        headers: auth.header === undefined ? {} : { authorization: auth.header },
      });
      openClients.push(new GatewayClient(ws));
      ws.on('error', reject);
      ws.on('open', () => resolve(openClients[openClients.length - 1]!));
    });
  }

  subscribe(sessionId: string, fromSeq?: number): void {
    this.ws.send(
      JSON.stringify({ type: 'subscribe', sessionId, ...(fromSeq !== undefined && { fromSeq }) }),
    );
  }

  rawSend(payload: string): void {
    this.ws.send(payload);
  }

  nextMessage(
    predicate: (message: ServerMessage) => boolean,
    label = 'message',
    timeoutMs = 2_000,
  ): Promise<ServerMessage> {
    const buffered = this.inbox.findIndex(predicate);
    if (buffered >= 0) {
      return Promise.resolve(this.inbox.splice(buffered, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async drainReplay(
    sessionId: string,
  ): Promise<{ envelopes: AgentEventEnvelope[]; lastSeq: number | null }> {
    const envelopes: AgentEventEnvelope[] = [];
    for (;;) {
      const message = await this.nextMessage(
        (m) =>
          (m.type === 'replay' && m.sessionId === sessionId) ||
          (m.type === 'replay_end' && m.sessionId === sessionId),
        `replay for ${sessionId}`,
      );
      if (message.type === 'replay') {
        envelopes.push(...message.envelopes);
      } else {
        return { envelopes, lastSeq: message.lastSeq };
      }
    }
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

function expectGapless(envelopes: AgentEventEnvelope[]): void {
  envelopes.forEach((envelope, index) => {
    const expected = index === 0 ? envelope.seq : envelopes[index - 1]!.seq + 1;
    expect(envelope.seq).toBe(expected);
  });
}

describe('gateway auth', () => {
  it('rejects connections without the per-boot token', async () => {
    const daemon = await boot();
    const port = daemon.address().port;
    expect(await upgradeStatus(port)).toBe(401);
  }, 10_000);

  it('rejects wrong tokens over both auth transports', async () => {
    const daemon = await boot();
    const port = daemon.address().port;
    const wrong = 'A'.repeat(43);
    expect(await upgradeStatus(port, { headers: { authorization: `Bearer ${wrong}` } })).toBe(401);
    expect(await upgradeStatus(port, { path: `/?token=${wrong}` })).toBe(401);
  }, 10_000);

  it('accepts the per-boot token via query param and Authorization header', async () => {
    const daemon = await boot();
    const port = daemon.address().port;
    expect(await upgradeStatus(port, { path: `/?token=${encodeURIComponent(daemon.token)}` })).toBe(
      101,
    );
    await GatewayClient.open(port, { header: `Bearer ${daemon.token}` });
  }, 10_000);

  it('rotates the token every boot — a previous boot token is rejected', async () => {
    const path = tempJournalPath();
    const first = await boot({ journalPath: path });
    const second = await boot({ journalPath: path });
    expect(first.token).not.toBe(second.token);
    expect(
      await upgradeStatus(second.address().port, {
        headers: { authorization: `Bearer ${first.token}` },
      }),
    ).toBe(401);
  }, 10_000);
});

describe('replay and resume', () => {
  it('replays deterministically across daemon restarts from the same journal', async () => {
    const path = tempJournalPath();
    const first = await boot({ journalPath: path });
    const events = sampleEvents();
    for (const event of events) {
      first.ingest('sess-1', event);
    }
    const firstClient = await GatewayClient.open(first.address().port, { query: first.token });
    firstClient.subscribe('sess-1');
    const firstReplay = await firstClient.drainReplay('sess-1');
    expect(firstReplay.lastSeq).toBe(events.length - 1);
    expectGapless(firstReplay.envelopes);
    expect(firstReplay.envelopes.map((envelope) => envelope.payload)).toEqual(events);
    await firstClient.close();
    await first.close();

    const second = await boot({ journalPath: path });
    const secondClient = await GatewayClient.open(second.address().port, {
      header: `Bearer ${second.token}`,
    });
    secondClient.subscribe('sess-1');
    const secondReplay = await secondClient.drainReplay('sess-1');
    expect(secondReplay).toEqual(firstReplay);

    const cursorClient = await GatewayClient.open(second.address().port, {
      query: second.token,
    });
    cursorClient.subscribe('sess-1', 3);
    const fromThree = await cursorClient.drainReplay('sess-1');
    expect(fromThree.lastSeq).toBe(firstReplay.lastSeq);
    expect(fromThree.envelopes).toEqual(firstReplay.envelopes.slice(4));
  }, 20_000);

  it('resumes a reconnection from the last seen seq with the exact gap', async () => {
    const daemon = await boot();
    const port = daemon.address().port;
    for (let seq = 0; seq < 3; seq++) {
      daemon.ingest('sess-1', turn(`chunk ${seq}`));
    }
    const first = await GatewayClient.open(port, { query: daemon.token });
    first.subscribe('sess-1');
    const initial = await first.drainReplay('sess-1');
    expect(initial.lastSeq).toBe(2);
    const live = first.nextMessage((m) => m.type === 'event', 'live event');
    daemon.ingest('sess-1', turn('live one'));
    expect((await live).envelope.seq).toBe(3);
    await first.close();

    daemon.ingest('sess-1', turn('while away 1'));
    daemon.ingest('sess-1', turn('while away 2'));

    const resumed = await GatewayClient.open(port, { query: daemon.token });
    resumed.subscribe('sess-1', 3);
    const gap = await resumed.drainReplay('sess-1');
    expect(gap.envelopes.map((envelope) => envelope.seq)).toEqual([4, 5]);
    expect(gap.lastSeq).toBe(5);

    const resumedLive = resumed.nextMessage((m) => m.type === 'event', 'resumed live');
    daemon.ingest('sess-1', turn('after reconnect'));
    expect((await resumedLive).envelope.seq).toBe(6);
  }, 20_000);

  it('streams live events in strict journal order after an empty replay', async () => {
    const daemon = await boot();
    const client = await GatewayClient.open(daemon.address().port, { query: daemon.token });
    client.subscribe('sess-1');
    const empty = await client.drainReplay('sess-1');
    expect(empty).toEqual({ envelopes: [], lastSeq: null });
    for (let seq = 0; seq < 20; seq++) {
      daemon.ingest('sess-1', turn(`chunk ${seq}`));
    }
    for (let seq = 0; seq < 20; seq++) {
      const message = await client.nextMessage((m) => m.type === 'event', `event ${seq}`);
      expect(message.envelope.seq).toBe(seq);
    }
  }, 20_000);

  it('replies with an error message to malformed client input', async () => {
    const daemon = await boot();
    const client = await GatewayClient.open(daemon.address().port, { query: daemon.token });
    client.rawSend('not json');
    const parseError = await client.nextMessage((m) => m.type === 'error', 'json error');
    expect(parseError.message).toMatch(/json/i);
    client.rawSend(JSON.stringify({ type: 'nope' }));
    const schemaError = await client.nextMessage((m) => m.type === 'error', 'schema error');
    expect(schemaError.message).toMatch(/unrecognized/i);
  }, 10_000);
});

describe('loopback-only bind', () => {
  it('binds a loopback address and refuses a non-loopback interface', async () => {
    const daemon = await boot();
    const { host, port } = daemon.address();
    expect(host).toBe('127.0.0.1');

    const nonLoopback = Object.values(networkInterfaces())
      .flat()
      .find((entry): entry is NetworkInterfaceInfoIPv4 => {
        return entry !== undefined && !entry.internal && entry.family === 'IPv4';
      })?.address;
    if (nonLoopback !== undefined) {
      const outcome = await probeConnect(nonLoopback, port);
      if (outcome.connected) {
        throw new Error(`daemon accepted a connection via ${nonLoopback} — not loopback-only`);
      }
    }

    await expect(boot({ host: '0.0.0.0' })).rejects.toThrowError(/loopback only/);
  }, 20_000);
});
