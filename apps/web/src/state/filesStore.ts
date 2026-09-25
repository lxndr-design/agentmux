import type { FsEntry, FsRequest, FsResult, FsRoot } from '@agentmux/protocol';
import { create } from 'zustand';
import type { FsChangeMessage } from '../ws/wire.js';

/**
 * File-flow state — the model behind FileTreePane, EditorPane, and DiffPane.
 * Panes are views over this store, never owners (blueprint: "Rendering a
 * firehose, calmly"). RPC goes through the minimal `FsRpc` port so tests can
 * drive the same flow against the real daemon or a stub.
 */

export interface FsRpc {
  request(request: FsRequest): Promise<FsResult>;
}

/** The file the editor holds, with the three contents the flow needs. */
export interface OpenFile {
  root: FsRoot;
  path: string;
  /** Content as first loaded — the diff "before". */
  original: string;
  /** Content as last written through the bridge — the diff "after". */
  saved: string;
  /** The editor's live buffer. */
  buffer: string;
  saving: boolean;
  /** The watcher saw a change for this file since it was loaded or saved. */
  externalChanged: boolean;
}

interface FilesState {
  root: FsRoot;
  /** Directory listings keyed by `<root>::<dirPath>` ('.' included). */
  listings: Record<string, FsEntry[]>;
  loadingDirs: Record<string, boolean>;
  /** Directory paths currently expanded, relative to the addressed root. */
  expanded: string[];
  file: OpenFile | null;
  /** Last failed action — rendered as a non-blocking banner, never a modal. */
  error: string | null;
}

interface FilesActions {
  setRoot(client: FsRpc, root: FsRoot): Promise<void>;
  toggleDir(client: FsRpc, dirPath: string): Promise<void>;
  openFile(client: FsRpc, root: FsRoot, path: string): Promise<void>;
  editBuffer(text: string): void;
  saveFile(client: FsRpc): Promise<void>;
  reloadFile(client: FsRpc): Promise<void>;
  closeFile(): void;
  /** Feed the watcher's fs_change into the tree and open-file state. */
  noteFsChange(client: FsRpc, change: FsChangeMessage): void;
  dismissError(): void;
}

export type FilesStore = FilesState & FilesActions;

const ROOT_DIR = '.';
const listingKey = (root: FsRoot, dirPath: string): string => `${root}::${dirPath}`;

function isListResult(result: FsResult): result is Extract<FsResult, { op: 'list' }> {
  return result.op === 'list';
}

function isReadResult(result: FsResult): result is Extract<FsResult, { op: 'read' }> {
  return result.op === 'read';
}

/**
 * True when an fs_change event addresses `path` as seen from `root`: the
 * event's workspace-relative path for the workspace root, or the event's
 * session view for a session root.
 */
function changeMatchesRoot(change: FsChangeMessage, root: FsRoot, path: string): boolean {
  if (root === 'workspace') {
    return change.path === path;
  }
  const sessionId = root.slice('session:'.length);
  return change.session?.sessionId === sessionId && change.session.path === path;
}

/** Paths (relative to the root) of expanded directories the change touches. */
function touchedExpandedDirs(change: FsChangeMessage, expanded: string[]): string[] {
  return expanded.filter((dirPath) => {
    if (dirPath === ROOT_DIR) {
      return true; // the root listing shows every top-level entry
    }
    return change.path === dirPath || change.path.startsWith(`${dirPath}/`);
  });
}

/** Fetch one listing into the cache; failures surface in the error banner. */
async function fetchListing(
  client: FsRpc,
  root: FsRoot,
  dirPath: string,
  set: (partial: Partial<FilesState> | ((state: FilesState) => Partial<FilesState>)) => void,
): Promise<void> {
  const key = listingKey(root, dirPath);
  set({ loadingDirs: { ...useFilesStore.getState().loadingDirs, [key]: true } });
  try {
    const result = await client.request({ op: 'list', root, path: dirPath });
    if (isListResult(result)) {
      set((state) => ({ listings: { ...state.listings, [key]: result.entries } }));
    }
  } catch (error) {
    set({ error: `could not list ${dirPath}: ${(error as Error).message}` });
  } finally {
    const loadingDirs = { ...useFilesStore.getState().loadingDirs };
    delete loadingDirs[key];
    set({ loadingDirs });
  }
}

export const initialFilesState: FilesState = {
  root: 'workspace',
  listings: {},
  loadingDirs: {},
  expanded: [],
  file: null,
  error: null,
};

export const useFilesStore = create<FilesStore>((set, get) => ({
  ...initialFilesState,

  async setRoot(client, root) {
    set({ root, listings: {}, loadingDirs: {}, expanded: [] });
    await get().toggleDir(client, ROOT_DIR);
  },

  async toggleDir(client, dirPath) {
    const { root, expanded } = get();
    if (expanded.includes(dirPath)) {
      // Collapse only — the listing stays cached for the next expand.
      set({ expanded: expanded.filter((entry) => entry !== dirPath) });
      return;
    }
    set({ expanded: [...expanded, dirPath] });
    await fetchListing(client, root, dirPath, set);
  },

  async openFile(client, root, path) {
    set({ error: null });
    try {
      const result = await client.request({ op: 'read', root, path });
      if (!isReadResult(result)) {
        throw new Error('unexpected result shape');
      }
      set({
        file: {
          root,
          path,
          original: result.read.content,
          saved: result.read.content,
          buffer: result.read.content,
          saving: false,
          externalChanged: false,
        },
      });
    } catch (error) {
      set({ error: `could not open ${path}: ${(error as Error).message}` });
    }
  },

  editBuffer(text) {
    const file = get().file;
    if (file === null) return;
    set({ file: { ...file, buffer: text } });
  },

  async saveFile(client) {
    const file = get().file;
    if (file === null || file.saving) return;
    set({ file: { ...file, saving: true }, error: null });
    try {
      await client.request({
        op: 'write',
        root: file.root,
        path: file.path,
        content: file.buffer,
      });
      set({
        file: {
          ...get().file!,
          saved: get().file!.buffer,
          saving: false,
          externalChanged: false,
        },
      });
      // Refresh the parent listing so size/mtime columns reflect the write.
      const parent = file.path.includes('/')
        ? file.path.slice(0, file.path.lastIndexOf('/'))
        : ROOT_DIR;
      await fetchListing(client, file.root, parent, set);
    } catch (error) {
      set({
        file: { ...file, saving: false },
        error: `could not save ${file.path}: ${(error as Error).message}`,
      });
    }
  },

  async reloadFile(client) {
    const file = get().file;
    if (file === null) return;
    await get().openFile(client, file.root, file.path);
  },

  closeFile() {
    set({ file: null });
  },

  noteFsChange(client, change) {
    const { file, root, expanded } = get();
    // Refresh cached listings the change touches — the tree stays honest
    // about files agents write behind the panes.
    const touched = touchedExpandedDirs(change, expanded);
    for (const dirPath of touched) {
      void fetchListing(client, root, dirPath, set);
    }
    // An external edit of the open file is never silently overwritten: the
    // editor shows a banner with a reload action (blueprint conflict policy).
    if (file !== null && changeMatchesRoot(change, file.root, file.path)) {
      set({ file: { ...file, externalChanged: true } });
    }
  },

  dismissError() {
    set({ error: null });
  },
}));

/** Entries of a listing with dotfiles hidden — the FileTreePane's view. */
export function visibleEntries(state: FilesStore, dirPath: string): FsEntry[] {
  const key = listingKey(state.root, dirPath);
  return (state.listings[key] ?? []).filter((entry) => !entry.name.startsWith('.'));
}

/** Derived: the open file has unsaved edits. */
export function fileIsDirty(state: FilesStore): boolean {
  const file = state.file;
  return file !== null && file.buffer !== file.saved;
}

/** Derived: the diff pair for DiffPane — what changed on disk through the bridge. */
/** The diff pair a save produces — pure over the open file for testability. */
export function fileDiffPair(file: OpenFile | null): { before: string; after: string } | null {
  if (file === null) return null;
  return { before: file.original, after: file.saved };
}
