import { useMemo } from 'react';
import { diffLines } from 'diff';
import { useFilesStore, fileDiffPair } from '../state/filesStore.js';

/**
 * DiffPane — the changeset view of the file flow: what a save through the
 * bridge changed on disk (original → last-saved), rendered as a plain
 * unified diff. Blueprint: "DiffPane — side-by-side / inline diff; also used
 * for approval previews."
 */

interface DiffRow {
  kind: 'context' | 'add' | 'del';
  text: string;
}

function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const change of diffLines(before, after)) {
    const lines = change.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop(); // trailing-newline artifact of change.value
    }
    const kind: DiffRow['kind'] = change.added ? 'add' : change.removed ? 'del' : 'context';
    for (const text of lines) {
      rows.push({ kind, text });
    }
  }
  return rows;
}

export function DiffPane() {
  const pair = useFilesStore(fileDiffPair);

  const rows = useMemo(() => (pair === null ? null : diffRows(pair.before, pair.after)), [pair]);
  const added = rows === null ? 0 : rows.filter((row) => row.kind === 'add').length;
  const removed = rows === null ? 0 : rows.filter((row) => row.kind === 'del').length;

  if (rows === null) {
    return (
      <div className="diff diff--empty" data-testid="diff-pane">
        <p className="diff__empty">no diff — open a file and save it through the bridge</p>
      </div>
    );
  }

  return (
    <div className="diff" data-testid="diff-pane">
      <div className="diff__bar">
        <span className="diff__title">changes through the bridge</span>
        <span className="diff__stat" data-testid="diff-stat">
          <span className="diff__stat-add">+{added}</span>{' '}
          <span className="diff__stat-del">−{removed}</span>
        </span>
      </div>
      {added === 0 && removed === 0 ? (
        <p className="diff__clean" data-testid="diff-clean">
          saved content matches the file as opened — no changes
        </p>
      ) : (
        <div className="diff__body">
          {rows.map((row, index) => (
            <div
              key={index}
              className={`diff__row diff__row--${row.kind}`}
              data-testid={`diff-row-${row.kind}`}
            >
              <span className="diff__sign">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
              </span>
              <span className="diff__text">{row.text.slice(1)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
