import { z } from 'zod';
import {
  agentEventEnvelopeSchema,
  fsErrorSchema,
  fsRequestSchema,
  fsResultSchema,
} from '@agentmux/protocol';

/**
 * Gateway wire messages — the daemon↔UI session-control layer. Event payloads
 * are never re-declared here: envelopes ride verbatim through
 * `agentEventEnvelopeSchema` from @agentmux/protocol, and so do filesystem
 * RPC payloads (`fsRequestSchema` / `fsResultSchema` / `fsErrorSchema`).
 * Approval decisions do not appear yet — they re-enter through the
 * connectors' stdin once the approval engine lands (blueprint: "The human in
 * the loop").
 */

export const fsRequestMessageSchema = z.object({
  type: z.literal('fs_request'),
  /** Caller-chosen correlation id — responses echo it verbatim. */
  requestId: z.string().min(1),
  request: fsRequestSchema,
});

export const fsResultMessageSchema = z.object({
  type: z.literal('fs_result'),
  requestId: z.string().min(1),
  result: fsResultSchema,
});

export const fsErrorMessageSchema = z.object({
  type: z.literal('fs_error'),
  requestId: z.string().min(1),
  error: fsErrorSchema,
});

/**
 * A workspace file changed (the FS bridge watcher). `path` is
 * workspace-root-relative; `session` is the root-relative view when the path
 * sits inside a managed worktree, so panes watching a session root can react
 * without knowing the host layout.
 */
export const fsChangeMessageSchema = z.object({
  type: z.literal('fs_change'),
  path: z.string().min(1),
  changeType: z.enum(['add', 'change', 'unlink', 'addDir', 'unlinkDir']),
  session: z
    .object({ sessionId: z.string().min(1), path: z.string().min(1) })
    .nullable()
    .optional(),
});

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
  fsRequestMessageSchema,
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
  fsResultMessageSchema,
  fsErrorMessageSchema,
  fsChangeMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
