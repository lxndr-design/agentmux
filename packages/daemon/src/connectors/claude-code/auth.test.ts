import { describe, expect, it } from 'vitest';
import { classifyAuthStatus, defaultAuthStatusRunner } from './auth.js';

/**
 * Claude Code login-state classification: the documented `claude auth
 * status` probe answers with exit code only (0 logged in, 1 not) — the JSON
 * payload's fields are not a documented contract, so none are guessed here
 * (Q5 discipline). Credentials stay with the CLI; these tests need no real
 * binary.
 */
describe('classifyAuthStatus', () => {
  it('maps exit 0 to logged-in', () => {
    expect(classifyAuthStatus(0)).toEqual({
      authState: 'logged-in',
      authDetail: expect.stringContaining('claude auth status'),
    });
  });

  it('maps a nonzero exit to not-logged-in with the guided fix', () => {
    const result = classifyAuthStatus(1);
    expect(result.authState).toBe('none');
    expect(result.authDetail).toContain('claude auth login');
    // Any nonzero exit is the same story — 127 is "binary found but failed".
    expect(classifyAuthStatus(127).authState).toBe('none');
  });

  it('maps a failed probe (null) to unavailable, never to not-logged-in', () => {
    // A broken install must not advertise a login fix as if login were the problem.
    expect(classifyAuthStatus(null)).toEqual({
      authState: 'unavailable',
      authDetail: expect.stringContaining('Could not determine login state'),
    });
  });
});

describe('defaultAuthStatusRunner', () => {
  it('reports an unavailable probe (code null) for a missing binary', async () => {
    const result = await defaultAuthStatusRunner('agentmux-no-such-cli-fixture');
    expect(result).toEqual({ code: null });
  });
});
