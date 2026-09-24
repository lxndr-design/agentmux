import { describe, expect, it } from 'vitest';
import { agentEventSchema } from '@agentmux/protocol';
import { clientMessageSchema, serverMessageSchema } from './wire.js';

const envelope = {
  sessionId: 'sess-1',
  seq: 0,
  ts: 1_758_700_000_000,
  payload: agentEventSchema.parse({ kind: 'thinking', text: 'hmm', done: false }),
};

describe('clientMessageSchema', () => {
  it('accepts a subscribe with and without a resume cursor', () => {
    expect(
      clientMessageSchema.parse({ type: 'subscribe', sessionId: 'sess-1', fromSeq: 4 }),
    ).toEqual({
      type: 'subscribe',
      sessionId: 'sess-1',
      fromSeq: 4,
    });
    expect(clientMessageSchema.parse({ type: 'subscribe', sessionId: 'sess-1' })).toEqual({
      type: 'subscribe',
      sessionId: 'sess-1',
    });
  });

  it('rejects malformed subscriptions', () => {
    expect(() => clientMessageSchema.parse({ type: 'subscribe' })).toThrowError();
    expect(() => clientMessageSchema.parse({ type: 'subscribe', sessionId: '' })).toThrowError();
    expect(() =>
      clientMessageSchema.parse({ type: 'subscribe', sessionId: 'sess-1', fromSeq: -1 }),
    ).toThrowError();
    expect(() => clientMessageSchema.parse({ type: 'unknown' })).toThrowError();
  });
});

describe('serverMessageSchema', () => {
  it('validates the four server message kinds', () => {
    expect(
      serverMessageSchema.parse({ type: 'replay', sessionId: 'sess-1', envelopes: [envelope] }),
    ).toEqual({ type: 'replay', sessionId: 'sess-1', envelopes: [envelope] });
    expect(
      serverMessageSchema.parse({ type: 'replay_end', sessionId: 'sess-1', lastSeq: 0 }),
    ).toEqual({
      type: 'replay_end',
      sessionId: 'sess-1',
      lastSeq: 0,
    });
    expect(serverMessageSchema.parse({ type: 'event', envelope })).toEqual({
      type: 'event',
      envelope,
    });
    expect(serverMessageSchema.parse({ type: 'error', message: 'bad request' })).toEqual({
      type: 'error',
      message: 'bad request',
    });
  });

  it('rejects envelopes that violate the protocol contract', () => {
    expect(() =>
      serverMessageSchema.parse({
        type: 'event',
        envelope: { ...envelope, seq: -1 },
      }),
    ).toThrowError();
  });
});
