import process from 'node:process';
import pty from 'node-pty';
import type { AgentEvent, ApprovalDecision, ExitInfo, SessionState } from '@agentmux/protocol';
import { CodexEventMapper } from './parser.js';
import {
  encodeInitializeRequest,
  encodeThreadStartRequest,
  encodeTurnStartRequest,
  type CodexSandbox,
} from './wire.js';
import { LineSplitter, POSIX_EXEC_WRAPPER, signalGroup, signalName } from '../pty.js';
import type { SessionEventSink, SessionSpawnConfig } from '../types.js';

const DEFAULT_KILL_GRACE_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The argv after the binary. `app-server` is the interactive surface whose
 * JSON-RPC frames carry approval requests we can answer in-band (Q5 finding:
 * `codex exec --json` has no in-band approval path, so the approval column
 * needs this mode). extraArgs precede the subcommand, matching the Claude
 * connector's convention.
 */
export function buildAppServerArgs(config: SessionSpawnConfig): string[] {
  return [...(config.extraArgs ?? []), 'app-server'];
}

/**
 * Sandbox level for a session, mapped from the spawn wizard's permission
 * preset: `acceptEdits` lets the CLI write inside its workspace sandbox;
 * the default is read-only — every write then needs an approval, which is
 * exactly the column's job. `approvalPolicy` is always pinned to
 * `on-request` in wire.ts: no preset may route around the column.
 */
export function sandboxFor(config: SessionSpawnConfig): CodexSandbox {
  return config.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
}

/**
 * A live Codex session over `codex app-server`: one PTY-supervised process
 * speaking JSON-RPC-shaped NDJSON. One thread = one session; turns stream in
 * as notifications and approvals arrive as server requests answered with
 * `{id, result}` frames. The CLI manages its own ChatGPT subscription auth —
 * nothing here touches tokens (F3a).
 */
export class CodexSession {
  private readonly pty: pty.IPty;
  private readonly mapper: CodexEventMapper;
  private threadId: string | null = null;
  private nextRequestId = 1;
  /** Pending client→server requests awaiting their `{id, result}` response. */
  private readonly pendingResponses = new Map<
    string,
    (value: { result?: unknown; error?: unknown } | null, error?: Error) => void
  >();
  private exitInfo: ExitInfo | null = null;
  private killed = false;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly exitPromise: Promise<ExitInfo>;

  private constructor(
    readonly id: string,
    ptyProcess: pty.IPty,
    sink: SessionEventSink,
  ) {
    this.pty = ptyProcess;
    // created→starting is the session's first journal entry; the thread/start
    // response drives starting→ready once the handshake completes.
    this.mapper = new CodexEventMapper((event: AgentEvent) => sink.onEvent(event));
    this.mapper.notifyStarting();

    const splitter = new LineSplitter((line) => this.onLine(line));
    ptyProcess.onData((chunk) => splitter.push(chunk));
    ptyProcess.onExit(({ exitCode, signal }) => this.onProcessExit(exitCode, signal));
    this.exitPromise = new Promise<ExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private resolveExit!: (info: ExitInfo) => void;

  /**
   * Spawns the CLI and completes the handshake before the session is handed
   * to the daemon: `initialize` (clientInfo), then `thread/start` (cwd,
   * sandbox, pinned on-request approval policy). A handshake failure —
   * including an unauthenticated CLI exiting immediately — rejects spawn.
   */
  static async spawn(config: SessionSpawnConfig, sink: SessionEventSink): Promise<CodexSession> {
    const binary = config.command ?? 'codex';
    const args = buildAppServerArgs(config);
    const useWrapper = process.platform !== 'win32';
    const argv = useWrapper
      ? ['/bin/sh', '-c', POSIX_EXEC_WRAPPER, 'agentmux-sh', binary, ...args]
      : [binary, ...args];
    const [file, ...spawnArgs] = argv;
    if (file === undefined) throw new Error('spawn argv must not be empty');
    // Documented convention for embedding the CLI (Q5): marks the process as
    // managed so it skips its own update prompts.
    const env = { ...process.env, CODEX_MANAGED_BY_NPM: 'agentmux' } as Record<string, string>;
    const ptyProcess = pty.spawn(file, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: config.cwd,
      env: {
        ...env,
        ...(config.env ?? {}),
      } as Record<string, string>,
    });
    config.onPidChange?.(ptyProcess.pid);
    const session = new CodexSession(config.sessionId, ptyProcess, sink);
    try {
      await session.handshake(config);
    } catch (error) {
      // A handshake that cannot complete leaves no usable session: take the
      // process group down and surface the cause.
      await session.kill({ graceMs: 1_000 });
      throw error;
    }
    return session;
  }

  get state(): SessionState {
    return this.mapper.state;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** The Codex thread id, once the handshake's thread/start response lands. */
  getThreadId(): string | null {
    return this.threadId;
  }

  /** Settles once the process group is gone and the tombstone event emitted. */
  get exit(): Promise<ExitInfo> {
    return this.exitPromise;
  }

  /** One user turn: `turn/start` with a single text input item. */
  send(text: string): void {
    if (this.threadId === null) {
      throw new Error('session is not ready — thread/start has not completed');
    }
    this.mapper.notifyTurnSent(text);
    this.writeLine(encodeTurnStartRequest(this.nextRequestId++, { threadId: this.threadId, text }));
  }

  /** The approval decision, written back over stdin — the round-trip closes. */
  respondToApproval(decision: ApprovalDecision): void {
    const frame = this.mapper.buildDecisionFrame(decision);
    if (frame !== null) this.writeLine(frame);
  }

  /**
   * "Stop this agent": SIGINT to the process group, a grace window for the
   * CLI to flush, then SIGKILL to the group (blueprint: "Kill semantics").
   */
  kill(options?: { graceMs?: number }): Promise<ExitInfo> {
    if (this.exitInfo !== null) return this.exitPromise;
    this.killed = true;
    const graceMs = options?.graceMs ?? DEFAULT_KILL_GRACE_MS;
    // The PTY child is a session leader (setsid): a negative pid signals the
    // whole group, so shells and helpers the CLI spawned come down too.
    signalGroup(this.pty.pid, 'SIGINT');
    this.killTimer = setTimeout(() => signalGroup(this.pty.pid, 'SIGKILL'), graceMs);
    return this.exitPromise;
  }

  private async handshake(config: SessionSpawnConfig): Promise<void> {
    const initResponse = await this.request(
      encodeInitializeRequest(this.nextRequestId++, {
        name: 'agentmux',
        title: 'agentmux',
        version: '0.1.0',
      }),
    );
    if (hasError(initResponse)) {
      throw new Error(
        `codex app-server rejected initialize: ${JSON.stringify(initResponse.error)}`,
      );
    }
    const threadResponse = await this.request(
      encodeThreadStartRequest(this.nextRequestId++, {
        cwd: config.cwd,
        sandbox: sandboxFor(config),
        ...(config.model ? { model: config.model } : {}),
      }),
    );
    if (hasError(threadResponse)) {
      throw new Error(
        `codex app-server rejected thread/start: ${JSON.stringify(threadResponse.error)}`,
      );
    }
    const thread = (threadResponse.result as { thread?: { id?: unknown } } | undefined)?.thread;
    const threadId = typeof thread?.id === 'string' ? thread.id : undefined;
    if (threadId === undefined) {
      throw new Error('codex app-server thread/start response carried no thread id');
    }
    this.threadId = threadId;
    this.mapper.notifyReady();
  }

  private request(line: string): Promise<{ result?: unknown; error?: unknown }> {
    const parsed = JSON.parse(line) as { id: string | number };
    const id = parsed.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(String(id));
        reject(
          new Error(
            `codex app-server did not answer request ${String(id)} within ${HANDSHAKE_TIMEOUT_MS}ms`,
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);
      this.pendingResponses.set(String(id), (value, error) => {
        clearTimeout(timer);
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(value as { result?: unknown; error?: unknown });
      });
      this.writeLine(line);
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Unparseable lines reach the mapper, which retains them — one
      // discipline for every line, whoever sent it.
      this.mapper.consumeAppServerLine(trimmed);
      return;
    }
    const frame = parsed as Record<string, unknown>;
    if ('method' in frame) {
      // Server requests (approvals) and notifications are stream content.
      this.mapper.consumeAppServerLine(trimmed);
      return;
    }
    if ('id' in frame) {
      // A response to one of our requests — resolve the pending waiter.
      const settle = this.pendingResponses.get(String(frame.id));
      if (settle !== undefined) {
        this.pendingResponses.delete(String(frame.id));
        settle(parsed as { result?: unknown; error?: unknown });
      }
      return;
    }
    this.mapper.consumeAppServerLine(trimmed);
  }

  private onProcessExit(exitCode: number, signal: number | undefined): void {
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    // A kill is a first-class operation — never a crash, whatever the code.
    const reason = this.killed ? 'killed' : exitCode === 0 ? 'exited' : 'self-exited nonzero';
    const exit: ExitInfo = {
      code: exitCode,
      ...(signal !== undefined && signal !== 0 ? { signal: signalName(signal) } : {}),
      reason,
    };
    this.exitInfo = exit;
    this.mapper.emitTerminal(exit, this.killed || exitCode === 0 ? 'stopped' : 'crashed');
    // A process that died with requests outstanding can never answer them —
    // fail the waiters loudly (an unauthenticated/missing CLI exits instantly,
    // and that exit must surface as the handshake's error, not as undefined).
    for (const [id, settle] of this.pendingResponses) {
      settle(
        null,
        new Error(`codex app-server exited before answering request ${id} (code ${exitCode})`),
      );
    }
    this.pendingResponses.clear();
    this.resolveExit(exit);
  }

  private writeLine(line: string): void {
    this.pty.write(`${line}\n`);
  }
}

function hasError(response: { error?: unknown }): boolean {
  return response.error !== undefined && response.error !== null;
}
