import { describe, expect, it } from 'vitest';
import { approvalDecisionSchema, approvalRequestSchema } from './approval';

const baseRequest = { requestId: 'req_1', tool: 'Bash', risk: 'high' as const };

describe('approvalRequestSchema', () => {
  it('accepts a request carrying the full command', () => {
    expect(approvalRequestSchema.parse({ ...baseRequest, command: 'rm -rf ./dist' })).toEqual({
      requestId: 'req_1',
      tool: 'Bash',
      risk: 'high',
      command: 'rm -rf ./dist',
    });
  });

  it('accepts a diff or affected paths as the full detail', () => {
    expect(() =>
      approvalRequestSchema.parse({ ...baseRequest, diff: '--- a/src/app.ts\n+++ b/src/app.ts' }),
    ).not.toThrow();
    expect(() =>
      approvalRequestSchema.parse({ ...baseRequest, paths: ['src/app.ts'] }),
    ).not.toThrow();
  });

  it('rejects a summary-only request with no command, diff, or paths', () => {
    expect(() => approvalRequestSchema.parse(baseRequest)).toThrow();
    expect(() => approvalRequestSchema.parse({ ...baseRequest, paths: [] })).toThrow();
  });

  it('rejects an unknown risk class', () => {
    expect(() =>
      approvalRequestSchema.parse({ ...baseRequest, risk: 'catastrophic', command: 'ls' }),
    ).toThrow();
  });
});

describe('approvalDecisionSchema', () => {
  it('accepts approve, approve-for-session, and deny with a reason', () => {
    expect(approvalDecisionSchema.parse({ requestId: 'req_1', decision: 'approve' })).toEqual({
      requestId: 'req_1',
      decision: 'approve',
    });
    expect(
      approvalDecisionSchema.parse({ requestId: 'req_1', decision: 'approve-for-session' }),
    ).toEqual({
      requestId: 'req_1',
      decision: 'approve-for-session',
    });
    expect(
      approvalDecisionSchema.parse({ requestId: 'req_1', decision: 'deny', reason: 'timeout' }),
    ).toEqual({
      requestId: 'req_1',
      decision: 'deny',
      reason: 'timeout',
    });
  });

  it('rejects an unknown decision', () => {
    expect(() => approvalDecisionSchema.parse({ requestId: 'req_1', decision: 'maybe' })).toThrow();
  });
});
