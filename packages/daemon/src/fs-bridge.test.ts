import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsRoot } from '@agentmux/protocol';
import { FsBridge, lexicallyInside, splitSessionPath, type FsChangeEvent } from './fs-bridge.js';

const execFile = promisify(execFileCallback);

let workspaceRoot = '';
let bridge: FsBridge;

/**
 * The standard fixture: a tiny text project plus the adversaries — a binary
 * blob, node_modules, dist, and an .agentmux directory that search must skip.
 */
async function writeFixture(): Promise<void> {
  await Promise.all([
    fs.writeFile(path.join(workspaceRoot, 'README.md'), '# workspace\n'),
    fs.writeFile(
      path.join(workspaceRoot, 'src/auth.ts'),
      'export const token = "secret-value";\n// refresh logic\n',
    ),
    fs.writeFile(path.join(workspaceRoot, 'src/app.ts'), 'console.log("app");\n'),
    fs.writeFile(path.join(workspaceRoot, 'docs/notes.md'), '- routine note\n'),
  ]);
  await Promise.all([
    fs.writeFile(path.join(workspaceRoot, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3])),
    fs.writeFile(path.join(workspaceRoot, 'node_modules/pkg.js'), 'const TOKEN_KEY = "dep";\n'),
    fs.writeFile(path.join(workspaceRoot, 'dist/out.js'), 'const TOKEN_KEY = "built";\n'),
    fs.writeFile(
      path.join(workspaceRoot, '.agentmux/worktrees/s-2/secret.txt'),
      'sibling secret\n',
    ),
  ]);
}

async function freshBridge(): Promise<FsBridge> {
  const next = new FsBridge({ workspaceRoot });
  bridge = next;
  return next;
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-fs-'));
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'docs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'dist'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, '.agentmux/worktrees/s-2'), { recursive: true });
  await writeFixture();
  await freshBridge();
});

afterEach(async () => {
  await bridge.close();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('lexicallyInside', () => {
  it('accepts the root itself and children', () => {
    expect(lexicallyInside('/ws', '/ws')).toBe(true);
    expect(lexicallyInside('/ws', '/ws/src/auth.ts')).toBe(true);
  });

  it('rejects siblings and prefix impostors', () => {
    expect(lexicallyInside('/ws', '/etc')).toBe(false);
    expect(lexicallyInside('/ws', '/workspace/secret')).toBe(false);
  });
});

describe('splitSessionPath', () => {
  it('splits managed worktree paths into session-root views', () => {
    expect(splitSessionPath('.agentmux/worktrees/s-1/src/auth.ts')).toEqual({
      sessionId: 's-1',
      path: 'src/auth.ts',
    });
  });

  it('returns undefined for paths outside any session worktree', () => {
    expect(splitSessionPath('src/auth.ts')).toBeUndefined();
    expect(splitSessionPath('.agentmux/worktrees')).toBeUndefined();
    expect(splitSessionPath('.agentmux/worktrees/../etc')).toBeUndefined();
    expect(splitSessionPath('.agentmux/worktrees/..%2F..-weird/x')).toBeUndefined();
  });
});

describe('sandbox containment', () => {
  it('rejects `..` traversal on read and confirms the outside file is untouched', async () => {
    const outside = path.join(path.dirname(workspaceRoot), 'outside-secret.txt');
    await fs.writeFile(outside, 'do not leak\n');
    try {
      await expect(bridge.read('workspace', '../outside-secret.txt')).rejects.toMatchObject({
        code: 'E_SANDBOX',
      });
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('do not leak\n');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('rejects absolute paths that leave the root', async () => {
    await expect(bridge.read('workspace', '/etc/passwd')).rejects.toMatchObject({
      code: 'E_SANDBOX',
    });
  });

  it('rejects traversal hidden under an existing directory', async () => {
    await expect(bridge.read('workspace', 'src/../../outside.txt')).rejects.toMatchObject({
      code: 'E_SANDBOX',
    });
  });

  it('rejects `..` traversal on write and creates nothing outside', async () => {
    const outsidePath = path.join(path.dirname(workspaceRoot), 'planted.txt');
    await expect(
      bridge.write('workspace', '../planted.txt', 'pwned'),
    ).rejects.toMatchObject({ code: 'E_SANDBOX' });
    await expect(fs.stat(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects listing the parent directory', async () => {
    await expect(bridge.list('workspace', '..')).rejects.toMatchObject({ code: 'E_SANDBOX' });
  });

  it('refuses to read through a symlinked file pointing outside', async () => {
    await fs.symlink('/etc/passwd', path.join(workspaceRoot, 'passwd-link'));
    await expect(bridge.read('workspace', 'passwd-link')).rejects.toMatchObject({
      code: 'E_SANDBOX',
    });
  });

  it('refuses to read through a symlinked directory pointing outside', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-out-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside\n');
    await fs.symlink(outsideDir, path.join(workspaceRoot, 'dir-link'));
    try {
      await expect(bridge.read('workspace', 'dir-link/secret.txt')).rejects.toMatchObject({
        code: 'E_SANDBOX',
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses to write through a symlink whose target is inside the root', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'victim.txt'), 'original\n');
    await fs.symlink(
      path.join(workspaceRoot, 'victim.txt'),
      path.join(workspaceRoot, 'alias-link'),
    );
    await expect(
      bridge.write('workspace', 'alias-link', 'tampered'),
    ).rejects.toMatchObject({ code: 'E_SANDBOX' });
    await expect(fs.readFile(path.join(workspaceRoot, 'victim.txt'), 'utf8')).resolves.toBe(
      'original\n',
    );
  });

  it('keeps session roots inside their own worktree — no sibling reach-through', async () => {
    const s1 = path.join(workspaceRoot, '.agentmux/worktrees/s-1');
    await fs.mkdir(s1, { recursive: true });
    await expect(
      bridge.read('session:s-1', '../s-2/secret.txt'),
    ).rejects.toMatchObject({ code: 'E_SANDBOX' });
  });

  it('rejects malformed session root ids at the bridge', async () => {
    for (const root of ['session:..', 'session:', 'session:../etc'] as FsRoot[]) {
      await expect(
        bridge.dispatch({ op: 'list', root, path: '.' } as never),
      ).rejects.toMatchObject({ code: 'E_SANDBOX' });
    }
  });

  it('reports unknown session worktrees as not found', async () => {
    await expect(
      bridge.read('session:s-404', 'auth.ts'),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('serves files inside a session worktree when addressed through it', async () => {
    await fs.writeFile(
      path.join(workspaceRoot, '.agentmux/worktrees/s-2/src.ts'),
      'export const inside = true;\n',
    );
    await expect(bridge.read('session:s-2', 'src.ts')).resolves.toMatchObject({
      path: 'src.ts',
      content: 'export const inside = true;\n',
    });
  });
});

describe('atomic writes', () => {
  it('writes exact content and leaves no temp files behind', async () => {
    const content = 'line one\nline two — ünïcode ✓\n';
    const result = await bridge.write('workspace', 'src/written.ts', content);
    expect(result.path).toBe('src/written.ts');
    await expect(fs.readFile(path.join(workspaceRoot, 'src/written.ts'), 'utf8')).resolves.toBe(
      content,
    );
    const names = (await fs.readdir(path.join(workspaceRoot, 'src'))).filter((n) =>
      n.includes('.amx-tmp-'),
    );
    expect(names).toEqual([]);
  });

  it('concurrent writes to one path always leave a whole file', async () => {
    const payloads = Array.from({ length: 8 }, (_, i) => `payload-${i}-${'#'.repeat(2000)}\n`);
    await Promise.all(
      payloads.map((p) => bridge.write('workspace', 'concurrent.txt', p)),
    );
    const final = await fs.readFile(path.join(workspaceRoot, 'concurrent.txt'), 'utf8');
    expect(payloads).toContain(final); // never interleaved, never partial
    const leftovers = (await fs.readdir(workspaceRoot)).filter((n) =>
      n.includes('.amx-tmp-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('a failed write leaves no temp file behind', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'blocker'), 'a file, not a dir\n');
    await expect(
      bridge.write('workspace', 'blocker/inner.txt', 'nope'),
    ).rejects.toMatchObject({ code: 'E_IO' });
    const leftovers = (await fs.readdir(workspaceRoot)).filter((n) =>
      n.includes('.amx-tmp-'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('file operations', () => {
  it('lists directories first, then files, alphabetically, with root-relative paths', async () => {
    const entries = await bridge.list('workspace', '.');
    expect(entries.map((e) => e.path)).toEqual([
      '.agentmux',
      'dist',
      'docs',
      'node_modules',
      'src',
      'blob.bin',
      'README.md',
    ]);
    expect(entries.find((e) => e.path === 'README.md')).toMatchObject({
      type: 'file',
      size: '# workspace\n'.length,
    });
    expect(entries.find((e) => e.path === 'src')).toMatchObject({ type: 'dir' });
  });

  it('lists nested directories with composed relative paths', async () => {
    const entries = await bridge.list('workspace', 'src');
    expect(entries.map((e) => e.path).sort()).toEqual(['src/app.ts', 'src/auth.ts']);
  });

  it('round-trips read with size and mtime', async () => {
    const result = await bridge.read('workspace', 'src/auth.ts');
    expect(result.content).toContain('secret-value');
    expect(result.path).toBe('src/auth.ts');
    expect(result.size).toBe('export const token = "secret-value";\n// refresh logic\n'.length);
    expect(result.mtimeMs).toBeGreaterThan(0);
  });

  it('rejects reads of missing paths and directories', async () => {
    await expect(bridge.read('workspace', 'src/missing.ts')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    await expect(bridge.read('workspace', 'src')).rejects.toMatchObject({ code: 'E_IS_DIR' });
  });

  it('bounds read size', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'big.txt'), Buffer.alloc(6 * 1024 * 1024));
    await expect(bridge.read('workspace', 'big.txt')).rejects.toMatchObject({
      code: 'E_RANGE',
    });
  });

  it('mkdir is idempotent and mkdir over a file conflicts', async () => {
    await expect(bridge.mkdir('workspace', 'src')).resolves.toBe('src');
    await expect(bridge.mkdir('workspace', 'a/b/c')).resolves.toBe('a/b/c');
    await expect(fs.stat(path.join(workspaceRoot, 'a/b/c')).then((s) => s.isDirectory())).resolves.toBe(true);
    await expect(bridge.mkdir('workspace', 'README.md')).rejects.toMatchObject({
      code: 'E_EXISTS',
    });
  });

  it('mv renames within the root and refuses collisions', async () => {
    await expect(bridge.mv('workspace', 'src/app.ts', 'src/renamed.ts')).resolves.toBe(
      'src/renamed.ts',
    );
    await expect(fs.stat(path.join(workspaceRoot, 'src/app.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(bridge.mv('workspace', 'src/renamed.ts', 'README.md')).rejects.toMatchObject({
      code: 'E_EXISTS',
    });
    await expect(bridge.mv('workspace', 'src/missing.ts', 'src/other.ts')).rejects.toMatchObject({
      code: 'E_IO',
    });
  });

  it('rm removes files, requires recursive for directories, and rejects missing paths', async () => {
    await expect(bridge.rm('workspace', 'src/app.ts')).resolves.toBe('src/app.ts');
    await expect(bridge.rm('workspace', 'docs')).rejects.toMatchObject({ code: 'E_IS_DIR' });
    await expect(bridge.rm('workspace', 'docs', true)).resolves.toBe('docs');
    await expect(bridge.rm('workspace', 'docs')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('stat returns entry shape via lstat semantics', async () => {
    const info = await bridge.stat('workspace', 'src/auth.ts');
    expect(info).toMatchObject({ path: 'src/auth.ts', type: 'file' });
    expect(info.size).toBeGreaterThan(0);
    await fs.symlink('/etc/hostname', path.join(workspaceRoot, 'stat-link'));
    await expect(bridge.stat('workspace', 'stat-link')).resolves.toMatchObject({
      type: 'symlink',
    });
  });
});

describe('search', () => {
  it('finds case-insensitive matches with line numbers', async () => {
    const matches = await bridge.search('workspace', 'token = "secret');
    expect(matches).toEqual([
      expect.objectContaining({ path: 'src/auth.ts', line: 1 }),
    ]);
  });

  it('searches session worktrees independently of the workspace', async () => {
    await fs.writeFile(
      path.join(workspaceRoot, '.agentmux/worktrees/s-2/wt-file.txt'),
      'needle here\n',
    );
    const inSession = await bridge.search('session:s-2', 'needle');
    expect(inSession.map((m) => m.path)).toEqual(['wt-file.txt']);
    const inWorkspace = await bridge.search('workspace', 'needle');
    expect(inWorkspace).toEqual([]); // worktrees are excluded from the workspace sweep
  });

  it('skips excluded directories and binaries', async () => {
    const matches = await bridge.search('workspace', 'TOKEN_KEY');
    expect(matches).toEqual([]);
  });

  it('respects the match limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, `match-${i}.txt`),
        'findme\n'.repeat(i + 1),
      );
    }
    const matches = await bridge.search('workspace', 'findme', 3);
    expect(matches).toHaveLength(3);
  });
});

describe('watcher', () => {
  it('emits add and change events with root-relative paths', async () => {
    const events: FsChangeEvent[] = [];
    const stop = bridge.onChange((event) => events.push(event));
    try {
      // Let chokidar finish its initial scan first: a write landing mid-scan
      // is suppressed by ignoreInitial, and under CI load that scan can lag.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(path.join(workspaceRoot, 'watched.txt'), 'v1\n');
      await waitForCondition(() => events.some((e) => e.path === 'watched.txt' && e.type === 'add'));
      await fs.writeFile(path.join(workspaceRoot, 'watched.txt'), 'v2\n');
      await waitForCondition(() =>
        events.some((e) => e.path === 'watched.txt' && e.type === 'change'),
      );
    } finally {
      stop();
    }
  });

  it('stops relaying after unsubscribe', async () => {
    const events: FsChangeEvent[] = [];
    const stop = bridge.onChange((event) => events.push(event));
    stop();
    await fs.writeFile(path.join(workspaceRoot, 'after-unsub.txt'), 'ignored\n');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toEqual([]);
  });
});

/** The worktree manager drives the same layout the bridge keys session roots by. */
describe('worktree integration', () => {
  it(
    'serves a created worktree as a session root',
    { timeout: 60_000 },
    async () => {
      await execFile('git', ['init', '-b', 'main'], { cwd: workspaceRoot });
      await execFile('git', ['config', 'user.email', 'test@agentmux.local'], {
        cwd: workspaceRoot,
      });
      await execFile('git', ['config', 'user.name', 'agentmux test'], { cwd: workspaceRoot });
      await execFile('git', ['add', '-A'], { cwd: workspaceRoot });
      await execFile('git', ['commit', '-m', 'fixture'], { cwd: workspaceRoot });
      const { WorktreeManager } = await import('./worktree.js');
      const manager = new WorktreeManager({ workspaceRoot });
      const sessionId = `it-${randomBytes(4).toString('hex')}`;
      const info = await manager.create(sessionId);
      await expect(
        bridge.read(`session:${sessionId}` as FsRoot, 'src/auth.ts'),
      ).resolves.toMatchObject({ path: 'src/auth.ts' });
      await manager.remove(sessionId);
      await expect(
        bridge.read(`session:${sessionId}` as FsRoot, 'src/auth.ts'),
      ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
      expect(info.path).toContain(sessionId);
    },
  );
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitForCondition: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
