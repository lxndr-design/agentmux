import { z } from 'zod';

/**
 * Approval round-trip types (blueprint: "The human in the loop"). A request
 * lands in the pinned approval column; the decision re-enters the connector
 * over stdin, so no agent code knows agentmux exists.
 */

export const approvalRiskSchema = z.enum(['low', 'medium', 'high']);
export type ApprovalRisk = z.infer<typeof approvalRiskSchema>;

/**
 * One pending human decision. The full command, diff, or affected paths is
 * mandatory — never a summary alone (the prompt-injection defense: a summary
 * can lie; the raw text cannot).
 */
export const approvalRequestSchema = z
  .object({
    requestId: z.string().min(1),
    tool: z.string().min(1),
    risk: approvalRiskSchema,
    command: z.string().optional(),
    diff: z.string().optional(),
    paths: z.array(z.string()).optional(),
  })
  .refine(
    (request) =>
      request.command !== undefined ||
      request.diff !== undefined ||
      (request.paths !== undefined && request.paths.length > 0),
    { message: 'approval request must carry the full command, diff, or affected paths' },
  );
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/**
 * The column's answer, written back to the connector's stdin. `reason` (for
 * denies) is returned to the agent as the denial message — including the
 * timeout auto-deny, whose reason names the timeout.
 */
export const approvalDecisionSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'approve-for-session', 'deny']),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
