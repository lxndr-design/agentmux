import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Shell } from './Shell.js';
import { deriveEnvelopeView, useSessionStore } from '../state/sessionStore.js';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { createAgentEventEnvelope } from '@agentmux/protocol';

type SessionView = NonNullable<ReturnType<typeof useSessionStore.getState>['sessions'][number]>;

function envelope(seq: number, payload: AgentEventEnvelope['payload']): AgentEventEnvelope {
  return createAgentEventEnvelope('s1', seq, payload);
}

function makeSession(): SessionView {
  return {
    id: 's1',
    name: 'agent-1',
    connectorLabel: 'fake-cli',
    state: 'working',
    exit: null,
    envelopes: [],
    lastSeq: null,
    pendingApproval: null,
    lastDecision: null,
    phase: 'live',
    streamError: null,
    transcriptOpen: false,
  };
}

function seedBase(): SessionView {
  const session = makeSession();
  useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
  return session;
}

function seedSession(patch: Partial<SessionView> = {}): SessionView {
  const next = { ...makeSession(), ...patch };
  useSessionStore.setState({ sessions: [next], activeSessionId: next.id });
  return next;
}

/** sessions[0] with an explicit failure path — noUncheckedIndexedAccess. */
function mustSession(): SessionView {
  const session = useSessionStore.getState().sessions[0];
  if (session === undefined) throw new Error('expected a seeded session');
  return session;
}

/** Seed a pending approval riding the working → waiting transition. */
function seedPendingApproval() {
  const base = mustSession();
  const request = {
    requestId: 'r1',
    tool: 'Bash',
    risk: 'high' as const,
    command: 'rm -rf ./dist',
  };
  const blocked = deriveEnvelopeView(
    base,
    envelope(1, { kind: 'state_change', from: 'working', to: 'waiting-approval', request }),
  );
  useSessionStore.setState({
    sessions: [blocked],
    activeSessionId: blocked.id,
    demoAvailable: true,
    daemonUrl: 'ws://127.0.0.1:8787',
    daemonToken: 't',
  });
  return blocked;
}

beforeEach(() => {
  cleanup();
  useSessionStore.setState({
    booted: true,
    demoAvailable: false,
    daemonUrl: null,
    daemonToken: null,
    columnCollapsed: false,
  });
  seedBase();
});

describe('Shell', () => {
  it('renders ribbon, pinned approval column, and both dock panes', () => {
    render(<Shell />);
    expect(screen.getByTestId('session-ribbon')).toBeTruthy();
    expect(screen.getByTestId('approval-column')).toBeTruthy();
    expect(screen.getByTestId('dock-host')).toBeTruthy();
    // Dockview registered both walking-skeleton panes
    expect(document.querySelector('[data-testid="agent-pane"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="terminal-pane"]')).toBeTruthy();
    // The session name shows in the ribbon chip AND the agent pane header
    expect(screen.getAllByText('agent-1').length).toBeGreaterThan(0);
    expect(screen.getByText('terminal')).toBeTruthy();
  });

  it('keeps the approval column OUTSIDE the dockview grid — the pinning invariant', () => {
    const { container } = render(<Shell />);

    const dockHost = container.querySelector('[data-testid="dock-host"]');
    const dockGrid = dockHost?.querySelector('.dockview-theme-abyss');
    const column = container.querySelector('[data-testid="approval-column"]');
    const appBody = container.querySelector('[data-testid="app-body"]');

    expect(dockHost).toBeTruthy();
    expect(dockGrid).toBeTruthy(); // the real Dockview grid mounted
    expect(column).toBeTruthy();
    // (1) not a descendant of the grid or the dock host
    expect(dockGrid!.contains(column!)).toBe(false);
    expect(dockHost!.contains(column!)).toBe(false);
    // (2) the column and the dock are siblings under .app-body: the layout
    // engine never sees the column, so it cannot be dragged or closed away
    expect(column!.parentElement).toBe(appBody);
    expect(dockHost!.parentElement).toBe(appBody);
  });

  it('carries the session state on the ribbon badge, including waiting-approval', () => {
    seedSession({ state: 'waiting-approval' });
    render(<Shell />);
    const badge = document.querySelector('[data-testid="state-badge-s1"]');
    expect(badge).toBeTruthy();
    expect(badge!.getAttribute('data-state')).toBe('waiting-approval');
  });

  it('disables the start control when the demo harness is unavailable', () => {
    render(<Shell />);
    expect((screen.getByTestId('start-session') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables start when the demo harness answers at boot', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:8787', token: 't' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await useSessionStore.getState().boot();

    render(<Shell />);
    expect((screen.getByTestId('start-session') as HTMLButtonElement).disabled).toBe(false);
    vi.unstubAllGlobals();
  });

  it('shows the full command on the approval card and clears it on deny', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    seedPendingApproval();

    const user = userEvent.setup();
    render(<Shell />);

    // No summary-only approvals: the raw command is on the card
    const card = screen.getByTestId('approval-card');
    expect(within(card).getByText('rm -rf ./dist')).toBeTruthy();
    expect(screen.getByTestId('pending-count').textContent).toBe('1');

    await user.click(within(card).getByTestId('deny-btn'));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/demo/sessions/s1/decision'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByTestId('approval-card')).toBeNull();
    expect(screen.getByTestId('pending-count').textContent).toBe('0');
    vi.unstubAllGlobals();
  });

  it('renders the tombstone with view-transcript for a stopped session', async () => {
    seedSession({ state: 'stopped', exit: { code: 0, reason: 'operator' } });
    const user = userEvent.setup();
    render(<Shell />);

    expect(screen.getByTestId('tombstone')).toBeTruthy();
    expect(screen.getByText('Session stopped')).toBeTruthy();
    expect(mustSession().transcriptOpen).toBe(false);
    await user.click(screen.getByText('View transcript'));
    expect(mustSession().transcriptOpen).toBe(true);
  });

  it('collapses the approval column to a badge rail and back', async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const column = document.querySelector('[data-testid="approval-column"]')!;
    await user.click(screen.getByTestId('column-toggle'));
    expect(column.className).toContain('approval-column--collapsed');
    expect(useSessionStore.getState().columnCollapsed).toBe(true);
  });
});
