import path from 'node:path';
import { WorktreeManager, type WorktreeRecord } from './worktree.js';

/**
 * The runtime seam (blueprint: "Runtime abstraction — the hook for future
 * SSH/Docker runtimes", F4b parity with `MUX_RUNTIME`). A runtime answers one
 * question: where does this session's CLI execute, and what must its
 * environment know about that? Everything above this file — the supervisor,
 * the connectors — provisiones workspaces and builds spawn environments only
 * through this interface, so the same code runs a session in a git worktree,
 * the main checkout, or (in tests) a throwaway in-memory root.
 *
 * v1 ships exactly two runtimes, both backed by the shared WorktreeManager:
 *
 * - `worktree` (default) — one git worktree per session; two agents editing
 *   one checkout is a lost-update bug factory, so isolation is the default.
 * - `local` — the main checkout itself, on explicit request. Not removable
 *   isolation, so every provision carries an operator-facing warning.
 *
 * SSH and Docker runtimes are v2 (open question Q10-era scope): they change
 * the exec target, not this interface.
 */

/** Runtimes shipping in v1. The `Runtime` interface stays open to v2 ids. */
export const RUNTIME_IDS = ['worktree', 'local'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];
export const DEFAULT_RUNTIME_ID: RuntimeId = 'worktree';

/** What a session asks the runtime for. */
export interface RuntimeRequest {
  sessionId: string;
  /** Base ref a fresh worktree branches from (default: current HEAD). */
  baseBranch?: string;
}

/** What a runtime hands back: the exec root a CLI session will run in. */
export interface RuntimeProvision {
  sessionId: string;
  /** The runtime that served the request — its `env()` names it too. */
  runtime: string;
  /** Absolute path the session's CLI runs in. */
  cwd: string;
  /** Branch checked out there, when the runtime manages one. */
  branch: string | null;
  /**
   * True when an existing registration served this request — the
   * restart-into-worktree case: the same session id gets the same workspace,
   * with whatever the previous run left in it.
   */
  reused: boolean;
  /** Non-fatal operator-facing notice (the local runtime's isolation trade-off). */
  warning?: string;
}

/** The one workspace API. Implementations: worktree, local (v1); SSH, Docker (v2). */
export interface Runtime {
  readonly id: string;
  /** The workspace root the runtime provisions inside — where `.agentmux/` bookkeeping lives. */
  readonly workspaceRoot: string;
  /** Prepare the exec root for a session — create fresh or reuse existing. */
  provision(request: RuntimeRequest): Promise<RuntimeProvision>;
  /**
   * Environment additions for the session's CLI process and its `.agentmux/init`
   * hook — one script adapts to where it runs by reading these (F4b pattern).
   */
  env(): Record<string, string>;
  /**
   * Release a session's workspace. Returns false when nothing was registered.
   * Releasing is not destroying: worktree removal still refuses dirty or
   * unmerged state unless forced (the WorktreeManager's never-lose-work rule).
   */
  release(sessionId: string, opts?: { force?: boolean }): Promise<boolean>;
}

/** The default runtime: one git worktree per session, reused across restarts. */
export class WorktreeRuntime implements Runtime {
  readonly id: RuntimeId = 'worktree';

  constructor(private readonly worktrees: WorktreeManager) {}

  get workspaceRoot(): string {
    return this.worktrees.workspaceRoot;
  }

  async provision(request: RuntimeRequest): Promise<RuntimeProvision> {
    // get-before-create is the restart signal: an existing registration means
    // this session id already has its workspace — hand the same one back.
    const existed = this.worktrees.get(request.sessionId) !== undefined;
    const record = await this.worktrees.create(request.sessionId, {
      baseBranch: request.baseBranch,
    });
    return provisionFromRecord(record, this.id, existed);
  }

  env(): Record<string, string> {
    return { AGENTMUX_RUNTIME: this.id };
  }

  release(sessionId: string, opts?: { force?: boolean }): Promise<boolean> {
    return this.worktrees.remove(sessionId, opts);
  }
}

/** The main-checkout runtime: no isolation, explicit operator trade-off. */
export class LocalRuntime implements Runtime {
  readonly id: RuntimeId = 'local';

  constructor(private readonly worktrees: WorktreeManager) {}

  get workspaceRoot(): string {
    return this.worktrees.workspaceRoot;
  }

  async provision(request: RuntimeRequest): Promise<RuntimeProvision> {
    const existed = this.worktrees.get(request.sessionId) !== undefined;
    const record = await this.worktrees.create(request.sessionId, {
      baseBranch: request.baseBranch,
      useMainCheckout: true,
    });
    return {
      ...provisionFromRecord(record, this.id, existed),
      // Not sourced from anywhere — this is the runtime's own honest label.
      warning:
        'session runs in the main checkout — worktree isolation is off; concurrent sessions share these files',
    };
  }

  env(): Record<string, string> {
    return { AGENTMUX_RUNTIME: this.id };
  }

  release(sessionId: string): Promise<boolean> {
    // Removing the main checkout is bookkeeping only — the manager never
    // deletes the user's checkout for a local registration.
    return this.worktrees.remove(sessionId);
  }
}

function provisionFromRecord(
  record: WorktreeRecord,
  runtime: string,
  reused: boolean,
): RuntimeProvision {
  return {
    sessionId: record.sessionId,
    runtime,
    cwd: record.path,
    branch: record.branch,
    reused,
  };
}

/** Maps a runtime id to its v1 implementation; unknown ids fail at boot, not at spawn. */
export function createRuntime(id: RuntimeId, worktrees: WorktreeManager): Runtime {
  switch (id) {
    case 'worktree':
      return new WorktreeRuntime(worktrees);
    case 'local':
      return new LocalRuntime(worktrees);
  }
}

/**
 * Validates a runtime id from configuration (or `AGENTMUX_RUNTIME` when a
 * caller wants that default). Unknown ids name what v1 ships and where the
 * v2 runtimes stand, so a typo fails with the fix in the message.
 */
export function resolveRuntimeId(value?: string): RuntimeId {
  if (value === undefined || value === '') return DEFAULT_RUNTIME_ID;
  if ((RUNTIME_IDS as readonly string[]).includes(value)) return value as RuntimeId;
  throw new Error(
    `unknown runtime "${value}" — v1 ships: ${RUNTIME_IDS.join(', ')} (SSH and Docker runtimes are planned for v2)`,
  );
}

/** The `.agentmux/` directory inside a workspace — bookkeeping, hook, worktrees. */
export function agentmuxDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agentmux');
}
