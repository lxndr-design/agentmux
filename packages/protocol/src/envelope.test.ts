import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentEventEnvelopeSchema,
  createAgentEventEnvelope,
  streamEnvelopeSchema,
} from './envelope';
import type { AgentEvent } from './events';

describe('streamEnvelopeSchema', () => {
  const schema = streamEnvelopeSchema(z.object({ n: z.number() }));
  const base = { sessionId: 'sess_1', seq: 0, ts: 1_727_123_456_789, payload: { n: 1 } };

  it('wraps a payload with the journal identity fields', () => {
    expect(schema.parse(base)).toEqual(base);
  });

  it('rejects a negative seq and a zero ts', () => {
    expect(() => schema.parse({ ...base, seq: -1 })).toThrow();
    expect(() => schema.parse({ ...base, ts: 0 })).toThrow();
  });

  it('rejects an empty sessionId', () => {
    expect(() => schema.parse({ ...base, sessionId: '' })).toThrow();
  });
});

describe('agentEventEnvelopeSchema', () => {
  const event: AgentEvent = { kind: 'usage', tokensIn: 10, tokensOut: 5 };

  it('round-trips a typed agent event through the envelope', () => {
    const envelope = createAgentEventEnvelope('sess_1', 3, event);
    const parsed = agentEventEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)) as unknown);
    expect(parsed).toEqual(envelope);
    expect(parsed.payload.kind).toBe('usage');
  });

  it('createAgentEventEnvelope stamps host time and identity', () => {
    const before = Date.now();
    const envelope = createAgentEventEnvelope('sess_1', 0, event);
    expect(envelope.seq).toBe(0);
    expect(envelope.ts).toBeGreaterThanOrEqual(before);
  });
});
