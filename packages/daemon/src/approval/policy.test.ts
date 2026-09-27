import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, ApprovalRisk } from '@agentmux/protocol';
import { PolicyEngine, rulesFor } from './policy.js';

function request(tool: string, risk: ApprovalRisk): ApprovalRequest {
  return { requestId: `req_${tool}_${risk}`, tool, risk, command: `${tool.toLowerCase()} ...` };
}

/** The four shapes the presets are compared on. */
const PROBES = [
  request('Edit', 'medium'),
  request('Bash', 'medium'),
  request('Bash', 'high'),
  request('Read', 'low'),
] as const;

describe('policy matrix', () => {
  it('default — and unselected sessions — escalates every request', () => {
    const engine = new PolicyEngine();
    for (const probe of PROBES) {
      expect(engine.evaluate('s1', probe)).toEqual({ action: 'escalate' });
    }
    // An unselected session runs the shared default.
    const fresh = new PolicyEngine();
    expect(fresh.evaluate('unselected', PROBES[0]!)).toEqual({ action: 'escalate' });
  });

  it('plan denies file edits outright — even high-risk ones — and escalates the rest', () => {
    const engine = new PolicyEngine();
    engine.select('s1', { connectorId: 'claude-code', preset: 'plan' });
    expect(engine.evaluate('s1', request('Edit', 'medium'))).toEqual({
      action: 'auto-deny',
      reason: 'plan mode — file edits are denied until the plan is approved (preset: plan)',
    });
    expect(engine.evaluate('s1', request('Write', 'high')).action).toBe('auto-deny');
    expect(engine.evaluate('s1', request('apply_patch', 'medium')).action).toBe('auto-deny');
    expect(engine.evaluate('s1', request('Bash', 'medium'))).toEqual({ action: 'escalate' });
    expect(engine.evaluate('s1', request('Read', 'low'))).toEqual({ action: 'escalate' });
  });

  it('acceptEdits auto-approves medium/low file edits and escalates everything else', () => {
    const engine = new PolicyEngine();
    engine.select('s1', { connectorId: 'claude-code', preset: 'acceptEdits' });
    expect(engine.evaluate('s1', request('Edit', 'medium'))).toEqual({ action: 'auto-approve' });
    expect(engine.evaluate('s1', request('Write', 'low'))).toEqual({ action: 'auto-approve' });
    // High risk is never auto-approved — no preset waives the conscience.
    expect(engine.evaluate('s1', request('Edit', 'high'))).toEqual({ action: 'escalate' });
    // Non-edit tools are outside the preset's allowlist.
    expect(engine.evaluate('s1', request('Bash', 'medium'))).toEqual({ action: 'escalate' });
  });

  it('dontAsk approves medium/low classes but keeps high-risk requests on the human path', () => {
    const engine = new PolicyEngine();
    engine.select('s1', { connectorId: 'claude-code', preset: 'dontAsk' });
    expect(engine.evaluate('s1', request('Bash', 'medium'))).toEqual({ action: 'auto-approve' });
    expect(engine.evaluate('s1', request('Read', 'low'))).toEqual({ action: 'auto-approve' });
    expect(engine.evaluate('s1', request('Bash', 'high'))).toEqual({ action: 'escalate' });
    expect(engine.evaluate('s1', request('Edit', 'medium'))).toEqual({ action: 'auto-approve' });
  });
});

describe('per-session grants (approve-for-session)', () => {
  it('auto-approves the granted tool+risk pair and escalates the next different request', () => {
    const engine = new PolicyEngine();
    const bash = request('Bash', 'medium');
    engine.grant('s1', bash);
    expect(engine.evaluate('s1', bash)).toEqual({ action: 'auto-approve' });
    expect(engine.evaluate('s1', request('Bash', 'medium'))).toEqual({ action: 'auto-approve' });
    // Different tool, or a higher risk of the same tool — human eyes again.
    expect(engine.evaluate('s1', request('Edit', 'medium'))).toEqual({ action: 'escalate' });
    expect(engine.evaluate('s1', request('Bash', 'high'))).toEqual({ action: 'escalate' });
  });

  it('deny rules outrank grants — a plan session cannot grant its way into edits', () => {
    const engine = new PolicyEngine();
    engine.select('s1', { connectorId: 'claude-code', preset: 'plan' });
    engine.grant('s1', request('Edit', 'medium'));
    expect(engine.evaluate('s1', request('Edit', 'medium')).action).toBe('auto-deny');
  });

  it('grants never auto-approve high risk even when granted explicitly', () => {
    const engine = new PolicyEngine();
    engine.grant('s1', request('Bash', 'high'));
    expect(engine.evaluate('s1', request('Bash', 'high'))).toEqual({ action: 'escalate' });
  });

  it('forget drops the selection and the grants', () => {
    const engine = new PolicyEngine();
    engine.select('s1', { connectorId: 'claude-code', preset: 'acceptEdits' });
    engine.grant('s1', request('Bash', 'medium'));
    engine.forget('s1');
    expect(engine.selectionFor('s1')).toEqual({ connectorId: 'generic', preset: 'default' });
    expect(engine.evaluate('s1', request('Edit', 'medium'))).toEqual({ action: 'escalate' });
  });
});

describe('per-connector preset mapping', () => {
  it('maps claude-code presets natively', () => {
    expect(rulesFor('claude-code', 'plan').deny?.tools.has('Edit')).toBe(true);
    expect(rulesFor('claude-code', 'acceptEdits').allow?.tools.has('Edit')).toBe(true);
  });

  it('falls back to the shared vocabulary for connectors without a mapping', () => {
    expect(rulesFor('codex', 'plan')).toEqual(rulesFor('claude-code', 'plan'));
    expect(rulesFor('something-new', 'dontAsk').allow?.risks).toBeDefined();
  });
});
