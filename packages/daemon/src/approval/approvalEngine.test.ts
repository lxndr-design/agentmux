import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventEnvelope, ApprovalRequest } from '@agentmux/protocol';
import { EventJournal } from '../journal.js';
import { ApprovalEngine, type ApprovalSessionHandle } from './approvalEngine.js';

function approvalRequest(
  requestId: string,
  tool = 'Bash',
  risk: ApprovalRequest['risk'] = 'high',
): ApprovalRequest {
  return { requestId, tool, risk, command: 'rm -rf ./dist' };
}

function blockedEvent(request: ApprovalRequest): AgentEvent {
  return {
    kind: 'state_change',
    from: 'working',
    to: 'waiting-approval',
    request,
  };
}

interface Harness {
  engine: ApprovalEngine;
  envelopes: AgentEventEnvelope[];
  handle: ApprovalSessionHandle & { decisions: unknown[] };
}

/** A real in-memory journal + captured fan-out + a recording session handle. */
function makeHarness(options: { timeoutMs?: number } = {}): Harness {
  const envelopes: AgentEventEnvelope[] = [];
  const engine = new ApprovalEngine({
    journal: new EventJournal(':memory:'),
    broadcast: (envelope) => envelopes.push(envelope),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const decisions: unknown[] = [];
  const handle = { respondToApproval: (decision: unknown) => decisions.push(decision), decisions };
  engine.attachSession('s1', handle);
  return { engine, envelopes, handle };
}

const decisionEvents = (envelopes: AgentEventEnvelope[]) =>
  envelopes
    .filter((envelope) => envelope.payload.kind === 'approval_decision')
    .map((envelope) => envelope.payload);

const stateChanges = (envelopes: AgentEventEnvelope[]) =>
  envelopes
    .filter((envelope) => envelope.payload.kind === 'state_change')
    .map((envelope) => envelope.payload);

async function until(
  description: string,
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ingest', () => {
  it('journals and fans out ordinary events untouched', () => {
    const { engine, envelopes } = makeHarness();
    const envelope = engine.ingest('s1', { kind: 'thinking', text: 'hmm', done: true });
    expect(envelope.seq).toBe(0);
    expect(envelopes).toHaveLength(1);
    expect(engine.pendingRequests('s1')).toEqual([]);
  });

  it('journals a request-riding transition and escalates under the default preset', () => {
    const { engine, envelopes, handle } = makeHarness();
    const request = approvalRequest('r1');
    engine.ingest('s1', blockedEvent(request));

    expect(stateChanges(envelopes)).toEqual([blockedEvent(request)]);
    expect(engine.pendingRequests('s1')).toEqual([request]);
    // No auto path ran — the card waits for a human, no decision events yet.
    expect(decisionEvents(envelopes)).toEqual([]);
    expect(handle.decisions).toEqual([]);
  });

  it('keeps one pending entry per request id and drops it after resolution', () => {
    const { engine, envelopes } = makeHarness();
    const request = approvalRequest('r1');
    engine.ingest('s1', blockedEvent(request));
    engine.resolve('s1', { requestId: 'r1', decision: 'approve' }, 'human');
    expect(engine.pendingRequests('s1')).toEqual([]);
    // A second resolve of the same id is rejected — no double-decision.
    expect(engine.resolve('s1', { requestId: 'r1', decision: 'deny' }, 'human')).toEqual({
      ok: false,
      error: 'unknown or already-resolved request r1',
    });
    expect(decisionEvents(envelopes)).toHaveLength(1);
  });

  it('cleans pending timers, handles, and policy on a terminal transition', async () => {
    vi.useFakeTimers();
    try {
      const { engine, envelopes, handle } = makeHarness({ timeoutMs: 20 });
      const request = approvalRequest('r1');
      engine.ingest('s1', blockedEvent(request));
      engine.ingest('s1', {
        kind: 'state_change',
        from: 'waiting-approval',
        to: 'stopped',
        exit: { code: 0, reason: 'operator' },
      });
      expect(engine.pendingRequests('s1')).toEqual([]);

      // The timeout fires after the session died — it must not journal a
      // bogus decision for a dead session.
      await vi.advanceTimersByTimeAsync(100);
      expect(decisionEvents(envelopes)).toEqual([]);
      expect(handle.decisions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('journal-first ordering', () => {
  it('assigns the decision event the next seq before the session handle resumes', () => {
    const { engine, envelopes, handle } = makeHarness();
    engine.setPolicy('s1', { connectorId: 'claude-code', preset: 'acceptEdits' });
    const request = approvalRequest('r1', 'Edit', 'medium');

    engine.ingest('s1', blockedEvent(request));
    expect(handle.decisions).toEqual([{ requestId: 'r1', decision: 'approve' }]);

    // request (seq 0) then the auto-approval decision (seq 1): a replay
    // reconstructs exactly what happened, in order.
    expect(envelopes.map((envelope) => envelope.payload.kind)).toEqual([
      'state_change',
      'approval_decision',
    ]);
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([0, 1]);
  });

  it('auto-denies with the policy reason on the decision event', () => {
    const { engine, envelopes, handle } = makeHarness();
    engine.setPolicy('s1', { connectorId: 'claude-code', preset: 'plan' });

    engine.ingest('s1', blockedEvent(approvalRequest('r1', 'Edit', 'medium')));

    expect(decisionEvents(envelopes)).toEqual([
      {
        kind: 'approval_decision',
        requestId: 'r1',
        decision: 'deny',
        actor: 'policy',
        reason: 'plan mode — file edits are denied until the plan is approved (preset: plan)',
      },
    ]);
    // The denial reason is what the agent receives.
    expect(handle.decisions).toEqual([
      {
        requestId: 'r1',
        decision: 'deny',
        reason: 'plan mode — file edits are denied until the plan is approved (preset: plan)',
      },
    ]);
  });
});

describe('resolve (the human path)', () => {
  it('journals the human decision and passes the reason to the session', () => {
    const { engine, envelopes, handle } = makeHarness();
    engine.ingest('s1', blockedEvent(approvalRequest('r1')));

    const outcome = engine.resolve(
      's1',
      { requestId: 'r1', decision: 'deny' },
      'human',
      'no filesystem mutation today',
    );

    expect(outcome).toEqual({ ok: true });
    expect(decisionEvents(envelopes)).toEqual([
      {
        kind: 'approval_decision',
        requestId: 'r1',
        decision: 'deny',
        actor: 'human',
        reason: 'no filesystem mutation today',
      },
    ]);
    expect(handle.decisions).toEqual([
      { requestId: 'r1', decision: 'deny', reason: 'no filesystem mutation today' },
    ]);
  });

  it('prefers the caller decision reason over the actor default reason', () => {
    const { engine, envelopes } = makeHarness();
    engine.ingest('s1', blockedEvent(approvalRequest('r1')));
    engine.resolve(
      's1',
      { requestId: 'r1', decision: 'deny', reason: 'because I said so' },
      'timeout',
      'fallback reason',
    );
    expect(decisionEvents(envelopes)[0]?.reason).toBe('because I said so');
  });

  it('rejects decisions for an unknown session or request id', () => {
    const { engine } = makeHarness();
    expect(engine.resolve('ghost', { requestId: 'r1', decision: 'approve' }, 'human')).toEqual({
      ok: false,
      error: 'unknown or already-resolved request r1',
    });
  });

  it('approve-for-session registers a grant that resolves the next identical request', () => {
    const { engine, envelopes, handle } = makeHarness();
    const first = approvalRequest('r1', 'Bash', 'medium');
    engine.ingest('s1', blockedEvent(first));
    engine.resolve('s1', { requestId: 'r1', decision: 'approve-for-session' }, 'human');
    expect(engine.pendingRequests('s1')).toEqual([]);

    // Same class again — the grant answers before any human sees a card.
    const second = approvalRequest('r2', 'Bash', 'medium');
    engine.ingest('s1', blockedEvent(second));
    expect(engine.pendingRequests('s1')).toEqual([]);
    expect(decisionEvents(envelopes).at(-1)).toMatchObject({
      requestId: 'r2',
      decision: 'approve',
      actor: 'policy',
    });

    // But a high-risk Bash still escalates — grants never waive the conscience.
    const risky = approvalRequest('r3', 'Bash', 'high');
    engine.ingest('s1', blockedEvent(risky));
    expect(engine.pendingRequests('s1')).toEqual([risky]);
    expect(
      handle.decisions.filter(
        (decision) => (decision as { decision: string }).decision === 'approve-for-session',
      ),
    ).toHaveLength(1);
  });
});

describe('timeout auto-deny', () => {
  it('denies the pending request when the window expires, with the timeout as the denial reason', async () => {
    const { engine, envelopes, handle } = makeHarness({ timeoutMs: 25 });
    engine.ingest('s1', blockedEvent(approvalRequest('r1')));

    await until('the timeout decision', () => decisionEvents(envelopes).length > 0);
    expect(decisionEvents(envelopes)[0]).toMatchObject({
      requestId: 'r1',
      decision: 'deny',
      actor: 'timeout',
    });
    expect(String(decisionEvents(envelopes)[0]?.reason)).toMatch(/timeout/);
    // The agent hears the timeout as its denial reason.
    expect(handle.decisions).toEqual([
      { requestId: 'r1', decision: 'deny', reason: expect.stringMatching(/timeout/) },
    ]);
    expect(engine.pendingRequests('s1')).toEqual([]);
  });
});
