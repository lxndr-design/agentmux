import { z } from 'zod';

/**
 * Session lifecycle — the state machine that drives the activity ribbon, the
 * pane chrome, and what a connector is allowed to do (blueprint: "Init, run,
 * kill, tombstone").
 *
 *   created → starting → ready → working ⇄ waiting-approval → stopped | crashed
 *
 * The zod schema validates the *shape* of a state; `SESSION_STATE_TRANSITIONS`
 * and `canTransition` are the semantic half — the host daemon checks a
 * `state_change` event against them when journaling, so an illegal transition
 * is a connector bug, not a schema concern.
 */

export const SESSION_STATES = [
  'created',
  'starting',
  'ready',
  'working',
  'waiting-approval',
  'stopped',
  'crashed',
] as const;

export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Legal transitions out of each state. Terminal states transition nowhere. */
export const SESSION_STATE_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  created: ['starting'],
  starting: ['ready', 'stopped', 'crashed'],
  ready: ['working', 'stopped', 'crashed'],
  working: ['waiting-approval', 'stopped', 'crashed'],
  'waiting-approval': ['working', 'stopped', 'crashed'],
  stopped: [],
  crashed: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_STATE_TRANSITIONS[from].includes(to);
}

/** How a session ended — journaled on the transition into a terminal state. */
export const exitInfoSchema = z.object({
  code: z.number().int(),
  signal: z.string().optional(),
  reason: z.string().optional(),
});
export type ExitInfo = z.infer<typeof exitInfoSchema>;
