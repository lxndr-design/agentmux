import type {
  AgentEvent,
  AgentEventEnvelope,
  ApprovalDecision,
  ApprovalRequest,
} from '@agentmux/protocol';
import type { EventJournal } from '../journal.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../config.js';
import { PolicyEngine, type AutoDecisionActor, type PolicySelection } from './policy.js';

export type { PolicyPreset, PolicySelection } from './policy.js';

/** How the engine talks to a live session — connector sessions and the demo harness alike. */
export interface ApprovalSessionHandle {
  /**
   * Answers a pending CLI permission prompt over the connector's stdin — the
   * round-trip's closing edge. Denial reasons reach the agent verbatim.
   */
  respondToApproval(decision: ApprovalDecision): void;
}

export interface ApprovalEngineOptions {
  journal: EventJournal;
  /** Fan-out — the gateway's broadcast, injected to keep the engine gateway-free. */
  broadcast(envelope: AgentEventEnvelope): void;
  /** Auto-deny window for pending cards (blueprint: default 10 minutes). */
  timeoutMs?: number;
  policy?: PolicyEngine;
}

export type DecisionOutcome = { ok: true } | { ok: false; error: string };

interface PendingEntry {
  readonly request: ApprovalRequest;
  readonly timer: NodeJS.Timeout;
}

/**
 * The approval engine: every request is evaluated against the session's
 * policy; escalations render as pinned-column cards, and every resolution —
 * human, policy, or timeout — is journaled as an `approval_decision` event
 * before the session handle hears about it.
 *
 * Journal-first, always: `ingest` writes the request event (seq n) before a
 * policy auto-decision (seq n+1), and only then calls the session handle —
 * so the connector's resumed `working` event (seq n+2) lands after both, and
 * a replay reconstructs exactly what happened.
 */
export class ApprovalEngine {
  private readonly pending = new Map<string, Map<string, PendingEntry>>();
  private readonly handles = new Map<string, ApprovalSessionHandle>();
  private readonly timeoutMs: number;
  private readonly journal: EventJournal;
  private readonly broadcast: (envelope: AgentEventEnvelope) => void;
  readonly policy: PolicyEngine;

  constructor(options: ApprovalEngineOptions) {
    this.journal = options.journal;
    this.broadcast = options.broadcast;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.policy = options.policy ?? new PolicyEngine();
  }

  /**
   * The daemon's sole ingest path: pass-through for ordinary events, and for
   * a request-riding transition — journal, register, then evaluate policy.
   */
  ingest(sessionId: string, event: AgentEvent): AgentEventEnvelope {
    if (event.kind === 'state_change' && event.to === 'waiting-approval' && event.request) {
      return this.ingestRequest(sessionId, event);
    }
    if (event.kind === 'state_change' && (event.to === 'stopped' || event.to === 'crashed')) {
      // A dead session answers nothing: drop pending timers (a timeout must
      // not journal a bogus decision after the exit) and forget policy state.
      this.dropPending(sessionId);
      this.handles.delete(sessionId);
      this.policy.forget(sessionId);
    }
    return this.appendAndFanOut(sessionId, event);
  }

  /** Wires a live session so the engine can close the round-trip over stdin. */
  attachSession(sessionId: string, handle: ApprovalSessionHandle): void {
    this.handles.set(sessionId, handle);
  }

  /** Selects the session's policy preset (per-connector mapping in policy.ts). */
  setPolicy(sessionId: string, selection: PolicySelection): void {
    this.policy.select(sessionId, selection);
  }

  /**
   * Resolves a pending request — the human path (WS decisions land here via
   * the gateway) and the auto path (policy and timeout both call this).
   * Journals the decision first; only then does the session resume.
   */
  resolve(
    sessionId: string,
    decision: ApprovalDecision,
    actor: 'human' | AutoDecisionActor,
    reason?: string,
  ): DecisionOutcome {
    const entry = this.pending.get(sessionId)?.get(decision.requestId);
    if (entry === undefined) {
      return { ok: false, error: `unknown or already-resolved request ${decision.requestId}` };
    }
    clearTimeout(entry.timer);
    this.pending.get(sessionId)!.delete(decision.requestId);

    // The caller's explicit reason wins; the actor's default reason fills the gap.
    const effective: ApprovalDecision =
      decision.reason === undefined && reason !== undefined ? { ...decision, reason } : decision;
    this.appendAndFanOut(sessionId, {
      kind: 'approval_decision',
      requestId: decision.requestId,
      decision: effective.decision,
      actor,
      ...(effective.reason !== undefined ? { reason: effective.reason } : {}),
    });
    if (decision.decision === 'approve-for-session') {
      this.policy.grant(sessionId, entry.request);
    }
    this.handles.get(sessionId)?.respondToApproval(effective);
    return { ok: true };
  }

  /** Requests currently awaiting a human decision, for host-side introspection. */
  pendingRequests(sessionId: string): readonly ApprovalRequest[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])].map((entry) => entry.request);
  }

  private ingestRequest(
    sessionId: string,
    event: Extract<AgentEvent, { kind: 'state_change' }>,
  ): AgentEventEnvelope {
    const request = event.request!;
    const envelope = this.appendAndFanOut(sessionId, event);

    const timer = setTimeout(() => {
      void this.resolve(
        sessionId,
        { requestId: request.requestId, decision: 'deny' },
        'timeout',
        `auto-denied: approval timeout after ${String(this.timeoutMs)}ms (blueprint: pending cards auto-deny)`,
      );
    }, this.timeoutMs);
    this.registerPending(sessionId, { request, timer });

    const evaluation = this.policy.evaluate(sessionId, request);
    if (evaluation.action === 'auto-approve') {
      this.resolve(sessionId, { requestId: request.requestId, decision: 'approve' }, 'policy');
    } else if (evaluation.action === 'auto-deny') {
      this.resolve(
        sessionId,
        { requestId: request.requestId, decision: 'deny' },
        'policy',
        evaluation.reason,
      );
    }
    return envelope;
  }

  private registerPending(sessionId: string, entry: PendingEntry): void {
    let pending = this.pending.get(sessionId);
    if (pending === undefined) {
      pending = new Map();
      this.pending.set(sessionId, pending);
    }
    pending.set(entry.request.requestId, entry);
  }

  private dropPending(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending === undefined) return;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  }

  private appendAndFanOut(sessionId: string, event: AgentEvent): AgentEventEnvelope {
    // Journal first, fan out second — the daemon's sequencing invariant.
    const envelope = this.journal.append(sessionId, event);
    this.broadcast(envelope);
    return envelope;
  }
}
