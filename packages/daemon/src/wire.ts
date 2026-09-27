import { z } from 'zod';
import {
  agentEventEnvelopeSchema,
  approvalDecisionSchema,
  divergenceEntrySchema,
  fsErrorSchema,
  fsRequestSchema,
  fsResultSchema,
  usageRollupsSchema,
} from '@agentmux/protocol';

/**
 * Gateway wire messages — the daemon↔UI session-control layer. Event payloads
 * are never re-declared here: envelopes ride verbatim through
 * `agentEventEnvelopeSchema` from @agentmux/protocol, and so do filesystem
 * RPC payloads (`fsRequestSchema` / `fsResultSchema` / `fsErrorSchema`).
 * Approval decisions ride `decide` messages: the pinned column's answer, routed
 * by the approval engine into the connector's stdin (blueprint: "The human in
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

/**
 * Observability RPC (blueprint: "Divergence view", "Cost & token tracking").
 * Same requestId correlation as the FS RPC; both requests take no parameters —
 * the panel is workspace-global.
 */

export const divergenceRequestMessageSchema = z.object({
  type: z.literal('divergence_request'),
  requestId: z.string().min(1),
});

export const divergenceResultMessageSchema = z.object({
  type: z.literal('divergence_result'),
  requestId: z.string().min(1),
  entries: z.array(divergenceEntrySchema),
});

export const usageRollupsRequestMessageSchema = z.object({
  type: z.literal('usage_rollups_request'),
  requestId: z.string().min(1),
});

export const usageRollupsResultMessageSchema = z.object({
  type: z.literal('usage_rollups_result'),
  requestId: z.string().min(1),
  rollups: usageRollupsSchema,
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
  divergenceRequestMessageSchema,
  usageRollupsRequestMessageSchema,
  z.object({
    type: z.literal('decide'),
    sessionId: z.string().min(1),
    decision: approvalDecisionSchema,
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
  fsResultMessageSchema,
  fsErrorMessageSchema,
  fsChangeMessageSchema,
  divergenceResultMessageSchema,
  usageRollupsResultMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
