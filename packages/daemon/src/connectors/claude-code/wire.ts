import { z } from 'zod';

/**
 * Claude Code stream-json wire schemas — Q5 findings, verified 2026-09-24
 * against the official docs (code.claude.com/docs/en/headless, /cli-reference)
 * and the shipped @anthropic-ai/claude-agent-sdk 0.3.282 source, whose
 * transport spawns exactly:
 *
 *   claude --output-format stream-json --verbose --input-format stream-json
 *          [--permission-prompt-tool stdio] [--permission-mode <mode>]
 *          [--include-partial-messages]
 *
 * Every schema is a `looseObject`: unrecognized fields survive parsing so a
 * CLI schema drift surfaces as a parser warning, never silently dropped data.
 * (Generic wrapper helpers are avoided on purpose — a `<T extends ZodObject>`
 * passthrough helper collapses zod's literal inference on the discriminator.)
 */

/** `{"type":"system","subtype":"init","session_id",...}` — first stdout line. */
export const claudeSystemMessageSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});

const usageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

// A plain union, not a discriminatedUnion: the loose catchall member has a
// non-literal `type`, which zod v4 rejects at runtime inside discriminated
// unions ("Invalid discriminated union option"). The parser guards block
// fields with runtime checks instead.
const assistantContentBlockSchema = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('thinking'), thinking: z.string() }),
  z.looseObject({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  /** Anything else (redacted_thinking, …) — retained, no event emitted. */
  z.looseObject({ type: z.string() }),
]);

const assistantMessageSchema = z.looseObject({
  id: z.string().optional(),
  type: z.literal('message').optional(),
  role: z.literal('assistant').optional(),
  model: z.string().optional(),
  content: z.array(assistantContentBlockSchema).optional(),
  stop_reason: z.string().nullable().optional(),
  usage: usageSchema.optional(),
});

/** Complete assistant message — arrives after (or instead of) its stream_events. */
export const claudeAssistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  message: assistantMessageSchema,
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
});

const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const userContentBlockSchema = z.union([
  toolResultBlockSchema,
  z.looseObject({ type: z.string() }),
]);

/**
 * Stdout user frames carry tool results (and, only with --replay-user-messages,
 * echoes of our own turns — a flag we never pass, so any text-only user frame
 * here is PTY echo residue and is ignored, never surfaced as a turn).
 */
export const claudeUserMessageSchema = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({
    role: z.literal('user').optional(),
    content: z.union([z.array(userContentBlockSchema), z.string()]).optional(),
  }),
  session_id: z.string().optional(),
});

/**
 * `{"type":"stream_event","event":{...raw Anthropic API event...}}` — emitted
 * per block when --include-partial-messages is set. The inner event is kept
 * loose: deltas of interest are text/thinking/input_json, the rest is noise.
 */
export const claudeStreamEventSchema = z.looseObject({
  type: z.literal('stream_event'),
  event: z.looseObject({ type: z.string() }),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
});

/** One per turn; carries usage and the authoritative turn boundary. */
export const claudeResultMessageSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: usageSchema.optional(),
  result: z.unknown().optional(),
  session_id: z.string().optional(),
});

/** CLI→host permission prompt (control protocol over stdout). */
export const claudeControlRequestSchema = z.looseObject({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: z.looseObject({
    subtype: z.string(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
  }),
});

/** CLI retracts one of its own permission prompts (e.g. turn interrupted). */
export const claudeControlCancelRequestSchema = z.looseObject({
  type: z.literal('control_cancel_request'),
  request_id: z.string(),
});

/** CLI answers a host→CLI control request (or echoes ours back — ignored). */
export const claudeControlResponseSchema = z.looseObject({
  type: z.literal('control_response'),
  response: z.looseObject({
    subtype: z.string().optional(),
    request_id: z.string().optional(),
  }),
});

/** Union of every frame kind we understand; anything else is a warning + raw retention. */
export const claudeStreamLineSchema = z.discriminatedUnion('type', [
  claudeSystemMessageSchema,
  claudeAssistantMessageSchema,
  claudeUserMessageSchema,
  claudeStreamEventSchema,
  claudeResultMessageSchema,
  claudeControlRequestSchema,
  claudeControlCancelRequestSchema,
  claudeControlResponseSchema,
]);

export type ClaudeStreamLine = z.infer<typeof claudeStreamLineSchema>;
export type ClaudeControlRequest = z.infer<typeof claudeControlRequestSchema>;
export type ClaudeResultMessage = z.infer<typeof claudeResultMessageSchema>;

// ---- stdin encoders (host → CLI) -----------------------------------------

/**
 * One user turn. Field shapes verified against the SDK's streaming-input
 * writer: `{"type":"user","message":{...},"parent_tool_use_id":null}`.
 */
export function encodeUserTurnMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  });
}

/** PermissionResult per the SDK types: allow (optionally rule-granting) or deny with a message. */
export type ClaudePermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/**
 * The approval decision, written back over stdin. `request_id` must match the
 * CLI's `control_request`; the CLI resumes (or denies) the pending tool call
 * on receipt. `approve-for-session` maps to plain allow — per-session grant
 * bookkeeping belongs to the host policy engine, not the connector.
 */
export function encodeApprovalDecisionMessage(
  requestId: string,
  result: ClaudePermissionResult,
): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: result },
  });
}
