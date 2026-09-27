import { execFile } from 'node:child_process';
import type { DivergenceEntry, DivergenceFile, DivergenceFileStatus } from '@agentmux/protocol';
import type { WorktreeManager, WorktreeRecord } from './worktree.js';

/**
 * Per-worktree git divergence (blueprint: "Divergence view" — ahead/behind
 * vs base, files touched, PR link). Read-only git probes against the same
 * worktrees the WorktreeManager owns; every session probes independently so
 * one wedged worktree degrades its own entry, never the panel.
 *
 * All git access goes through `execFile` with an argument array — never a
 * shell — matching the WorktreeManager's discipline.
 */

/** A hung git probe must not hang the panel. */
const GIT_TIMEOUT_MS = 15_000;

export interface DivergenceServiceOptions {
  /** The workspace — main checkout and the `.agentmux/worktrees` root. */
  readonly worktrees: WorktreeManager;
}

/** Where each probe runs: the workspace root owns branch refs; a worktree owns its own status. */
interface ProbeContext {
  /** Root of the main checkout — rev-list and diff run here (worktrees share its refs). */
  readonly workspaceRoot: string;
  /** The session's worktree — `git status` runs here. */
  readonly worktreePath: string;
}

export class DivergenceService {
  private readonly worktrees: WorktreeManager;

  constructor(options: DivergenceServiceOptions) {
    this.worktrees = options.worktrees;
  }

  /**
   * Divergence for every managed workspace — main checkout included —
   * sorted by session id. Boot reconciliation runs first so worktrees left
   * by a previous daemon are adopted (WorktreeManager.reconcile is
   * idempotent) rather than silently missing from the panel.
   */
  async list(): Promise<DivergenceEntry[]> {
    await this.worktrees.reconcile();
    const workspaceRoot = this.worktrees.workspaceRoot;
    const remoteSlug = await this.remoteGitHubSlug(workspaceRoot);
    const workspaceBranch = await this.workspaceBranch(workspaceRoot);
    const probes = this.worktrees
      .list()
      .map((record) =>
        probeRecord(
          record,
          { workspaceRoot, worktreePath: record.isMainCheckout ? workspaceRoot : record.path },
          (args, cwd) => this.git(args, cwd),
          { remoteSlug, workspaceBranch },
        ),
      );
    return Promise.all(probes);
  }

  private git(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`));
        },
      );
    });
  }

  /** GitHub `owner/repo` from `remote.origin.url`, or null when absent/not GitHub. */
  private async remoteGitHubSlug(workspaceRoot: string): Promise<string | null> {
    try {
      const remote = (
        await this.git(['config', '--get', 'remote.origin.url'], workspaceRoot)
      ).trim();
      return parseGitHubSlug(remote);
    } catch {
      return null;
    }
  }

  /** The main checkout's current branch — the compare base for every worktree PR link. */
  private async workspaceBranch(workspaceRoot: string): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot)).trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Divergence for one workspace record. Every failed probe becomes the
 * entry's `error` — never a rejected list().
 */
async function probeRecord(
  record: WorktreeRecord,
  context: ProbeContext,
  git: (args: string[], cwd: string) => Promise<string>,
  links: { remoteSlug: string | null; workspaceBranch: string | null },
): Promise<DivergenceEntry> {
  const entry: DivergenceEntry = {
    sessionId: record.sessionId,
    branch: record.branch,
    base: null,
    ahead: null,
    behind: null,
    files: [],
    prUrl: null,
    error: null,
  };
  try {
    if (record.isMainCheckout) {
      // The main checkout diverges from its upstream, when it has one.
      const upstream = await git(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        context.workspaceRoot,
      ).catch(() => null);
      if (upstream !== null) {
        entry.base = upstream.trim();
        const counts = await revListCounts(entry.base, 'HEAD', context.workspaceRoot, git);
        entry.behind = counts.behind;
        entry.ahead = counts.ahead;
      }
    } else if (record.branch !== null) {
      // The workspace root's HEAD is the base side (the branch point), the
      // worktree branch the compared side. Symmetric difference from the
      // merge base: left = base-side (behind), right = branch-side (ahead).
      entry.base = 'HEAD';
      const counts = await revListCounts('HEAD', record.branch, context.workspaceRoot, git);
      entry.behind = counts.behind;
      entry.ahead = counts.ahead;
      entry.files = await committedFiles(record.branch, context.workspaceRoot, git);
    }
    entry.files = [...entry.files, ...(await uncommittedFiles(context.worktreePath, git))];
    entry.prUrl = prCompareUrl(record.branch, links);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  return entry;
}

/** `git rev-list --left-right --count base...head` → { behind, ahead }. */
async function revListCounts(
  base: string,
  head: string,
  cwd: string,
  git: (args: string[], cwd: string) => Promise<string>,
): Promise<{ behind: number; ahead: number }> {
  const raw = await git(['rev-list', '--left-right', '--count', `${base}...${head}`], cwd);
  const parts = raw.trim().split(/\s+/);
  // Number(undefined) is NaN; the integer check turns a malformed response
  // into explicit zeros rather than NaN leaking into the panel.
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  return {
    behind: Number.isInteger(behind) ? behind : 0,
    ahead: Number.isInteger(ahead) ? ahead : 0,
  };
}

/** Files changed on `branch` since it diverged from the workspace HEAD. */
async function committedFiles(
  branch: string,
  workspaceRoot: string,
  git: (args: string[], cwd: string) => Promise<string>,
): Promise<DivergenceFile[]> {
  // -z: NUL-separated fields, safe for any filename. --no-renames keeps the
  // field layout two-wide (status, path) — a rename surfaces as delete+add.
  const raw = await git(
    ['diff', '--name-status', '-z', '--no-renames', `HEAD...${branch}`],
    workspaceRoot,
  );
  return parseNameStatus(raw);
}

/** Uncommitted working-tree changes, untracked included — files the agent touched but has not committed. */
async function uncommittedFiles(
  worktreePath: string,
  git: (args: string[], cwd: string) => Promise<string>,
): Promise<DivergenceFile[]> {
  const raw = await git(['status', '--porcelain', '-z'], worktreePath);
  const files: DivergenceFile[] = [];
  const fields = raw.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === '') continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    // Rename/copy porcelain entries carry the original path as an extra field.
    if (status.includes('R') || status.includes('C')) index += 1;
    files.push({ path: filePath, status: classifyUncommitted(status) });
  }
  return files;
}

function classifyUncommitted(status: string): DivergenceFileStatus {
  if (status.includes('?')) return 'uncommitted';
  if (status.includes('A') || status.includes('C')) return 'added';
  if (status.includes('D')) return 'deleted';
  return 'modified';
}

/** `git diff --name-status -z` → alternating `STATUS\0path\0` pairs. */
function parseNameStatus(raw: string): DivergenceFile[] {
  const files: DivergenceFile[] = [];
  const fields = raw.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (status === undefined || filePath === undefined || status === '' || filePath === '') {
      break; // trailing NUL
    }
    files.push({ path: filePath, status: classifyDiff(status) });
  }
  return files;
}

function classifyDiff(status: string): DivergenceFileStatus {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    default:
      // M (modified), T (typechange) and friends all read as modified.
      return 'modified';
  }
}

/**
 * The PR deep link: a GitHub remote plus a known base branch yields the
 * compare page pre-filled to open a PR from the session branch (an existing
 * open PR for the same head branch is offered on that page too). No
 * credentials, no API call — the daemon holds neither.
 */
function prCompareUrl(
  branch: string | null,
  links: { remoteSlug: string | null; workspaceBranch: string | null },
): string | null {
  const { remoteSlug, workspaceBranch } = links;
  if (remoteSlug === null || workspaceBranch === null || branch === null) {
    return null;
  }
  return `https://github.com/${remoteSlug}/compare/${workspaceBranch}...${branch}?expand=1`;
}

/**
 * `git@github.com:owner/repo.git`, `ssh://…/owner/repo.git`,
 * `https://github.com/owner/repo.git` → `owner/repo`; anything else → null.
 */
export function parseGitHubSlug(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const scpLike = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (scpLike !== null) {
    return `${scpLike[1]}/${scpLike[2]}`;
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') {
      return null;
    }
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    if (segments.length !== 2) {
      return null;
    }
    return `${segments[0]}/${segments[1]}`;
  } catch {
    return null;
  }
}
