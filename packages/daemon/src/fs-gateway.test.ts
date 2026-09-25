import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { serverMessageSchema, type ServerMessage } from './wire.js';

const execFile = promisify(execFileCallback);

/**
 * End-to-end filesystem RPC: temp git workspace → real daemon → gateway →
 * FsBridge, over an authenticated WebSocket — the same path the browser
 * takes, minus the DOM.
 */

const openDaemons: DaemonHandle[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  for (const handle of openDaemons.splice(0)) {
    await handle.close();
  }
});

async function tempGitWorkspace(): Promise<string> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agentmux-fs-gateway-'));
  await writeFile(join(workspaceRoot, 'README.md'), 'hello\n');
  await execFile('git', ['init', '-q', '-b', 'main'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-q', '-m', 'init'], { cwd: workspaceRoot });
  return workspaceRoot;
}

type Waiter = {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  timer: NodeJS.Timeout;
};

/** One authenticated gateway connection with request-id correlation. */
class FsWsClient {
  private readonly waiters: Waiter[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = serverMessageSchema.parse(JSON.parse(String(data)));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters[index]!;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  static open(port: number, token: string): Promise<FsWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      ws.on('error', reject);
      ws.on('open', () => {
        const client = new FsWsClient(ws);
        openSockets.push(ws);
        resolve(client);
      });
    });
  }

  request(request: unknown): Promise<ServerMessage> {
    const requestId = `req-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: 'fs_request', requestId, request }));
    return this.waitFor(
      (message) =>
        (message.type === 'fs_result' || message.type === 'fs_error') &&
        message.requestId === requestId,
      `fs response for ${String((request as { op?: string }).op ?? request)}`,
    );
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }
}

async function boot(workspaceRoot: string): Promise<{ handle: DaemonHandle; client: FsWsClient }> {
  const handle = await startDaemon({ port: 0, workspaceRoot });
  openDaemons.push(handle);
  const client = await FsWsClient.open(handle.address().port, handle.token);
  return { handle, client };
}

describe('filesystem RPC over the gateway', () => {
  it('round-trips list → read → write → read through the real daemon', async () => {
    const { client } = await boot(await tempGitWorkspace());

    const listed = await client.request({ op: 'list', root: 'workspace', path: '.' });
    expect(listed.type).toBe('fs_result');
    if (listed.type !== 'fs_result') return;
    // The bridge reports every entry (dotdirs included — hiding is a
    // FileTreePane concern); the fixture repo holds .git and README.md.
    expect(listed.result).toMatchObject({ op: 'list' });
    expect(listed.result.entries.map((entry) => entry.path).sort()).toEqual(['.git', 'README.md']);

    const read = await client.request({ op: 'read', root: 'workspace', path: 'README.md' });
    if (read.type !== 'fs_result') {
      throw new Error(`read failed: ${JSON.stringify(read)}`);
    }
    expect(read.result.op).toBe('read');
    expect(read.result).toMatchObject({ read: { content: 'hello\n' } });

    const written = await client.request({
      op: 'write',
      root: 'workspace',
      path: 'src/new.ts',
      content: 'export {};\n',
    });
    if (written.type !== 'fs_result') {
      throw new Error(`write failed: ${JSON.stringify(written)}`);
    }
    expect(written.result.op).toBe('write');
    expect(written.result).toMatchObject({ stat: { path: 'src/new.ts' } });

    const readBack = await client.request({ op: 'read', root: 'workspace', path: 'src/new.ts' });
    if (readBack.type !== 'fs_result') {
      throw new Error(`re-read failed: ${JSON.stringify(readBack)}`);
    }
    expect(readBack.result.op).toBe('read');
    expect(readBack.result).toMatchObject({ read: { content: 'export {};\n' } });
  });

  it('answers sandbox escapes and malformed requests with fs_error', async () => {
    const { client } = await boot(await tempGitWorkspace());

    const escape = await client.request({
      op: 'read',
      root: 'workspace',
      path: '../../../etc/passwd',
    });
    expect(escape.type).toBe('fs_error');
    if (escape.type === 'fs_error') {
      expect(escape.error.code).toBe('E_SANDBOX');
    }

    // A request the wire schema rejects never reaches the bridge; the
    // connection stays alive and answers with a protocol error message.
    client.request({ op: 'detonate' });
    const unknownOp = await client.waitFor(
      (message) => message.type === 'error',
      'protocol error',
    );
    expect(unknownOp.type).toBe('error');
  });

  it('broadcasts fs_change to every open connection when a write lands', async () => {
    const workspaceRoot = await tempGitWorkspace();
    const { handle } = await boot(workspaceRoot);
    const observer = await FsWsClient.open(handle.address().port, handle.token);

    // Wait out chokidar's initial scan — a change landing mid-scan is
    // suppressed by design, and the test would race it otherwise.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const changePromise = observer.waitFor(
      (message) => message.type === 'fs_change' && message.path === 'watched.txt',
      'fs_change broadcast',
    );
    await writeFile(join(workspaceRoot, 'watched.txt'), 'v1\n');
    const change = await changePromise;

    expect(change.type).toBe('fs_change');
    if (change.type === 'fs_change') {
      expect(change.changeType).toBe('add');
      expect(change.session).toBeNull(); // outside any session worktree
    }
  });

  it('reports session-root paths in fs_change when a worktree file changes', async () => {
    const workspaceRoot = await tempGitWorkspace();
    const { handle } = await boot(workspaceRoot);
    const created = await handle.worktrees.create('s-change');
    const observer = await FsWsClient.open(handle.address().port, handle.token);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const changePromise = observer.waitFor(
      (message) =>
        message.type === 'fs_change' &&
        message.session !== null &&
        message.session.sessionId === 's-change',
      'fs_change with session view',
    );
    await writeFile(join(created.path, 'inside.ts'), 'new\n');
    const change = await changePromise;

    expect(change.type).toBe('fs_change');
    if (change.type === 'fs_change') {
      expect(change.path).toBe('.agentmux/worktrees/s-change/inside.ts');
      expect(change.session).toEqual({ sessionId: 's-change', path: 'inside.ts' });
    }
  });
});
