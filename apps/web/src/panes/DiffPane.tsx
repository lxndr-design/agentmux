import { useMemo } from 'react';
import { diffArrays } from 'diff';
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

/** Line-atom diff — rows are always whole lines, never character fragments. */
export function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  // A trailing newline splits into an empty final element that is not a real
  // line; drop exactly that one from each side.
  const beforeLines = before.split('\n');
  if (beforeLines.length > 1 && beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
  const afterLines = after.split('\n');
  if (afterLines.length > 1 && afterLines[afterLines.length - 1] === '') afterLines.pop();
  for (const change of diffArrays(beforeLines, afterLines)) {
    const kind: DiffRow['kind'] = change.added ? 'add' : change.removed ? 'del' : 'context';
    for (const text of change.value as string[]) {
      rows.push({ kind, text });
    }
  }
  return rows;
}

export function DiffPane() {
  const file = useFilesStore((state) => state.file);
  // Derived in render from a stable selector — the store's snapshot contract
  // forbids selectors that allocate a fresh object per call (React would
  // force-render forever, #185).
  const pair = useMemo(() => fileDiffPair(file), [file]);

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
              <span className="diff__text">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
