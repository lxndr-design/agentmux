import type { AgentEventEnvelope } from '@agentmux/protocol';

/**
 * Streaming coalescing — the blueprint's throughput discipline: "deltas
 * coalesce per pane at ~33 ms — one paint per frame, never per token."
 *
 * The WS client delivers one callback per envelope (replay of a long journal
 * is a burst of thousands). This buffer sits between the client and the
 * store: envelopes accumulate per session and flush at most once per frame,
 * so a burst costs one store update and one React commit — not N.
 *
 * The frame scheduler is injectable: tests drive frames manually, and
 * non-browser hosts fall back to a FRAME_BUDGET_MS timer.
 */

/** Blueprint frame budget (ms) — one coalesced flush per ~33 ms frame. */
export const FRAME_BUDGET_MS = 33;

export type FrameScheduler = (callback: () => void) => () => void;

export interface EnvelopeCoalescerOptions {
  /** Called once per frame with everything buffered for that session. */
  flush: (sessionId: string, envelopes: readonly AgentEventEnvelope[]) => void;
  /** Override the frame scheduler (tests drive frames manually). */
  schedule?: FrameScheduler;
  /** Fallback timer budget when rAF is unavailable (default FRAME_BUDGET_MS). */
  frameMs?: number;
  /** Hard bound on buffer age; past it the flush goes synchronous instead of
   * waiting for the next frame — rAF stops firing in backgrounded tabs, and
   * the WS client does not. Default: 3× frameMs. */
  maxDelayMs?: number;
}

export interface EnvelopeCoalescer {
  push(sessionId: string, envelope: AgentEventEnvelope): void;
  /** Drop buffers and pending frames — the session client is going away. */
  destroy(): void;
}

export function createEnvelopeCoalescer(options: EnvelopeCoalescerOptions): EnvelopeCoalescer {
  const frameMs = options.frameMs ?? FRAME_BUDGET_MS;
  const maxDelayMs = options.maxDelayMs ?? frameMs * 3;
  const schedule =
    options.schedule ??
    ((callback: () => void): (() => void) => {
      if (typeof requestAnimationFrame === 'function') {
        const handle = requestAnimationFrame(() => callback());
        return () => cancelAnimationFrame(handle);
      }
      const handle = setTimeout(callback, frameMs);
      return () => clearTimeout(handle);
    });
  const buffers = new Map<string, AgentEventEnvelope[]>();
  const bufferedSince = new Map<string, number>();
  const pending = new Map<string, () => void>();
  let destroyed = false;

  function flushBuffer(sessionId: string): void {
    pending.delete(sessionId);
    bufferedSince.delete(sessionId);
    const buffered = buffers.get(sessionId);
    if (buffered === undefined || buffered.length === 0) return;
    buffers.set(sessionId, []);
    options.flush(sessionId, buffered);
  }

  return {
    push(sessionId, envelope) {
      if (destroyed) return; // detached mid-burst — the successor client re-subscribes
      const now = Date.now();
      const since = bufferedSince.get(sessionId);
      if (since === undefined) {
        bufferedSince.set(sessionId, now);
      } else if (now - since >= maxDelayMs) {
        // Frame scheduler stalled (backgrounded rAF): drain before growing.
        flushBuffer(sessionId);
        bufferedSince.set(sessionId, now);
      }
      const buffered = buffers.get(sessionId);
      if (buffered === undefined) buffers.set(sessionId, [envelope]);
      else buffered.push(envelope);
      if (!pending.has(sessionId)) {
        pending.set(
          sessionId,
          schedule(() => flushBuffer(sessionId)),
        );
      }
    },
    destroy() {
      destroyed = true;
      for (const cancel of pending.values()) cancel();
      pending.clear();
      buffers.clear();
      bufferedSince.clear();
    },
  };
}
