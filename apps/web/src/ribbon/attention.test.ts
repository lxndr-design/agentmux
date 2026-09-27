import { describe, expect, it } from 'vitest';
import {
  createAgentEventEnvelope,
  type AgentEvent,
  type AgentEventEnvelope,
} from '@agentmux/protocol';
import { deriveSessionAttention } from './attention.js';

function envelope(seq: number, payload: AgentEvent): AgentEventEnvelope {
  return createAgentEventEnvelope('s1', seq, payload);
}

const assistantTurn = (done: boolean): AgentEvent => ({
  kind: 'turn',
  turnId: 't1',
  role: 'assistant',
  text: 'done',
  done,
});

describe('deriveSessionAttention', () => {
  it('flags waiting-approval as needs-approval — the highest attention', () => {
    expect(deriveSessionAttention({ state: 'waiting-approval', envelopes: [] })).toEqual({
      level: 'needs-approval',
      label: 'needs approval',
    });
  });

  it('flags crashed — a dead agent needs eyes even without a pending card', () => {
    expect(deriveSessionAttention({ state: 'crashed', envelopes: [] })).toEqual({
      level: 'crashed',
      label: 'crashed',
    });
  });

  it('marks a ready session with a completed assistant turn as idle-done', () => {
    const session = {
      state: 'ready' as const,
      envelopes: [envelope(0, assistantTurn(true))],
    };
    expect(deriveSessionAttention(session)).toEqual({ level: 'idle-done', label: 'done' });
  });

  it('stays none for a ready session that never finished a turn', () => {
    expect(deriveSessionAttention({ state: 'ready', envelopes: [] })).toEqual({
      level: 'none',
      label: 'ready',
    });
  });

  it('requires an ASSISTANT turn — a completed user turn is not a result', () => {
    const session = {
      state: 'ready' as const,
      envelopes: [
        envelope(0, { kind: 'turn', turnId: 't1', role: 'user', text: 'go', done: true }),
      ],
    };
    expect(deriveSessionAttention(session)).toEqual({ level: 'none', label: 'ready' });
  });

  it('needs-approval outranks idle-done when both facts hold', () => {
    const session = {
      state: 'waiting-approval' as const,
      envelopes: [envelope(0, assistantTurn(true))],
    };
    expect(deriveSessionAttention(session).level).toBe('needs-approval');
  });

  it('working and other states carry no attention', () => {
    expect(deriveSessionAttention({ state: 'working', envelopes: [] })).toEqual({
      level: 'none',
      label: 'working',
    });
  });
});
