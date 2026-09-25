import type { AgentEvent, ExitInfo, SessionState } from '@agentmux/protocol';
import type { AgentConnector, AgentSession, SessionSpawnConfig } from './connectors/types.js';
import {
  runInitHook,
  InitHookError,
  type InitHookOptions,
  type InitHookResult,
} from './init-hook.js';
import type { ProcessRegistry } from './process-registry.js';
import { DEFAULT_REAP_GRACE_MS, escalateKillGroup, type KillOutcome } from './process-group.js';
import type { Runtime, RuntimeId } from './runtime.js';

/**
 * The daemon-level supervisor: the single owner of live agent sessions
 * (blueprint: "Init, run, kill, tombstone"). Connectors still own their
 * streams — the supervisor owns everything around them: workspace
 * provisioning through the runtime seam, the init hook, the durable process
 * registry, kill + tombstone, restart-into-worktree, boot-time orphan
 * reaping, and daemon shutdown.
 */

/** Shell convention: command found but could not be executed. */
const INIT_HOOK_FAILURE_EXIT_CODE = 126;

export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export interface SupervisorOptions {
  /** Every provisionable runtime, keyed by id — the runtime seam's consumers. */
  readonly runtimes: Readonly<Record<RuntimeId, Runtime>>;
  /** Where sessions run when the request does not opt into the main checkout. */
  readonly defaultRuntimeId: RuntimeId;
  /** Durable live-process-group registry (migration 002 table). */
  readonly registry: ProcessRegistry;
  /** The workspace init hook runner — injectable for tests. */
  readonly runInitHook?: (options: InitHookOptions) => Promise<InitHookResult>;
  /** Journal-then-fan-out, as wired in the daemon. */
  readonly ingest: (sessionId: string, event: AgentEvent) => void;
  /** Connector registry — 'claude-code', 'codex', and whatever ships next. */
  readonly connectors: ReadonlyMap<string, AgentConnector>;
  /** Grace window for supervised kills; default 5s (blueprint kill semantics). */
  readonly killGraceMs?: number;
  /** Grace window for boot-time orphan reaping; default 1s. */
  readonly reapGraceMs?: number;
  /** Init hook budget; default 5s. */
  readonly hookTimeoutMs?: number;
}

export interface SupervisorStartRequest {
  sessionId: string;
  connectorId: string;
  /** CLI permission preset; the approval column stays in the loop. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  model?: string;
  /** Test escape hatch — a fake CLI path; production resolves on PATH. */
  command?: string;
  extraArgs?: string[];
  /**
   * Opt into the shared main checkout (blueprint: main-checkout use is an
   * explicit opt-out; the worktree runtime is the default).
   */
  useMainCheckout?: boolean;
}

/** The supervisor's view of one live session — the activity ribbon's source. */
export interface SupervisorSession {
  readonly id: string;
  readonly connectorId: string;
  readonly runtimeId: string;
  readonly cwd: string;
  /** True when this start reused the session's existing workspace. */
  readonly workspaceReused: boolean;
  readonly pid: number | null;
  readonly state: SessionState;
}

export interface ReapReport {
  readonly sessionId: string;
  readonly pgid: number;
  readonly runtimeId: string;
  readonly outcome: KillOutcome;
}

interface SupervisorEntry {
  request: SupervisorStartRequest;
  runtimeId: string;
  provision: { cwd: string; reused: boolean };
  session: AgentSession;
  pgid: number | null;
}

/**
 * The supervisor does not own kill outcomes beyond the connector contract: a
 * session that reaches a connector-level terminal state settles its own
 * `exit`; the tombstone lives in the journal as the terminal `state_change`
 * the connector emitted.
 */
export class Supervisor {
  private readonly entries = new Map<string, SupervisorEntry>();
  private readonly runInitHook: (options: InitHookOptions) => Promise<InitHookResult>;

  constructor(private readonly options: SupervisorOptions) {
    this.runInitHook = options.runInitHook ?? runInitHook;
  }

  /** Live session views, oldest first — the ribbon's data source. */
  list(): SupervisorSession[] {
    return [...this.entries.values()].map((entry) => this.toView(entry));
  }

  get(sessionId: string): SupervisorSession | undefined {
    const entry = this.entries.get(sessionId);
    return entry === undefined ? undefined : this.toView(entry);
  }

  /**
   * Provisions a workspace (reusing the session's existing one — the
   * restart-into-worktree flow), runs the workspace init hook, and spawns the
   * connector's CLI into the provisioned root. A failed hook fails the start:
   * the session is tombstoned as crashed with the hook's own stderr as the
   * exit reason, and the provisioned workspace is kept for diagnosis.
   */
  async start(request: SupervisorStartRequest): Promise<SupervisorSession> {
    if (this.entries.has(request.sessionId)) {
      throw new Error(`session '${request.sessionId}' already exists — restart it instead`);
    }
    const connector = this.options.connectors.get(request.connectorId);
    if (connector === undefined) {
      const known = [...this.options.connectors.keys()].join(', ');
      throw new Error(`unknown connector '${request.connectorId}' (known: ${known})`);
    }

    const runtimeId: RuntimeId =
      request.useMainCheckout === true ? 'local' : this.options.defaultRuntimeId;
    const runtime = this.options.runtimes[runtimeId];
    const provision = await runtime.provision({ sessionId: request.sessionId });

    // F4b parity: the init hook adapts one script to every runtime. It runs
    // from the workspace root (never from inside an agent workspace — an
    // agent cannot plant the hook that runs for it), in the provisioned cwd,
    // with the session identity in its environment.
    try {
      await this.runInitHook({
        workspaceRoot: runtime.workspaceRoot,
        cwd: provision.cwd,
        env: this.sessionEnv(runtime, request.sessionId),
        timeoutMs: this.options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      });
    } catch (error) {
      const reason = error instanceof InitHookError ? error.message : String(error);
      this.options.ingest(request.sessionId, {
        kind: 'state_change',
        from: 'starting',
        to: 'crashed',
        exit: { code: INIT_HOOK_FAILURE_EXIT_CODE, reason: `init hook: ${reason}` },
      });
      throw error;
    }

    let pgid: number | null = null;
    const spawnConfig: SessionSpawnConfig = {
      sessionId: request.sessionId,
      cwd: provision.cwd,
      permissionMode: request.permissionMode,
      model: request.model,
      command: request.command,
      extraArgs: request.extraArgs,
      env: this.sessionEnv(runtime, request.sessionId),
      onPidChange: (reportedPgid) => {
        // The connector reports the live group as it changes (initial PTY
        // leader, per-turn exec groups, 0 between turns). The registry is the
        // reaper's source of truth — pid 0 means "nothing live right now".
        if (reportedPgid > 0) {
          pgid = reportedPgid;
          this.options.registry.record(request.sessionId, reportedPgid, runtimeId, provision.cwd);
        } else {
          this.options.registry.remove(request.sessionId);
        }
      },
    };

    const session = await connector.spawn(spawnConfig, {
      onEvent: (event) => this.options.ingest(request.sessionId, event),
    });

    const entry: SupervisorEntry = {
      request,
      runtimeId,
      provision: { cwd: provision.cwd, reused: provision.reused },
      session,
      pgid,
    };
    this.entries.set(request.sessionId, entry);

    // Every exit path — clean, killed, crash — clears the registry row. The
    // connector's own terminal state_change is the tombstone.
    void session.exit
      .then(() => {
        this.options.registry.remove(request.sessionId);
      })
      .catch(() => {
        // `exit` never rejects by contract; a connector that breaks that
        // contract must not take the daemon down with it.
        this.options.registry.remove(request.sessionId);
      });

    return this.toView(entry);
  }

  /**
   * "Stop this agent": the connector's kill (SIGINT → grace → SIGKILL to the
   * process group, then the tombstone), followed by registry cleanup.
   * Killing an unknown or already-dead session is a no-op, not an error —
   * stop semantics stay idempotent.
   */
  async kill(sessionId: string, options?: { graceMs?: number }): Promise<ExitInfo | null> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return null;
    this.entries.delete(sessionId);
    const exit = await entry.session.kill({
      graceMs: options?.graceMs ?? this.options.killGraceMs,
    });
    this.options.registry.remove(sessionId);
    return exit;
  }

  /**
   * Restart into the session's existing worktree: kill the live process (if
   * any), then spawn fresh into the SAME workspace — `provision()` hands the
   * same workspace back for the session id. The original request (connector,
   * mode, model, flags) is replayed.
   */
  async restart(sessionId: string, options?: { graceMs?: number }): Promise<SupervisorSession> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      throw new Error(`unknown session '${sessionId}' — restart needs a previous start`);
    }
    await this.kill(sessionId, options);
    return this.start(entry.request);
  }

  /**
   * Boot-time orphan reap: every registry row the previous daemon instance
   * left behind is a live process group with no owner. The escalation is the
   * shared kill discipline at janitorial grace; 'survived' rows are KEPT so
   * the next boot tries again — an unkillable group is exactly what must
   * never be silently dropped.
   */
  async reapOrphans(): Promise<ReapReport[]> {
    const reports: ReapReport[] = [];
    for (const row of this.options.registry.list()) {
      const outcome = await escalateKillGroup(row.pgid, {
        graceMs: this.options.reapGraceMs ?? DEFAULT_REAP_GRACE_MS,
      });
      if (outcome !== 'survived') {
        this.options.registry.remove(row.sessionId);
      }
      reports.push({
        sessionId: row.sessionId,
        pgid: row.pgid,
        runtimeId: row.runtimeId,
        outcome,
      });
    }
    return reports;
  }

  /**
   * Daemon shutdown: kill every live session (concurrently — each carries its
   * own grace), and settle when the last process group is gone.
   */
  async shutdown(): Promise<Array<{ sessionId: string; exit: ExitInfo | null }>> {
    const ids = [...this.entries.keys()];
    const exits = await Promise.all(ids.map((id) => this.kill(id)));
    return ids.map((sessionId, index) => ({
      sessionId,
      exit: exits[index] ?? null,
    }));
  }

  private sessionEnv(runtime: Runtime, sessionId: string): Record<string, string> {
    return {
      ...runtime.env(),
      AGENTMUX_SESSION_ID: sessionId,
      AGENTMUX_WORKSPACE: runtime.workspaceRoot,
    };
  }

  private toView(entry: SupervisorEntry): SupervisorSession {
    return {
      id: entry.request.sessionId,
      connectorId: entry.request.connectorId,
      runtimeId: entry.runtimeId,
      cwd: entry.provision.cwd,
      workspaceReused: entry.provision.reused,
      pid: entry.pgid,
      state: entry.session.state,
    };
  }
}
