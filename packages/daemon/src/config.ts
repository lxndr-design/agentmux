/**
 * Daemon options — loopback-only by construction.
 *
 * The blueprint pins v1 to a local, single-user host (Q2): the daemon binds a
 * loopback interface and serves nothing else. `resolveDaemonOptions` refuses
 * any non-loopback host up front, so a misconfigured caller fails at boot
 * instead of silently exposing agent sessions to the LAN.
 */

import { resolveRuntimeId, type RuntimeId } from './runtime.js';
import type { AgentConnector } from './connectors/types.js';

export const DAEMON_DEFAULT_PORT = 8787;
export const DAEMON_DEFAULT_HOST = '127.0.0.1';
/** Blueprint "Timeout": pending approval cards auto-deny after ten minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export interface DaemonOptions {
  /** TCP port; 0 lets the OS pick an ephemeral port (tests rely on this). */
  port?: number;
  /** Loopback interfaces only — 'localhost' is normalized to '127.0.0.1'. */
  host?: string;
  /** SQLite journal file; ':memory:' keeps everything in-process. */
  journalPath?: string;
  /**
   * The workspace the FS bridge and worktrees live under. Defaults to the
   * process cwd — the checkout agentmux itself runs from.
   */
  workspaceRoot?: string;
  /**
   * The default runtime sessions provision in (blueprint: "Runtime
   * abstraction"). `worktree` is the default; `local` is the explicit
   * no-isolation trade-off. A session spec may still choose per session.
   */
  runtime?: RuntimeId;
  /**
   * Pending approval cards auto-deny after this window (blueprint: "Timeout",
   * default 10 minutes); the agent receives the timeout as its denial reason.
   */
  approvalTimeoutMs?: number;
  /**
   * Test seam (like the supervisor's `command`/`extraArgs`): extra or
   * replacement connectors, merged over the shipped `claude-code`/`codex`
   * pair so integration tests can drive sessions through a fake connector —
   * never a real CLI, never API keys. Production never passes this.
   */
  connectors?: ReadonlyMap<string, AgentConnector>;
}

export type ResolvedDaemonOptions = Required<DaemonOptions>;

export function resolveDaemonOptions(options: DaemonOptions = {}): ResolvedDaemonOptions {
  const host = options.host ?? DAEMON_DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `daemon binds loopback only — refusing host "${host}" (blueprint Q2: local-only in v1)`,
    );
  }
  return {
    port: options.port ?? DAEMON_DEFAULT_PORT,
    host: host === 'localhost' ? DAEMON_DEFAULT_HOST : host,
    journalPath: options.journalPath ?? ':memory:',
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    runtime: resolveRuntimeId(options.runtime),
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    connectors: options.connectors ?? new Map<string, AgentConnector>(),
  };
}
