import { z } from 'zod';
import { agentEventEnvelopeSchema } from '@agentmux/protocol';

/**
 * Gateway wire messages — the daemon↔UI session-control layer. Event payloads
 * are never re-declared here: envelopes ride verbatim through
 * `agentEventEnvelopeSchema` from @agentmux/protocol. Approval decisions do
 * not appear yet — they re-enter through the connectors' stdin once the
 * approval engine lands (blueprint: "The human in the loop").
 */

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string().min(1),
    /**
     * Resume cursor: the last seq this client saw, after which it wants the
     * gap. Omitted means "I have seen nothing" — full replay from seq 0.
     */
    fromSeq: z.number().int().nonnegative().optional(),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const replayMessageSchema = z.object({
  type: z.literal('replay'),
  sessionId: z.string(),
  envelopes: z.array(agentEventEnvelopeSchema),
});

export const replayEndMessageSchema = z.object({
  type: z.literal('replay_end'),
  sessionId: z.string(),
  /** The session's newest seq; null when the journal holds nothing for it. */
  lastSeq: z.number().int().nonnegative().nullable(),
});

export const eventMessageSchema = z.object({
  type: z.literal('event'),
  envelope: agentEventEnvelopeSchema,
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  replayMessageSchema,
  replayEndMessageSchema,
  eventMessageSchema,
  errorMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
