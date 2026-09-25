import { useSessionStore } from '../state/sessionStore.js';

/**
 * Session ribbon — one cell per session with its lifecycle badge (the
 * protocol's SessionState machine is the source), plus the start control.
 * Start/stop act through the demo harness in this skeleton; the supervisor
 * PR replaces the control path without touching this surface.
 */
export function SessionRibbon() {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const demoAvailable = useSessionStore((state) => state.demoAvailable);
  const startSession = useSessionStore((state) => state.startSession);
  const stopSession = useSessionStore((state) => state.stopSession);
  const setActive = useSessionStore((state) => state.setActive);

  return (
    <div className="ribbon" data-testid="session-ribbon">
      <span className="ribbon__brand">agentmux</span>
      <button
        type="button"
        className="ribbon__start"
        data-testid="start-session"
        disabled={!demoAvailable}
        title={
          demoAvailable
            ? 'Start a demo session'
            : 'Session spawn needs the daemon harness or supervisor — run the demo harness for now'
        }
        onClick={() => void startSession()}
      >
        + Start session
      </button>
      <div className="ribbon__sessions">
        {sessions.map((session) => {
          const terminal = session.state === 'stopped' || session.state === 'crashed';
          return (
            <div
              key={session.id}
              className={
                session.id === activeSessionId
                  ? 'ribbon-session ribbon-session--active'
                  : 'ribbon-session'
              }
              data-testid="session-chip"
              onClick={() => setActive(session.id)}
            >
              <span
                className={
                  session.state === 'waiting-approval' ? 'badge badge--waiting-approval' : 'badge'
                }
                data-testid={`state-badge-${session.id}`}
                data-state={session.state}
                title={session.state}
              >
                {session.state}
              </span>
              <span className="ribbon-session__name">{session.name}</span>
              <button
                type="button"
                className="ribbon-session__stop"
                data-testid={`stop-session-${session.id}`}
                aria-label={`Stop ${session.name}`}
                disabled={terminal}
                title={terminal ? 'already stopped' : 'Stop this session'}
                onClick={(event) => {
                  event.stopPropagation();
                  stopSession(session.id);
                }}
              >
                ⏹
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
