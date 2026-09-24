import { describe, expect, it } from 'vitest';
import {
  SESSION_STATES,
  SESSION_STATE_TRANSITIONS,
  canTransition,
  sessionStateSchema,
  type SessionState,
} from './session';

describe('sessionStateSchema', () => {
  it('accepts every machine state and rejects anything else', () => {
    for (const state of SESSION_STATES) {
      expect(sessionStateSchema.parse(state)).toBe(state);
    }
    expect(() => sessionStateSchema.parse('queued')).toThrow();
  });
});

describe('SESSION_STATE_TRANSITIONS', () => {
  it('has a row for every state', () => {
    expect(Object.keys(SESSION_STATE_TRANSITIONS).sort()).toEqual([...SESSION_STATES].sort());
  });
});

describe('canTransition', () => {
  const legal: Array<[SessionState, SessionState]> = [
    ['created', 'starting'],
    ['starting', 'ready'],
    ['starting', 'stopped'],
    ['starting', 'crashed'],
    ['ready', 'working'],
    ['ready', 'stopped'],
    ['ready', 'crashed'],
    ['working', 'waiting-approval'],
    ['working', 'stopped'],
    ['working', 'crashed'],
    ['waiting-approval', 'working'],
    ['waiting-approval', 'stopped'],
    ['waiting-approval', 'crashed'],
  ];

  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const illegal: Array<[SessionState, SessionState]> = [
    ['created', 'ready'],
    ['created', 'working'],
    ['ready', 'waiting-approval'],
    ['working', 'ready'],
    ['stopped', 'created'],
    ['stopped', 'working'],
    ['crashed', 'starting'],
    ['crashed', 'working'],
  ];

  it.each(illegal)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
