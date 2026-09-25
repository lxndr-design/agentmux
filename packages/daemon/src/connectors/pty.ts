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

// The kill discipline's single implementation lives at the daemon root, where
// the supervisor and the orphan reaper share it with the connectors.
export { signalGroup } from '../process-group.js';

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
