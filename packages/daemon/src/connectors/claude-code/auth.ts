import { execFile } from 'node:child_process';
import type { ConnectorDetectResult } from '../types.js';

/**
 * Claude Code login-state detection via the documented `claude auth status`
 * probe (CLI reference: "Show authentication status as JSON… Exits with code
 * 0 if logged in, 1 if not"). The JSON payload's fields are not a documented
 * contract, so classification uses the exit code only — distinguishing
 * subscription from Console billing is left to a future revision rather than
 * guessed field names (Q5 discipline). Credentials stay with the CLI;
 * agentmux reads nothing but the exit code.
 */

export type AuthStatusResult = { code: number | null };
export type AuthStatusRunner = (binary: string) => Promise<AuthStatusResult>;

/** Runs `claude auth status` — injectable so tests never need the real CLI. */
export const defaultAuthStatusRunner: AuthStatusRunner = (binary) =>
  new Promise((resolve) => {
    execFile(binary, ['auth', 'status'], { timeout: 5_000 }, (error) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ code: null });
        return;
      }
      // error.code is the process exit code here (a number); anything else
      // that is not a clean exit also surfaces as unavailable upstream.
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code });
    });
  });

/** Pure exit-code classification — the onboarding-facing auth fields. */
export function classifyAuthStatus(
  code: number | null,
): Pick<ConnectorDetectResult, 'authState' | 'authDetail'> {
  if (code === null) {
    return {
      authState: 'unavailable',
      authDetail: 'Could not determine login state (`claude auth status` failed)',
    };
  }
  if (code === 0) {
    return {
      authState: 'logged-in',
      authDetail: 'Logged in (`claude auth status` exit 0) — the CLI owns the credentials',
    };
  }
  return {
    authState: 'none',
    authDetail: 'Not logged in — run `claude auth login`, or start `claude` and use /login',
  };
}
