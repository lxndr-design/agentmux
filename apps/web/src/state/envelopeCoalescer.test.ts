import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { createAgentEventEnvelope } from '@agentmux/protocol';
import { createEnvelopeCoalescer } from './envelopeCoalescer.js';

/** Real timers by default; the perf tests pin their own clock. */
function envelope(seq: number, payload: AgentEventEnvelope['payload']): AgentEventEnvelope {
  return createAgentEventEnvelope('s1', seq, payload);
}

describe('createEnvelopeCoalescer', () => {
  it('flushes buffered envelopes to the same session id', () => {
    vi.useFakeTimers();
    try {
      const flushed: Array<{ sessionId: string; batch: readonly AgentEventEnvelope[] }> = [];
      const c = createEnvelopeCoalescer({
        flush: (sessionId, batch) => flushed.push({ sessionId, batch }),
      });
      c.push('s1', envelope(0, { kind: 'usage', tokensIn: 1, tokensOut: 1 }));
      c.push('s1', envelope(1, { kind: 'usage', tokensIn: 2, tokensOut: 2 }));
      vi.advanceTimersByTime(33);
      expect(flushed).toEqual([{ sessionId: 's1', batch: expect.any(Array) }]);
      expect(flushed[0]?.batch.map((e) => e.seq)).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes each session separately — no cross-talk', () => {
    vi.useFakeTimers();
    try {
      const flushed = new Map<string, readonly AgentEventEnvelope[]>();
      const c = createEnvelopeCoalescer({
        flush: (sessionId, batch) => flushed.set(sessionId, batch),
      });
      c.push('a', envelope(0, { kind: 'usage', tokensIn: 1, tokensOut: 1 }));
      c.push('b', envelope(1, { kind: 'usage', tokensIn: 1, tokensOut: 1 }));
      vi.advanceTimersByTime(33);
      expect([...flushed.keys()].sort()).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets a buffer outlive the max delay even under sustained bursts', () => {
    vi.useFakeTimers();
    try {
      const flushes: number[][] = [];
      const c = createEnvelopeCoalescer({
        frameMs: 33,
        maxDelayMs: 100,
        flush: (_sessionId, batch) => flushes.push(batch.map((e) => e.seq)),
      });
      // Three tokens arrive every 20 ms — faster than the frame: the timer
      // keeps re-arming, but maxDelayMs forces a flush at least every 100 ms.
      for (let i = 0; i < 50; i += 1) {
        const base = i * 3;
        c.push('s1', envelope(base, { kind: 'usage', tokensIn: base, tokensOut: 0 }));
        c.push('s1', envelope(base + 1, { kind: 'usage', tokensIn: base + 1, tokensOut: 0 }));
        c.push('s1', envelope(base + 2, { kind: 'usage', tokensIn: base + 2, tokensOut: 0 }));
        vi.advanceTimersByTime(20);
      }
      expect(flushes.length).toBeGreaterThanOrEqual(9); // 1000 ms / 100 ms
      expect(flushes[0]?.length).toBeGreaterThan(1); // batched, not per-token
      expect(flushes.at(-1)?.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys without flushing pending buffers', () => {
    vi.useFakeTimers();
    try {
      const flushed: unknown[] = [];
      const c = createEnvelopeCoalescer({ flush: (id, batch) => flushed.push([id, batch]) });
      c.push('s1', envelope(0, { kind: 'usage', tokensIn: 1, tokensOut: 1 }));
      c.destroy();
      vi.advanceTimersByTime(33);
      expect(flushed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PERF: a 500-event burst lands in exactly one flush — one render frame per burst', () => {
    vi.useFakeTimers();
    try {
      let flushCount = 0;
      let flushed = 0;
      const N = 500;
      const c = createEnvelopeCoalescer({
        flush: (_id, batch) => {
          flushCount += 1;
          flushed = batch.length;
        },
      });
      for (let i = 0; i < N; i += 1) {
        c.push('s1', envelope(i, { kind: 'usage', tokensIn: i, tokensOut: 0 }));
      }
      vi.advanceTimersByTime(33);
      // The burst costs exactly one frame regardless of N — the store-apply
      // cost of that frame is measured against the real store in
      // sessionStore.test.ts (perf: burst applies within the frame budget).
      expect(flushCount).toBe(1);
      expect(flushed).toBe(N);
    } finally {
      vi.useRealTimers();
    }
  });
});
