import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKTREE_DIR, WorktreeError, WorktreeManager, type WorktreeRecord } from './worktree.js';

/**
 * Lifecycle tests run real git against throwaway repos — worktree semantics
 * are exactly what git implements, so mocking the SCM would test the mock.
 */

const GIT_IDENTITY = ['-c', 'user.name=agentmux-test', '-c', 'user.email=test@agentmux.local'];

function gitIn(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_IDENTITY, ...args],
      { cwd: repo, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'agentmux-worktree-'));
  // A repo must have at least one commit before a worktree can branch from HEAD.
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  // Awaited in order — git init/add/commit race otherwise (a commit that runs
  // before add stages nothing, leaving a repo without HEAD).
  await gitIn(repo, ['init', '-q', '-b', 'main']);
  await gitIn(repo, ['add', '.']);
  await gitIn(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const managers: WorktreeManager[] = [];
const repos: string[] = [];

function makeManager(repo: string): WorktreeManager {
  const manager = new WorktreeManager({ workspaceRoot: repo });
  managers.push(manager);
  return manager;
}

beforeEach(async () => {
  repos.push(await tempRepo());
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.close();
  }
  for (const repo of repos.splice(0)) {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
});

function repo(): string {
  return repos[0] as string;
}

describe('WorktreeManager.create', () => {
  it('creates an isolated worktree on its own branch, inside the workspace root', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s1');

    expect(record.isMainCheckout).toBe(false);
    expect(record.branch).toBe('agentmux/s1');
    expect(record.path).toBe(join(repo(), WORKTREE_DIR, 's1'));
    await expect(exists(record.path)).resolves.toBe(true);
    expect((await gitIn(record.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(
      'agentmux/s1',
    );
    // The worktree starts at the same commit as the base.
    expect((await gitIn(record.path, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await gitIn(repo(), ['rev-parse', 'HEAD'])).trim(),
    );
  });

  it('is idempotent per session — a retried create returns the same record', async () => {
    const manager = makeManager(repo());
    const first = await manager.create('s1');
    const second = await manager.create('s1', { baseBranch: 'other' });
    expect(second).toEqual(first);
    expect(manager.list()).toHaveLength(1);
  });

  it('hands out the main checkout only on explicit opt-out', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s-main', { useMainCheckout: true });
    expect(record.path).toBe(repo());
    expect(record.isMainCheckout).toBe(true);
    // And it never creates a worktree directory for that session.
    await expect(exists(join(repo(), WORKTREE_DIR, 's-main'))).resolves.toBe(false);
  });

  it('rejects session ids that could smuggle paths or flags', async () => {
    const manager = makeManager(repo());
    for (const bad of ['../escape', '', 'a b', '.hidden', 'x'.repeat(65), 'sub/dir']) {
      await expect(manager.create(bad)).rejects.toMatchObject({ code: 'E_SESSION_ID' });
    }
  });

  it('refuses to overwrite an existing directory with a worktree', async () => {
    const manager = makeManager(repo());
    mkdirSync(join(repo(), WORKTREE_DIR), { recursive: true });
    writeFileSync(join(repo(), WORKTREE_DIR, 's1'), 'not a worktree', 'utf8');
    await expect(manager.create('s1')).rejects.toMatchObject({ code: 'E_EXISTS' });
  });

  it('reuses the session branch after a daemon restart (fresh manager, empty registry)', async () => {
    const first = makeManager(repo());
    await first.create('s1');
    first.close();

    const second = makeManager(repo());
    const record = await second.create('s1');
    expect(record.branch).toBe('agentmux/s1');
    await expect(exists(record.path)).resolves.toBe(true);
  });
});

describe('WorktreeManager.remove', () => {
  it('removes a clean worktree and its branch', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s1');
    await expect(manager.remove('s1')).resolves.toBe(true);
    await expect(exists(record.path)).resolves.toBe(false);
    await expect(
      gitIn(repo(), ['rev-parse', '--verify', '--quiet', 'refs/heads/agentmux/s1']),
    ).rejects.toThrow();
    expect(manager.get('s1')).toBeUndefined();
  });

  it('refuses to discard uncommitted work unless forced', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s1');
    writeFileSync(join(record.path, 'agent-output.txt'), 'uncommitted\n', 'utf8');

    await expect(manager.remove('s1')).rejects.toMatchObject({ code: 'E_DIRTY' });
    // The worktree and the work survive the refusal.
    await expect(exists(record.path)).resolves.toBe(true);
    await expect(readFile(join(record.path, 'agent-output.txt'), 'utf8')).resolves.toBe(
      'uncommitted\n',
    );

    await expect(manager.remove('s1', { force: true })).resolves.toBe(true);
    await expect(exists(record.path)).resolves.toBe(false);
  });

  it('refuses to discard unmerged commits unless forced', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s1');
    writeFileSync(join(record.path, 'committed.txt'), 'work\n', 'utf8');
    await gitIn(record.path, ['add', '.']);
    await gitIn(record.path, ['commit', '-q', '-m', 'session work']);

    await expect(manager.remove('s1')).rejects.toMatchObject({ code: 'E_UNMERGED' });
    await expect(exists(record.path)).resolves.toBe(true);

    // Merging the branch into the workspace HEAD makes removal safe.
    await gitIn(repo(), ['merge', '-q', '--no-ff', 'agentmux/s1', '-m', 'merge session']);
    await expect(manager.remove('s1')).resolves.toBe(true);
  });

  it('removes a main-checkout registration without touching the checkout', async () => {
    const manager = makeManager(repo());
    await manager.create('s-main', { useMainCheckout: true });
    await expect(manager.remove('s-main')).resolves.toBe(true);
    await expect(exists(repo())).resolves.toBe(true);
  });
});

describe('WorktreeManager.gc', () => {
  function oldEnough(record: WorktreeRecord): WorktreeRecord {
    // Age the record so the default staleness window does not protect it.
    record.createdAt = Date.now() - 48 * 60 * 60 * 1000;
    return record;
  }

  it('reclaims stale clean merged worktrees and reports them', async () => {
    const manager = makeManager(repo());
    oldEnough(await manager.create('s1'));
    const result = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(result.removed).toEqual(['s1']);
    expect(result.skipped).toEqual([]);
  });

  it('skips dirty worktrees and reports why', async () => {
    const manager = makeManager(repo());
    const record = oldEnough(await manager.create('s1'));
    writeFileSync(join(record.path, 'wip.txt'), 'wip\n', 'utf8');

    const result = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ sessionId: 's1', reason: 'dirty' }]);
    await expect(exists(record.path)).resolves.toBe(true);
  });

  it('skips worktrees with unmerged commits and reports why', async () => {
    const manager = makeManager(repo());
    const record = oldEnough(await manager.create('s1'));
    writeFileSync(join(record.path, 'done.txt'), 'work\n', 'utf8');
    await gitIn(record.path, ['add', '.']);
    await gitIn(record.path, ['commit', '-q', '-m', 'unmerged']);

    const result = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(result.skipped).toEqual([{ sessionId: 's1', reason: 'unmerged' }]);
    await expect(exists(record.path)).resolves.toBe(true);

    // Merged work becomes reclaimable.
    await gitIn(repo(), ['merge', '-q', '--no-ff', 'agentmux/s1', '-m', 'merge']);
    const second = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(second.removed).toEqual(['s1']);
  });

  it('force-collects dirty worktrees when the operator insists', async () => {
    const manager = makeManager(repo());
    const record = oldEnough(await manager.create('s1'));
    writeFileSync(join(record.path, 'wip.txt'), 'wip\n', 'utf8');

    const result = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000, force: true });
    expect(result.removed).toEqual(['s1']);
    expect(result.skipped).toEqual([]);
    await expect(exists(record.path)).resolves.toBe(false);
  });

  it('reclaims orphaned worktrees from a dead daemon — only when their work is safe', async () => {
    const first = makeManager(repo());
    const orphan = await first.create('s-orphan');
    first.close(); // the daemon "dies" without cleanup

    const second = makeManager(repo());
    const result = await second.gc({ maxAgeMs: 0, force: true });
    expect(result.removed).toEqual(['s-orphan']);
    await expect(exists(orphan.path)).resolves.toBe(false);
  });

  it('never touches worktrees still registered and fresh', async () => {
    const manager = makeManager(repo());
    const record = await manager.create('s1');
    const result = await manager.gc({ maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    await expect(exists(record.path)).resolves.toBe(true);
  });
});

describe('WorktreeManager.reconcile', () => {
  it('adopts worktrees left by a previous daemon so restarts never lose track', async () => {
    const first = makeManager(repo());
    const orphan = await first.create('s1');
    first.close();

    const second = makeManager(repo());
    expect(second.get('s1')).toBeUndefined();
    const adopted = await second.reconcile();
    expect(adopted.map((r) => r.sessionId)).toEqual(['s1']);
    expect(second.get('s1')?.path).toBe(orphan.path);
    expect(second.get('s1')?.isMainCheckout).toBe(false);
  });

  it('survives a repo with no managed worktrees', async () => {
    const manager = makeManager(repo());
    await expect(manager.reconcile()).resolves.toEqual([]);
  });
});

describe('WorktreeError', () => {
  it('carries a machine-readable code for the supervisor to branch on', () => {
    const error = new WorktreeError('E_NOT_FOUND', 'missing');
    expect(error.code).toBe('E_NOT_FOUND');
    expect(error.name).toBe('WorktreeError');
  });
});
