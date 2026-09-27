import type {
  AgentEventEnvelope,
  ApprovalDecision,
  ApprovalRequest,
  ExitInfo,
  SessionState,
} from '@agentmux/protocol';
import { create } from 'zustand';
import { createEnvelopeCoalescer, type EnvelopeCoalescer } from './envelopeCoalescer.js';
import { fetchDemoConfig, startDemoSession, stopDemoSession } from '../demo/demoClient.js';
import { WsSessionClient, type StreamPhase } from '../ws/wsClient.js';
import {
  DEFAULT_WORKSPACE_ID,
  isActiveWorkspaceSession,
  withSessionAssigned,
  withWorkspaceCreated,
  withWorkspaceDeleted,
  type WorkspaceRecord,
} from './workspacesModel.js';
import { initialWorkspaceSnapshot, saveWorkspaceSnapshot } from './workspaceStorage.js';

/** Envelope cap per session — the timeline renders a window; this bounds memory. */
export const MAX_ENVELOPES = 2000;

export interface SessionView {
  id: string;
  name: string;
  connectorLabel: string;
  state: SessionState;
  exit: ExitInfo | null;
  envelopes: AgentEventEnvelope[];
  lastSeq: number | null;
  pendingApproval: ApprovalRequest | null;
  lastDecision: { requestId: string; decision: ApprovalDecision['decision'] } | null;
  phase: StreamPhase | null;
  streamError: string | null;
  /** Tombstone overlay: after a terminal event, transcript view on request. */
  transcriptOpen: boolean;
}

interface SessionStoreState {
  booted: boolean;
  demoAvailable: boolean;
  /** Daemon gateway WS endpoint (no token appended). */
  daemonUrl: string | null;
  /**
   * The daemon's per-boot loopback token. Not a vendor credential and never
   * rendered or persisted — it authorizes this page's WS subscriptions for
   * this boot only.
   */
  daemonToken: string | null;
  sessions: SessionView[];
  activeSessionId: string | null;
  columnCollapsed: boolean;
  /** Named session groups (blueprint: workspaces) — pure logic in workspacesModel. */
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
}

interface SessionStoreActions {
  boot(): Promise<void>;
  startSession(): Promise<void>;
  stopSession(sessionId: string): void;
  setActive(sessionId: string): void;
  toggleColumn(): void;
  createWorkspace(name: string): void;
  deleteWorkspace(id: string): void;
  setActiveWorkspace(id: string): void;
  moveSession(sessionId: string, workspaceId: string): void;
  toggleTranscript(sessionId: string): void;
  decide(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision['decision'],
    reason?: string,
  ): void;
  applyEnvelope(sessionId: string, envelope: AgentEventEnvelope): void;
  /**
   * Batch apply — one store update per coalesced frame. The coalescing
   * boundary turns an N-envelope burst into exactly one set() and one React
   * commit (blueprint ~33 ms frame budget); dedupe still runs per envelope.
   */
  applyEnvelopes(sessionId: string, envelopes: readonly AgentEventEnvelope[]): void;
  setPhase(sessionId: string, phase: StreamPhase): void;
  setStreamError(sessionId: string, message: string | null): void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

/** WS clients are effects, not render state — they live beside the store. */
const clients = new Map<string, WsSessionClient>();
const coalescers = new Map<string, EnvelopeCoalescer>();

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['stopped', 'crashed']);

function patchSession(
  state: SessionStoreState,
  sessionId: string,
  patch: (session: SessionView) => SessionView,
): SessionView[] {
  return state.sessions.map((session) => (session.id === sessionId ? patch(session) : session));
}

function findSession(state: SessionStoreState, sessionId: string): SessionView | undefined {
  return state.sessions.find((session) => session.id === sessionId);
}

/** Boot-time workspace state: the stored snapshot, or the bare default group. */
const initialWorkspaces = initialWorkspaceSnapshot();

/**
 * Pure event → view derivation. Every session fact the UI shows (state badge,
 * tombstone, pending card) is a fold over the envelope stream — nothing else
 * mutates it.
 */
export function deriveEnvelopeView(
  session: SessionView,
  envelope: AgentEventEnvelope,
): SessionView {
  const envelopes = [...session.envelopes, envelope].slice(-MAX_ENVELOPES);
  let { state, exit, pendingApproval, lastDecision } = session;
  const payload = envelope.payload;
  if (payload.kind === 'state_change') {
    state = payload.to;
    exit = payload.exit ?? null;
    pendingApproval = payload.to === 'waiting-approval' ? (payload.request ?? null) : null;
  } else if (payload.kind === 'approval_decision') {
    // Authoritative resolution from the journal — our own optimistic echo, a
    // decision made in another window, or a policy/timeout auto-decision.
    // Clears the matching card only, never a different pending request.
    lastDecision = { requestId: payload.requestId, decision: payload.decision };
    if (pendingApproval?.requestId === payload.requestId) {
      pendingApproval = null;
    }
  }
  return { ...session, envelopes, state, exit, pendingApproval, lastDecision };
}

function emptySession(id: string, name: string): SessionView {
  return {
    id,
    name,
    connectorLabel: 'fake-cli',
    state: 'created',
    exit: null,
    envelopes: [],
    lastSeq: null,
    pendingApproval: null,
    lastDecision: null,
    phase: null,
    streamError: null,
    transcriptOpen: false,
  };
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  booted: false,
  demoAvailable: false,
  daemonUrl: null,
  daemonToken: null,
  sessions: [],
  activeSessionId: null,
  columnCollapsed: false,
  workspaces: initialWorkspaces.workspaces,
  activeWorkspaceId: initialWorkspaces.activeWorkspaceId,

  async boot() {
    set({ booted: true });
    try {
      const config = await fetchDemoConfig();
      set({ daemonUrl: config.wsUrl, daemonToken: config.token, demoAvailable: true });
    } catch {
      // No demo harness — production session control (automation API) is a
      // later PR; the shell still renders with controls disabled.
      set({ daemonUrl: null, daemonToken: null, demoAvailable: false });
    }
  },

  async startSession() {
    const { demoAvailable, daemonUrl } = get();
    if (!demoAvailable || daemonUrl === null) return;
    const name = `agent-${get().sessions.length + 1}`;
    let sessionId: string;
    try {
      sessionId = await startDemoSession(name);
    } catch (error) {
      set({ demoAvailable: false }); // harness went away — degrade the ribbon
      console.error('session start failed', error);
      return;
    }
    set((state) => ({
      sessions: [...state.sessions, emptySession(sessionId, name)],
      // New sessions join the active workspace — the group the operator is
      // looking at is the group they are filling.
      workspaces: withSessionAssigned(state.workspaces, sessionId, state.activeWorkspaceId),
      activeSessionId: sessionId,
    }));
    attachClient(sessionId, daemonUrl);
  },

  stopSession(sessionId) {
    const { demoAvailable } = get();
    const session = findSession(get(), sessionId);
    if (!demoAvailable || session === undefined || TERMINAL_STATES.has(session.state)) return;
    void stopDemoSession(sessionId).catch((error) => {
      console.error('session stop failed', error);
      get().setStreamError(sessionId, 'stop request failed — is the demo harness running?');
    });
  },

  setActive(sessionId) {
    set({ activeSessionId: sessionId });
  },

  toggleColumn() {
    set((state) => ({ columnCollapsed: !state.columnCollapsed }));
  },

  createWorkspace(name) {
    set((state) => ({
      workspaces: withWorkspaceCreated(state.workspaces, `ws-${crypto.randomUUID()}`, name),
    }));
  },

  deleteWorkspace(id) {
    set((state) => {
      const next = withWorkspaceDeleted(state.workspaces, id);
      if (next === null) return state; // default workspace and unknown ids are refused
      return {
        workspaces: next.workspaces,
        activeWorkspaceId:
          state.activeWorkspaceId === id ? DEFAULT_WORKSPACE_ID : state.activeWorkspaceId,
      };
    });
  },

  setActiveWorkspace(id) {
    if (!get().workspaces.some((workspace) => workspace.id === id)) return;
    set({ activeWorkspaceId: id });
  },

  moveSession(sessionId, workspaceId) {
    set((state) => ({
      workspaces: withSessionAssigned(state.workspaces, sessionId, workspaceId),
    }));
  },

  toggleTranscript(sessionId) {
    set((state) => ({
      sessions: patchSession(state, sessionId, (session) => ({
        ...session,
        transcriptOpen: !session.transcriptOpen,
      })),
    }));
  },

  decide(sessionId, requestId, decision, reason) {
    const session = findSession(get(), sessionId);
    if (session === undefined || session.pendingApproval?.requestId !== requestId) return;
    // One path for every decision — the daemon WS round-trip, demo or real
    // connector alike (the harness registers a session handle; the connector
    // writes stdin). Unsent means the card stays pending for another try.
    const trimmed = reason?.trim();
    const sent =
      clients.get(sessionId)?.sendDecision({
        requestId,
        decision,
        ...(trimmed !== undefined && trimmed !== '' && { reason: trimmed }),
      }) ?? false;
    if (!sent) {
      get().setStreamError(sessionId, 'decision not sent — the session stream is not connected');
      return;
    }
    // Optimistic clear; the journaled approval_decision event re-derives the
    // same view authoritatively (replay, resync, or another window).
    set((state) => ({
      sessions: patchSession(state, sessionId, (current) => ({
        ...current,
        pendingApproval: null,
        lastDecision: { requestId, decision },
      })),
    }));
  },

  applyEnvelope(sessionId, envelope) {
    get().applyEnvelopes(sessionId, [envelope]);
  },

  applyEnvelopes(sessionId, envelopes) {
    set((state) => {
      const session = findSession(state, sessionId);
      if (session === undefined || envelopes.length === 0) return state;
      let next = session;
      // The store does not maintain lastSeq (the WS client owns replay
      // dedupe), so the batch tracks its own seen-max, seeded from the last
      // retained envelope to drop replay-tail overlaps.
      let maxSeq = session.envelopes.at(-1)?.seq ?? -1;
      for (const envelope of envelopes) {
        if (envelope.seq <= maxSeq) continue;
        maxSeq = envelope.seq;
        next = deriveEnvelopeView(next, envelope);
      }
      if (next === session) return state;
      if (TERMINAL_STATES.has(next.state)) {
        clients.get(sessionId)?.stop(); // stream over — the tombstone stays
      }
      return { sessions: patchSession(state, sessionId, () => next) };
    });
  },

  setPhase(sessionId, phase) {
    set((state) => ({
      sessions: patchSession(state, sessionId, (session) => ({ ...session, phase })),
    }));
  },

  setStreamError(sessionId, message) {
    set((state) => ({
      sessions: patchSession(state, sessionId, (session) => ({ ...session, streamError: message })),
    }));
  },
}));

/**
 * Workspace persistence — one subscription is the single write path, so no
 * action can forget to save. Fires only when workspace state actually
 * changes (zustand hands us the previous state for comparison).
 */
useSessionStore.subscribe((state, prev) => {
  if (state.workspaces !== prev.workspaces || state.activeWorkspaceId !== prev.activeWorkspaceId) {
    saveWorkspaceSnapshot({
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId,
    });
  }
});

/**
 * Ribbon sessions: the active workspace's members (unfiled sessions show in
 * the default workspace — see isActiveWorkspaceSession). Pair with
 * `useShallow` when consuming — the filter allocates a fresh array.
 */
export function selectVisibleSessions(state: SessionStoreState): SessionView[] {
  return state.sessions.filter((session) =>
    isActiveWorkspaceSession(state.workspaces, state.activeWorkspaceId, session.id),
  );
}

/**
 * Attaches (or re-attaches) a session's WS stream. Exported for tests — the
 * production flow attaches from `startSession`; tests stub the global
 * WebSocket and call this to exercise decisions through the real client.
 */
export function attachClient(sessionId: string, daemonUrl: string): void {
  clients.get(sessionId)?.stop();
  coalescers.get(sessionId)?.destroy();
  const store = useSessionStore;
  const { daemonToken } = store.getState();
  const url =
    daemonToken === null
      ? daemonUrl
      : `${daemonUrl}${daemonUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(daemonToken)}`;
  // Coalescing boundary: per-envelope callbacks batch into one store update
  // per frame, so bursts (replay especially) cost one commit, not N.
  const coalescer = createEnvelopeCoalescer({
    flush: (id, batch) => store.getState().applyEnvelopes(id, batch),
  });
  coalescers.set(sessionId, coalescer);
  const client = new WsSessionClient({
    url,
    sessionId,
    onEnvelope: (envelope) => coalescer.push(sessionId, envelope),
    onPhase: (phase) => store.getState().setPhase(sessionId, phase),
    onProtocolError: (message) => store.getState().setStreamError(sessionId, message),
  });
  clients.set(sessionId, client);
  client.start();
}
