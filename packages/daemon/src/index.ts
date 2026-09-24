import { createEnvelope, type Envelope } from '@agentmux/protocol';

/**
 * Daemon stub — the supervisor, approval policy engine, FS bridge, and SQLite
 * journal land in later PRs. This entry keeps the workspace link to the
 * protocol package exercised end to end.
 */

/** Fixed loopback port for the daemon's WebSocket server (blueprint: ws://127.0.0.1:8787). */
export const DAEMON_DEFAULT_PORT = 8787;

export interface DaemonOptions {
  port?: number;
}

export function resolveDaemonOptions(options: DaemonOptions = {}): Required<DaemonOptions> {
  return { port: options.port ?? DAEMON_DEFAULT_PORT };
}

/** Stub session-status envelope; replaced when the real supervisor lands. */
export function sessionReadyEnvelope(sessionId: string): Envelope<{ status: 'ready' }> {
  return createEnvelope(sessionId, 0, 'session.status', { status: 'ready' });
}
