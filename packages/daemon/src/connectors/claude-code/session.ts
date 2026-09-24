import process from 'node:process';
import pty from 'node-pty';
import type { AgentEvent, ApprovalDecision, ExitInfo, SessionState } from '@agentmux/protocol';
import { ClaudeStreamParser } from './parser.js';
import { encodeApprovalDecisionMessage, encodeUserTurnMessage } from './wire.js';
import type { SessionEventSink, SessionSpawnConfig } from '../types.js';

const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * The argv after the binary: the exact flags the official Agent SDK passes
 * (verified against @anthropic-ai/claude-agent-sdk 0.3.282 source), plus `-p`
 * for non-interactive mode per the headless docs. `--permission-prompt-tool
 * stdio` is what routes permission prompts over the control protocol — the
 * approval round-trip's whole mechanism. `dontAsk`/`bypassPermissions` are
 * deliberately absent: they route around the approval column.
 */
export function buildSpawnArgs(config: SessionSpawnConfig): string[] {
  return [
    ...(config.extraArgs ?? []),
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    ...(config.permissionMode ? ['--permission-mode', config.permissionMode] : []),
    ...(config.model ? ['--model', config.model] : []),
  ];
}

/**
 * The PTY line discipline echoes our stdin JSON back onto stdout and caps a
 * canonical-mode line at 4096 bytes — both corrupt a stream-json session.
 * Disabling echo and canonical mode before exec fixes both; the parser still
 * ignores text-only stdout user frames as defense in depth.
 */
const POSIX_EXEC_WRAPPER = 'stty raw -echo 2>/dev/null; exec "$@"';

/**
 * A live Claude Code session: one PTY-supervised CLI process, its NDJSON
 * stream parsed into protocol events, its approvals answered over stdin.
 * The CLI manages its own subscription auth — nothing here touches tokens.
 */
export class ClaudeCodeSession {
  private readonly pty: pty.IPty;
  private readonly parser: ClaudeStreamParser;
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
    // created→starting is the session's first journal entry; the CLI's own
    // system/init frame drives starting→ready from here.
    this.parser = new ClaudeStreamParser((event: AgentEvent) => sink.onEvent(event));
    this.parser.notifyStarting();

    const splitter = new LineSplitter((line) => this.parser.consumeLine(line));
    ptyProcess.onData((chunk) => splitter.push(chunk));
    ptyProcess.onExit(({ exitCode, signal }) => this.onProcessExit(exitCode, signal));
    this.exitPromise = new Promise<ExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private resolveExit!: (info: ExitInfo) => void;

  static spawn(config: SessionSpawnConfig, sink: SessionEventSink): ClaudeCodeSession {
    const binary = config.command ?? 'claude';
    const args = buildSpawnArgs(config);
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
      cwd: config.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'agentmux' } as Record<string, string>,
    });
    return new ClaudeCodeSession(config.sessionId, ptyProcess, sink);
  }

  get state(): SessionState {
    return this.parser.state;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Settles once the process group is gone and the tombstone event emitted. */
  get exit(): Promise<ExitInfo> {
    return this.exitPromise;
  }

  /** One user turn over stream-json stdin. */
  send(text: string): void {
    this.parser.notifyTurnSent(text);
    this.writeLine(encodeUserTurnMessage(text));
  }

  /** The approval decision, written back over stdin — the round-trip closes. */
  respondToApproval(decision: ApprovalDecision): void {
    const result =
      decision.decision === 'deny'
        ? { behavior: 'deny' as const, message: decision.reason ?? 'denied by operator' }
        : { behavior: 'allow' as const };
    this.parser.notifyDecisionSent(decision);
    this.writeLine(encodeApprovalDecisionMessage(decision.requestId, result));
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
    this.parser.emitTerminal(exit, this.killed || exitCode === 0 ? 'stopped' : 'crashed');
    this.resolveExit(exit);
  }

  private writeLine(line: string): void {
    this.pty.write(`${line}\n`);
  }
}

function signalGroup(pid: number, signal: 'SIGINT' | 'SIGKILL'): void {
  try {
    if (process.platform === 'win32') return; // no process groups; v1 targets darwin/linux
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH = the group is already gone; anything else surfaces.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function signalName(signal: number): string {
  // node-pty reports the numeric signal; the common names keep the journal
  // human-auditable ("what did I kill and how").
  const names: Record<number, string> = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };
  return names[signal] ?? `signal-${signal}`;
}

class LineSplitter {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newlineAt = this.buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      newlineAt = this.buffer.indexOf('\n');
    }
  }
}
