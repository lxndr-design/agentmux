// @vitest-environment node
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startDaemon, type DaemonHandle } from '@agentmux/daemon';
import { fileDiffPair, initialFilesState, useFilesStore } from '../state/filesStore.js';
import { getOrCreateFsClient, resetFsClientsForTests } from './useFsClient.js';

const execFile = promisify(execFileCallback);

// The FsClient targets the browser WebSocket global; the `ws` implementation
// exposes the same onopen/onmessage API and is what Node has (same shim the
// wsClient contract test uses).
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

/**
 * The file flow end-to-end against the REAL daemon over a real WebSocket:
 * temp repo fixture → daemon (bridge + worktrees) → gateway → FsClient →
 * filesStore. This is the open→edit→save→diff acceptance flow, headless;
 * the rendered flow is dogfooded separately in the browser.
 */

interface FsClientBoot {
  handle: DaemonHandle;
  port: number;
  token: string;
}

const daemons: DaemonHandle[] = [];

afterEach(async () => {
  resetFsClientsForTests();
  for (const handle of daemons.splice(0)) {
    await handle.close();
  }
});

async function tempGitWorkspace(): Promise<string> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentmux-fileflow-'));
  await writeFile(join(workspaceRoot, 'README.md'), 'hello\n');
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  // Same reason as the daemon fixtures: CI has no global git identity, so the
  // commit must carry one explicitly.
  await execFile(
    'git',
    [
      '-c',
      'user.name=agentmux-test',
      '-c',
      'user.email=test@agentmux.local',
      'commit',
      '-q',
      '-m',
      'init',
    ],
    { cwd: workspaceRoot },
  );
  return workspaceRoot;
}

async function boot(workspaceRoot: string): Promise<FsClientBoot> {
  const handle = await startDaemon({ port: 0, workspaceRoot });
  daemons.push(handle);
  return { handle, port: handle.address().port, token: handle.token };
}

const resetStore = () => {
  // Shallow-merge the initial state — a replace would wipe the store's
  // actions, which live outside the state object.
  useFilesStore.setState(initialFilesState);
};

describe('file flow against the real daemon', () => {
  beforeEach(() => {
    resetStore();
  });

  it('opens, edits, saves, and diffs a file through the bridge', async () => {
    const workspaceRoot = await tempGitWorkspace();
    const bootInfo = await boot(workspaceRoot);
    const client = getOrCreateFsClient(`ws://127.0.0.1:${bootInfo.port}`, bootInfo.token);
    const state = useFilesStore.getState();

    await state.setRoot(client, 'workspace');
    const rootListing = useFilesStore.getState().listings['workspace::.'];
    expect(rootListing?.map((entry) => entry.name)).toContain('README.md');

    await state.openFile(client, 'workspace', 'README.md');
    expect(useFilesStore.getState().file).toMatchObject({
      path: 'README.md',
      buffer: 'hello\n',
      saved: 'hello\n',
    });

    state.editBuffer('hello\nedited through the bridge\n');
    await state.saveFile(client);

    // The write landed on real disk inside the workspace.
    expect(await readFile(join(workspaceRoot, 'README.md'), 'utf8')).toBe(
      'hello\nedited through the bridge\n',
    );
    expect(fileDiffPair(useFilesStore.getState().file)).toEqual({
      before: 'hello\n',
      after: 'hello\nedited through the bridge\n',
    });
  });

  it('rejects sandbox escapes through the store with the error banner', async () => {
    const workspaceRoot = await tempGitWorkspace();
    const bootInfo = await boot(workspaceRoot);
    const client = getOrCreateFsClient(`ws://127.0.0.1:${bootInfo.port}`, bootInfo.token);

    await useFilesStore.getState().openFile(client, 'workspace', '../../../etc/passwd');

    expect(useFilesStore.getState().file).toBeNull();
    expect(useFilesStore.getState().error).toContain('passwd');
  });

  it(
    'receives fs_change and flags the open file as externally changed',
    { timeout: 15_000 },
    async () => {
      const workspaceRoot = await tempGitWorkspace();
      const bootInfo = await boot(workspaceRoot);
      const client = getOrCreateFsClient(`ws://127.0.0.1:${bootInfo.port}`, bootInfo.token);

      await useFilesStore.getState().openFile(client, 'workspace', 'README.md');
      useFilesStore.getState().editBuffer('local edit\n');

      // Wait out chokidar's initial scan, then write behind the editor.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(join(workspaceRoot, 'README.md'), 'an agent wrote this\n');

      // The FsClient's onFsChange wiring feeds the store; wait for the flag.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (useFilesStore.getState().file?.externalChanged === true) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(useFilesStore.getState().file?.externalChanged).toBe(true);
      // The local buffer was not clobbered.
      expect(useFilesStore.getState().file?.buffer).toBe('local edit\n');
    },
  );

  it('lists and writes through a session worktree root', async () => {
    const workspaceRoot = await tempGitWorkspace();
    const bootInfo = await boot(workspaceRoot);
    const client = getOrCreateFsClient(`ws://127.0.0.1:${bootInfo.port}`, bootInfo.token);
    const state = useFilesStore.getState();

    const worktree = await bootInfo.handle.worktrees.create('s-flow');
    await state.setRoot(client, 'session:s-flow');
    const worktreeListing = useFilesStore.getState().listings['session:s-flow::.'];
    expect(worktreeListing?.map((entry) => entry.name)).toContain('README.md');

    await state.openFile(client, 'session:s-flow', 'README.md');
    state.editBuffer('worktree edit\n');
    await state.saveFile(client);

    expect(await readFile(join(worktree.path, 'README.md'), 'utf8')).toBe('worktree edit\n');
    // The main checkout is untouched — worktree isolation held.
    expect(await readFile(join(workspaceRoot, 'README.md'), 'utf8')).toBe('hello\n');
  });
});
