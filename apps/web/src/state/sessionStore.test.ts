import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { createAgentEventEnvelope } from '@agentmux/protocol';
import {
  attachClient,
  deriveEnvelopeView,
  MAX_ENVELOPES,
  useSessionStore,
} from './sessionStore.js';

type SessionView = NonNullable<ReturnType<typeof useSessionStore.getState>['sessions'][number]>;

/** sessions[0] with an explicit failure path — noUncheckedIndexedAccess. */
function mustSession(index = 0): SessionView {
  const session = useSessionStore.getState().sessions[index];
  if (session === undefined) throw new Error(`expected a session at index ${index}`);
  return session;
}

function envelope(seq: number, payload: AgentEventEnvelope['payload']): AgentEventEnvelope {
  return createAgentEventEnvelope('s1', seq, payload);
}

const THINKING = { kind: 'thinking' as const, text: 'hmm', done: true };

/** A session with a pending approval riding the working → waiting transition. */
function sessionWithPendingApproval() {
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
  return { session: blocked, request };
}

beforeEach(() => {
  useSessionStore.setState({
    booted: false,
    demoAvailable: false,
    daemonUrl: null,
    daemonToken: null,
    sessions: [
      {
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
      },
    ],
    activeSessionId: 's1',
    columnCollapsed: false,
  });
});

describe('deriveEnvelopeView', () => {
  it('appends the envelope in journal order', () => {
    const session = mustSession();
    const next = deriveEnvelopeView(session, envelope(0, THINKING));
    expect(next.envelopes.map((e) => e.seq)).toEqual([0]);
  });

  it('derives state, exit, and pending approval from state_change events', () => {
    const session = mustSession();
    const request = { requestId: 'r1', tool: 'Bash', risk: 'high' as const, command: 'dd' };
    const next = deriveEnvelopeView(session, {
      ...envelope(0, { kind: 'state_change', from: 'working', to: 'waiting-approval', request }),
    });
    expect(next.state).toBe('waiting-approval');
    expect(next.pendingApproval).toEqual(request);
    expect(next.exit).toBeNull();
  });

  it('clears the pending approval when the session leaves waiting-approval', () => {
    const request = { requestId: 'r1', tool: 'Bash', risk: 'high' as const, command: 'dd' };
    const blocked = deriveEnvelopeView(mustSession(), {
      ...envelope(0, { kind: 'state_change', from: 'working', to: 'waiting-approval', request }),
    });
    const resumed = deriveEnvelopeView(blocked, {
      ...envelope(1, { kind: 'state_change', from: 'waiting-approval', to: 'working' }),
    });
    expect(resumed.pendingApproval).toBeNull();
    expect(resumed.state).toBe('working');
  });

  it('records an approval_decision event and clears the matching card', () => {
    const request = { requestId: 'r1', tool: 'Bash', risk: 'high' as const, command: 'dd' };
    const blocked = deriveEnvelopeView(mustSession(), {
      ...envelope(0, { kind: 'state_change', from: 'working', to: 'waiting-approval', request }),
    });
    const resolved = deriveEnvelopeView(blocked, {
      ...envelope(1, {
        kind: 'approval_decision',
        requestId: 'r1',
        decision: 'deny',
        actor: 'human',
        reason: 'no',
      }),
    });
    expect(resolved.pendingApproval).toBeNull();
    expect(resolved.lastDecision).toEqual({ requestId: 'r1', decision: 'deny' });
    expect(resolved.state).toBe('waiting-approval'); // the session event decides the state, not the decision
  });

  it('keeps a non-matching pending card when a decision event names a different request', () => {
    const request = { requestId: 'r1', tool: 'Bash', risk: 'high' as const, command: 'dd' };
    const blocked = deriveEnvelopeView(mustSession(), {
      ...envelope(0, { kind: 'state_change', from: 'working', to: 'waiting-approval', request }),
    });
    const resolved = deriveEnvelopeView(blocked, {
      ...envelope(1, {
        kind: 'approval_decision',
        requestId: 'other',
        decision: 'approve',
        actor: 'policy',
      }),
    });
    expect(resolved.pendingApproval?.requestId).toBe('r1');
    expect(resolved.lastDecision).toEqual({ requestId: 'other', decision: 'approve' });
  });

  it('records exit info on a terminal transition', () => {
    const session = mustSession();
    const next = deriveEnvelopeView(session, {
      ...envelope(0, {
        kind: 'state_change',
        from: 'working',
        to: 'stopped',
        exit: { code: 0, reason: 'operator' },
      }),
    });
    expect(next.state).toBe('stopped');
    expect(next.exit).toEqual({ code: 0, reason: 'operator' });
  });

  it('caps retained envelopes at MAX_ENVELOPES', () => {
    let session = mustSession();
    for (let seq = 0; seq < MAX_ENVELOPES + 50; seq += 1) {
      session = deriveEnvelopeView(session, envelope(seq, THINKING));
    }
    expect(session.envelopes.length).toBe(MAX_ENVELOPES);
    const oldest = session.envelopes[0];
    if (oldest === undefined) throw new Error('expected the cap to retain envelopes');
    expect(oldest.seq).toBe(50); // oldest trimmed
  });
});

describe('decide', () => {
  /** Minimal WebSocket stand-in — records sent frames, reports OPEN. */
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      /* no-op — the client's stop() handles phase */
    }
  }

  function stubSocket(): void {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  }

  it('clears the pending card, records the decision, and sends the WS decide frame', () => {
    stubSocket();
    const { session, request } = sessionWithPendingApproval();
    attachClient(session.id, 'ws://127.0.0.1:8787');

    useSessionStore.getState().decide(session.id, request.requestId, 'deny');

    const after = mustSession();
    expect(after.pendingApproval).toBeNull();
    expect(after.lastDecision).toEqual({ requestId: 'r1', decision: 'deny' });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error('expected an attached socket');
    const frames = socket.sent.map(
      (data) => JSON.parse(data) as { type: string; decision?: { requestId?: string } },
    );
    expect(
      frames.some((frame) => frame.type === 'decide' && frame.decision?.requestId === 'r1'),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('keeps the card pending and surfaces an error when the stream is not connected', () => {
    const orphan: SessionView = {
      ...mustSession(),
      id: 'no-stream',
      name: 'agent-9',
      pendingApproval: {
        requestId: 'r9',
        tool: 'Bash',
        risk: 'high',
        command: 'dd if=/dev/zero of=/dev/sda',
      },
      lastDecision: null,
    };
    useSessionStore.setState({ sessions: [...useSessionStore.getState().sessions, orphan] });

    useSessionStore.getState().decide('no-stream', 'r9', 'deny');

    const after = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === 'no-stream');
    if (after === undefined) throw new Error('expected the orphan session');
    expect(after.pendingApproval).not.toBeNull();
    expect(after.lastDecision).toBeNull();
    expect(after.streamError).toMatch(/not connected/);
  });

  it('ignores decisions for an unknown request id', () => {
    stubSocket();
    const { session } = sessionWithPendingApproval();
    attachClient(session.id, 'ws://127.0.0.1:8787');
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error('expected an attached socket');
    socket.onopen?.(); // complete the handshake — the subscribe frame goes out
    const before = socket.sent.length;

    useSessionStore.getState().decide(session.id, 'nope', 'approve');

    const after = mustSession();
    expect(after.pendingApproval).not.toBeNull();
    expect(after.lastDecision).toBeNull();
    expect(socket.sent.length).toBe(before); // no decide frame followed
    vi.unstubAllGlobals();
  });
});

describe('boot', () => {
  it('enables the demo ribbon when the harness answers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:8787', token: 'boot-token' }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await useSessionStore.getState().boot();

    const state = useSessionStore.getState();
    expect(state.booted).toBe(true);
    expect(state.demoAvailable).toBe(true);
    expect(state.daemonUrl).toBe('ws://127.0.0.1:8787');
    expect(state.daemonToken).toBe('boot-token');
    vi.unstubAllGlobals();
  });

  it('degrades to a disabled ribbon when no harness is running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );

    await useSessionStore.getState().boot();

    const state = useSessionStore.getState();
    expect(state.booted).toBe(true);
    expect(state.demoAvailable).toBe(false);
    expect(state.daemonToken).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('tombstone chrome', () => {
  it('keeps the transcript closed until the user opens it', () => {
    const { session } = sessionWithPendingApproval();
    useSessionStore.setState({
      sessions: useSessionStore.getState().sessions.map((candidate) => ({
        ...candidate,
        state: 'stopped',
        exit: { code: 0, reason: 'operator' },
        pendingApproval: null,
      })),
    });
    const stopped = mustSession();
    expect(stopped.id).toBe(session.id);

    useSessionStore.getState().toggleTranscript(stopped.id);
    expect(mustSession().transcriptOpen).toBe(true);
    useSessionStore.getState().toggleTranscript(stopped.id);
    expect(mustSession().transcriptOpen).toBe(false);
  });
});
