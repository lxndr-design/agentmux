import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AgentEvent, AgentEventEnvelope } from '@agentmux/protocol';
import { resolveDaemonOptions, type DaemonOptions, type ResolvedDaemonOptions } from './config.js';
import { DivergenceService } from './divergence.js';
import { FsBridge } from './fs-bridge.js';
import { UsageRollupService } from './usage-rollups.js';
import { FactoryQueue } from './factory-queue.js';
import { Gateway } from './gateway.js';
import { HttpApi } from './http-api.js';
import { EventJournal } from './journal.js';
import { ApprovalEngine } from './approval/approvalEngine.js';
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
  /**
   * The WS gateway — exposed for onboarding detect fixtures and tests that
   * stub the connector registry's detection answers.
   */
  readonly gateway: Gateway;
  /** The supervisor: owns live agent sessions, kills, restarts, and the boot reap. */
  readonly supervisor: Supervisor;
  /**
   * The approval engine: policy evaluation, escalation, and the WS decision
   * round-trip into connector stdin. Connector sessions and the demo harness
   * register themselves here (attachSession / setPolicy).
   */
  readonly approvals: ApprovalEngine;
  /** The code-factory ticket queue — the automation API's enqueue edge. */
  readonly factory: FactoryQueue;
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
  const divergence = new DivergenceService({ worktrees });
  const usageRollups = new UsageRollupService({ journal });
  const gateway = new Gateway({ journal, token, fsBridge, divergence, usageRollups });
  // The bridge watches the workspace; every connection sees the change feed.
  const stopChangeRelay = fsBridge.onChange((event) => gateway.broadcastFsChange(event));

  // The approval engine owns the ingest path so requests are policy-evaluated
  // and decisions journal before anything fans out; the supervisor's sessions
  // and the gateway's decide path both route through it.
  const approvals = new ApprovalEngine({
    journal,
    broadcast: (envelope) => gateway.broadcast(envelope),
    timeoutMs: resolved.approvalTimeoutMs,
  });
  gateway.onDecision = (sessionId, decision) => approvals.resolve(sessionId, decision, 'human');

  const ingest = (sessionId: string, event: AgentEvent): AgentEventEnvelope =>
    approvals.ingest(sessionId, event);

  const registry = new ProcessRegistry(journal.database);
  const factory = new FactoryQueue(journal.database);

  // Shipped connectors first, then the option's test seam merges over them.
  // The connector registry doubles as the onboarding wizard's data source:
  // the gateway answers detect_request with each connector's own probe
  // (install + login STATUS — the CLIs own the credentials).
  const connectors = new Map<string, AgentConnector>([
    ['claude-code', new ClaudeCodeConnector()],
    ['codex', new CodexConnector()],
  ]);
  for (const [id, connector] of resolved.connectors) {
    connectors.set(id, connector);
  }
  gateway.onDetect = () =>
    Promise.all(
      [...connectors.entries()].map(async ([connectorId, connector]) => ({
        connectorId,
        ...(await connector.detect()),
      })),
    );
  const supervisor = new Supervisor({
    runtimes: {
      worktree: new WorktreeRuntime(worktrees),
      local: new LocalRuntime(worktrees),
    },
    defaultRuntimeId: resolved.runtime,
    registry,
    ingest,
    connectors,
    // The PR #8 follow-up: a session the supervisor spawns (via the UI's
    // supervisor path or the automation API) gets the same approval
    // round-trip a connector-attached session has — without this, an
    // API-spawned session's cards escalate where no decision can reach.
    onSessionSpawned: (sessionId, session) => approvals.attachSession(sessionId, session),
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

  // The actually-bound address, resolved lazily — a port-0 boot binds an
  // ephemeral port the handle and the API's stream pointers both read.
  const address = (): { host: string; port: number } => {
    const bound = server.address();
    if (bound === null || typeof bound === 'string') {
      throw new Error('daemon socket is not bound to an IP endpoint');
    }
    return { host: bound.address, port: bound.port };
  };

  const httpApi = new HttpApi({
    token,
    journal,
    supervisor,
    queue: factory,
    address,
  });
  const server = createServer((request, response) => {
    // The automation API serves /api/*; anything else gets the same answer
    // the pre-API daemon gave. WS upgrades are handled by the listener below.
    httpApi.handle(request, response);
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
    gateway,
    supervisor,
    approvals,
    factory,
    ingest(sessionId, event) {
      // Journal first, fan out second — nothing observable may be missing
      // from the state of record (blueprint: "Sequencing and replay"). The
      // approval engine owns the path so requests are policy-evaluated and
      // decisions journal before anything fans out.
      return approvals.ingest(sessionId, event);
    },
    address,
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
