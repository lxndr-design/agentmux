import type { DivergenceEntry, UsageRollups } from '@agentmux/protocol';
import { parseServerMessage } from './wire.js';

/**
 * The browser's observability-RPC client — divergence and usage rollups over
 * the daemon gateway, request/response correlated by `requestId` (the FsClient
 * pattern minus the change feed; the unification candidate is noted in the PR
 * until a third RPC shape forces the refactor).
 */

/** The connection is down (or was closed) — the request never reached the daemon. */
export class ObservabilityUnavailableError extends Error {
  constructor(message = 'observability connection is not open') {
    super(message);
    this.name = 'ObservabilityUnavailableError';
  }
}

export type ObservabilityClientPhase = 'connecting' | 'live' | 'retrying' | 'closed';

export interface ObservabilityClientOptions {
  /** Full endpoint including the token query, e.g. `ws://127.0.0.1:8787/?token=…`. */
  url: string;
  onPhase?: (phase: ObservabilityClientPhase) => void;
  onProtocolError?: (message: string) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

type PendingResponse =
  | { ok: true; kind: 'divergence'; entries: DivergenceEntry[] }
  | { ok: true; kind: 'usage-rollups'; rollups: UsageRollups }
  | { ok: false; error: Error };

type PendingSink = (response: PendingResponse) => void;

export class ObservabilityClient {
  private readonly base: number;
  private readonly cap: number;
  private readonly pending = new Map<string, PendingSink>();
  /** Requests accepted while the socket was still connecting, in send order. */
  private readonly queued: Array<{
    requestId: string;
    type: 'divergence_request' | 'usage_rollups_request';
  }> = [];
  private requestCounter = 0;
  private attempt = 0;
  private ws: WebSocket | null = null;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPhase: ObservabilityClientPhase = 'closed';

  constructor(private readonly options: ObservabilityClientOptions) {
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
    this.failPending(new ObservabilityUnavailableError('observability client stopped'));
    this.setPhase('closed');
  }

  /** One divergence probe; resolves with the per-session entries or throws. */
  requestDivergence(): Promise<DivergenceEntry[]> {
    return this.request('divergence_request').then((response) => {
      if (response.ok && response.kind === 'divergence') {
        return response.entries;
      }
      throw response.ok ? wrongShape('divergence_result') : response.error;
    });
  }

  /** One usage-rollup read; resolves with the aggregated rows or throws. */
  requestUsageRollups(): Promise<UsageRollups> {
    return this.request('usage_rollups_request').then((response) => {
      if (response.ok && response.kind === 'usage-rollups') {
        return response.rollups;
      }
      throw response.ok ? wrongShape('usage_rollups_result') : response.error;
    });
  }

  private request(type: 'divergence_request' | 'usage_rollups_request'): Promise<PendingResponse> {
    if (this.stopped) {
      return Promise.reject(new ObservabilityUnavailableError());
    }
    const requestId = `obs-${++this.requestCounter}`;
    const promise = new Promise<PendingResponse>((resolve) => {
      this.pending.set(requestId, resolve);
    });
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.sendNow(requestId, type);
    } else {
      // Panes mount before the socket finishes opening; hold their first
      // requests and send in order once `onopen` fires.
      this.queued.push({ requestId, type });
    }
    return promise;
  }

  private sendNow(requestId: string, type: 'divergence_request' | 'usage_rollups_request'): void {
    this.ws?.send(JSON.stringify({ type, requestId }));
  }

  private open(): void {
    if (this.stopped) return;
    this.setPhase(this.attempt === 0 ? 'connecting' : 'retrying');
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setPhase('live');
      const queued = this.queued.splice(0);
      for (const item of queued) {
        this.sendNow(item.requestId, item.type);
      }
    };
    ws.onmessage = (event: MessageEvent) => this.handleFrame(event.data);
    ws.onclose = () => {
      this.ws = null;
      this.failPending(new ObservabilityUnavailableError('observability connection dropped'));
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
    if (message.type === 'divergence_result') {
      this.pending.get(message.requestId)?.({
        ok: true,
        kind: 'divergence',
        entries: message.entries,
      });
      this.pending.delete(message.requestId);
      return;
    }
    if (message.type === 'usage_rollups_result') {
      this.pending.get(message.requestId)?.({
        ok: true,
        kind: 'usage-rollups',
        rollups: message.rollups,
      });
      this.pending.delete(message.requestId);
      return;
    }
    // Session-layer and FS frames belong to the other clients, not here.
  }

  private failPending(error: Error): void {
    for (const settle of this.pending.values()) {
      settle({ ok: false, error });
    }
    this.pending.clear();
  }

  private setPhase(phase: ObservabilityClientPhase): void {
    if (this.currentPhase === phase) return;
    this.currentPhase = phase;
    this.options.onPhase?.(phase);
  }
}

/** A result arrived whose payload shape does not match its message type. */
function wrongShape(expected: string): Error {
  return new Error(`server answered ${expected} with an unexpected payload`);
}
