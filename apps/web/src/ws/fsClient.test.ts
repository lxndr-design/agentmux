// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsBridgeRpcError, FsUnavailableError, FsClient } from './fsClient.js';
import type { FsRequest, FsResult } from '@agentmux/protocol';

/**
 * FsClient contract — request correlation against a controlled fake
 * WebSocket, focusing on the connect-phase queue: panes mount before the
 * socket opens, and their first requests must wait, not fail.
 */

/** Fake WebSocket the test drives manually: open/close/message are explicit. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  openNow(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

const readRequest: FsRequest = { op: 'read', root: 'workspace', path: 'README.md' };

/** The single socket the client under test created — fails loudly if absent. */
function theSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances[0];
  if (ws === undefined) {
    throw new Error('the client never opened a socket');
  }
  return ws;
}

function makeClient() {
  const client = new FsClient({ url: 'ws://127.0.0.1:1/?token=t' });
  client.start();
  return client;
}

describe('FsClient request queue', () => {
  it('holds requests made while connecting and resolves them after open', async () => {
    const client = makeClient();
    const pending = client.request(readRequest);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = theSocket();
    expect(ws.sent).toHaveLength(0); // not sent yet — socket still connecting

    ws.openNow();
    expect(ws.sent.map((frame) => JSON.parse(frame).requestId)).toEqual(['fs-1']);

    // The daemon answers once the queued request actually went out.
    ws.serverMessage({ type: 'fs_result', requestId: 'fs-1', result: readResult('hi\n') });
    const result = await pending;
    expect(result).toEqual(readResult('hi\n'));
  });

  it('sends queued requests in order once the socket opens', async () => {
    const client = makeClient();
    const ws = theSocket();

    void client.request({ op: 'list', root: 'workspace', path: '.' });
    void client.request(readRequest);
    expect(ws.sent).toHaveLength(0);

    ws.openNow();
    expect(ws.sent.map((frame) => JSON.parse(frame).requestId)).toEqual(['fs-1', 'fs-2']);
  });

  it('fails requests queued on a socket that closes before opening', async () => {
    const client = makeClient();
    const pending = client.request(readRequest);
    theSocket().close(); // drops before onopen ever fired

    await expect(pending).rejects.toBeInstanceOf(FsUnavailableError);
  });

  it('sends requests made on an already-open socket immediately', async () => {
    const client = makeClient();
    const ws = theSocket();
    ws.openNow();

    const pending = client.request(readRequest);
    expect(ws.sent.map((frame) => JSON.parse(frame).requestId)).toEqual(['fs-1']);

    ws.serverMessage({ type: 'fs_result', requestId: 'fs-1', result: readResult('hi\n') });
    expect(await pending).toEqual(readResult('hi\n'));
  });

  it('correlates results to the requesting call across interleaved requests', async () => {
    const client = makeClient();
    const ws = theSocket();
    ws.openNow();

    const first = client.request(readRequest);
    const second = client.request(readRequest);

    // The daemon replies out of order — correlation must hold anyway.
    ws.serverMessage({ type: 'fs_result', requestId: 'fs-2', result: readResult('second') });
    ws.serverMessage({ type: 'fs_result', requestId: 'fs-1', result: readResult('first') });

    expect(await second).toEqual(readResult('second'));
    expect(await first).toEqual(readResult('first'));
  });

  it('rejects a request answered with fs_error as a typed bridge error', async () => {
    const client = makeClient();
    const ws = theSocket();
    ws.openNow();

    const pending = client.request({ op: 'read', root: 'workspace', path: '../../../etc/passwd' });
    ws.serverMessage({
      type: 'fs_error',
      requestId: 'fs-1',
      error: { code: 'E_SANDBOX', message: 'path escapes the workspace' },
    });

    const error = await pending.catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(FsBridgeRpcError);
    expect((error as FsBridgeRpcError).code).toBe('E_SANDBOX');
  });

  it('rejects requests on a stopped client instead of queueing them', async () => {
    const client = makeClient();
    client.stop();
    await expect(client.request(readRequest)).rejects.toBeInstanceOf(FsUnavailableError);
    expect(theSocket().sent).toHaveLength(0);
  });
});

function readResult(content: string): FsResult {
  return {
    op: 'read',
    read: { path: 'README.md', content, size: content.length, mtimeMs: 1 },
  };
}
