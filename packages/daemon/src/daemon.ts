import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AgentEvent, AgentEventEnvelope } from '@agentmux/protocol';
import { resolveDaemonOptions, type DaemonOptions, type ResolvedDaemonOptions } from './config.js';
import { FsBridge } from './fs-bridge.js';
import { Gateway } from './gateway.js';
import { EventJournal } from './journal.js';
import { ClaudeCodeConnector } from './connectors/claude-code/connector.js';
import { CodexConnector } from './connectors/codex/connector.js';
import type { AgentConnector } from './connectors/types.js';
import { ProcessRegistry } from './process-registry.js';
import { Supervisor } from './supervisor.js';
import { LocalRuntime, WorktreeRuntime } from './runtime.js';
import { WorktreeManager } from './worktree.js';

export interface DaemonHandle {
  /** Resolved boot options — the host is loopback by construction. */
  readonly options: ResolvedDaemonOptions;
  /** Per-boot bearer token; rotates on every restart. */
  readonly token: string;
  /** The daemon's state of record. */
  readonly journal: EventJournal;
  /** The sandboxed filesystem bridge serving file RPC. */
  readonly fs: FsBridge;
  /** Per-session worktree lifecycle (create/remove/gc/reconcile). */
  readonly worktrees: WorktreeManager;
  /** The supervisor: owns live agent sessions, kills, restarts, and the boot reap. */
  readonly supervisor: Supervisor;
  /** Journals the event (assigning the next seq) and fans it out. */
  ingest(sessionId: string, event: AgentEvent): AgentEventEnvelope;
  /** The actually-bound address — a port-0 boot resolves here. */
  address(): { host: string; port: number };
  /** Closes the WS server, the HTTP server, the bridge watcher, and the journal. */
  close(): Promise<void>;
}

/**
 * Boots the daemon: event journal, loopback-only HTTP server, and the
 * authenticated WS gateway on top, with the supervisor owning live agent
 * sessions on the same journal. The UI shell connects as just another
 * gateway client.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const resolved = resolveDaemonOptions(options);
  const journal = new EventJournal(resolved.journalPath);
  const token = randomBytes(32).toString('base64url');
  const fsBridge = new FsBridge({ workspaceRoot: resolved.workspaceRoot });
  const worktrees = new WorktreeManager({ workspaceRoot: resolved.workspaceRoot });
  const gateway = new Gateway({ journal, token, fsBridge });
  // The bridge watches the workspace; every connection sees the change feed.
  const stopChangeRelay = fsBridge.onChange((event) => gateway.broadcastFsChange(event));

  const ingest = (sessionId: string, event: AgentEvent): AgentEventEnvelope => {
    // Journal first, fan out second — nothing observable may be missing
    // from the state of record (blueprint: "Sequencing and replay").
    const envelope = journal.append(sessionId, event);
    gateway.broadcast(envelope);
    return envelope;
  };

  const registry = new ProcessRegistry(journal.database);
  const supervisor = new Supervisor({
    runtimes: {
      worktree: new WorktreeRuntime(worktrees),
      local: new LocalRuntime(worktrees),
    },
    defaultRuntimeId: resolved.runtime,
    registry,
    ingest,
    connectors: new Map<string, AgentConnector>([
      ['claude-code', new ClaudeCodeConnector()],
      ['codex', new CodexConnector()],
    ]),
  });

  // Boot-time orphan reap: rows the previous daemon instance left behind are
  // live agent process groups with no owner. Nothing else serves sessions
  // until they are gone; a group that survives SIGKILL is boot noise.
  for (const report of await supervisor.reapOrphans()) {
    if (report.outcome === 'survived') {
      console.warn(
        `agentmux: orphaned process group ${report.pgid} (session '${report.sessionId}') survived SIGKILL — left registered for the next boot`,
      );
    }
  }

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
    fs: fsBridge,
    worktrees,
    supervisor,
    ingest,
    address() {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        throw new Error('daemon socket is not bound to an IP endpoint');
      }
      return { host: bound.address, port: bound.port };
    },
    close: () => closeDaemon(server, gateway, journal, fsBridge, stopChangeRelay),
  };
}

async function closeDaemon(
  server: Server,
  gateway: Gateway,
  journal: EventJournal,
  fsBridge: FsBridge,
  stopChangeRelay: () => void,
): Promise<void> {
  stopChangeRelay();
  fsBridge.close();
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
