import process from 'node:process';

/**
 * Supervision machinery shared by every connector (blueprint: "Init, run,
 * kill, tombstone"). The Claude connector contributed it first; the Codex
 * connector is the second consumer — one kill discipline, one line
 * discipline, regardless of CLI.
 */

/**
 * The PTY line discipline echoes our stdin JSON back onto stdout and caps a
 * canonical-mode line at 4096 bytes — both corrupt a line-oriented JSON
 * stream. Disabling echo and canonical mode before exec fixes both; parsers
 * still retain unparseable lines as defense in depth.
 */
export const POSIX_EXEC_WRAPPER = 'stty raw -echo 2>/dev/null; exec "$@"';

/**
 * "Stop this agent": the host signals the session's _process group_ — the PTY
 * child is a session leader (setsid), so a negative pid reaches shells and
 * helpers the CLI spawned too (blueprint: "Kill semantics").
 */
export function signalGroup(pid: number, signal: 'SIGINT' | 'SIGKILL'): void {
  try {
    if (process.platform === 'win32') return; // no process groups; v1 targets darwin/linux
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH = the group is already gone; anything else surfaces.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export function signalName(signal: number): string {
  // node-pty reports the numeric signal; the common names keep the journal
  // human-auditable ("what did I kill and how").
  const names: Record<number, string> = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' };
  return names[signal] ?? `signal-${signal}`;
}

/** Splits a byte stream into lines — every connector's stdout discipline. */
export class LineSplitter {
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
