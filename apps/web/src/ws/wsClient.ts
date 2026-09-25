import type { AgentEventEnvelope, ApprovalDecision } from '@agentmux/protocol';
import { parseServerMessage, type ClientMessage } from './wire.js';

/**
 * Stream phases as seen by one session client:
 *
 *   connecting → replaying → live ⇄ retrying → closed (user stop only)
 *
 * `live` is only ever entered through `replay_end` — the replay backlog and
 * any buffered live frames are applied first, so the store never sees an
 * event out of journal order.
 */
export type StreamPhase = 'connecting' | 'replaying' | 'live' | 'retrying' | 'closed';

export interface WsSessionClientOptions {
  /**
   * Full endpoint including the token query, e.g.
   * `ws://127.0.0.1:8787/?token=…` — browsers cannot set WS upgrade
   * headers, so the per-boot token rides the URL (daemon contract).
   */
  url: string;
  sessionId: string;
  onEnvelope: (envelope: AgentEventEnvelope) => void;
  onPhase: (phase: StreamPhase) => void;
  onProtocolError: (message: string) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/**
 * One WS subscription to one session of the daemon gateway. The client owns
 * the reconnect/replay contract end to end: it subscribes with its last-seen
 * seq, applies the replay gap, consumes `replay_end` before switching to
 * live, dedupes by seq, and self-heals (full resubscribe) if the stream ever
 * violates gapless ordering.
 */
export class WsSessionClient {
  private readonly base: number;
  private readonly cap: number;

  private ws: WebSocket | null = null;
  private phase: StreamPhase = 'connecting';
  private lastSeq: number | null = null;
  /** Live frames that arrived before `replay_end` — applied in order at the flip. */
  private buffered: AgentEventEnvelope[] = [];
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncUsed = false;

  constructor(private readonly options: WsSessionClientOptions) {
    this.base = options.retryBaseMs ?? 250;
    this.cap = options.retryMaxMs ?? 5000;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  /** User-initiated close — no reconnect, phase rests at `closed`. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setPhase('closed');
  }

  /**
   * Answers a pending approval — the pinned column's round-trip. Returns
   * false when the socket is not open (the UI keeps the card pending; the
   * request can still be answered after a reconnect).
   */
  sendDecision(decision: ApprovalDecision): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.send({ type: 'decide', sessionId: this.options.sessionId, decision });
    return true;
  }

  private open(): void {
    if (this.stopped) return;
    this.setPhase(this.attempt === 0 ? 'connecting' : 'retrying');
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      const message: ClientMessage = {
        type: 'subscribe',
        sessionId: this.options.sessionId,
        ...(this.lastSeq === null ? {} : { fromSeq: this.lastSeq }),
      };
      ws.send(JSON.stringify(message));
    };
    ws.onmessage = (event: MessageEvent) => this.handleFrame(event.data);
    ws.onerror = () => {
      // A close always follows an error — surface the transport failure and
      // let onclose drive the retry.
      this.options.onProtocolError('websocket transport error');
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) return;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const delay = Math.min(this.base * 2 ** this.attempt, this.cap);
    this.attempt += 1;
    this.setPhase('retrying');
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private send(message: ClientMessage): void {
    this.ws?.send(JSON.stringify(message));
  }

  private handleFrame(raw: unknown): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.options.onProtocolError(parsed.error);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'replay':
        for (const envelope of message.envelopes) {
          this.applyEnvelope(envelope);
        }
        break;
      case 'replay_end':
        this.finishReplay(message.lastSeq);
        break;
      case 'event':
        if (this.phase === 'live') {
          this.applyEnvelope(message.envelope);
        } else {
          // Defensive ordering: a compliant daemon never sends live frames
          // before replay_end, but the client must not trust that.
          this.buffered.push(message.envelope);
        }
        break;
      case 'error':
        this.options.onProtocolError(message.message);
        break;
    }
  }

  private applyEnvelope(envelope: AgentEventEnvelope): void {
    if (this.lastSeq !== null && envelope.seq <= this.lastSeq) {
      return; // duplicate (e.g. replay tail overlapping a buffered live frame)
    }
    const continuous =
      this.lastSeq === null ? envelope.seq === 0 : envelope.seq === this.lastSeq + 1;
    if (!continuous) {
      this.resync(
        `journal gap: expected seq ${this.lastSeq === null ? 0 : this.lastSeq + 1}, got ${envelope.seq}`,
      );
      return;
    }
    this.lastSeq = envelope.seq;
    this.options.onEnvelope(envelope);
  }

  private finishReplay(serverLastSeq: number | null): void {
    const buffered = this.buffered;
    this.buffered = [];
    for (const envelope of buffered) {
      this.applyEnvelope(envelope);
    }
    const caughtUp =
      serverLastSeq === null ? this.lastSeq === null : serverLastSeq === this.lastSeq;
    if (!caughtUp) {
      if (!this.resyncUsed) {
        this.resync(
          `replay ended at seq ${String(serverLastSeq)} but client is at ${String(this.lastSeq)}`,
        );
        return;
      }
      this.options.onProtocolError(
        `replay still inconsistent after resync (server ${String(serverLastSeq)}, client ${String(this.lastSeq)})`,
      );
      this.setPhase('live');
      return;
    }
    this.attempt = 0;
    this.setPhase('live');
  }

  /** Full resubscribe from seq 0 — the store dedupes already-applied frames. */
  private resync(reason: string): void {
    this.options.onProtocolError(reason);
    if (this.resyncUsed) {
      return; // one self-heal attempt per session — beyond that, surface only
    }
    this.resyncUsed = true;
    this.lastSeq = null;
    this.buffered = [];
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.setPhase('replaying');
      this.send({ type: 'subscribe', sessionId: this.options.sessionId });
    } else {
      this.open();
    }
  }

  private setPhase(phase: StreamPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase);
  }
}
