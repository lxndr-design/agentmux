import type { SessionView } from '../state/sessionStore.js';

/**
 * Attention states (task deliverable; blueprint "Multi-agent at a glance"):
 * which session chips need the human's eyes right now. Derived purely from
 * the session view so the ribbon, tabs, and any future surface agree.
 *
 * Priority: needs-approval > crashed > idle-done — an urgent state always
 * outranks a informational one.
 */

export type AttentionLevel = 'needs-approval' | 'crashed' | 'idle-done' | 'none';

export interface SessionAttention {
  level: AttentionLevel;
  /** Badge copy — what the human reads at a glance. */
  label: string;
}

/** A `ready` session counts as idle-done only once a turn actually completed. */
function hasCompletedTurn(session: Pick<SessionView, 'envelopes'>): boolean {
  return session.envelopes.some(
    (envelope) =>
      envelope.payload.kind === 'turn' &&
      envelope.payload.role === 'assistant' &&
      envelope.payload.done,
  );
}

export function deriveSessionAttention(
  session: Pick<SessionView, 'state' | 'envelopes'>,
): SessionAttention {
  if (session.state === 'waiting-approval') {
    return { level: 'needs-approval', label: 'needs approval' };
  }
  if (session.state === 'crashed') {
    return { level: 'crashed', label: 'crashed' };
  }
  if (session.state === 'ready' && hasCompletedTurn(session)) {
    return { level: 'idle-done', label: 'done' };
  }
  return { level: 'none', label: session.state };
}
