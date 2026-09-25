import { z } from 'zod';
import {
  agentEventEnvelopeSchema,
  fsErrorSchema,
  fsRequestSchema,
  fsResultSchema,
} from '@agentmux/protocol';

/**
 * Client/server wire messages — mirrored from packages/daemon/src/wire.ts.
 *
 * The mirror exists because @agentmux/daemon is a Node-only package
 * (better-sqlite3, ws), so the browser cannot import it at runtime, and the
 * wire schema belongs to the daemon while the connector PR is still in
 * flight. Hoisting these schemas into @agentmux/protocol is the follow-up
 * once the approval-decision messages land; until then, wsClient.test.ts
 * pins this mirror to the real daemon, so drift fails CI instead of the UI.
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

/**
 * Filesystem RPC over the same gateway (blueprint "A bridge, not a bypass").
 * `requestId` correlates responses on this connection; `fs_change` is a
 * workspace-global notification with an optional session-root view.
 */

export const fsRequestMessageSchema = z.object({
  type: z.literal('fs_request'),
  requestId: z.string().min(1),
  request: fsRequestSchema,
});
export type FsRequestMessage = z.infer<typeof fsRequestMessageSchema>;

export const fsResultMessageSchema = z.object({
  type: z.literal('fs_result'),
  requestId: z.string().min(1),
  result: fsResultSchema,
});
export type FsResultMessage = z.infer<typeof fsResultMessageSchema>;

export const fsErrorMessageSchema = z.object({
  type: z.literal('fs_error'),
  requestId: z.string().min(1),
  error: fsErrorSchema,
});
export type FsErrorMessage = z.infer<typeof fsErrorMessageSchema>;

export const fsChangeMessageSchema = z.object({
  type: z.literal('fs_change'),
  path: z.string().min(1),
  changeType: z.enum(['add', 'change', 'unlink', 'addDir', 'unlinkDir']),
  session: z
    .object({ sessionId: z.string().min(1), path: z.string().min(1) })
    .nullable()
    .optional(),
});
export type FsChangeMessage = z.infer<typeof fsChangeMessageSchema>;

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

export type ServerMessageParse =
  { ok: true; message: ServerMessage } | { ok: false; error: string };

/**
 * Parse + validate one inbound frame. The client validates everything the
 * daemon sends — a misbehaving or hostile source must surface as a protocol
 * error, never as a crash or as unchecked data in the UI.
 */
export function parseServerMessage(raw: unknown): ServerMessageParse {
  let json: unknown;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: 'frame is not JSON' };
    }
  } else {
    json = raw;
  }
  const parsed = serverMessageSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `unrecognized server message: ${parsed.error.message}` };
  }
  return { ok: true, message: parsed.data };
}
