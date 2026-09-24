/**
 * Normalized agent-event protocol — the one contract every backend (CLI
 * connector, future API or MCP adapter) compiles down to. Dependency-free by
 * design: everything above the connectors only ever sees this module.
 */

/** Event kinds every connector emits, gapless per session. */
export type AgentEventKind =
  | 'session.status'
  | 'thinking.delta'
  | 'text.delta'
  | 'tool.started'
  | 'tool.output'
  | 'approval.requested'
  | 'approval.resolved'
  | 'usage'
  | 'error'
  | 'session.exit';

/**
 * Event envelope — one per record, gapless per session. `seq` is the replay
 * cursor a reconnecting client sends back to receive the gap.
 */
export interface Envelope<T = unknown> {
  sessionId: string;
  seq: number;
  ts: number;
  kind: AgentEventKind;
  payload: T;
}

/** Every valid event kind, in one list — for exhaustiveness checks and tests. */
export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  'session.status',
  'thinking.delta',
  'text.delta',
  'tool.started',
  'tool.output',
  'approval.requested',
  'approval.resolved',
  'usage',
  'error',
  'session.exit',
];

export function isAgentEventKind(kind: string): kind is AgentEventKind {
  return (AGENT_EVENT_KINDS as readonly string[]).includes(kind);
}

export function createEnvelope<P>(
  sessionId: string,
  seq: number,
  kind: AgentEventKind,
  payload: P,
): Envelope<P> {
  return { sessionId, seq, ts: Date.now(), kind, payload };
}
