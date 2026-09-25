import { useEffect, useMemo } from 'react';
import type { FsEntry, FsRoot } from '@agentmux/protocol';
import { useSessionStore } from '../state/sessionStore.js';
import { useFilesStore } from '../state/filesStore.js';
import { useFsClient } from '../ws/useFsClient.js';

/**
 * FileTreePane — the workspace tree with the worktree root selector
 * (blueprint "FS bridge: UI surfaces"). Watching what an agent is actually
 * doing to its tree is the point of the selector: the workspace names the
 * main checkout, each session names that agent's worktree.
 */

const ROOT_DIR = '.';

function RootSelector({ root, onRoot }: { root: FsRoot; onRoot: (root: FsRoot) => void }) {
  const sessions = useSessionStore((state) => state.sessions);
  return (
    <select
      className="file-tree__root-select"
      aria-label="File tree root"
      value={root}
      onChange={(event) => onRoot(event.target.value as FsRoot)}
    >
      <option value="workspace">main checkout</option>
      {sessions.map((session) => (
        <option key={session.id} value={`session:${session.id}`}>
          {session.name} · worktree
        </option>
      ))}
    </select>
  );
}

function TreeRow({
  entry,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onOpen,
}: {
  entry: FsEntry;
  depth: number;
  expanded: boolean;
  selectedPath: string | null;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const isDir = entry.type === 'dir';
  return (
    <>
      <button
        type="button"
        className="file-tree__row"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        data-path={entry.path}
        data-type={entry.type}
        aria-expanded={isDir ? expanded : undefined}
        onClick={isDir ? onToggle : onOpen}
      >
        <span className="file-tree__marker">{isDir ? (expanded ? '▾' : '▸') : ''}</span>
        <span className="file-tree__name">
          {entry.name}
          {selectedPath === entry.path ? ' ●' : ''}
        </span>
      </button>
      {isDir && expanded ? <DirChildren dirPath={entry.path} depth={depth + 1} /> : null}
    </>
  );
}

function DirChildren({ dirPath, depth }: { dirPath: string; depth: number }) {
  const root = useFilesStore((state) => state.root);
  const expanded = useFilesStore((state) => state.expanded);
  const listings = useFilesStore((state) => state.listings);
  const loadingDirs = useFilesStore((state) => state.loadingDirs);
  const file = useFilesStore((state) => state.file);
  const toggleDir = useFilesStore((state) => state.toggleDir);
  const openFile = useFilesStore((state) => state.openFile);
  const client = useFsClient();

  // Memo over the listings record — a fresh filtered array per call would
  // break the store's snapshot contract and re-render forever.
  const entries = useMemo(() => {
    const cached = listings[`${root}::${dirPath}`] ?? [];
    return cached.filter((entry) => !entry.name.startsWith('.'));
  }, [listings, root, dirPath]);
  const loading = loadingDirs[`${root}::${dirPath}`] === true;

  if (loading && entries.length === 0) {
    return <div className="file-tree__loading">loading…</div>;
  }
  return (
    <>
      {entries.map((entry) => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expanded.includes(entry.path)}
          selectedPath={file?.path ?? null}
          onToggle={() => {
            if (client !== null) void toggleDir(client, entry.path);
          }}
          onOpen={() => {
            if (client !== null) void openFile(client, root, entry.path);
          }}
        />
      ))}
    </>
  );
}

export function FileTreePane() {
  const root = useFilesStore((state) => state.root);
  const expanded = useFilesStore((state) => state.expanded);
  const setRoot = useFilesStore((state) => state.setRoot);
  const toggleDir = useFilesStore((state) => state.toggleDir);
  const error = useFilesStore((state) => state.error);
  const dismissError = useFilesStore((state) => state.dismissError);
  const client = useFsClient();

  // Boot the tree once a gateway connection exists; the root is the initial
  // one (a user change flows through the selector, not this effect).
  useEffect(() => {
    if (client !== null) {
      void setRoot(client, root);
    }
  }, [client]);

  if (client === null) {
    return (
      <div className="file-tree file-tree--empty" data-testid="file-tree">
        <p className="file-tree__empty">filesystem unavailable — no daemon connection</p>
      </div>
    );
  }

  return (
    <div className="file-tree" data-testid="file-tree">
      <div className="file-tree__bar">
        <RootSelector root={root} onRoot={(next) => void setRoot(client, next)} />
      </div>
      {error !== null ? (
        <div className="file-tree__error" role="alert">
          {error}
          <button type="button" className="file-tree__error-dismiss" onClick={dismissError}>
            dismiss
          </button>
        </div>
      ) : null}
      <div className="file-tree__body">
        {expanded.includes(ROOT_DIR) ? (
          <DirChildren dirPath={ROOT_DIR} depth={0} />
        ) : (
          <button
            type="button"
            className="file-tree__row"
            onClick={() => void toggleDir(client, ROOT_DIR)}
          >
            <span className="file-tree__marker">▸</span>
            <span className="file-tree__name">{root}</span>
          </button>
        )}
      </div>
    </div>
  );
}
