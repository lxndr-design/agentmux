import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { FsBridgeError, splitSessionPath, type FsBridge, type FsChangeEvent } from './fs-bridge.js';
import type { EventJournal } from './journal.js';
import { clientMessageSchema, type ServerMessage } from './wire.js';

/** Replay batches cap the size of a single WS frame. */
const REPLAY_BATCH_SIZE = 500;

export interface GatewayOptions {
  journal: EventJournal;
  token: string;
  /**
   * The FS bridge serving file RPC — absent until the bridge is wired in
   * (boot order: journal → gateway → bridge), so fs_request degrades to a
   * typed error instead of crashing the session path.
   */
  fsBridge?: FsBridge;
}

/**
 * Token extraction: `Authorization: Bearer` for non-browser clients, `?token=`
 * for browsers (they cannot set WS upgrade headers). The token is per-boot,
 * and the daemon is loopback-only, so the URL exposure is local by
 * construction.
 */
function extractToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token !== undefined) {
      return token;
    }
  }
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? undefined;
}

function tokenMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The WebSocket gateway: authenticated session subscriptions over the journal.
 *
 * Subscribe contract — a client sends `{type:'subscribe', sessionId,
 * fromSeq?}` and receives the journaled envelopes after `fromSeq` in order
 * (batched 'replay' messages), then one 'replay_end' carrying the session's
 * newest seq; every later append arrives as 'event'. Reconnection resume is
 * the same path: send the last seq you saw, receive exactly the gap.
 *
 * Ordering and exactly-once per connection are guaranteed by construction:
 * the journal replay is a synchronous read and the subscriber is registered
 * only after the snapshot, while Node runs each message handler to completion
 * — no append can slip between snapshot and registration.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  constructor(private readonly options: GatewayOptions) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => {
      this.setupConnection(ws);
    });
  }

  /** Auth-gated upgrade: rejects non-token clients with 401 before accepting. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = extractToken(request);
    if (token === undefined || !tokenMatches(token, this.options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  /** Fan out one journaled envelope to every subscriber of its session. */
  broadcast(envelope: AgentEventEnvelope): void {
    const audience = this.subscribers.get(envelope.sessionId);
    if (audience === undefined) {
      return;
    }
    const message = JSON.stringify({ type: 'event', envelope } satisfies ServerMessage);
    for (const ws of audience) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private setupConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      this.handleClientMessage(ws, data.toString());
    });
    ws.on('close', () => this.removeSubscriber(ws));
    ws.on('error', () => this.removeSubscriber(ws));
  }

  private handleClientMessage(ws: WebSocket, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      this.send(ws, { type: 'error', message: 'messages must be JSON' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.send(ws, { type: 'error', message: `unrecognized message: ${parsed.error.message}` });
      return;
    }
    if (parsed.data.type === 'subscribe') {
      this.subscribe(ws, parsed.data.sessionId, parsed.data.fromSeq ?? -1);
      return;
    }
    if (parsed.data.type === 'fs_request') {
      this.handleFsRequest(ws, parsed.data.requestId, parsed.data.request);
    }
  }

  /**
   * FS RPC: validate, dispatch into the bridge (the sandbox lives there),
   * and answer exactly one fs_result or fs_error for the request id. A
   * missing bridge is a typed error, not a silent hang.
   */
  private async handleFsRequest(
    ws: WebSocket,
    requestId: string,
    request: Parameters<FsBridge['dispatch']>[0],
  ): Promise<void> {
    if (this.options.fsBridge === undefined) {
      this.send(ws, {
        type: 'fs_error',
        requestId,
        error: { code: 'E_IO', message: 'no filesystem bridge is running' },
      });
      return;
    }
    try {
      const result = await this.options.fsBridge.dispatch(request);
      this.send(ws, { type: 'fs_result', requestId, result });
    } catch (error) {
      const bridgeError =
        error instanceof FsBridgeError
          ? error
          : new FsBridgeError('E_IO', `filesystem request failed: ${(error as Error).message}`);
      this.send(ws, {
        type: 'fs_error',
        requestId,
        error: { code: bridgeError.code, message: bridgeError.message },
      });
    }
  }

  /**
   * File changes are workspace-global — broadcast to every connection, not
   * per-session subscribers, so a file pane reacts to edits from any pane or
   * agent process.
   */
  broadcastFsChange(event: FsChangeEvent): void {
    if (this.wss.clients.size === 0) {
      return;
    }
    const message = JSON.stringify({
      type: 'fs_change',
      path: event.path,
      changeType: event.type,
      session: splitSessionPath(event.path) ?? null,
    } satisfies ServerMessage);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  private subscribe(ws: WebSocket, sessionId: string, fromSeq: number): void {
    // Snapshot first, register second — see the class comment for why the
    // subscriber can neither miss an event nor receive one twice.
    const envelopes = this.options.journal.replay(sessionId, fromSeq);
    let audience = this.subscribers.get(sessionId);
    if (audience === undefined) {
      audience = new Set();
      this.subscribers.set(sessionId, audience);
    }
    audience.add(ws);

    for (let offset = 0; offset < envelopes.length; offset += REPLAY_BATCH_SIZE) {
      this.send(ws, {
        type: 'replay',
        sessionId,
        envelopes: envelopes.slice(offset, offset + REPLAY_BATCH_SIZE),
      });
    }
    this.send(ws, {
      type: 'replay_end',
      sessionId,
      lastSeq: this.options.journal.latestSeq(sessionId) ?? null,
    });
  }

  private removeSubscriber(ws: WebSocket): void {
    for (const [sessionId, audience] of this.subscribers) {
      audience.delete(ws);
      if (audience.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
