import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_KINDS,
  agentEventSchema,
  isAgentEventKind,
  type AgentEvent,
  type AgentEventKind,
} from './events';
import { assertNever } from './util';

/** One fixture per variant — plus boundary shapes for state_change. */
const FIXTURES: AgentEvent[] = [
  { kind: 'turn', turnId: 'turn_1', role: 'assistant', text: 'Tracing the auth bug…', done: false },
  { kind: 'turn', turnId: 'turn_2', role: 'user', text: 'ship it', done: true },
  {
    kind: 'thinking',
    text: 'The token refresh races on tab restore…',
    done: true,
    turnId: 'turn_1',
  },
  {
    kind: 'tool_use',
    callId: 'call_1',
    tool: 'Bash',
    summary: 'rm -rf ./dist',
    detail: { command: 'rm -rf ./dist' },
  },
  { kind: 'tool_result', callId: 'call_1', output: 'removed 3 paths', truncated: false },
  { kind: 'usage', tokensIn: 1520, tokensOut: 640 },
  {
    kind: 'state_change',
    from: 'working',
    to: 'waiting-approval',
    request: { requestId: 'req_1', tool: 'Bash', risk: 'high', command: 'rm -rf ./dist' },
  },
  { kind: 'state_change', from: 'working', to: 'crashed', exit: { code: 1, signal: 'SIGKILL' } },
  {
    kind: 'approval_decision',
    requestId: 'req_1',
    decision: 'deny',
    actor: 'human',
    reason: 'no filesystem mutation today',
  },
];

describe('agentEventSchema', () => {
  it('round-trips every event variant', () => {
    for (const event of FIXTURES) {
      expect(agentEventSchema.parse(event)).toEqual(event);
    }
  });

  it('round-trips every variant through JSON serialization', () => {
    for (const event of FIXTURES) {
      const wire = JSON.parse(JSON.stringify(event)) as unknown;
      expect(agentEventSchema.parse(wire)).toEqual(event);
    }
  });

  it('rejects an unknown kind', () => {
    expect(() => agentEventSchema.parse({ kind: 'session.status' })).toThrow();
  });
});

describe('state_change invariants', () => {
  const request = {
    requestId: 'req_1',
    tool: 'Bash',
    risk: 'high' as const,
    command: 'rm -rf ./dist',
  };

  it('rejects entering waiting-approval without the pending request', () => {
    expect(() =>
      agentEventSchema.parse({ kind: 'state_change', from: 'working', to: 'waiting-approval' }),
    ).toThrow();
  });

  it('rejects a request riding a non-approval transition', () => {
    expect(() =>
      agentEventSchema.parse({ kind: 'state_change', from: 'ready', to: 'working', request }),
    ).toThrow();
  });

  it('rejects exit info on a non-terminal transition', () => {
    expect(() =>
      agentEventSchema.parse({
        kind: 'state_change',
        from: 'working',
        to: 'waiting-approval',
        request,
        exit: { code: 0 },
      }),
    ).toThrow();
  });

  it('rejects a no-op transition', () => {
    expect(() =>
      agentEventSchema.parse({ kind: 'state_change', from: 'ready', to: 'ready' }),
    ).toThrow();
  });
});

/**
 * Exhaustiveness, twice. Compile-time: the `default` branch only type-checks
 * if every variant is handled — a new union member breaks `tsc` for any
 * consumer that forgets a case. Runtime: the schema-derived kind list is
 * checked against the fixtures and the switch, so `vitest` catches drift
 * even though CI typechecks sources separately from tests.
 */
function handleEvent(event: AgentEvent): AgentEventKind {
  switch (event.kind) {
    case 'turn':
      return 'turn';
    case 'thinking':
      return 'thinking';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'usage':
      return 'usage';
    case 'state_change':
      return 'state_change';
    case 'approval_decision':
      return 'approval_decision';
    default:
      return assertNever(event);
  }
}

describe('discriminated-union exhaustiveness', () => {
  it('derives AGENT_EVENT_KINDS from the schema and has a fixture per kind', () => {
    expect([...AGENT_EVENT_KINDS]).toEqual([
      'turn',
      'thinking',
      'tool_use',
      'tool_result',
      'usage',
      'state_change',
      'approval_decision',
    ]);
    const fixtureKinds = new Set(FIXTURES.map((event) => event.kind));
    for (const kind of AGENT_EVENT_KINDS) {
      expect(fixtureKinds.has(kind), `missing fixture for kind ${kind}`).toBe(true);
    }
  });

  it('routes every fixture through the exhaustive switch', () => {
    for (const event of FIXTURES) {
      expect(handleEvent(event)).toBe(event.kind);
    }
  });

  it('isAgentEventKind accepts exactly the union kinds', () => {
    for (const kind of AGENT_EVENT_KINDS) expect(isAgentEventKind(kind)).toBe(true);
    expect(isAgentEventKind('session.status')).toBe(false);
    expect(isAgentEventKind('')).toBe(false);
  });
});
