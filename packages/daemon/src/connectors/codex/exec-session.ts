import process from 'node:process';
import pty from 'node-pty';
import type { AgentEvent, ApprovalDecision, ExitInfo, SessionState } from '@agentmux/protocol';
import { CodexEventMapper } from './parser.js';
import type { CodexSandbox } from './wire.js';
import { LineSplitter, POSIX_EXEC_WRAPPER, signalGroup, signalName } from '../pty.js';
import type { SessionEventSink, SessionSpawnConfig } from '../types.js';

const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * The argv for one exec turn: `codex exec [--json --cd <cwd> --sandbox
 * <mode>] <prompt>`, or `codex exec resume <threadId> …` when the session
 * already carries a thread id from a previous turn's `thread.started` (Q5
 * finding: exec is per-turn; `exec resume` is the documented continuation).
 * The prompt is the last positional argument, per the CLI's usage.
 */
export function buildExecTurnArgs(params: {
  cwd: string;
  sandbox: CodexSandbox;
  prompt: string;
  resumeThreadId?: string | null;
}): string[] {
  return [
    'exec',
    ...(params.resumeThreadId ? ['resume', params.resumeThreadId] : []),
    '--json',
    '--cd',
    params.cwd,
    '--sandbox',
    params.sandbox,
    params.prompt,
  ];
}

/**
 * A Codex session over `codex exec --json` — the per-turn surface. There is
 * no persistent CLI process and no in-band approval channel (Q5 finding):
 * each `send` spawns one supervised process that runs the turn to completion
 * and exits, exactly the consumption pattern the brief names for exec. The
 * session itself stays alive until killed; the journal records one process
 * boundary per turn. Approval decisions have no wire to answer on and are
 * refused with a warning, not silently dropped.
 */
export class CodexExecSession {
  private readonly mapper: CodexEventMapper;
  private readonly config: SessionSpawnConfig;
  private turnPty: pty.IPty | null = null;
  private exitInfo: ExitInfo | null = null;
  private killed = false;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly exitPromise: Promise<ExitInfo>;
  private resolveExit!: (info: ExitInfo) => void;

  private constructor(id: string, config: SessionSpawnConfig, sink: SessionEventSink) {
    this.id = id;
    this.config = config;
    // No process exists yet: created→starting→ready describes a container
    // that is live even though no turn process is.
    this.mapper = new CodexEventMapper((event: AgentEvent) => sink.onEvent(event));
    this.mapper.notifyStarting();
    this.mapper.notifyReady();
    this.exitPromise = new Promise<ExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  readonly id: string;

  static spawn(config: SessionSpawnConfig, sink: SessionEventSink): CodexExecSession {
    return new CodexExecSession(config.sessionId, config, sink);
  }

  get state(): SessionState {
    return this.mapper.state;
  }

  /** The active turn's process-group pid, or 0 between turns. */
  get pid(): number {
    return this.turnPty?.pid ?? 0;
  }

  /** Settles once the session is killed and the tombstone event emitted. */
  get exit(): Promise<ExitInfo> {
    return this.exitPromise;
  }

  /** Spawns one exec process for this turn. */
  send(text: string): void {
    if (this.exitInfo !== null) {
      throw new Error('session is stopped — no further turns can be sent');
    }
    const binary = this.config.command ?? 'codex';
    // extraArgs precede the subcommand — same convention as the app-server
    // session (fixtures and wrappers ride in front of the CLI's own argv).
    const args = [
      ...(this.config.extraArgs ?? []),
      ...buildExecTurnArgs({
        cwd: this.config.cwd,
        sandbox: this.config.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only',
        prompt: text,
        resumeThreadId: this.mapper.getExecThreadId(),
      }),
    ];
    const useWrapper = process.platform !== 'win32';
    const argv = useWrapper
      ? ['/bin/sh', '-c', POSIX_EXEC_WRAPPER, 'agentmux-sh', binary, ...args]
      : [binary, ...args];
    const [file, ...spawnArgs] = argv;
    if (file === undefined) throw new Error('spawn argv must not be empty');
    const ptyProcess = pty.spawn(file, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.config.cwd,
      env: { ...process.env, CODEX_MANAGED_BY_NPM: 'agentmux' } as Record<string, string>,
    });
    this.mapper.notifyTurnSent(text);
    this.turnPty = ptyProcess;
    const splitter = new LineSplitter((line) => this.mapper.consumeExecLine(line));
    ptyProcess.onData((chunk) => splitter.push(chunk));
    ptyProcess.onExit(({ exitCode, signal }) => {
      this.turnPty = null;
      // A turn's process boundary is the turn boundary — the session
      // container survives and stays ready for the next turn.
      this.mapper.notifyExecTurnEnded();
      if (this.killed) {
        this.settle({
          code: exitCode,
          ...(signal !== undefined && signal !== 0 ? { signal: signalName(signal) } : {}),
          reason: 'killed',
        });
      }
    });
  }

  /**
   * No in-band approval channel exists in exec mode (Q5 finding) — there is
   * never a pending approval to answer; the mapper records the mismatch as a
   * warning rather than dropping the decision silently.
   */
  respondToApproval(decision: ApprovalDecision): void {
    const frame = this.mapper.buildDecisionFrame(decision);
    if (frame !== null) this.turnPty?.write(`${frame}\n`);
  }

  /**
   * "Stop this agent": SIGINT to the active turn's process group, a grace
   * window, then SIGKILL; with no turn running the session tombstones
   * directly (blueprint: "Kill semantics").
   */
  kill(options?: { graceMs?: number }): Promise<ExitInfo> {
    if (this.exitInfo !== null) return this.exitPromise;
    this.killed = true;
    const graceMs = options?.graceMs ?? DEFAULT_KILL_GRACE_MS;
    if (this.turnPty === null) {
      this.settle({ code: 0, reason: 'killed' });
      return this.exitPromise;
    }
    const pid = this.turnPty.pid;
    // The PTY child is a session leader (setsid): a negative pid signals the
    // whole group, so shells and helpers the CLI spawned come down too.
    signalGroup(pid, 'SIGINT');
    this.killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL'), graceMs);
    return this.exitPromise;
  }

  private settle(exit: ExitInfo): void {
    if (this.exitInfo !== null) return;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    this.exitInfo = exit;
    this.mapper.emitTerminal(exit, 'stopped');
    this.resolveExit(exit);
  }
}
