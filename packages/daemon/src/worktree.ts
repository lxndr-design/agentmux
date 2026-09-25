import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Session worktree isolation (blueprint: "Init, run, kill, tombstone").
 *
 * Every agent runs in its own git worktree by default — two agents editing
 * one checkout is a lost-update bug factory; isolation makes it structurally
 * impossible. Worktrees live under `<workspaceRoot>/.agentmux/worktrees/<id>`,
 * inside the workspace the FS bridge already sandboxes, so a session tree is
 * served by the same bridge under a per-session root prefix. The main
 * checkout is handed out only on explicit opt-out (`useMainCheckout`).
 *
 * All git access goes through `execFile` with an argument array — never a
 * shell — so a session id cannot smuggle commands into git. The manager
 * never commits, so it needs no git identity of its own.
 */

/** Where session worktrees live, relative to the workspace root. */
export const WORKTREE_DIR = '.agentmux/worktrees';
/** The exclude entry keeping the main checkout's `git status` free of worktree noise. */
const EXCLUDE_LINE = '.agentmux/';

/** Session-id shape — shared with the FS bridge, which keys session roots by it. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH_PREFIX = 'agentmux/';
/** A hung `git worktree add` means git itself is wedged — fail rather than hang the daemon. */
const GIT_TIMEOUT_MS = 30_000;
/** Default staleness window for gc(): a day of no ownership. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type WorktreeErrorCode =
  'E_SESSION_ID' | 'E_EXISTS' | 'E_NOT_FOUND' | 'E_DIRTY' | 'E_UNMERGED' | 'E_GIT';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/** A registered session workspace: an isolated worktree, or the main checkout on explicit opt-out. */
export interface WorktreeRecord {
  sessionId: string;
  /** Absolute path the session's CLI runs in. */
  path: string;
  /** Branch checked out in the worktree (`agentmux/<sessionId>`); null when detached. */
  branch: string | null;
  /** Base ref the worktree was cut from ('' when adopted or main checkout). */
  base: string;
  /** True when the session was explicitly opted out of worktree isolation. */
  isMainCheckout: boolean;
  createdAt: number;
}

/** Options for gc() — what "stale" means and how aggressively to reap. */
export interface WorktreeGcOptions {
  /**
   * Only worktrees untouched for at least this long are candidates.
   * 0 means every unclaimed managed worktree is a candidate.
   */
  maxAgeMs?: number;
  /**
   * Remove even when the worktree is dirty or its branch holds unmerged
   * commits. Default false: gc only reclaims worktrees whose work is already
   * preserved, so routine cleanup can never silently destroy agent output.
   */
  force?: boolean;
}

export interface WorktreeGcResult {
  /** Session ids whose worktrees (and branches) were removed. */
  removed: string[];
  /** Session ids that qualified as stale but were kept, with the reason. */
  skipped: Array<{ sessionId: string; reason: 'dirty' | 'unmerged' }>;
}

export interface WorktreeManagerOptions {
  /** The workspace root — the main checkout worktrees branch from. */
  workspaceRoot: string;
}

interface WorktreeListEntry {
  path: string;
  branch: string | null;
}

export class WorktreeManager {
  private readonly root: string;
  private readonly worktreeRoot: string;
  /** sessionId → record. In-memory; `git worktree list` is the durable truth. */
  private readonly records = new Map<string, WorktreeRecord>();
  /** Serializes git mutations — create/remove/gc never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorktreeManagerOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.worktreeRoot = path.join(this.root, WORKTREE_DIR);
  }

  /**
   * Boot reconciliation (blueprint: "the host reconciles … reaps agent
   * orphans left by a previous run"). Worktrees registered under
   * `.agentmux/worktrees` are adopted into the registry so a daemon restart
   * neither loses track of them nor silently deletes them; `git worktree
   * prune` first clears metadata for directories removed out from under git.
   */
  async reconcile(): Promise<WorktreeRecord[]> {
    return this.enqueue(async () => {
      await this.git(['worktree', 'prune']);
      for (const entry of await this.managedWorktrees()) {
        if (this.records.has(entry.sessionId)) continue;
        const mtime = (await statSafe(entry.path))?.mtimeMs ?? Date.now();
        this.records.set(entry.sessionId, {
          sessionId: entry.sessionId,
          path: entry.path,
          branch: entry.branch,
          base: '',
          isMainCheckout: false,
          createdAt: mtime,
        });
      }
      return this.list();
    });
  }

  /**
   * Create the workspace for a session. Worktree isolation is the default;
   * `useMainCheckout` is the explicit opt-out. Idempotent per session — an
   * existing registration returns the same record, so a retried spawn does
   * not multiply worktrees.
   */
  async create(
    sessionId: string,
    opts: { baseBranch?: string; useMainCheckout?: boolean } = {},
  ): Promise<WorktreeRecord> {
    assertSessionId(sessionId);
    return this.enqueue(async () => {
      const existing = this.records.get(sessionId);
      if (existing !== undefined) {
        return existing;
      }

      if (opts.useMainCheckout === true) {
        // The main checkout is shared state — registering it is bookkeeping,
        // not isolation. The record marks that the trade-off was chosen.
        const head = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const record: WorktreeRecord = {
          sessionId,
          path: this.root,
          branch: head,
          base: '',
          isMainCheckout: true,
          createdAt: Date.now(),
        };
        this.records.set(sessionId, record);
        return record;
      }

      const worktreePath = path.join(this.worktreeRoot, sessionId);
      const branch = `${BRANCH_PREFIX}${sessionId}`;
      if ((await statSafe(worktreePath)) !== undefined) {
        // A managed worktree on disk without a registry record is the
        // daemon-restart case (registry lost, branch and worktree alive) —
        // adopt it rather than fail the spawn. Anything else at that path is
        // a hard conflict.
        const adopted = await this.adoptWorktreeAt(worktreePath, sessionId);
        if (adopted !== undefined) {
          this.records.set(sessionId, adopted);
          return adopted;
        }
        throw new WorktreeError(
          'E_EXISTS',
          `a worktree for session "${sessionId}" already exists at ${worktreePath}`,
        );
      }
      const base = opts.baseBranch ?? 'HEAD';
      const branchExists = await this.branchExists(branch);
      // After a daemon restart the registry is empty but the branch may live
      // on — reuse it instead of failing the spawn.
      await this.git([
        'worktree',
        'add',
        ...(branchExists ? [] : ['-b', branch]),
        worktreePath,
        ...(branchExists ? [branch] : [base]),
      ]);
      await this.ensureWorktreesExcluded();
      const record: WorktreeRecord = {
        sessionId,
        path: worktreePath,
        branch,
        base,
        isMainCheckout: false,
        createdAt: Date.now(),
      };
      this.records.set(sessionId, record);
      return record;
    });
  }

  /**
   * Tear a session's workspace down. Default (non-forced) removal refuses a
   * dirty worktree or an unmerged branch, so an operator's cleanup never
   * silently deletes output the human has not seen. Force discards both.
   */
  async remove(sessionId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    assertSessionId(sessionId);
    return this.enqueue(async () => {
      const record = this.records.get(sessionId);
      if (record === undefined) {
        return false;
      }
      if (!record.isMainCheckout) {
        if (opts.force !== true) {
          if (await this.isDirty(record.path)) {
            throw new WorktreeError(
              'E_DIRTY',
              `worktree for session "${sessionId}" has uncommitted changes — pass force to discard them`,
            );
          }
          if (record.branch !== null && !(await this.isMerged(record.branch))) {
            throw new WorktreeError(
              'E_UNMERGED',
              `branch ${record.branch} holds unmerged commits — pass force to discard them`,
            );
          }
        }
        await this.destroyWorktree(record, opts.force === true);
      }
      this.records.delete(sessionId);
      return true;
    });
  }

  /** All live registrations — the supervisor's session→worktree map. */
  list(): WorktreeRecord[] {
    return [...this.records.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  get(sessionId: string): WorktreeRecord | undefined {
    return this.records.get(sessionId);
  }

  /**
   * Reclaim worktrees that no live session owns. Candidates: registrations
   * older than `maxAgeMs`, and orphans under `.agentmux/worktrees` found by
   * `git worktree list` — worktrees whose owning daemon died without
   * cleanup. Unless `force`, a candidate is removed only when its tree is
   * clean AND its branch is fully merged into the workspace HEAD, i.e. its
   * work is preserved in history. One wedged worktree never aborts the
   * sweep — the failure is surfaced and the sweep continues.
   */
  async gc(opts: WorktreeGcOptions = {}): Promise<WorktreeGcResult> {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const force = opts.force ?? false;
    const removed: string[] = [];
    const skipped: Array<{ sessionId: string; reason: 'dirty' | 'unmerged' }> = [];
    await this.enqueue(async () => {
      for (const record of await this.gcCandidates(maxAgeMs)) {
        try {
          if (!force) {
            if (await this.isDirty(record.path)) {
              skipped.push({ sessionId: record.sessionId, reason: 'dirty' });
              continue;
            }
            if (record.branch !== null && !(await this.isMerged(record.branch))) {
              skipped.push({ sessionId: record.sessionId, reason: 'unmerged' });
              continue;
            }
          }
          await this.destroyWorktree(record, force);
          this.records.delete(record.sessionId);
          removed.push(record.sessionId);
        } catch (error) {
          console.error(`worktree gc: failed to remove "${record.sessionId}":`, error);
        }
      }
    });
    return { removed, skipped };
  }

  /**
   * Hook for daemon shutdown. There is no background work to stop yet — the
   * FS bridge owns watching — but a uniform close() keeps callers honest.
   */
  close(): void {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job, job);
    // Keep the chain alive after a rejection; the caller still observes it.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private git(args: string[], cwd: string = this.root): Promise<string> {
    return this.runGit(args, cwd).then((run) => {
      if (run.code !== 0) {
        throw new WorktreeError('E_GIT', `git ${args[0] ?? ''} failed: ${run.stderr.trim()}`);
      }
      return run.stdout;
    });
  }

  private async runGit(
    args: string[],
    cwd: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ code: error.code, stdout, stderr });
          } else {
            // Not an exit code — git itself could not be spawned.
            reject(new WorktreeError('E_GIT', `git could not run: ${error.message}`));
          }
        },
      );
    });
  }

  private async branchExists(branch: string): Promise<boolean> {
    const run = await this.runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      this.root,
    );
    return run.code === 0;
  }

  private async isDirty(worktreePath: string): Promise<boolean> {
    const exists = (await statSafe(worktreePath)) !== undefined;
    if (!exists) {
      return false; // nothing left to be dirty
    }
    const status = await this.git(['status', '--porcelain'], worktreePath);
    return status.trim() !== '';
  }

  /** True when every commit on `branch` is already in the workspace HEAD. */
  private async isMerged(branch: string): Promise<boolean> {
    const run = await this.runGit(['merge-base', '--is-ancestor', branch, 'HEAD'], this.root);
    if (run.code === 0) return true;
    if (run.code === 1) return false;
    throw new WorktreeError('E_GIT', `git merge-base failed: ${run.stderr.trim()}`);
  }

  /** Worktrees git knows about that live under our managed directory. */
  private async managedWorktrees(): Promise<
    Array<{ sessionId: string; path: string; branch: string | null }>
  > {
    const listing = parseWorktreeList(await this.git(['worktree', 'list', '--porcelain']));
    const managed: Array<{ sessionId: string; path: string; branch: string | null }> = [];
    for (const entry of listing) {
      const relative = path.relative(this.worktreeRoot, entry.path);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        continue; // not under .agentmux/worktrees — not ours
      }
      const sessionId = path.basename(entry.path);
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        console.warn(`worktree: ignoring unmanaged directory name "${sessionId}"`);
        continue;
      }
      managed.push({ sessionId, path: entry.path, branch: entry.branch });
    }
    return managed;
  }

  /** A record for a registered git worktree already on disk, if `worktreePath` is one. */
  private async adoptWorktreeAt(
    worktreePath: string,
    sessionId: string,
  ): Promise<WorktreeRecord | undefined> {
    const entry = (await this.managedWorktrees()).find(
      (candidate) => candidate.path === worktreePath,
    );
    if (entry === undefined) {
      return undefined;
    }
    const mtime = (await statSafe(entry.path))?.mtimeMs ?? Date.now();
    return {
      sessionId,
      path: entry.path,
      branch: entry.branch,
      base: '',
      isMainCheckout: false,
      createdAt: mtime,
    };
  }

  private async gcCandidates(maxAgeMs: number): Promise<WorktreeRecord[]> {
    const now = Date.now();
    const candidates = new Map<string, WorktreeRecord>();
    for (const record of this.records.values()) {
      if (!record.isMainCheckout && now - record.createdAt >= maxAgeMs) {
        candidates.set(record.sessionId, record);
      }
    }
    for (const entry of await this.managedWorktrees()) {
      if (this.records.has(entry.sessionId) || candidates.has(entry.sessionId)) continue;
      const mtime = (await statSafe(entry.path))?.mtimeMs;
      if (mtime === undefined || now - mtime >= maxAgeMs) {
        candidates.set(entry.sessionId, {
          sessionId: entry.sessionId,
          path: entry.path,
          branch: entry.branch,
          base: '',
          isMainCheckout: false,
          createdAt: mtime ?? now,
        });
      }
    }
    return [...candidates.values()];
  }

  private async destroyWorktree(record: WorktreeRecord, force: boolean): Promise<void> {
    const exists = (await statSafe(record.path)) !== undefined;
    if (exists) {
      try {
        await this.git(['worktree', 'remove', record.path, ...(force ? ['--force'] : [])]);
      } catch (error) {
        // git's registration can be stale (directory replaced, metadata
        // half-removed). Clear both sides, then decide whether the original
        // failure still matters.
        await this.git(['worktree', 'prune']);
        await rm(record.path, { recursive: true, force: true });
        if (!force) {
          throw error;
        }
      }
    } else {
      await this.git(['worktree', 'prune']);
    }
    if (record.branch !== null) {
      await this.git(['branch', '-D', record.branch]);
    }
  }

  /**
   * Keep the user's `git status` in the main checkout clean: worktrees are
   * agentmux bookkeeping, so hide them via the repo-local exclude — a local
   * only file, never a change to the user's tracked .gitignore.
   */
  private async ensureWorktreesExcluded(): Promise<void> {
    try {
      const excludePath = (await this.git(['rev-parse', '--git-path', 'info/exclude'])).trim();
      const absolute = path.resolve(this.root, excludePath);
      const current =
        (await statSafe(absolute)) === undefined ? '' : await readFile(absolute, 'utf8');
      if (current.split('\n').some((existing) => existing.trim() === EXCLUDE_LINE)) {
        return;
      }
      const separator = current.endsWith('\n') || current === '' ? '' : '\n';
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `${current}${separator}${EXCLUDE_LINE}\n`, 'utf8');
    } catch (error) {
      // Cosmetic only — a read-only .git must not fail worktree creation.
      console.warn('worktree: could not update .git/info/exclude:', error);
    }
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new WorktreeError(
      'E_SESSION_ID',
      `invalid session id "${sessionId}" — expected [A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
    );
  }
}

/** `git worktree list --porcelain` → entries, blank-line separated blocks. */
function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current !== undefined && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

async function statSafe(target: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const info = await stat(target);
    // Normalize — @types/node types mtimeMs as number | bigint across stat overloads.
    return { mtimeMs: Number(info.mtimeMs) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
