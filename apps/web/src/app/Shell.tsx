import { DockHost } from '../dock/DockHost';
import { ApprovalColumn } from '../approvals/ApprovalColumn';
import { SessionRibbon } from '../ribbon/SessionRibbon';
import { useSessionStore } from '../state/sessionStore.js';

/**
 * The IDE shell. The approval column is a grid sibling of the dock host —
 * deliberately OUTSIDE the Dockview tree (blueprint pinned-column invariant,
 * F1d): docking libraries pin edge panes to an edge yet keep them draggable
 * and tabbable by design, so the invariant must hold by construction. The
 * layout engine never sees the column; it cannot be dragged, tabbed, closed,
 * or serialized away.
 */
export function Shell() {
  // The dock restores/saves a layout per workspace (blueprint persistence
  // item); the ribbon owns the workspace picker that drives this id.
  const workspaceId = useSessionStore((state) => state.activeWorkspaceId);
  return (
    <div className="app-shell">
      <SessionRibbon />
      <div className="app-body" data-testid="app-body">
        <ApprovalColumn />
        <DockHost workspaceId={workspaceId} />
      </div>
    </div>
  );
}
