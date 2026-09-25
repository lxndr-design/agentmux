import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type {
  FsEntry,
  FsReadResult,
  FsRequest,
  FsResult,
  FsRoot,
  FsSearchMatch,
  FsStat,
  FsWriteResult,
} from '@agentmux/protocol';
import { SESSION_ID_PATTERN, WORKTREE_DIR } from './worktree.js';

/**
 * The host FS bridge (blueprint: "A bridge, not a bypass") — the one door
 * between UI panes and the workspace on disk.
 *
 * Sandbox rules, enforced HERE, not in the UI (defense in depth):
 * - Every path is resolved against the addressed root; anything that lands
 *   outside it — via `..`, an absolute path, or a symlink pointing out — is
 *   rejected with E_SANDBOX before a single byte moves.
 * - Writes never follow a symlink at the target path, so a malicious tree
 *   cannot turn an "edit inside the workspace" into a write elsewhere.
 * - Writes are atomic (sibling temp file + rename): a reader — a pane, a
 *   diff, an agent — sees the old file or the new one, never a partial one.
 *
 * Roots: `workspace` is the main checkout; `session:<id>` is that agent's
 * worktree under `.agentmux/worktrees/<id>` (the layout lives here, not in
 * the UI — panes address a root id, never a host path).
 */

export type FsBridgeErrorCode =
  'E_SANDBOX' | 'E_NOT_FOUND' | 'E_EXISTS' | 'E_IS_DIR' | 'E_NOT_DIR' | 'E_RANGE' | 'E_IO';

export class FsBridgeError extends Error {
  constructor(
    readonly code: FsBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FsBridgeError';
  }
}

/** Reads and writes are bounded — the bridge is not a file-transfer channel. */
const MAX_TRANSFER_BYTES = 5 * 1024 * 1024;
/** Search skips files beyond this size — grep discipline, not full-text indexing. */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Search visits at most this many files per query, then reports what it found. */
const MAX_SEARCH_FILES = 4000;

const SEARCH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.agentmux',
  'node_modules',
  'dist',
]);

export interface FsBridgeOptions {
  workspaceRoot: string;
}

export type FsChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FsChangeEvent {
  type: FsChangeType;
  /** Workspace-root-relative path — the watcher watches the whole workspace. */
  path: string;
}

/** True when `candidate` is `root` itself or strictly under it. */
export function lexicallyInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root + path.sep);
}

/**
 * Split a workspace-relative watched path into a session-root view, if the
 * path lives inside a managed worktree. Lets consumers address change events
 * with the same root ids the bridge serves.
 */
export function splitSessionPath(relPath: string): { sessionId: string; path: string } | undefined {
  const prefix = WORKTREE_DIR + path.sep;
  if (!relPath.startsWith(prefix)) {
    return undefined;
  }
  const rest = relPath.slice(prefix.length);
  const sep = rest.indexOf(path.sep);
  if (sep < 0) {
    return undefined; // the worktrees directory itself
  }
  const sessionId = rest.slice(0, sep);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return undefined;
  }
  return { sessionId, path: rest.slice(sep + 1) };
}

export class FsBridge {
  private readonly root: string;
  private readonly rootRealCache = new Map<string, Promise<string>>();
  private watcher: FSWatcher | undefined;
  private readonly changeSubscribers = new Set<(event: FsChangeEvent) => void>();

  constructor(options: FsBridgeOptions) {
    this.root = path.resolve(options.workspaceRoot);
  }

  /**
   * Single dispatch entry — the gateway hands a validated FsRequest here and
   * mirrors the result/error back over the wire.
   */
  dispatch(request: FsRequest): Promise<FsResult> {
    switch (request.op) {
      case 'list':
        return this.list(request.root, request.path).then((entries) => ({ op: 'list', entries }));
      case 'read':
        return this.read(request.root, request.path).then((read) => ({ op: 'read', read }));
      case 'write':
        return this.write(request.root, request.path, request.content).then((stat_) => ({
          op: 'write',
          stat: stat_,
        }));
      case 'mkdir':
        return this.mkdir(request.root, request.path).then((p) => ({ op: 'mkdir', path: p }));
      case 'mv':
        return this.mv(request.root, request.from, request.to).then((p) => ({ op: 'mv', path: p }));
      case 'rm':
        return this.rm(request.root, request.path, request.recursive).then((p) => ({
          op: 'rm',
          path: p,
        }));
      case 'stat':
        return this.stat(request.root, request.path).then((stat_) => ({ op: 'stat', stat: stat_ }));
      case 'search':
        return this.search(request.root, request.query, request.limit).then((matches) => ({
          op: 'search',
          matches,
        }));
    }
  }

  /**
   * List one directory. Entries are directories-first, then alphabetical —
   * the shape a file tree wants. `path` fields are relative to the root, so
   * the UI can feed them straight back into other bridge calls.
   */
  async list(rootId: FsRoot, relPath: string): Promise<FsEntry[]> {
    const { abs: dirAbs, realRoot } = await this.contain(rootId, relPath);
    const info = await statSafe(dirAbs);
    if (info === undefined) {
      throw new FsBridgeError('E_NOT_FOUND', `"${relPath}" does not exist in ${rootId}`);
    }
    if (!info.isDirectory()) {
      throw new FsBridgeError('E_NOT_DIR', `"${relPath}" is not a directory`);
    }
    const dirents = await readdir(dirAbs, { withFileTypes: true });
    const listed = await Promise.all(
      dirents.map(async (dirent): Promise<FsEntry | undefined> => {
        try {
          const childAbs = path.join(dirAbs, dirent.name);
          const link = await lstat(childAbs);
          const type = link.isSymbolicLink() ? 'symlink' : link.isDirectory() ? 'dir' : 'file';
          return {
            name: dirent.name,
            path: path.relative(realRoot, childAbs),
            type,
            mtimeMs: Number(link.mtimeMs),
            ...(type === 'file' ? { size: link.size } : {}),
          };
        } catch {
          // The entry vanished between readdir and lstat — a routine race in
          // a live workspace; listing what survived is the honest answer.
          return undefined;
        }
      }),
    );
    return listed
      .filter((entry): entry is FsEntry => entry !== undefined)
      .sort((a, b) => {
        if (a.type !== b.type && (a.type === 'dir' || b.type === 'dir')) {
          return a.type === 'dir' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }

  async read(rootId: FsRoot, relPath: string): Promise<FsReadResult> {
    const { abs, realRoot } = await this.contain(rootId, relPath);
    const info = await statSafe(abs);
    if (info === undefined) {
      throw new FsBridgeError('E_NOT_FOUND', `"${relPath}" does not exist in ${rootId}`);
    }
    if (info.isDirectory()) {
      throw new FsBridgeError('E_IS_DIR', `"${relPath}" is a directory`);
    }
    if (info.size > MAX_TRANSFER_BYTES) {
      throw new FsBridgeError(
        'E_RANGE',
        `"${relPath}" is ${info.size} bytes — the bridge reads at most ${MAX_TRANSFER_BYTES}`,
      );
    }
    const content = await readFile(abs, 'utf8');
    return {
      path: path.relative(realRoot, abs),
      content,
      size: info.size,
      mtimeMs: Number(info.mtimeMs),
    };
  }

  /**
   * Atomic write (temp sibling + rename), creating parent directories as
   * needed — both happen inside the sandbox after containment is proven.
   * Any filesystem failure is surfaced as a typed bridge error — an unwrapped
   * errno would leak system internals through the wire protocol.
   */
  async write(rootId: FsRoot, relPath: string, content: string): Promise<FsWriteResult> {
    if (content.length > MAX_TRANSFER_BYTES) {
      throw new FsBridgeError(
        'E_RANGE',
        `write exceeds the ${MAX_TRANSFER_BYTES}-byte bridge limit`,
      );
    }
    const { abs, realRoot } = await this.contain(rootId, relPath, { forWrite: true });
    // Sibling temp file: same directory guarantees the same filesystem, so
    // the final rename is atomic.
    const temp = path.join(
      path.dirname(abs),
      `.${path.basename(abs)}.amx-tmp-${randomBytes(6).toString('hex')}`,
    );
    try {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(temp, content, 'utf8');
      await rename(temp, abs);
    } catch (error) {
      // Best-effort temp cleanup; the write error is the one that matters.
      await unlink(temp).catch(() => undefined);
      if (error instanceof FsBridgeError) {
        throw error;
      }
      throw new FsBridgeError('E_IO', `write "${relPath}" failed: ${(error as Error).message}`);
    }
    const info = await stat(abs);
    return {
      path: path.relative(realRoot, abs),
      size: info.size,
      mtimeMs: Number(info.mtimeMs),
    };
  }

  /** Recursive mkdir with POSIX `mkdir -p` semantics (existing dir = success). */
  async mkdir(rootId: FsRoot, relPath: string): Promise<string> {
    const { abs, realRoot } = await this.contain(rootId, relPath, { forWrite: true });
    const info = await statSafe(abs);
    if (info !== undefined) {
      if (info.isDirectory()) {
        return path.relative(realRoot, abs); // mkdir -p semantics
      }
      throw new FsBridgeError('E_EXISTS', `"${relPath}" already exists and is not a directory`);
    }
    try {
      await mkdir(abs, { recursive: true });
    } catch (error) {
      throw new FsBridgeError('E_IO', `mkdir "${relPath}" failed: ${(error as Error).message}`);
    }
    return path.relative(realRoot, abs);
  }

  /**
   * Rename within the addressed root. Collisions are refused — a UI move
   * silently overwriting a file is a data-loss bug, not a convenience.
   */
  async mv(rootId: FsRoot, fromRel: string, toRel: string): Promise<string> {
    const from = await this.contain(rootId, fromRel);
    const to = await this.contain(rootId, toRel, { forWrite: true });
    const toInfo = await statSafe(to.abs);
    if (toInfo !== undefined) {
      throw new FsBridgeError('E_EXISTS', `"${toRel}" already exists`);
    }
    try {
      await rename(from.abs, to.abs);
    } catch (error) {
      throw new FsBridgeError(
        'E_IO',
        `rename ${fromRel} → ${toRel} failed: ${(error as Error).message}`,
      );
    }
    return toRel;
  }

  async rm(rootId: FsRoot, relPath: string, recursive?: boolean): Promise<string> {
    const target = await this.contain(rootId, relPath, { forWrite: true });
    const info = await statSafe(target.abs);
    if (info === undefined) {
      throw new FsBridgeError('E_NOT_FOUND', `"${relPath}" does not exist in ${rootId}`);
    }
    try {
      await rm(target.abs, { recursive: recursive === true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_FS_EISDIR') {
        throw new FsBridgeError(
          'E_IS_DIR',
          `"${relPath}" is a directory — pass recursive to remove it`,
        );
      }
      throw new FsBridgeError('E_IO', `rm "${relPath}" failed: ${(error as Error).message}`);
    }
    return relPath;
  }

  async stat(rootId: FsRoot, relPath: string): Promise<FsStat> {
    const { abs, realRoot } = await this.containLexical(rootId, relPath);
    const link = await lstat(abs).catch(() => undefined);
    if (link === undefined) {
      throw new FsBridgeError('E_NOT_FOUND', `"${relPath}" does not exist in ${rootId}`);
    }
    return {
      path: path.relative(realRoot, abs),
      type: link.isSymbolicLink() ? 'symlink' : link.isDirectory() ? 'dir' : 'file',
      size: link.size,
      mtimeMs: Number(link.mtimeMs),
    };
  }

  /**
   * Case-insensitive substring search across the root's text files, skipping
   * `.git`/`node_modules`/`dist`/`.agentmux` and binaries. Stops at `limit`
   * matches (default 50) or the file cap; a huge tree therefore reports a
   * prefix of its matches rather than an error.
   */
  async search(rootId: FsRoot, query: string, limit?: number): Promise<FsSearchMatch[]> {
    const { abs: startDir, realRoot } = await this.contain(rootId, '.');
    const cap = limit ?? 50;
    const needle = query.toLowerCase();
    const matches: FsSearchMatch[] = [];
    let visited = 0;
    const walk = async (dirAbs: string): Promise<void> => {
      if (matches.length >= cap || visited >= MAX_SEARCH_FILES) {
        return;
      }
      const dirents = await readdir(dirAbs, { withFileTypes: true });
      for (const dirent of dirents) {
        if (matches.length >= cap || visited >= MAX_SEARCH_FILES) {
          return;
        }
        const childAbs = path.join(dirAbs, dirent.name);
        if (dirent.isDirectory()) {
          if (!SEARCH_EXCLUDED_DIRS.has(dirent.name)) {
            await walk(childAbs);
          }
        } else if (dirent.isFile()) {
          visited += 1;
          const hit = await searchFile(childAbs, needle);
          if (hit !== undefined) {
            matches.push({ path: path.relative(realRoot, childAbs), ...hit });
          }
        }
      }
    };
    await walk(startDir);
    return matches;
  }

  /**
   * Watch the whole workspace (worktrees included — they live inside it) and
   * relay normalized change events. One chokidar instance per bridge,
   * reference-counted by subscribers; events are workspace-root-relative.
   */
  onChange(callback: (event: FsChangeEvent) => void): () => void {
    this.ensureWatcher();
    this.changeSubscribers.add(callback);
    return () => {
      this.changeSubscribers.delete(callback);
    };
  }

  async close(): Promise<void> {
    if (this.watcher !== undefined) {
      const watcher = this.watcher;
      this.watcher = undefined;
      await watcher.close();
    }
  }

  private ensureWatcher(): FSWatcher {
    if (this.watcher === undefined) {
      this.watcher = watch(this.root, {
        ignoreInitial: true,
        depth: 20,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: ['**/.git/**', '**/node_modules/**'],
      });
      const relay =
        (type: FsChangeType) =>
        (absPath: string): void => {
          const event: FsChangeEvent = { type, path: path.relative(this.root, absPath) };
          for (const callback of this.changeSubscribers) {
            callback(event);
          }
        };
      this.watcher.on('add', relay('add'));
      this.watcher.on('change', relay('change'));
      this.watcher.on('unlink', relay('unlink'));
      this.watcher.on('addDir', relay('addDir'));
      this.watcher.on('unlinkDir', relay('unlinkDir'));
      this.watcher.on('error', (error) => {
        console.error('fs-bridge watcher error:', error);
      });
    }
    return this.watcher;
  }

  /**
   * Resolve a root id to its absolute directory, then prove `relPath` stays
   * inside it — lexically first (cheap, kills `..` before any fs touch),
   * then by realpath: walk up to the deepest EXISTING ancestor (only existing
   * segments can hide a symlink), realpath it, and reject escapes. The
   * non-existent tail is appended back lexically — it cannot be a symlink.
   *
   * The containment bound is the ADDRESSED root's realpath, not the
   * workspace's: a session worktree may not reach a sibling worktree via
   * `..` any more than it may leave the workspace. `realRoot` is that
   * resolved root, so every relative path the bridge returns is relative to
   * the root the caller addressed and round-trips into the next request.
   */
  private async contain(
    rootId: FsRoot,
    relPath: string,
    opts: { forWrite?: boolean } = {},
  ): Promise<{ abs: string; realRoot: string }> {
    const rootAbs = await this.resolveRoot(rootId);
    const target = path.resolve(rootAbs, relPath);
    if (!lexicallyInside(rootAbs, target)) {
      throw new FsBridgeError('E_SANDBOX', `"${relPath}" resolves outside ${rootId}`);
    }
    // "Writes never follow a symlink at the target path": lstat the LEXICAL
    // path — a link whose target is also inside the root must still be
    // refused for writes, because the caller addressed the link, not the
    // file it points at.
    if (opts.forWrite === true) {
      const link = await lstat(target).catch(() => undefined);
      if (link?.isSymbolicLink()) {
        throw new FsBridgeError(
          'E_SANDBOX',
          `"${relPath}" is a symlink — refusing to write through it`,
        );
      }
    }
    let probe = target;
    const missing: string[] = [];
    for (;;) {
      const info = await statSafe(probe);
      if (info !== undefined) {
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new FsBridgeError('E_NOT_FOUND', `root "${rootId}" does not exist on disk`);
      }
      missing.push(path.basename(probe));
      probe = parent;
    }
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      throw new FsBridgeError('E_IO', `cannot resolve "${relPath}": ${(error as Error).message}`);
    }
    const realRoot = await this.realRootPath(rootId, rootAbs);
    if (!lexicallyInside(realRoot, real)) {
      throw new FsBridgeError('E_SANDBOX', `"${relPath}" escapes ${rootId} through a symlink`);
    }
    const abs = missing.length === 0 ? real : path.join(real, ...missing.reverse());
    return { abs, realRoot };
  }

  /**
   * Lexical-only containment for metadata operations that must describe the
   * entry as it stands on disk — `stat` reports a symlink AS a symlink
   * (lstat semantics) instead of resolving or refusing it. Traversal outside
   * the root is still rejected; a symlink's own metadata cannot leak
   * anything it does not already display.
   */
  private async containLexical(
    rootId: FsRoot,
    relPath: string,
  ): Promise<{ abs: string; realRoot: string }> {
    const rootAbs = await this.resolveRoot(rootId);
    const abs = path.resolve(rootAbs, relPath);
    if (!lexicallyInside(rootAbs, abs)) {
      throw new FsBridgeError('E_SANDBOX', `"${relPath}" resolves outside ${rootId}`);
    }
    return { abs, realRoot: await this.realRootPath(rootId, rootAbs) };
  }

  private async resolveRoot(rootId: FsRoot): Promise<string> {
    if (rootId === 'workspace') {
      return this.root;
    }
    const sessionId = rootId.slice('session:'.length);
    // The wire schema validates the shape; this guards direct library callers.
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new FsBridgeError('E_SANDBOX', `invalid session root "${rootId}"`);
    }
    const sessionRoot = path.join(this.root, WORKTREE_DIR, sessionId);
    const info = await statSafe(sessionRoot);
    if (info === undefined || !info.isDirectory()) {
      throw new FsBridgeError('E_NOT_FOUND', `no worktree for session "${sessionId}"`);
    }
    return sessionRoot;
  }

  /** The addressed root's realpath, cached per root id (failure is retryable). */
  private realRootPath(rootId: FsRoot, rootAbs: string): Promise<string> {
    let cached = this.rootRealCache.get(rootId);
    if (cached === undefined) {
      cached = realpath(rootAbs).catch((error: unknown) => {
        this.rootRealCache.delete(rootId);
        throw new FsBridgeError(
          'E_IO',
          `root "${rootId}" is inaccessible: ${(error as Error).message}`,
        );
      });
      this.rootRealCache.set(rootId, cached);
    }
    return cached;
  }
}

/** First case-insensitive match in one text file; undefined for binary/unreadable. */
async function searchFile(
  absPath: string,
  needle: string,
): Promise<{ line: number; text: string } | undefined> {
  const info = await statSafe(absPath);
  if (info === undefined || info.size > MAX_SEARCH_FILE_BYTES) {
    return undefined;
  }
  let content: string;
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    // Vanished or became unreadable mid-scan — the same benign race listing
    // tolerates. The rest of the sweep continues.
    return undefined;
  }
  if (content.includes('\0')) {
    return undefined; // binary
  }
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.toLowerCase().includes(needle)) {
      return { line: index + 1, text: (lines[index] ?? '').slice(0, 240) };
    }
  }
  return undefined;
}

async function statSafe(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR (a parent component is a file) means the path cannot exist as
    // addressed — the same answer the probe loop needs as ENOENT.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}
