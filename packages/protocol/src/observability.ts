import { z } from 'zod';

/**
 * Observability wire shapes — the divergence panel and the usage rollups
 * (blueprint: "Divergence view", "Cost & token tracking"). The same
 * discipline as fs.ts: both the daemon and the UI import these schemas, so
 * neither side re-declares a wire shape.
 *
 * Divergence is computed host-side by real git probes against the workspace
 * (ahead/behind, files touched) plus a derived PR deep link — the daemon
 * holds no GitHub credentials and makes no API calls in v1.
 */

/** Change class for one file touched on the session branch or working tree. */
export const divergenceFileStatusSchema = z.enum(['added', 'modified', 'deleted', 'uncommitted']);
export type DivergenceFileStatus = z.infer<typeof divergenceFileStatusSchema>;

export const divergenceFileSchema = z.object({
  /** Workspace-root-relative path (session worktree prefix included). */
  path: z.string().min(1),
  status: divergenceFileStatusSchema,
});
export type DivergenceFile = z.infer<typeof divergenceFileSchema>;

export const divergenceEntrySchema = z.object({
  sessionId: z.string().min(1),
  /** Branch checked out in the worktree; null when detached. */
  branch: z.string().nullable(),
  /** Base ref the ahead/behind counts compare against; null when unresolved. */
  base: z.string().nullable(),
  /** Commits the session branch is ahead of / behind the base. */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  files: z.array(divergenceFileSchema),
  /**
   * GitHub compare deep link (opens PR creation for the branch; an existing
   * open PR for the same head branch is offered there too). Null when the
   * remote is not GitHub or no remote is configured.
   */
  prUrl: z.string().nullable(),
  /** Why divergence could not be computed for this session, when it could not. */
  error: z.string().nullable(),
});
export type DivergenceEntry = z.infer<typeof divergenceEntrySchema>;

/** One UTC day of usage for one session — the rollup's grain (blueprint: per agent/task/day). */
export const usageRollupRowSchema = z.object({
  sessionId: z.string().min(1),
  /** UTC calendar day, `YYYY-MM-DD`, bucketed from the journaled envelope ts. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** Number of journaled usage events folded into this row. */
  events: z.number().int().positive(),
});
export type UsageRollupRow = z.infer<typeof usageRollupRowSchema>;

export const usageRollupsSchema = z.object({
  /** Session × day rows, sorted by session then day. */
  rows: z.array(usageRollupRowSchema),
  totals: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
});
export type UsageRollups = z.infer<typeof usageRollupsSchema>;
