import type {
  AgentEventEnvelope,
  ApprovalDecision,
  ApprovalRequest,
  ExitInfo,
  SessionState,
} from '@agentmux/protocol';
import { create } from 'zustand';
import {
  fetchDemoConfig,
  sendDemoDecision,
  startDemoSession,
  stopDemoSession,
} from '../demo/demoClient.js';
import { WsSessionClient, type StreamPhase } from '../ws/wsClient.js';

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
}

interface SessionStoreActions {
  boot(): Promise<void>;
  startSession(): Promise<void>;
  stopSession(sessionId: string): void;
  setActive(sessionId: string): void;
  toggleColumn(): void;
  toggleTranscript(sessionId: string): void;
  decide(sessionId: string, requestId: string, decision: ApprovalDecision['decision']): void;
  applyEnvelope(sessionId: string, envelope: AgentEventEnvelope): void;
  setPhase(sessionId: string, phase: StreamPhase): void;
  setStreamError(sessionId: string, message: string | null): void;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

/** WS clients are effects, not render state — they live beside the store. */
const clients = new Map<string, WsSessionClient>();

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
  let { state, exit, pendingApproval } = session;
  const payload = envelope.payload;
  if (payload.kind === 'state_change') {
    state = payload.to;
    exit = payload.exit ?? null;
    pendingApproval = payload.to === 'waiting-approval' ? (payload.request ?? null) : null;
  }
  return { ...session, envelopes, state, exit, pendingApproval };
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

  toggleTranscript(sessionId) {
    set((state) => ({
      sessions: patchSession(state, sessionId, (session) => ({
        ...session,
        transcriptOpen: !session.transcriptOpen,
      })),
    }));
  },

  decide(sessionId, requestId, decision) {
    const session = findSession(get(), sessionId);
    if (session === undefined || session.pendingApproval?.requestId !== requestId) return;
    set((state) => ({
      sessions: patchSession(state, sessionId, (current) => ({
        ...current,
        pendingApproval: null,
        lastDecision: { requestId, decision },
      })),
    }));
    if (get().demoAvailable) {
      // The decision re-enters the agent via the harness control path; the
      // connector PR replaces this with the stdin round-trip.
      void sendDemoDecision(sessionId, { requestId, decision }).catch((error) => {
        console.error('decision delivery failed', error);
        get().setStreamError(sessionId, 'decision delivery failed — is the demo harness running?');
      });
    }
  },

  applyEnvelope(sessionId, envelope) {
    set((state) => {
      const session = findSession(state, sessionId);
      if (session === undefined) return state;
      // Dedupe: replay tails overlap buffered live frames; resync re-delivers.
      if (session.lastSeq !== null && envelope.seq <= session.lastSeq) return state;
      const next = deriveEnvelopeView(session, envelope);
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

function attachClient(sessionId: string, daemonUrl: string): void {
  clients.get(sessionId)?.stop();
  const store = useSessionStore;
  const { daemonToken } = store.getState();
  const url =
    daemonToken === null
      ? daemonUrl
      : `${daemonUrl}${daemonUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(daemonToken)}`;
  const client = new WsSessionClient({
    url,
    sessionId,
    onEnvelope: (envelope) => store.getState().applyEnvelope(sessionId, envelope),
    onPhase: (phase) => store.getState().setPhase(sessionId, phase),
    onProtocolError: (message) => store.getState().setStreamError(sessionId, message),
  });
  clients.set(sessionId, client);
  client.start();
}
