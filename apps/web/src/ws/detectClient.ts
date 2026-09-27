import type { ConnectorDetectReport } from '@agentmux/protocol';
import { parseServerMessage, type ClientMessage } from './wire.js';

export interface DetectClientOptions {
  timeoutMs?: number;
}

/**
 * One-shot control connection for CLI detection (the onboarding wizard's data
 * source). Detection happens before any session exists, so this opens its own
 * short-lived gateway connection and never touches the per-session stream
 * clients. Resolves with the daemon's report or rejects with a human-readable
 * reason (timeout, protocol error, daemon refusal).
 */
export function detectConnectors(
  daemonUrl: string,
  token: string | null,
  options: DetectClientOptions = {},
): Promise<ConnectorDetectReport[]> {
  const { timeoutMs = 10_000 } = options;
  return new Promise((resolve, reject) => {
    const requestId = `detect-${crypto.randomUUID()}`;
    const url =
      token === null
        ? daemonUrl
        : `${daemonUrl}${daemonUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (
      outcome: { ok: true; results: ConnectorDetectReport[] } | { ok: false; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        // Closing a socket that is already closing is a no-op, not an error
        // path — the catch exists for the readyState races, not for silence.
        socket?.close();
      } catch {
        /* already closed */
      }
      if (outcome.ok) resolve(outcome.results);
      else reject(outcome.error);
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        error: new Error('CLI detection timed out — is the agentmux daemon running?'),
      });
    }, timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      finish({
        ok: false,
        error: new Error(`CLI detection could not open a connection: ${(error as Error).message}`),
      });
      return;
    }
    socket.onopen = () => {
      const request = { type: 'detect_request', requestId } satisfies ClientMessage;
      socket?.send(JSON.stringify(request));
    };
    socket.onmessage = (event) => {
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        console.warn('agentmux: discarding malformed gateway frame during detection', parsed.error);
        return;
      }
      const message = parsed.message;
      if (message.type === 'detect_result' && message.requestId === requestId) {
        finish({ ok: true, results: message.results });
      } else if (message.type === 'error') {
        finish({ ok: false, error: new Error(message.message) });
      }
    };
    socket.onerror = () => {
      finish({ ok: false, error: new Error('CLI detection could not reach the daemon') });
    };
    socket.onclose = () => {
      finish({
        ok: false,
        error: new Error('the detection connection closed before a result arrived'),
      });
    };
  });
}
