import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { connectorDetectSchema, type ConnectorDetectReport } from '@agentmux/protocol';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { serverMessageSchema, type ServerMessage } from './wire.js';

/**
 * Onboarding detect over the gateway: the browser path (WS detect_request →
 * daemon connector registry → detect_result), status only — no credential
 * ever rides the answer.
 */

const openDaemons: DaemonHandle[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  for (const handle of openDaemons.splice(0)) {
    await handle.close();
  }
});

type Waiter = {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  timer: NodeJS.Timeout;
};

/** One authenticated gateway connection with request-id correlation. */
class DetectWsClient {
  private readonly waiters: Waiter[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = serverMessageSchema.parse(JSON.parse(String(data)));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters[index]!;
        this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  static open(port: number, token: string): Promise<DetectWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      ws.on('error', reject);
      ws.on('open', () => {
        openSockets.push(ws);
        resolve(new DetectWsClient(ws));
      });
    });
  }

  detect(): Promise<ServerMessage> {
    const requestId = `detect-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: 'detect_request', requestId }));
    return this.waitFor(
      (message) =>
        (message.type === 'detect_result' || message.type === 'error') &&
        // detect_result echoes the request id; error frames do not — treat
        // any error frame as ours (single-request connections in these tests).
        (message.type === 'error' || message.requestId === requestId),
      'detect response',
    );
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }
}

async function boot(): Promise<{ handle: DaemonHandle; client: DetectWsClient }> {
  const handle = await startDaemon({ port: 0 });
  openDaemons.push(handle);
  const client = await DetectWsClient.open(handle.address().port, handle.token);
  return { handle, client };
}

describe('connector detection over the gateway', () => {
  it('answers detect_request with schema-valid reports for the registry', async () => {
    const { client } = await boot();

    const response = await client.detect();
    expect(response.type).toBe('detect_result');
    if (response.type !== 'detect_result') return;

    expect(response.results).toHaveLength(2);
    const ids = response.results.map((report) => report.connectorId).sort();
    expect(ids).toEqual(['claude-code', 'codex']);
    for (const report of response.results) {
      // The real probes ran; whatever the host machine's CLI state is, the
      // wire shape holds (status only — never a credential).
      expect(connectorDetectSchema.parse(report)).toBeDefined();
    }
  });

  it('echoes each request id when two detects are in flight', async () => {
    const { handle, client } = await boot();
    const stub: ConnectorDetectReport[] = [
      { connectorId: 'claude-code', installed: true, version: '9.9.9', authState: 'none' },
    ];
    handle.gateway.onDetect = () => Promise.resolve(stub);

    const [first, second] = await Promise.all([client.detect(), client.detect()]);
    expect(first.type).toBe('detect_result');
    expect(second.type).toBe('detect_result');
    if (first.type !== 'detect_result' || second.type !== 'detect_result') return;
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.results).toEqual(stub);
    expect(second.results).toEqual(stub);
  });

  it('answers a throwing detect source with a typed error, not a hang', async () => {
    const { handle, client } = await boot();
    handle.gateway.onDetect = () => Promise.reject(new Error('registry exploded'));

    const response = await client.detect();
    expect(response.type).toBe('error');
    if (response.type !== 'error') return;
    expect(response.message).toContain('connector detection failed');
    expect(response.message).toContain('registry exploded');
  });
});
