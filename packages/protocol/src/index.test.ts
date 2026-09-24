import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_KINDS, createEnvelope, isAgentEventKind } from './index';

describe('createEnvelope', () => {
  it('builds an envelope with the given identity, sequence, kind, and payload', () => {
    const envelope = createEnvelope('sess_1', 0, 'session.status', { status: 'ready' });
    expect(envelope).toMatchObject({
      sessionId: 'sess_1',
      seq: 0,
      kind: 'session.status',
      payload: { status: 'ready' },
    });
    expect(typeof envelope.ts).toBe('number');
  });
});

describe('AGENT_EVENT_KINDS', () => {
  it('is non-empty and fully recognized by the kind guard', () => {
    expect(AGENT_EVENT_KINDS.length).toBeGreaterThan(0);
    for (const kind of AGENT_EVENT_KINDS) expect(isAgentEventKind(kind)).toBe(true);
  });

  it('rejects unknown kinds', () => {
    expect(isAgentEventKind('not-a-kind')).toBe(false);
  });
});
