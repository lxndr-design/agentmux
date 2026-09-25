import { useMemo } from 'react';
import { useSessionStore } from '../state/sessionStore.js';
import { Timeline } from './timeline/Timeline';
import { buildTimelineItems, deriveVisualState } from './timeline/timelineModel';

/**
 * Agent pane — the structured projection of one session's stream. The raw
 * per-envelope projection it replaces is gone; renderers per event kind live
 * in timeline/. Timeline items are built from the full envelope history (so
 * merges and tool correlation survive windowing) and windowed after.
 */

const TIMELINE_WINDOW = 300;

export function AgentPane() {
  const session = useSessionStore((state) =>
    state.activeSessionId === null
      ? undefined
      : state.sessions.find((candidate) => candidate.id === state.activeSessionId),
  );
  const toggleTranscript = useSessionStore((state) => state.toggleTranscript);

  const timeline = useMemo(
    () => (session === undefined ? null : buildTimelineItems(session.envelopes)),
    [session],
  );

  if (session === undefined || timeline === null) {
    return (
      <div className="pane-empty" data-testid="agent-pane">
        No sessions yet — start one from the ribbon.
      </div>
    );
  }

  const terminal = session.state === 'stopped' || session.state === 'crashed';
  const visible = timeline.items.slice(-TIMELINE_WINDOW);
  const visualState = deriveVisualState(timeline.items);

  return (
    <div className="agent-pane" data-testid="agent-pane">
      <header className="agent-pane__header">
        <span>{session.name}</span>
        <span className="agent-pane__meta">
          {session.connectorLabel} · {session.phase ?? 'offline'}
          {visualState !== 'idle' ? ` · ${visualState}` : ''}
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
          <Timeline items={visible} usage={timeline.usage} visualState={visualState} />
          {timeline.items.length > visible.length && (
            <footer className="timeline__footer">
              showing last {visible.length} of {session.envelopes.length} events
            </footer>
          )}
        </>
      )}
    </div>
  );
}
