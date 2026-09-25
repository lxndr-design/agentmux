// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { FsEntry, FsRequest, FsResult } from '@agentmux/protocol';
import {
  fileDiffPair,
  fileIsDirty,
  initialFilesState,
  useFilesStore,
  type FsRpc,
} from './filesStore.js';

/**
 * The file-flow state machine — open → edit → save → diff, the
 * external-change banner, and session-root change mapping — driven against
 * a stub RPC port. The same flow against the REAL daemon lives in
 * ws/fsClient.integration.test.ts.
 */

/** In-memory "bridge": the stub serves and mutates this map like disk. */
type FakeDisk = Record<string, string>;

function makeStub(disk: FakeDisk) {
  const writes: FsRequest[] = [];
  const client: FsRpc & { writes: FsRequest[] } = {
    writes,
    async request(request: FsRequest): Promise<FsResult> {
      if (request.op === 'list') {
        const dir = request.path === '.' ? '' : `${request.path}/`;
        const entries: FsEntry[] = Object.keys(disk)
          .filter((path) => path.startsWith(dir) && !path.slice(dir.length).includes('/'))
          .map((path) => ({
            path,
            name: path.slice(path.lastIndexOf('/') + 1) || path,
            type: 'file' as const,
            size: disk[path]?.length ?? 0,
            mtimeMs: 0,
          }));
        return { op: 'list', entries };
      }
      if (request.op === 'read') {
        const content = disk[request.path];
        if (content === undefined) {
          throw new Error(`ENOENT: ${request.path}`);
        }
        return {
          op: 'read',
          read: { path: request.path, content, size: content.length, mtimeMs: 0 },
        };
      }
      if (request.op === 'write') {
        writes.push(request);
        disk[request.path] = request.content;
        return {
          op: 'write',
          stat: { path: request.path, size: request.content.length, mtimeMs: 0 },
        };
      }
      throw new Error(`stub does not handle ${JSON.stringify(request)}`);
    },
  };
  return client;
}

const resetStore = () => {
  // Shallow-merge the initial state — a replace would wipe the store's
  // actions, which live outside the state object.
  useFilesStore.setState(initialFilesState);
};

describe('file-flow store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('loads the root listing on setRoot', async () => {
    const disk: FakeDisk = { 'README.md': 'hello\n' };
    const client = makeStub(disk);
    await useFilesStore.getState().setRoot(client, 'workspace');

    expect(useFilesStore.getState().expanded).toEqual(['.']);
    expect(useFilesStore.getState().listings['workspace::.']).toHaveLength(1);
  });

  it('runs open → edit → save → diff through the bridge port', async () => {
    const disk: FakeDisk = { 'README.md': 'hello\n' };
    const client = makeStub(disk);
    const state = useFilesStore.getState();

    await state.openFile(client, 'workspace', 'README.md');
    expect(useFilesStore.getState().file).toMatchObject({
      path: 'README.md',
      buffer: 'hello\n',
      saved: 'hello\n',
      externalChanged: false,
    });

    state.editBuffer('hello\nedited\n');
    expect(useFilesStore.getState().file?.buffer).toBe('hello\nedited\n');
    expect(fileIsDirty(useFilesStore.getState())).toBe(true);

    await useFilesStore.getState().saveFile(client);
    expect(useFilesStore.getState().file).toMatchObject({
      saved: 'hello\nedited\n',
      saving: false,
    });
    expect(disk['README.md']).toBe('hello\nedited\n');
    expect(client.writes).toEqual([
      { op: 'write', root: 'workspace', path: 'README.md', content: 'hello\nedited\n' },
    ]);

    const pair = fileDiffPair(useFilesStore.getState().file);
    expect(pair).toEqual({ before: 'hello\n', after: 'hello\nedited\n' });
    expect(fileIsDirty(useFilesStore.getState())).toBe(false);
  });

  it('surfaces failed opens in the error banner without clobbering state', async () => {
    const client = makeStub({});
    await useFilesStore.getState().openFile(client, 'workspace', 'missing.txt');

    expect(useFilesStore.getState().file).toBeNull();
    expect(useFilesStore.getState().error).toContain('missing.txt');
  });

  it('flags external changes for the open file and reloads on demand', async () => {
    const disk: FakeDisk = { 'README.md': 'v1\n' };
    const client = makeStub(disk);

    await useFilesStore.getState().openFile(client, 'workspace', 'README.md');
    useFilesStore.getState().editBuffer('v1\nlocal edit\n');

    // An agent wrote the file behind the editor.
    disk['README.md'] = 'v2 from an agent\n';
    useFilesStore.getState().noteFsChange(client, {
      type: 'fs_change',
      path: 'README.md',
      changeType: 'change',
      session: null,
    });
    expect(useFilesStore.getState().file?.externalChanged).toBe(true);
    // The banner never silently overwrites the buffer.
    expect(useFilesStore.getState().file?.buffer).toBe('v1\nlocal edit\n');

    await useFilesStore.getState().reloadFile(client);
    expect(useFilesStore.getState().file).toMatchObject({
      buffer: 'v2 from an agent\n',
      externalChanged: false,
    });
  });

  it('maps fs_change for session roots by sessionId and relative path', async () => {
    const disk: FakeDisk = { 'README.md': 'worktree copy\n' };
    const client = makeStub(disk);

    await useFilesStore.getState().openFile(client, 'session:s1', 'README.md');
    expect(useFilesStore.getState().file?.root).toBe('session:s1');

    // Same relative path but a different session's worktree — not ours.
    useFilesStore.getState().noteFsChange(client, {
      type: 'fs_change',
      path: '.agentmux/worktrees/s2/README.md',
      changeType: 'change',
      session: { sessionId: 's2', path: 'README.md' },
    });
    expect(useFilesStore.getState().file?.externalChanged).toBe(false);

    // Our session, our path — the banner applies.
    useFilesStore.getState().noteFsChange(client, {
      type: 'fs_change',
      path: '.agentmux/worktrees/s1/README.md',
      changeType: 'change',
      session: { sessionId: 's1', path: 'README.md' },
    });
    expect(useFilesStore.getState().file?.externalChanged).toBe(true);
  });

  it('refreshes expanded listings when a change touches their subtree', async () => {
    const disk: FakeDisk = { 'src/app.ts': 'export {}\n', 'README.md': 'hi\n' };
    const client = makeStub(disk);

    await useFilesStore.getState().setRoot(client, 'workspace');
    // Pretend src/ is expanded with a stale listing.
    useFilesStore.setState({
      expanded: ['.', 'src'],
      listings: { 'workspace::.': [], 'workspace::src': [] },
    });

    useFilesStore.getState().noteFsChange(client, {
      type: 'fs_change',
      path: 'src/app.ts',
      changeType: 'change',
      session: null,
    });
    // The stub re-lists synchronously — both touched listings are refetched.
    await Promise.resolve();
    expect(useFilesStore.getState().listings['workspace::src']).toHaveLength(1);
  });
});
