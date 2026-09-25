import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRuntime,
  LocalRuntime,
  resolveRuntimeId,
  RUNTIME_IDS,
  WorktreeRuntime,
  type Runtime,
  type RuntimeProvision,
} from './runtime.js';
import { WORKTREE_DIR, WorktreeManager } from './worktree.js';

/**
 * The runtime contract — the same suite against every `Runtime`
 * implementation, including an in-memory one with no git underneath. That
 * third runtime is the seam's proof: anything that passes here works against
 * a backend that shares nothing with the worktree manager, which is exactly
 * what a future SSH or Docker runtime must satisfy.
 *
 * The universal block holds for every runtime. Runtime-specific behavior —
 * worktree isolation, the local runtime's shared main checkout — is asserted
 * separately, because the contract is the intersection, not the union.
 */

const GIT_IDENTITY = ['-c', 'user.name=agentmux-test', '-c', 'user.email=test@agentmux.local'];

function gitIn(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_IDENTITY, ...args], { cwd: repo }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function tempRepo(): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-runtime-'));
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
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

/**
 * The in-memory second runtime: the same `Runtime` interface over a plain
 * directory map — no git, no WorktreeManager. It is the reference for what
 * the contract actually requires of a backend (and what it does not).
 */
class InMemoryRuntime implements Runtime {
  readonly id = 'in-memory';
  readonly workspaceRoot: string;
  private readonly homes = new Map<string, string>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async provision(request: { sessionId: string }): Promise<RuntimeProvision> {
    const existing = this.homes.get(request.sessionId);
    if (existing !== undefined) {
      return {
        sessionId: request.sessionId,
        runtime: this.id,
        cwd: existing,
        branch: null,
        reused: true,
      };
    }
    const cwd = path.join(this.workspaceRoot, request.sessionId);
    await mkdir(cwd, { recursive: true });
    this.homes.set(request.sessionId, cwd);
    return {
      sessionId: request.sessionId,
      runtime: this.id,
      cwd,
      branch: null,
      reused: false,
    };
  }

  env(): Record<string, string> {
    return { AGENTMUX_RUNTIME: this.id };
  }

  async release(sessionId: string): Promise<boolean> {
    const cwd = this.homes.get(sessionId);
    if (cwd === undefined) return false;
    await rm(cwd, { recursive: true, force: true });
    this.homes.delete(sessionId);
    return true;
  }
}

interface Harness {
  runtime: Runtime;
  cleanup(): Promise<void>;
  /** Repo root for runtimes that have one (the worktree/local backend). */
  repoRoot: string | undefined;
}

const harnesses: Array<{ name: string; make(): Promise<Harness> }> = [
  {
    name: 'worktree runtime',
    make: async () => {
      const repoRoot = await tempRepo();
      const manager = new WorktreeManager({ workspaceRoot: repoRoot });
      return {
        runtime: createRuntime('worktree', manager),
        repoRoot,
        cleanup: async () => {
          manager.close();
          await rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    },
  },
  {
    name: 'local runtime',
    make: async () => {
      const repoRoot = await tempRepo();
      const manager = new WorktreeManager({ workspaceRoot: repoRoot });
      return {
        runtime: createRuntime('local', manager),
        repoRoot,
        cleanup: async () => {
          manager.close();
          await rm(repoRoot, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    },
  },
  {
    name: 'in-memory runtime',
    make: async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'agentmux-inmemory-'));
      const runtime = new InMemoryRuntime(root);
      return {
        runtime,
        repoRoot: undefined,
        cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
      };
    },
  },
];

describe.each(harnesses)('runtime contract — $name', ({ make }) => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await make();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('provisions a workspace that exists on disk', async () => {
    const provision = await harness.runtime.provision({ sessionId: 's1' });
    expect(provision.cwd).toBeTruthy();
    expect(provision.runtime).toBe(harness.runtime.id);
    expect(await exists(provision.cwd)).toBe(true);
  });

  it('hands the same workspace back to the same session id — restart-into-workspace', async () => {
    const first = await harness.runtime.provision({ sessionId: 's1' });
    expect(first.reused).toBe(false);
    const second = await harness.runtime.provision({ sessionId: 's1' });
    expect(second.cwd).toBe(first.cwd);
    expect(second.reused).toBe(true);
  });

  it('exposes its id as AGENTMUX_RUNTIME in the session environment', () => {
    expect(harness.runtime.env()).toEqual({ AGENTMUX_RUNTIME: harness.runtime.id });
  });

  it('reports an unknown session as nothing to release', async () => {
    await expect(harness.runtime.release('never-provisioned')).resolves.toBe(false);
  });

  it('release then re-provision leaves a usable workspace', async () => {
    await harness.runtime.provision({ sessionId: 's1' });
    await expect(harness.runtime.release('s1')).resolves.toBe(true);
    const again = await harness.runtime.provision({ sessionId: 's1' });
    expect(await exists(again.cwd)).toBe(true);
  });
});

describe('runtime contract — worktree specifics', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await harnesses[0]!.make();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('isolates sessions into distinct worktrees on their own branches', async () => {
    const [first, second] = await Promise.all([
      harness.runtime.provision({ sessionId: 's1' }),
      harness.runtime.provision({ sessionId: 's2' }),
    ]);
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.branch).toBe('agentmux/s1');
    expect(second.branch).toBe('agentmux/s2');
    expect(first.cwd).toBe(path.join(harness.repoRoot!, WORKTREE_DIR, 's1'));
  });

  it('releases only clean, merged worktrees unless forced', async () => {
    const provision = await harness.runtime.provision({ sessionId: 's1' });
    await mkdir(path.join(provision.cwd, 'scratch'), { recursive: true });
    await writeFile(path.join(provision.cwd, 'scratch', 'wip.txt'), 'wip\n', 'utf8');
    await expect(harness.runtime.release('s1')).rejects.toMatchObject({ code: 'E_DIRTY' });
    await expect(exists(provision.cwd)).resolves.toBe(true);
    await expect(harness.runtime.release('s1', { force: true })).resolves.toBe(true);
  });
});

describe('runtime contract — local specifics', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await harnesses[1]!.make();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('serves the main checkout itself and says so', async () => {
    const provision = await harness.runtime.provision({ sessionId: 's1' });
    expect(provision.cwd).toBe(harness.runtime.workspaceRoot);
    expect(provision.warning).toMatch(/main checkout/i);
    expect(provision.branch).toBeTruthy();
  });

  it('releases without touching the main checkout', async () => {
    await harness.runtime.provision({ sessionId: 's1' });
    await expect(harness.runtime.release('s1')).resolves.toBe(true);
    await expect(exists(harness.runtime.workspaceRoot)).resolves.toBe(true);
  });
});

describe('runtime registry', () => {
  it('defaults to worktree and resolves both v1 ids', () => {
    expect(resolveRuntimeId()).toBe('worktree');
    expect(resolveRuntimeId('worktree')).toBe('worktree');
    expect(resolveRuntimeId('local')).toBe('local');
  });

  it('refuses unknown ids with the v2 plan named', () => {
    expect(() => resolveRuntimeId('ssh')).toThrowError(
      /SSH and Docker runtimes are planned for v2/,
    );
    expect(() => resolveRuntimeId('worktrees')).toThrowError(/v1 ships/);
  });

  it('keeps the WorktreeRuntime and LocalRuntime distinct implementations', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'agentmux-registry-'));
    try {
      const manager = new WorktreeManager({ workspaceRoot: repo });
      expect(createRuntime('worktree', manager)).toBeInstanceOf(WorktreeRuntime);
      expect(createRuntime('local', manager)).toBeInstanceOf(LocalRuntime);
      expect(RUNTIME_IDS).toEqual(['worktree', 'local']);
      manager.close();
    } finally {
      rm(repo, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
