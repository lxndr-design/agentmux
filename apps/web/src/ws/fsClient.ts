import type { FsRequest, FsResult } from '@agentmux/protocol';
import { parseServerMessage, type FsChangeMessage } from './wire.js';

/**
 * The browser's FS-RPC client — one WebSocket to the daemon gateway,
 * request/response correlation by `requestId`, and the workspace-wide
 * `fs_change` feed. Unlike the session stream there is nothing to replay:
 * RPC is stateless and change events are refresh hints, so a drop only
 * fails in-flight requests (they reject with `FsUnavailable`) and the
 * client reconnects with backoff.
 */

/** A typed bridge error surfaced through `fs_error`. */
export class FsBridgeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FsBridgeRpcError';
  }
}

/** The connection is down (or was closed) — the request never reached a bridge. */
export class FsUnavailableError extends Error {
  constructor(message = 'filesystem connection is not open') {
    super(message);
    this.name = 'FsUnavailableError';
  }
}

export type FsClientPhase = 'connecting' | 'live' | 'retrying' | 'closed';

export interface FsClientOptions {
  /** Full endpoint including the token query, e.g. `ws://127.0.0.1:8787/?token=…`. */
  url: string;
  onFsChange?: (change: FsChangeMessage) => void;
  onPhase?: (phase: FsClientPhase) => void;
  onProtocolError?: (message: string) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export class FsClient {
  private readonly base: number;
  private readonly cap: number;
  private readonly pending = new Map<string, (response: PendingResponse) => void>();
  /** Requests accepted while the socket was still connecting, in send order. */
  private readonly queued: Array<{ requestId: string; request: FsRequest }> = [];
  private requestCounter = 0;
  private attempt = 0;
  private ws: WebSocket | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPhase: FsClientPhase = 'closed';

  constructor(private readonly options: FsClientOptions) {
    this.base = options.retryBaseMs ?? 250;
    this.cap = options.retryMaxMs ?? 5000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.failPending(new FsUnavailableError('filesystem client stopped'));
    this.setPhase('closed');
  }

  /** Sends one FS request; resolves with the op result or throws a typed error. */
  request(request: FsRequest): Promise<FsResult> {
    if (this.stopped) {
      return Promise.reject(new FsUnavailableError());
    }
    const requestId = `fs-${++this.requestCounter}`;
    const promise = new Promise<FsResult>((resolve, reject) => {
      this.pending.set(requestId, (response) => {
        if (response.ok) {
          resolve(response.result);
        } else {
          reject(response.error);
        }
      });
    });
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.sendNow(requestId, request);
    } else {
      // Panes mount before the socket finishes opening; hold their first
      // requests and send in order once `onopen` fires.
      this.queued.push({ requestId, request });
    }
    return promise;
  }

  private sendNow(requestId: string, request: FsRequest): void {
    this.ws?.send(JSON.stringify({ type: 'fs_request', requestId, request }));
  }

  private open(): void {
    if (this.stopped) return;
    this.setPhase(this.attempt === 0 ? 'connecting' : 'retrying');
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setPhase('live');
      // Send everything that arrived while the socket was connecting, in
      // request order; a close after this point fails them via `failPending`.
      const queued = this.queued.splice(0);
      for (const item of queued) {
        this.sendNow(item.requestId, item.request);
      }
    };
    ws.onmessage = (event: MessageEvent) => this.handleFrame(event.data);
    ws.onclose = () => {
      this.ws = null;
      // A dropped connection can no longer answer anything in flight.
      this.failPending(new FsUnavailableError('filesystem connection dropped'));
      if (!this.stopped) {
        this.scheduleRetry();
      }
    };
    ws.onerror = () => {
      // onclose always follows; keep the surface quiet about transport noise.
    };
  }

  private scheduleRetry(): void {
    const delay = Math.min(this.base * 2 ** this.attempt, this.cap);
    this.attempt += 1;
    this.setPhase('retrying');
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private handleFrame(raw: unknown): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.options.onProtocolError?.(parsed.error);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'fs_result':
        this.pending.get(message.requestId)?.({ ok: true, result: message.result });
        this.pending.delete(message.requestId);
        break;
      case 'fs_error':
        this.pending.get(message.requestId)?.({
          ok: false,
          error: new FsBridgeRpcError(message.error.code, message.error.message),
        });
        this.pending.delete(message.requestId);
        break;
      case 'fs_change':
        this.options.onFsChange?.(message);
        break;
      default:
        break; // session-layer frames belong to WsSessionClient, not here
    }
  }

  private failPending(error: Error): void {
    for (const settle of this.pending.values()) {
      settle({ ok: false, error });
    }
    this.pending.clear();
  }

  private setPhase(phase: FsClientPhase): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.options.onPhase?.(phase);
  }
}

type PendingResponse =
  { ok: true; result: FsResult } | { ok: false; error: FsBridgeRpcError | FsUnavailableError };
