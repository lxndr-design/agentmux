import { useMemo } from 'react';
import { useSessionStore } from '../state/sessionStore.js';

/**
 * The pinned approval column. Rendered outside the dock (see Shell); its
 * pending cards always show the FULL command or diff — the summary can lie,
 * the raw text cannot (the prompt-injection defense).
 */
export function ApprovalColumn() {
  const collapsed = useSessionStore((state) => state.columnCollapsed);
  const toggleColumn = useSessionStore((state) => state.toggleColumn);
  const decide = useSessionStore((state) => state.decide);

  // Select the stable sessions reference, then derive — a selector returning a
  // fresh array (flatMap here) loops useSyncExternalStore forever.
  const sessions = useSessionStore((state) => state.sessions);
  const cards = useMemo(
    () =>
      sessions.flatMap((session) =>
        session.pendingApproval === null ? [] : [{ session, request: session.pendingApproval }],
      ),
    [sessions],
  );

  return (
    <aside
      className={collapsed ? 'approval-column approval-column--collapsed' : 'approval-column'}
      data-testid="approval-column"
      aria-label="Approvals"
    >
      <header className="approval-column__header">
        <h2>APPROVALS</h2>
        <span className="approval-column__count" data-testid="pending-count">
          {cards.length}
        </span>
        <button
          type="button"
          className="approval-column__toggle"
          data-testid="column-toggle"
          onClick={toggleColumn}
          aria-expanded={!collapsed}
        >
          {collapsed ? '»' : '«'}
        </button>
      </header>
      {collapsed ? (
        <p className="approval-column__rail-label">approvals</p>
      ) : cards.length === 0 ? (
        <p className="approval-column__empty" data-testid="approvals-empty">
          No pending approvals
        </p>
      ) : (
        <ul className="approval-cards">
          {cards.map(({ session, request }) => (
            <li className="approval-card" key={request.requestId} data-testid="approval-card">
              <div className="approval-card__origin">
                {session.name} · {request.tool}
              </div>
              <span className={`risk-pill risk-pill--${request.risk}`}>{request.risk}</span>
              {request.command !== undefined && (
                <pre className="approval-detail">{request.command}</pre>
              )}
              {request.diff !== undefined && <pre className="approval-detail">{request.diff}</pre>}
              {request.paths !== undefined && (
                <pre className="approval-detail">{request.paths.join('\n')}</pre>
              )}
              <div className="approval-actions">
                <button
                  type="button"
                  data-testid="approve-btn"
                  onClick={() => decide(session.id, request.requestId, 'approve')}
                >
                  Allow
                </button>
                <button
                  type="button"
                  data-testid="approve-session-btn"
                  onClick={() => decide(session.id, request.requestId, 'approve-for-session')}
                >
                  Always (session)
                </button>
                <button
                  type="button"
                  className="danger"
                  data-testid="deny-btn"
                  onClick={() => decide(session.id, request.requestId, 'deny')}
                >
                  Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
