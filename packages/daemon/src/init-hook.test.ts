import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INIT_HOOK_RELATIVE_PATH, runInitHook, type InitHookOptions } from './init-hook.js';

/**
 * The init hook is a user-authored script executed by the daemon — the tests
 * pin the containment rules: opt-in, executable-bit required, bounded, stderr
 * surfaced, cwd at the provisioned root, env carrying the session identity.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentmux-init-'));
  dirs.push(dir);
  return dir;
}

function hookOptions(
  workspaceRoot: string,
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = 5_000,
): InitHookOptions {
  return { workspaceRoot, cwd, env, timeoutMs };
}

/** Writes a hook into the workspace's `.agentmux/` directory, executable by default. */
async function writeHook(workspaceRoot: string, body: string, executable = true): Promise<string> {
  const hookPath = path.join(workspaceRoot, INIT_HOOK_RELATIVE_PATH);
  await rm(hookPath, { force: true });
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(hookPath, body, 'utf8');
  await chmod(hookPath, executable ? 0o755 : 0o644);
  return hookPath;
}

describe('runInitHook', () => {
  it('runs nothing when the workspace defines no hook', async () => {
    const workspaceRoot = tempDir();
    await expect(runInitHook(hookOptions(workspaceRoot, workspaceRoot))).resolves.toEqual({
      ran: false,
    });
  });

  it('runs the hook with the session env and cwd at the provisioned root', async () => {
    const workspaceRoot = tempDir();
    const provisioned = path.join(workspaceRoot, 'provisioned-root');
    await mkdir(provisioned, { recursive: true });

    const observed = path.join(workspaceRoot, 'observed.env');
    await writeHook(
      workspaceRoot,
      [
        '#!/bin/sh',
        `printf 'runtime=%s\\n' "$AGENTMUX_RUNTIME" > "${observed}"`,
        `printf 'session=%s\\n' "$AGENTMUX_SESSION_ID" >> "${observed}"`,
        `printf 'workspace=%s\\n' "$AGENTMUX_WORKSPACE" >> "${observed}"`,
        `printf 'cwd=%s\\n' "$(pwd)" >> "${observed}"`,
        `printf 'custom=%s\\n' "$AGENTMUX_TEST_EXTRA" >> "${observed}"`,
      ].join('\n'),
    );

    await expect(
      runInitHook(
        hookOptions(workspaceRoot, provisioned, {
          AGENTMUX_RUNTIME: 'worktree',
          AGENTMUX_SESSION_ID: 's1',
          AGENTMUX_WORKSPACE: workspaceRoot,
          AGENTMUX_TEST_EXTRA: 'carried-through',
        }),
      ),
    ).resolves.toEqual({ ran: true });

    const contents = await readFile(observed, 'utf8');
    expect(contents).toContain('runtime=worktree');
    expect(contents).toContain('session=s1');
    expect(contents).toContain(`workspace=${workspaceRoot}`);
    expect(contents).toContain(`cwd=${provisioned}`);
    expect(contents).toContain('custom=carried-through');
  });

  it('resolves the hook from the workspace root even when run inside a worktree', async () => {
    const workspaceRoot = tempDir();
    // A decoy hook planted where an agent could write one — inside the
    // provisioned root — must never be the hook that executes.
    const provisioned = path.join(workspaceRoot, 'provisioned-root');
    await mkdir(path.join(provisioned, '.agentmux'), { recursive: true });
    await writeHook(provisioned, '#!/bin/sh\nexit 1\n');
    const marker = path.join(workspaceRoot, 'root-hook-ran');
    await writeHook(workspaceRoot, `#!/bin/sh\ntouch "${marker}"\n`);

    await expect(runInitHook(hookOptions(workspaceRoot, provisioned))).resolves.toEqual({
      ran: true,
    });
    await expect(stat(marker)).resolves.toBeTruthy();
  });

  it('fails the start with the hook stderr attached', async () => {
    const workspaceRoot = tempDir();
    await writeHook(
      workspaceRoot,
      '#!/bin/sh\necho "install failed:" >&2\necho "no space left on device" >&2\nexit 3\n',
    );
    await expect(runInitHook(hookOptions(workspaceRoot, workspaceRoot))).rejects.toMatchObject({
      name: 'InitHookError',
      code: 'E_FAILED',
    });
    await expect(runInitHook(hookOptions(workspaceRoot, workspaceRoot))).rejects.toThrowError(
      /no space left on device/,
    );
  });

  it('refuses a non-executable hook with the fix in the message', async () => {
    const workspaceRoot = tempDir();
    await writeHook(workspaceRoot, '#!/bin/sh\n', false);
    await expect(runInitHook(hookOptions(workspaceRoot, workspaceRoot))).rejects.toMatchObject({
      name: 'InitHookError',
      code: 'E_NOT_EXECUTABLE',
    });
    await expect(runInitHook(hookOptions(workspaceRoot, workspaceRoot))).rejects.toThrowError(
      /chmod \+x/,
    );
  });

  it('times out a hung hook instead of wedging the daemon', async () => {
    const workspaceRoot = tempDir();
    await writeHook(workspaceRoot, '#!/bin/sh\nsleep 30\n');
    await expect(
      runInitHook(hookOptions(workspaceRoot, workspaceRoot, {}, 300)),
    ).rejects.toMatchObject({ name: 'InitHookError', code: 'E_TIMEOUT' });
  }, 10_000);
});
