import { z } from 'zod';
import { approvalDecisionSchema, approvalRequestSchema } from './approval.js';
import { exitInfoSchema, sessionStateSchema } from './session.js';

/**
 * The agent-event union — the brief's six kinds. Blueprint naming collapses
 * into them: text/thinking deltas become streamed `turn`/`thinking` events
 * (concatenate `text` chunks until `done`), tool.started/tool.output become
 * `tool_use`/`tool_result`, and session.status/exit surface as `state_change`
 * (approvals ride along: entering `waiting-approval` carries the pending
 * ApprovalRequest; the decision goes back over stdin as an ApprovalDecision).
 */

const turnEventSchema = z.object({
  kind: z.literal('turn'),
  turnId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  /** Text chunk; concatenated chunks form the turn, `done` marks the last. */
  text: z.string(),
  done: z.boolean(),
});

const thinkingEventSchema = z.object({
  kind: z.literal('thinking'),
  /** Reasoning chunk; concatenated chunks form the block, `done` marks the last. */
  text: z.string(),
  done: z.boolean(),
  /** Correlates the reasoning with the turn it precedes, when known. */
  turnId: z.string().min(1).optional(),
});

const toolDetailSchema = z.object({
  command: z.string().optional(),
  diff: z.string().optional(),
  paths: z.array(z.string()).optional(),
});

const toolUseEventSchema = z.object({
  kind: z.literal('tool_use'),
  callId: z.string().min(1),
  tool: z.string().min(1),
  summary: z.string().optional(),
  detail: toolDetailSchema.optional(),
});

const toolResultEventSchema = z.object({
  kind: z.literal('tool_result'),
  callId: z.string().min(1),
  output: z.string(),
  truncated: z.boolean(),
  isError: z.boolean().optional(),
});

const usageEventSchema = z.object({
  kind: z.literal('usage'),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** Vendor-reported plan quota remaining, when the CLI exposes one. */
  planQuota: z.number().int().nonnegative().optional(),
});

const stateChangeEventSchema = z
  .object({
    kind: z.literal('state_change'),
    from: sessionStateSchema,
    to: sessionStateSchema,
    /** Pending approval, mandatory when entering waiting-approval. */
    request: approvalRequestSchema.optional(),
    exit: exitInfoSchema.optional(),
  })
  .refine((event) => event.from !== event.to, {
    message: 'state_change must actually change state',
  })
  .refine((event) => event.to !== 'waiting-approval' || event.request !== undefined, {
    message: 'entering waiting-approval requires the pending ApprovalRequest',
  })
  .refine((event) => event.request === undefined || event.to === 'waiting-approval', {
    message: 'a pending ApprovalRequest may only ride a transition into waiting-approval',
  })
  .refine((event) => event.exit === undefined || event.to === 'stopped' || event.to === 'crashed', {
    message: 'exit info may only ride a transition into a terminal state',
  });

const approvalDecisionEventSchema = z.object({
  kind: z.literal('approval_decision'),
  /** The requestId of the resolved approval — joins the request's journal trail. */
  requestId: z.string().min(1),
  decision: approvalDecisionSchema.shape.decision,
  /** Who resolved it — the audit trail separates human calls from host policy. */
  actor: z.enum(['human', 'policy', 'timeout']),
  /**
   * Denial reason (or grant scope note for approve-for-session). Also carried
   * on the journaled event so the feed is auditable after the fact.
   */
  reason: z.string().optional(),
});

export const agentEventSchema = z.discriminatedUnion('kind', [
  turnEventSchema,
  thinkingEventSchema,
  toolUseEventSchema,
  toolResultEventSchema,
  usageEventSchema,
  stateChangeEventSchema,
  approvalDecisionEventSchema,
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventKind = AgentEvent['kind'];

/** Runtime kind list, extracted from the union — never hand-duplicated. */
export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = agentEventSchema.options.map(
  (option) => [...option.shape.kind.values][0],
) as readonly AgentEventKind[];

export function isAgentEventKind(kind: string): kind is AgentEventKind {
  return (AGENT_EVENT_KINDS as readonly string[]).includes(kind);
}
