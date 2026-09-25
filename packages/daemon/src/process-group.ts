import process from 'node:process';

/**
 * The daemon-level kill discipline, owned here so every caller — the orphan
 * reaper, the supervisor, future factory lanes — shares one escalation
 * sequence (blueprint: "Kill semantics"): SIGINT to the process _group_, a
 * bounded grace window for the agent to flush, SIGKILL to the group. The
 * PTY-fork path on win32 has no process groups; v1 targets darwin/linux and
 * the group calls degrade to no-ops there, mirroring the connectors' stance.
 */

export const DEFAULT_KILL_GRACE_MS = 5_000;
/** Boot reaping is janitorial on already-orphaned groups — a shorter grace. */
export const DEFAULT_REAP_GRACE_MS = 1_000;
/** How often the escalation polls for group death while a window is open. */
const KILL_POLL_MS = 25;
/** Bounded wait after SIGKILL — SIGKILL is not instant, but it is close. */
const KILL_SETTLE_MS = 1_000;

/**
 * "Stop this agent": the host signals the session's _process group_ — the
 * PTY child is a session leader (setsid), so a negative pid reaches shells
 * and helpers the CLI spawned too (blueprint: "Kill semantics").
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

/** Existence probe (signal 0) against the whole group — false only when gone. */
export function groupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false; // no groups; nothing to probe
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists, outside our signal reach
    throw error;
  }
}

/** What the escalation actually did — 'survived' is an anomaly, reported not swallowed. */
export type KillOutcome = 'already-gone' | 'flushed' | 'killed' | 'survived';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One kill escalation against a process group: SIGINT, then a grace window
 * during which death is polled, then SIGKILL to whatever remains. Never
 * throws for a target that fights back — 'survived' (group alive after
 * SIGKILL + settle, e.g. uninterruptible D-state) is the caller's signal to
 * surface the anomaly.
 */
export async function escalateKillGroup(
  pgid: number,
  options?: { graceMs?: number },
): Promise<KillOutcome> {
  const graceMs = options?.graceMs ?? DEFAULT_KILL_GRACE_MS;
  if (process.platform === 'win32' || !groupAlive(pgid)) return 'already-gone';

  signalGroup(pgid, 'SIGINT');
  const flushDeadline = Date.now() + graceMs;
  while (Date.now() < flushDeadline) {
    if (!groupAlive(pgid)) return 'flushed';
    await sleep(KILL_POLL_MS);
  }
  if (!groupAlive(pgid)) return 'flushed';

  signalGroup(pgid, 'SIGKILL');
  const killDeadline = Date.now() + KILL_SETTLE_MS;
  while (Date.now() < killDeadline) {
    if (!groupAlive(pgid)) return 'killed';
    await sleep(KILL_POLL_MS);
  }
  return groupAlive(pgid) ? 'survived' : 'killed';
}
