import type { AgentEvent } from '@agentmux/protocol';
import { useSessionStore } from '../state/sessionStore.js';

/**
 * Raw event timeline — the walking-skeleton projection of the envelope
 * stream. One row per envelope, journal order, every kind rendered. The
 * structured/diff projections of the blueprint land in later PRs.
 */

const TIMELINE_WINDOW = 300;

function EventRow({ event, seq }: { event: AgentEvent; seq: number }) {
  switch (event.kind) {
    case 'turn':
      return (
        <li className="tl-row tl-turn" data-kind="turn" data-seq={seq}>
          <span className="tl-kind">{event.role}</span>
          <span className="tl-text">
            {event.role === 'user' ? `→ ${event.text}` : event.text}
            {!event.done ? '…' : ''}
          </span>
        </li>
      );
    case 'thinking':
      return (
        <li className="tl-row tl-thinking" data-kind="thinking" data-seq={seq}>
          <span className="tl-kind">thinking</span>
          <span className="tl-text">
            {event.text}
            {!event.done ? '…' : ''}
          </span>
        </li>
      );
    case 'tool_use':
      return (
        <li className="tl-row tl-tool" data-kind="tool_use" data-seq={seq}>
          <span className="tl-kind">tool</span>
          <span className="tl-chip">{event.tool}</span>
          <span className="tl-text">{event.summary ?? event.detail?.command ?? ''}</span>
        </li>
      );
    case 'tool_result':
      return (
        <li className="tl-row tl-tool-result" data-kind="tool_result" data-seq={seq}>
          <span className="tl-kind">output</span>
          <pre className="tl-text">{event.output.slice(0, 2000)}</pre>
        </li>
      );
    case 'usage':
      return (
        <li className="tl-row tl-usage" data-kind="usage" data-seq={seq}>
          <span className="tl-kind">usage</span>
          <span className="tl-text">
            tokens {event.tokensIn} in / {event.tokensOut} out
          </span>
        </li>
      );
    case 'state_change':
      return (
        <li className="tl-row tl-state" data-kind="state_change" data-seq={seq}>
          <span className="tl-kind">state</span>
          <span className="tl-text">
            {event.from} → {event.to}
          </span>
        </li>
      );
    default:
      return null; // unreachable: the union is exhaustive
  }
}

export function AgentPane() {
  const session = useSessionStore((state) =>
    state.activeSessionId === null
      ? undefined
      : state.sessions.find((candidate) => candidate.id === state.activeSessionId),
  );
  const toggleTranscript = useSessionStore((state) => state.toggleTranscript);

  if (session === undefined) {
    return (
      <div className="pane-empty" data-testid="agent-pane">
        No sessions yet — start one from the ribbon.
      </div>
    );
  }

  const terminal = session.state === 'stopped' || session.state === 'crashed';
  const visible = session.envelopes.slice(-TIMELINE_WINDOW);

  return (
    <div className="agent-pane" data-testid="agent-pane">
      <header className="agent-pane__header">
        <span>{session.name}</span>
        <span className="agent-pane__meta">
          {session.connectorLabel} · {session.phase ?? 'offline'}
        </span>
      </header>
      {session.streamError !== null && (
        <div className="stream-error" data-testid="stream-error" role="alert">
          {session.streamError}
        </div>
      )}
      {session.phase === 'replaying' && (
        <div className="replay-banner" data-testid="replay-banner">
          Replaying journal history…
        </div>
      )}
      {terminal && !session.transcriptOpen ? (
        <div className="tombstone" data-testid="tombstone">
          <h3>{session.state === 'crashed' ? 'Session crashed' : 'Session stopped'}</h3>
          {session.exit !== null && (
            <p>
              exit {session.exit.code}
              {session.exit.signal !== undefined ? ` (${session.exit.signal})` : ''}
              {session.exit.reason !== undefined ? ` — ${session.exit.reason}` : ''}
            </p>
          )}
          <button type="button" onClick={() => toggleTranscript(session.id)}>
            View transcript
          </button>
        </div>
      ) : (
        <>
          {terminal && (
            <button
              type="button"
              className="link"
              data-testid="back-to-tombstone"
              onClick={() => toggleTranscript(session.id)}
            >
              ← back to tombstone
            </button>
          )}
          <ul className="timeline" data-testid="timeline">
            {visible.map((envelope) => (
              <EventRow key={envelope.seq} event={envelope.payload} seq={envelope.seq} />
            ))}
          </ul>
          {session.envelopes.length > visible.length && (
            <footer className="timeline__footer">
              showing last {visible.length} of {session.envelopes.length} events
            </footer>
          )}
        </>
      )}
    </div>
  );
}
