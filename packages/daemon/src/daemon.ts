import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AgentEvent, AgentEventEnvelope } from '@agentmux/protocol';
import { resolveDaemonOptions, type DaemonOptions, type ResolvedDaemonOptions } from './config.js';
import { Gateway } from './gateway.js';
import { EventJournal } from './journal.js';

export interface DaemonHandle {
  /** Resolved boot options — the host is loopback by construction. */
  readonly options: ResolvedDaemonOptions;
  /** Per-boot bearer token; rotates on every restart. */
  readonly token: string;
  /** The daemon's state of record. */
  readonly journal: EventJournal;
  /** Journals the event (assigning the next seq) and fans it out. */
  ingest(sessionId: string, event: AgentEvent): AgentEventEnvelope;
  /** The actually-bound address — a port-0 boot resolves here. */
  address(): { host: string; port: number };
  /** Closes the WS server, the HTTP server, and the journal. */
  close(): Promise<void>;
}

/**
 * Boots the daemon: event journal, loopback-only HTTP server, and the
 * authenticated WS gateway on top. This is the seam every later layer hangs
 * from — the supervisor replaces hand-driven `ingest` calls with connector
 * pumps; the UI shell connects as just another gateway client.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const resolved = resolveDaemonOptions(options);
  const journal = new EventJournal(resolved.journalPath);
  const token = randomBytes(32).toString('base64url');
  const gateway = new Gateway({ journal, token });

  const server = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('agentmux daemon — WebSocket endpoint only\n');
  });
  server.on('upgrade', (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(resolved.port, resolved.host, () => resolve());
    });
  } catch (error) {
    journal.close();
    throw error;
  }

  return {
    options: resolved,
    token,
    journal,
    ingest(sessionId, event) {
      // Journal first, fan out second — nothing observable may be missing
      // from the state of record (blueprint: "Sequencing and replay").
      const envelope = journal.append(sessionId, event);
      gateway.broadcast(envelope);
      return envelope;
    },
    address() {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        throw new Error('daemon socket is not bound to an IP endpoint');
      }
      return { host: bound.address, port: bound.port };
    },
    close: () => closeDaemon(server, gateway, journal),
  };
}

async function closeDaemon(server: Server, gateway: Gateway, journal: EventJournal): Promise<void> {
  await gateway.close();
  await new Promise<void>((resolve, reject) => {
    // Closing twice is a no-op, not an error — teardown paths and the
    // occasional late hook both rely on that.
    server.close((error) => {
      if (error === undefined || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  journal.close();
}
