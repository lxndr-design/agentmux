// @vitest-environment node
/**
 * ws-client contract test — the drift check the wire-schema mirror relies on.
 * A mock gateway speaks the REAL daemon protocol (packages/daemon/src/gateway.ts
 * + wire.ts): token auth via ?token=, subscribe → replay → replay_end → live
 * 'event' frames. If the daemon changes its wire shape, this file is what
 * fails, not a user's browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { createAgentEventEnvelope, agentEventSchema } from '@agentmux/protocol';
import { z } from 'zod';
import { WsSessionClient, type StreamPhase } from './wsClient.js';

// The client targets the browser WebSocket global; the `ws` implementation
// exposes the same onopen/onmessage API and is what Node has. The cast is
// double-jumped because the imported binding shadows the DOM constructor type.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const TOKEN = 'test-token';

/** Minimal mock of the daemon gateway — same messages, same ordering. */
class MockGateway {
  readonly wss: WebSocketServer;
  readonly sockets = new Set<WsSocket>();
  /** Resolves once the server is actually listening — address() needs this. */
  readonly ready: Promise<void>;
  private journal: AgentEventEnvelope[] = [];
  /**
   * Optional pre-replay hook — lets a test inject a live frame between the
   * connection and the subscribe handling (the race the client must survive).
   */
  interceptSubscribe: ((socket: WsSocket) => void) | null = null;

  constructor() {
    // Token auth is enforced at the UPGRADE stage — a ws server's 'connection'
    // handler only ever sees completed handshakes. verifyClient (deprecated but
    // the one hook that runs before accept) rejects bad tokens with 401, which
    // the client observes as a connection error.
    this.wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (info: { req: { url?: string | null } }) => {
        const token = new URL(info.req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
        return token === TOKEN;
      },
    });
    this.ready = new Promise((resolve, reject) => {
      this.wss.on('listening', resolve);
      this.wss.on('error', reject);
    });
    this.wss.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('message', (raw) => this.onClientFrame(socket, raw.toString()));
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  get port(): number {
    const address = this.wss.address();
    if (address === null || typeof address === 'string') throw new Error('not bound');
    return address.port;
  }

  url(path = '/'): string {
    return `ws://127.0.0.1:${this.port}${path}`;
  }

  /** Journal append + live fan-out — mirrors daemon.ingest. */
  push(event: z.infer<typeof agentEventSchema>): AgentEventEnvelope {
    const seq = this.journal.length;
    const envelope = createAgentEventEnvelope('s1', seq, event);
    this.journal.push(envelope);
    this.fanout(envelope);
    return envelope;
  }

  /** Force-drop every socket — simulates a transport loss, client will retry. */
  dropClients(): void {
    for (const socket of this.sockets) socket.close();
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private fanout(envelope: AgentEventEnvelope): void {
    const message = JSON.stringify({ type: 'event', envelope });
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  private onClientFrame(socket: WsSocket, raw: string): void {
    const message = JSON.parse(raw) as {
      type: string;
      sessionId?: string;
      fromSeq?: number;
    };
    if (message.type !== 'subscribe' || message.sessionId === undefined) return;
    this.interceptSubscribe?.(socket);
    const fromSeq = message.fromSeq ?? -1;
    const gap = this.journal.filter((envelope) => envelope.seq > fromSeq);
    if (gap.length > 0) {
      socket.send(JSON.stringify({ type: 'replay', sessionId: message.sessionId, envelopes: gap }));
    }
    const lastSeq = this.journal.at(-1)?.seq ?? null;
    socket.send(JSON.stringify({ type: 'replay_end', sessionId: message.sessionId, lastSeq }));
  }
}

interface Harness {
  gateway: MockGateway;
  envelopes: AgentEventEnvelope[];
  phases: StreamPhase[];
  errors: string[];
  client: WsSessionClient;
}

function startClient(gateway: MockGateway, sessionId = 's1'): Harness {
  const envelopes: AgentEventEnvelope[] = [];
  const phases: StreamPhase[] = [];
  const errors: string[] = [];
  const client = new WsSessionClient({
    url: `${gateway.url()}?token=${TOKEN}`,
    sessionId,
    onEnvelope: (envelope) => envelopes.push(envelope),
    onPhase: (phase) => phases.push(phase),
    onProtocolError: (message) => errors.push(message),
    retryBaseMs: 10,
    retryMaxMs: 50,
  });
  client.start();
  return { gateway, envelopes, phases, errors, client };
}

async function waitFor<T>(
  produce: () => T | undefined,
  matches: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 2000;
  let value = produce();
  while (!(value !== undefined && matches(value))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    value = produce();
  }
  return value;
}

const eventuallyLive = (harness: Harness) =>
  waitFor(
    () => harness.phases.at(-1),
    (phase) => phase === 'live',
    'the client to reach live phase',
  );

const eventuallyCount = (harness: Harness, n: number) =>
  waitFor(
    () => harness.envelopes.length,
    (length) => length >= n,
    `${n} envelopes`,
  );

let gateway: MockGateway;

/** First connected client socket, or a clear failure instead of undefined. */
function requireSocket(): WsSocket {
  for (const socket of gateway.sockets) return socket;
  throw new Error('no connected client sockets');
}

beforeEach(async () => {
  gateway = new MockGateway();
  await gateway.ready;
});

afterEach(async () => {
  await gateway.close();
});

describe('WsSessionClient contract', () => {
  it('subscribes with the per-boot token and replays the journal before going live', async () => {
    gateway.push({ kind: 'thinking', text: 'one', done: true });
    gateway.push({ kind: 'thinking', text: 'two', done: true });

    const harness = startClient(gateway);
    await eventuallyCount(harness, 2);
    // live is entered only after replay_end — both replay frames applied first
    await eventuallyLive(harness);

    expect(harness.envelopes.map((e) => e.seq)).toEqual([0, 1]);
    expect(harness.phases.indexOf('live')).toBeGreaterThan(harness.phases.indexOf('replaying'));
    expect(harness.errors).toEqual([]);
  });

  it('does not enter live before replay_end, deduping a live frame that raced the replay', async () => {
    gateway.push({ kind: 'thinking', text: 'j0', done: true });

    // A live frame arriving between the connection and the replay batch: the
    // daemon journals before fanning out, so the same seq also rides the
    // replay. The client must buffer the early frame and dedupe the overlap.
    gateway.interceptSubscribe = (socket) => {
      gateway.push({ kind: 'thinking', text: 'raced', done: true });
      void socket; // push already fanned out to this socket
    };

    const harness = startClient(gateway);
    await eventuallyCount(harness, 2);
    await eventuallyLive(harness);

    const seqs = harness.envelopes.map((e) => e.seq);
    expect(seqs).toEqual([0, 1]);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(harness.errors).toEqual([]);
  });

  it('reconnects with its last-seen seq and receives exactly the gap', async () => {
    gateway.push({ kind: 'thinking', text: 'a', done: true });
    const harness = startClient(gateway);
    await eventuallyLive(harness);
    expect(harness.envelopes.map((e) => e.seq)).toEqual([0]);

    // Transport loss, then more journal writes land before the retry fires.
    gateway.dropClients();
    gateway.push({ kind: 'thinking', text: 'b', done: true });
    gateway.push({ kind: 'thinking', text: 'c', done: true });

    await eventuallyCount(harness, 3);
    await eventuallyLive(harness);
    // Gap-only delivery, journal order, zero duplicates
    expect(harness.envelopes.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(harness.phases).toContain('retrying');
    expect(harness.errors).toEqual([]);
  });

  it('surfaces a token auth failure as a protocol error and keeps retrying', async () => {
    const phases: StreamPhase[] = [];
    const errors: string[] = [];
    const client = new WsSessionClient({
      url: `${gateway.url()}?token=WRONG`,
      sessionId: 's1',
      onEnvelope: () => {},
      onPhase: (phase) => phases.push(phase),
      onProtocolError: (message) => errors.push(message),
      retryBaseMs: 10,
      retryMaxMs: 20,
    });
    client.start();

    await waitFor(
      () => errors.length,
      (count) => count > 0,
      'a protocol error for the 401',
    );
    expect(phases.at(-1)).toBe('retrying');
    client.stop();
  });

  it('treats a malformed server frame as a protocol error, never a crash', async () => {
    const harness = startClient(gateway);
    await eventuallyLive(harness);

    requireSocket().send('not json');

    await waitFor(
      () => harness.errors.length,
      (count) => count > 0,
      'a protocol error for the bad frame',
    );
    // The connection stays up — errors do not kill the stream.
    gateway.push({ kind: 'thinking', text: 'still-alive', done: true });
    await eventuallyCount(harness, 1);
  });

  it('self-heals a seq gap with a full resubscribe and recovers to live', async () => {
    gateway.push({ kind: 'thinking', text: 'a', done: true });
    const harness = startClient(gateway);
    await eventuallyLive(harness);

    // A seq jump with no replay behind it (a daemon bug) — the client
    // resubscribes from 0; the mock replays the full journal.
    requireSocket().send(
      JSON.stringify({
        type: 'event',
        envelope: createAgentEventEnvelope('s1', 7, {
          kind: 'thinking',
          text: 'jump',
          done: true,
        }),
      }),
    );

    await waitFor(
      () => harness.errors.length,
      (count) => count >= 1,
      'the gap error',
    );
    await eventuallyLive(harness);
    // The resync re-delivers from seq 0; the store dedupes on its side, so
    // re-delivery here is by design — the invariant is that the stream ended
    // consistent, at the journal's head.
    expect(harness.envelopes.at(-1)?.seq).toBe(0);
    harness.client.stop();
  });

  it('stop() closes cleanly with no further reconnects', async () => {
    const harness = startClient(gateway);
    await eventuallyLive(harness);
    harness.client.stop();
    expect(harness.phases.at(-1)).toBe('closed');
    await vi.waitFor(() => expect(gateway.sockets.size).toBe(0));
  });
});
