import { DockHost } from '../dock/DockHost';
import { ApprovalColumn } from '../approvals/ApprovalColumn';
import { SessionRibbon } from '../ribbon/SessionRibbon';

/**
 * The IDE shell. The approval column is a grid sibling of the dock host —
 * deliberately OUTSIDE the Dockview tree (blueprint pinned-column invariant,
 * F1d): docking libraries pin edge panes to an edge yet keep them draggable
 * and tabbable by design, so the invariant must hold by construction. The
 * layout engine never sees the column; it cannot be dragged, tabbed, closed,
 * or serialized away.
 */
export function Shell() {
  return (
    <div className="app-shell">
      <SessionRibbon />
      <div className="app-body" data-testid="app-body">
        <ApprovalColumn />
        <DockHost />
      </div>
    </div>
  );
}
