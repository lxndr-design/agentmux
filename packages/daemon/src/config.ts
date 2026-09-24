/**
 * Daemon options — loopback-only by construction.
 *
 * The blueprint pins v1 to a local, single-user host (Q2): the daemon binds a
 * loopback interface and serves nothing else. `resolveDaemonOptions` refuses
 * any non-loopback host up front, so a misconfigured caller fails at boot
 * instead of silently exposing agent sessions to the LAN.
 */

export const DAEMON_DEFAULT_PORT = 8787;
export const DAEMON_DEFAULT_HOST = '127.0.0.1';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export interface DaemonOptions {
  /** TCP port; 0 lets the OS pick an ephemeral port (tests rely on this). */
  port?: number;
  /** Loopback interfaces only — 'localhost' is normalized to '127.0.0.1'. */
  host?: string;
  /** SQLite journal file; ':memory:' keeps everything in-process. */
  journalPath?: string;
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
  };
}
