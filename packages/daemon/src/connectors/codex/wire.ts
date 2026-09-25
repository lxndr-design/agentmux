import { z } from 'zod';

/**
 * Codex CLI wire schemas — Q5 findings, verified 2026-09-25 against
 * openai/codex @ main (downloaded source under /home/user/work/codex-ref;
 * paths cited relative to codex-rs/). The connector speaks BOTH surfaces:
 *
 *   - `codex app-server` (codex-rs/app-server): JSON-RPC-shaped NDJSON without
 *     the `jsonrpc` field (rpc.rs). Client→server requests `{id, method,
 *     params}`; server→client requests (approvals) `{id, method, params}`
 *     answered with `{id, result}`; notifications `{method, params}`.
 *     Params/results are camelCase (v2 structs `rename_all = "camelCase"`).
 *   - `codex exec --json` (codex-rs/exec/exec_events.rs): snake_case
 *     type-tagged JSONL events, one JSON object per line.
 *
 * Every schema is a `looseObject`: unrecognized fields survive parsing so a
 * CLI schema drift surfaces as a parser warning, never silently dropped data.
 * Unknown top-level event types are skipped with a warning, not errors.
 */

// ---- app-server frames ----------------------------------------------------

/** `{id, result}` — the answer to one of OUR requests (handshake, turn/start). */
export const codexResponseSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/**
 * A server→client request. The two approval methods carry full disclosure
 * payloads (the exact command string, or the file-change item reference):
 *
 *   - v2 `item/commandExecution/requestApproval` — params `{kind, threadId,
 *     turnId, itemId, startedAtMs, approvalId?, reason?, command?: string,
 *     cwd?, commandActions?, availableDecisions?}`
 *     (app-server-protocol/src/protocol/common.rs:1765; params constructed in
 *     app-server/src/bespoke_event_handling.rs:785).
 *   - v2 `item/fileChange/requestApproval` — params `{threadId, turnId,
 *     itemId, startedAtMs, reason?, grantRoot?}`; NO file list rides the
 *     request — the paths come from the matching `fileChange` item
 *     (app-server-protocol/src/protocol/v2/item.rs:1632).
 *   - v1 fallbacks `execCommandApproval` (`command: string[]`) and
 *     `applyPatchApproval` still serialize the same way; accepted tolerantly.
 */
export const codexServerRequestSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.looseObject({}).optional(),
});

/** `{method, params}` — server notifications carry the whole turn stream. */
export const codexNotificationSchema = z.looseObject({
  method: z.string(),
  params: z.looseObject({}).optional(),
});

// ---- app-server item payloads (v2 ThreadItem, camelCase tags) --------------

/**
 * v2 ThreadItem (`app-server-protocol/src/protocol/v2/item.rs`): `id` +
 * `type` + flattened fields. Only the shapes v1 maps are named; everything
 * else passes through retained.
 */
export const codexAppItemSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  command: z.unknown().optional(),
  aggregatedOutput: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  status: z.string().optional(),
  changes: z.array(z.looseObject({ path: z.string(), kind: z.string().optional() })).optional(),
  message: z.string().optional(),
});

/**
 * The decisions the CLI accepts on an approval response (verified:
 * `CommandExecutionApprovalDecision` — app-server-protocol/src/protocol/v2/
 * item.rs:66, serde camelCase; decode test in app-server/src/
 * outgoing_message.rs uses `{"decision": "acceptForSession"}`).
 */
export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/**
 * Encodes the client's answer to a server approval request. `decision` is a
 * plain string per the serde of the externally-tagged enum's unit variants;
 * `Decline`/`Cancel` carry no payload, so a deny reason cannot reach the CLI
 * on this surface — it is journaled host-side (denial reasons DO reach the
 * model on the v1 shape below).
 */
export function encodeApprovalResponse(
  requestId: string | number,
  decision: CodexApprovalDecision,
): string {
  return JSON.stringify({ id: requestId, result: { decision } });
}

/**
 * v1 `ReviewDecision` (protocol/src/protocol.rs:4157, `rename_all =
 * "snake_case"`, externally tagged): `approved` | `approved_for_session` |
 * `{"denied": {"rejection": "..."}}` | `abort` | `timed_out`. Denied carries
 * the rejection reason — deny-with-reason is native here. Accepted by
 * `execCommandApproval` / `applyPatchApproval` request ids (verify test:
 * app-server/tests/suite/v2/review.rs answers `{"decision": "approved"}`).
 */
export function encodeV1ApprovalResponse(
  requestId: string | number,
  decision: { approve: boolean; reason?: string },
): string {
  const reviewDecision: unknown = decision.approve
    ? 'approved'
    : { denied: { rejection: decision.reason ?? 'denied by operator' } };
  return JSON.stringify({ id: requestId, result: { decision: reviewDecision } });
}

// ---- client→server request encoders ----------------------------------------

/**
 * Handshake: `initialize` params carry `clientInfo` (verified serialization
 * test, app-server-protocol/src/protocol/common.rs:2760). The capabilities
 * block is optional — omitted.
 */
export function encodeInitializeRequest(
  id: number,
  client: { name: string; title: string; version: string },
): string {
  return JSON.stringify({
    id,
    method: 'initialize',
    params: { clientInfo: client },
  });
}

/**
 * One thread = one session. `approvalPolicy` is the brief's
 * "--ask-for-approval on-request" at the API level (the flag exists on
 * thread/start, not on exec — verified: `AskForApproval` kebab-case,
 * app-server-protocol/src/protocol/v2/shared.rs:180; `SandboxMode`
 * kebab-case, shared.rs:305). The approval column needs every risky action
 * surfaced, so `on-request` is pinned and `never` is never sent.
 */
export type CodexSandbox = 'read-only' | 'workspace-write';

export function encodeThreadStartRequest(
  id: number,
  params: { cwd: string; sandbox: CodexSandbox; model?: string },
): string {
  return JSON.stringify({
    id,
    method: 'thread/start',
    params: {
      cwd: params.cwd,
      sandbox: params.sandbox,
      approvalPolicy: 'on-request',
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
  });
}

/** One user turn: `{threadId, input: [{type: "text", text}]}` (v2/turn.rs:167). */
export function encodeTurnStartRequest(
  id: number,
  params: { threadId: string; text: string },
): string {
  return JSON.stringify({
    id,
    method: 'turn/start',
    params: {
      threadId: params.threadId,
      input: [{ type: 'text', text: params.text }],
    },
  });
}

// ---- exec JSONL (codex-rs/exec/exec_events.rs) ------------------------------

/** `{"type":"thread.started","thread_id":...}` — first exec event. */
export const codexExecThreadStartedSchema = z.looseObject({
  type: z.literal('thread.started'),
  thread_id: z.string(),
});

export const codexExecTurnStartedSchema = z.looseObject({ type: z.literal('turn.started') });

const codexExecUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  cache_write_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_output_tokens: z.number().optional(),
});

export const codexExecTurnCompletedSchema = z.looseObject({
  type: z.literal('turn.completed'),
  usage: codexExecUsageSchema.optional(),
});

export const codexExecTurnFailedSchema = z.looseObject({
  type: z.literal('turn.failed'),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

export const codexExecErrorSchema = z.looseObject({
  type: z.literal('error'),
  message: z.string().optional(),
});

/**
 * Exec items are snake_case-tagged (`command_execution`, `agent_message`,
 * `reasoning`, `file_change`, …) with flattened fields — the v2 app-server
 * item's snake_case twin, normalized by the parser's dual-dialect mapping.
 */
export const codexExecItemEventSchema = z.looseObject({
  type: z.enum(['item.started', 'item.updated', 'item.completed']),
  item: z.looseObject({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    command: z.unknown().optional(),
    aggregated_output: z.string().optional(),
    exit_code: z.number().nullable().optional(),
    status: z.string().optional(),
    changes: z.array(z.looseObject({ path: z.string(), kind: z.string().optional() })).optional(),
    message: z.string().optional(),
  }),
});
