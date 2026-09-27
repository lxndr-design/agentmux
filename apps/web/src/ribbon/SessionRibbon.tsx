import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectVisibleSessions, useSessionStore } from '../state/sessionStore.js';
import { DEFAULT_WORKSPACE_ID, workspaceOfSession } from '../state/workspacesModel.js';
import { openOnboardingPanel } from '../dock/dockApiRef.js';
import { deriveSessionAttention } from './attention.js';

/**
 * Session ribbon — one cell per session with its lifecycle badge (the
 * protocol's SessionState machine is the source), plus the start control.
 * Start/stop act through the demo harness in this skeleton; the supervisor
 * PR replaces the control path without touching this surface.
 *
 * Workspaces (named session groups) scope the ribbon: the picker selects the
 * active group, new sessions join it, and each chip can move between groups.
 */
export function SessionRibbon() {
  const sessions = useSessionStore(useShallow((state) => selectVisibleSessions(state)));
  const workspaces = useSessionStore((state) => state.workspaces);
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const demoAvailable = useSessionStore((state) => state.demoAvailable);
  const startSession = useSessionStore((state) => state.startSession);
  const stopSession = useSessionStore((state) => state.stopSession);
  const setActive = useSessionStore((state) => state.setActive);
  const createWorkspace = useSessionStore((state) => state.createWorkspace);
  const deleteWorkspace = useSessionStore((state) => state.deleteWorkspace);
  const setActiveWorkspace = useSessionStore((state) => state.setActiveWorkspace);
  const moveSession = useSessionStore((state) => state.moveSession);

  const [workspaceName, setWorkspaceName] = useState('');
  const multipleWorkspaces = workspaces.length > 1;

  const submitWorkspace = () => {
    createWorkspace(workspaceName);
    setWorkspaceName('');
  };

  return (
    <div className="ribbon" data-testid="session-ribbon">
      <span className="ribbon__brand">agentmux</span>
      <div className="ribbon__workspaces" data-testid="workspace-bar">
        <select
          className="ribbon__workspace-select"
          data-testid="workspace-select"
          value={activeWorkspaceId}
          aria-label="Active workspace"
          onChange={(event) => setActiveWorkspace(event.target.value)}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <input
          className="ribbon__workspace-input"
          data-testid="workspace-name-input"
          value={workspaceName}
          placeholder="new workspace"
          aria-label="New workspace name"
          onChange={(event) => setWorkspaceName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitWorkspace();
          }}
        />
        <button
          type="button"
          className="ribbon__workspace-add"
          data-testid="create-workspace"
          disabled={workspaceName.trim() === ''}
          onClick={submitWorkspace}
        >
          + workspace
        </button>
        {activeWorkspaceId !== DEFAULT_WORKSPACE_ID && (
          <button
            type="button"
            className="ribbon__workspace-delete"
            data-testid="delete-workspace"
            title="Delete this workspace — its sessions move to default"
            aria-label="Delete active workspace"
            onClick={() => deleteWorkspace(activeWorkspaceId)}
          >
            ✕
          </button>
        )}
      </div>
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
      <button
        type="button"
        className="ribbon__setup"
        data-testid="open-onboarding"
        title="Check CLI installs and logins"
        onClick={() => openOnboardingPanel()}
      >
        CLI setup
      </button>
      <div className="ribbon__sessions">
        {sessions.map((session) => {
          const terminal = session.state === 'stopped' || session.state === 'crashed';
          const attention = deriveSessionAttention(session);
          return (
            <div
              key={session.id}
              className={
                session.id === activeSessionId
                  ? 'ribbon-session ribbon-session--active'
                  : 'ribbon-session'
              }
              data-testid="session-chip"
              data-attention={attention.level}
              onClick={() => setActive(session.id)}
            >
              <span
                className="badge"
                data-testid={`state-badge-${session.id}`}
                data-state={session.state}
                data-attention={attention.level}
                title={attention.level === 'none' ? session.state : attention.label}
              >
                {attention.label}
              </span>
              <span className="ribbon-session__name">{session.name}</span>
              {multipleWorkspaces && (
                <select
                  className="ribbon-session__move"
                  data-testid={`assign-session-${session.id}`}
                  value={workspaceOfSession(workspaces, session.id)?.id ?? DEFAULT_WORKSPACE_ID}
                  aria-label={`Move ${session.name} to workspace`}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => moveSession(session.id, event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              )}
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
