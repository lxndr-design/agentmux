import { z } from 'zod';

/**
 * Filesystem RPC contract — the host FS bridge serves the workspace, and the
 * UI consumes it through this schema. Both sides import from here, so the
 * browser never re-declares a wire shape (blueprint: "One event model, many
 * backends" — same discipline, applied to the FS surface).
 *
 * Paths in every message are RELATIVE to the addressed root. Roots are
 * `workspace` (the main checkout) or `session:<id>` (one agent's worktree) —
 * the UI never learns absolute host paths. Containment against traversal and
 * symlink escapes is enforced at the bridge; these schemas only shape the
 * traffic.
 */

/** `workspace` names the main checkout; `session:<id>` names an agent worktree. */
export const fsRootSchema = z
  .string()
  .min(1)
  .regex(/^(workspace|session:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/, 'invalid fs root id');
export type FsRoot = z.infer<typeof fsRootSchema>;

const relPathSchema = z.string().min(1);

export const fsEntrySchema = z.object({
  /** Final path segment. */
  name: z.string(),
  /** Path relative to the addressed root. */
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink']),
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsStatSchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink']),
  size: z.number(),
  mtimeMs: z.number(),
});
export type FsStat = z.infer<typeof fsStatSchema>;

export const fsReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
});
export type FsReadResult = z.infer<typeof fsReadResultSchema>;

export const fsWriteResultSchema = z.object({
  path: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
});
export type FsWriteResult = z.infer<typeof fsWriteResultSchema>;

export const fsSearchMatchSchema = z.object({
  /** File the match was found in, relative to the addressed root. */
  path: z.string(),
  /** 1-based line number. */
  line: z.number().int().positive(),
  /** The matching line, truncated for the wire. */
  text: z.string(),
});
export type FsSearchMatch = z.infer<typeof fsSearchMatchSchema>;

export const fsRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), root: fsRootSchema, path: relPathSchema }),
  z.object({ op: z.literal('read'), root: fsRootSchema, path: relPathSchema }),
  z.object({
    op: z.literal('write'),
    root: fsRootSchema,
    path: relPathSchema,
    content: z.string(),
  }),
  z.object({ op: z.literal('mkdir'), root: fsRootSchema, path: relPathSchema }),
  z.object({
    op: z.literal('mv'),
    root: fsRootSchema,
    from: relPathSchema,
    to: relPathSchema,
  }),
  z.object({
    op: z.literal('rm'),
    root: fsRootSchema,
    path: relPathSchema,
    recursive: z.boolean().optional(),
  }),
  z.object({ op: z.literal('stat'), root: fsRootSchema, path: relPathSchema }),
  z.object({
    op: z.literal('search'),
    root: fsRootSchema,
    query: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
  }),
]);
export type FsRequest = z.infer<typeof fsRequestSchema>;

/** One success shape per op — the caller never guesses which field holds what. */
export const fsResultSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), entries: z.array(fsEntrySchema) }),
  z.object({ op: z.literal('read'), read: fsReadResultSchema }),
  z.object({ op: z.literal('write'), stat: fsWriteResultSchema }),
  z.object({ op: z.literal('mkdir'), path: relPathSchema }),
  z.object({ op: z.literal('mv'), path: relPathSchema }),
  z.object({ op: z.literal('rm'), path: relPathSchema }),
  z.object({ op: z.literal('stat'), stat: fsStatSchema }),
  z.object({ op: z.literal('search'), matches: z.array(fsSearchMatchSchema) }),
]);
export type FsResult = z.infer<typeof fsResultSchema>;

export const fsErrorSchema = z.object({
  /** Machine-readable bridge error code (E_SANDBOX, E_NOT_FOUND, …). */
  code: z.string(),
  message: z.string(),
});
export type FsError = z.infer<typeof fsErrorSchema>;
