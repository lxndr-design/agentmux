import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { agentmuxDir } from './runtime.js';

/**
 * The `.agentmux/init` hook (blueprint F4b parity: Mux's init hooks + runtime
 * env) — a workspace-level script run once per session start, after the
 * runtime provisions the exec root and before the CLI spawns. It is how one
 * script adapts to where it runs: install dependencies into a fresh worktree,
 * start a dev server for a preview pane, print diagnostics — reading
 * `AGENTMUX_RUNTIME` to tell `worktree` from `local`.
 *
 * Containment rules:
 * - The hook is resolved from the **workspace root's** `.agentmux/`, never
 *   from the provisioned worktree. Agents write files inside their own
 *   worktrees; the main checkout's `.agentmux/` is the human's. A hook an
 *   agent could plant in its worktree would be a prompt-injection-shaped
 *   footgun — this layout makes it structurally unreachable.
 * - The hook executes directly (execFile, argument array — never a shell) and
 *   must carry the executable bit; the error for a missing bit says so.
 * - A nonzero exit, signal death, or timeout fails the session start loudly:
 *   "agent won't start" arrives with the hook's own stderr attached.
 */
export const INIT_HOOK_RELATIVE_PATH = '.agentmux/init';
/** A hung hook must not wedge the daemon — bounded by default, configurable for slow installs. */
export const INIT_HOOK_TIMEOUT_MS = 60_000;
/** Hook output is diagnostics, not a transfer channel. */
const INIT_HOOK_MAX_BUFFER_BYTES = 1024 * 1024;

export type InitHookErrorCode = 'E_NOT_EXECUTABLE' | 'E_FAILED' | 'E_TIMEOUT';

export class InitHookError extends Error {
  constructor(
    readonly code: InitHookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InitHookError';
  }
}

export interface InitHookOptions {
  /** Where the hook lives: `<workspaceRoot>/.agentmux/init`. */
  workspaceRoot: string;
  /** Where the hook runs: the provisioned exec root (worktree or main checkout). */
  cwd: string;
  /** The session environment — the runtime env plus session identity. */
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface InitHookResult {
  /** False when the workspace defines no hook — a hook is opt-in. */
  ran: boolean;
}

/**
 * Runs the workspace's init hook for one session, if it has one. The hook
 * inherits the caller's environment plus the session's `AGENTMUX_*` vars, and
 * starts with its cwd at the provisioned root.
 */
export async function runInitHook(options: InitHookOptions): Promise<InitHookResult> {
  const hookPath = path.join(agentmuxDir(path.resolve(options.workspaceRoot)), 'init');
  const hookStat = await stat(hookPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (hookStat === undefined) {
    return { ran: false };
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      hookPath,
      [],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? INIT_HOOK_TIMEOUT_MS,
        maxBuffer: INIT_HOOK_MAX_BUFFER_BYTES,
        env: { ...process.env, ...options.env },
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        if (error.code === 'EACCES') {
          reject(
            new InitHookError(
              'E_NOT_EXECUTABLE',
              `${INIT_HOOK_RELATIVE_PATH} is not executable — chmod +x ${hookPath}`,
            ),
          );
          return;
        }
        // execFile kills the child only via the timeout option, so any signal
        // death here is the timeout firing — never an external signal.
        if (error.killed === true || error.signal !== null) {
          reject(
            new InitHookError(
              'E_TIMEOUT',
              `${INIT_HOOK_RELATIVE_PATH} did not finish within ${options.timeoutMs ?? INIT_HOOK_TIMEOUT_MS}ms`,
            ),
          );
          return;
        }
        reject(
          new InitHookError(
            'E_FAILED',
            `${INIT_HOOK_RELATIVE_PATH} failed (exit ${error.code ?? 'signal'}): ${tail(stderr)}`,
          ),
        );
      },
    );
  });
  return { ran: true };
}

/** The last stderr lines are the actionable ones — keep the message bounded. */
function tail(stderr: string, maxChars = 2000): string {
  const trimmed = stderr.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}
