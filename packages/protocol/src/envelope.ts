import { z } from 'zod';
import { agentEventSchema, type AgentEvent } from './events.js';

/**
 * Envelope factory — the WS/journal record shape. One envelope per event,
 * `seq` gapless per session: a reconnecting client sends its last-seen seq
 * and the host replays the gap from the journal (blueprint: "Sequencing and
 * replay"). The event rides as `payload`, so `kind` has exactly one home.
 */
export function streamEnvelopeSchema<P extends z.ZodType>(payload: P) {
  return z.object({
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().positive(),
    payload,
  });
}

/** Envelope type for a given payload schema — derived, never hand-written. */
export type StreamEnvelope<P extends z.ZodType> = z.infer<
  ReturnType<typeof streamEnvelopeSchema<P>>
>;

export const agentEventEnvelopeSchema = streamEnvelopeSchema(agentEventSchema);
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;

/** Host-side convenience: stamp the envelope the daemon journals and fans out. */
export function createAgentEventEnvelope(
  sessionId: string,
  seq: number,
  event: AgentEvent,
): AgentEventEnvelope {
  return { sessionId, seq, ts: Date.now(), payload: event };
}
