import { useCallback, useEffect, useState } from 'react';
import { useObservabilityClient } from '../ws/useObservabilityClient.js';
import {
  useObservabilityStore,
  resetObservabilityStoreForTests,
} from '../state/observabilityStore.js';
import type { DivergenceEntry, DivergenceFileStatus } from '@agentmux/protocol';

/**
 * DivergencePane — the per-workspace git divergence view (blueprint: "New:
 * divergence panel — per workspace: ahead/behind vs base, files touched…
 * PR link"). Read-only git probes served by the daemon; the panel never
 * runs git itself.
 */

const REFRESH_INTERVAL_MS = 15_000;

export function DivergencePane() {
  const client = useObservabilityClient();
  const divergence = useObservabilityStore((state) => state.divergence);
  const loading = useObservabilityStore((state) => state.divergenceLoading);
  const error = useObservabilityStore((state) => state.divergenceError);
  const refresh = useObservabilityStore((state) => state.refreshDivergence);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refreshNow = useCallback(() => {
    if (client !== null) {
      void refresh(client);
    }
  }, [client, refresh]);

  useEffect(() => {
    refreshNow();
    const timer = setInterval(refreshNow, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshNow]);

  // Unmount cleanup keeps repeated demo sessions from accumulating state.
  useEffect(() => () => resetObservabilityStoreForTests(), []);

  return (
    <div className="divergence-pane" data-testid="divergence-pane">
      <div className="divergence-pane__header">
        <span className="divergence-pane__title">Divergence</span>
        <button
          type="button"
          className="pane-button"
          onClick={refreshNow}
          disabled={client === null}
        >
          Refresh
        </button>
      </div>
      {error !== null && (
        <div className="divergence-pane__error" role="alert">
          {error}
          <button type="button" className="pane-button" onClick={refreshNow}>
            Retry
          </button>
        </div>
      )}
      {loading && divergence === null && <div className="pane-empty">Probing worktrees…</div>}
      {!loading && divergence !== null && divergence.length === 0 && (
        <div className="pane-empty">
          No agent worktrees yet — start a session to see its divergence here.
        </div>
      )}
      {divergence !== null && divergence.length > 0 && (
        <ul className="divergence-pane__list">
          {divergence.map((entry) => (
            <DivergenceRow
              key={entry.sessionId}
              entry={entry}
              expanded={expanded === entry.sessionId}
              onToggle={() => setExpanded(expanded === entry.sessionId ? null : entry.sessionId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DivergenceRow(props: { entry: DivergenceEntry; expanded: boolean; onToggle: () => void }) {
  const { entry, expanded, onToggle } = props;
  if (entry.error !== null) {
    return (
      <li className="divergence-row divergence-row--error">
        <span className="divergence-row__branch">{entry.branch ?? entry.sessionId}</span>
        <span className="divergence-row__error">{entry.error}</span>
      </li>
    );
  }
  const fileSummary = summarizeFiles(entry);
  return (
    <li className="divergence-row">
      <div className="divergence-row__head">
        <button type="button" className="divergence-row__branch" onClick={onToggle}>
          {entry.branch ?? entry.sessionId}
        </button>
        <span className="divergence-row__counts">
          <span className="badge badge--ahead">+{entry.ahead ?? '?'}</span>
          <span className="badge badge--behind">−{entry.behind ?? '?'}</span>
          <span className="divergence-row__files">{fileSummary}</span>
        </span>
        {entry.prUrl !== null && (
          <a
            className="divergence-row__pr"
            href={entry.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Open PR
          </a>
        )}
      </div>
      <div className="divergence-row__base">base: {entry.base ?? '—'}</div>
      {expanded && entry.files.length > 0 && (
        <ul className="divergence-row__file-list">
          {entry.files.map((file) => (
            <li key={`${file.status}:${file.path}`} className="divergence-row__file">
              <FileStatusBadge status={file.status} />
              <span className="divergence-row__file-path">{file.path}</span>
            </li>
          ))}
        </ul>
      )}
      {expanded && entry.files.length === 0 && <div className="pane-empty">No changed files.</div>}
    </li>
  );
}

/** Compact per-entry summary, e.g. "3 files · 1 uncommitted". */
function summarizeFiles(entry: DivergenceEntry): string {
  const uncommitted = entry.files.filter((file) => file.status === 'uncommitted').length;
  const committed = entry.files.length - uncommitted;
  if (entry.files.length === 0) {
    return 'no changes';
  }
  return uncommitted === 0
    ? `${committed} file${committed === 1 ? '' : 's'}`
    : `${committed} + ${uncommitted} uncommitted`;
}

const STATUS_LABELS: Record<DivergenceFileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  uncommitted: 'U',
};

function FileStatusBadge(props: { status: DivergenceFileStatus }) {
  return (
    <span className={`file-badge file-badge--${props.status}`} title={props.status}>
      {STATUS_LABELS[props.status]}
    </span>
  );
}
