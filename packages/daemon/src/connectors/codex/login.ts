import { execFile } from 'node:child_process';
import type { ConnectorDetectResult } from '../types.js';

/**
 * Codex login-state detection (brief: "distinguish 'signed in with ChatGPT'
 * vs API-key vs not-authenticated" — blueprint F3a/F3b). `codex login
 * status` reports the active auth mode on stderr; its exit code is nonzero
 * when not logged in. Credentials are the user's own, inside the CLI's own
 * config — agentmux never reads, stores, or transmits them.
 */

export type CodexLoginState = 'chatgpt' | 'api-key' | 'other' | 'none' | 'unavailable';

export interface LoginStatusResult {
  /** null = the binary could not be spawned at all. */
  code: number | null;
  stderr: string;
}

export type LoginStatusRunner = (binary: string) => Promise<LoginStatusResult>;

/** Runs `codex login status` — injectable so tests never need the real CLI. */
export const defaultLoginStatusRunner: LoginStatusRunner = (binary) =>
  new Promise((resolve) => {
    execFile(binary, ['login', 'status'], { timeout: 5_000 }, (error, _stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ code: null, stderr: '' });
        return;
      }
      // error.code is the process exit code here (a number); anything else
      // that is not a clean exit also surfaces as unavailable upstream.
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stderr });
    });
  });

/**
 * Pure classifier over the `login status` output — the exit code separates
 * not-logged-in from logged-in; the stderr wording separates the ChatGPT
 * subscription path from the API-key path.
 */
export function classifyLoginStatus(output: string, exitCode: number | null): CodexLoginState {
  if (exitCode === null) return 'unavailable';
  if (exitCode !== 0) return 'none';
  if (output.includes('Logged in using ChatGPT')) return 'chatgpt';
  if (output.includes('Logged in using an API key')) return 'api-key';
  return 'other';
}

export async function detectLoginState(
  binary: string,
  runner: LoginStatusRunner = defaultLoginStatusRunner,
): Promise<CodexLoginState> {
  const { code, stderr } = await runner(binary);
  return classifyLoginStatus(stderr, code);
}

/** Maps a login state onto the wizard-facing auth fields on detect(). */
export function authFieldsFor(
  login: CodexLoginState,
): Pick<ConnectorDetectResult, 'authState' | 'authDetail'> {
  switch (login) {
    case 'chatgpt':
      return {
        authState: 'subscription',
        authDetail: 'Signed in with ChatGPT (subscription billing)',
      };
    case 'api-key':
      return {
        authState: 'api-key',
        authDetail: 'Logged in with an API key — not the subscription path',
      };
    case 'other':
      return { authState: 'other', authDetail: 'Logged in with an unrecognized auth mode' };
    case 'none':
      return {
        authState: 'none',
        authDetail:
          'Not logged in — run `codex login` (Sign in with ChatGPT) or `codex login --api-key`',
      };
    case 'unavailable':
      return {
        authState: 'unavailable',
        authDetail: 'Could not determine login state (`codex login status` failed)',
      };
  }
}
