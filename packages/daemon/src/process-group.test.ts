import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escalateKillGroup, groupAlive } from './process-group.js';

/**
 * Kill-semantics acceptance, against real process groups: `detached: true`
 * makes the spawned sh a session leader, so its pid IS the pgid and anything
 * it spawns shares the group. Every assertion here is about the GROUP —
 * `groupAlive(pgid)` is false only when every member is gone.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function spawnGroup(
  file: string,
  args: string[],
): { pgid: number; exited: Promise<number | null> } {
  // stdio ignore keeps the group free of pipes that could keep members alive;
  // the leader registers its group before this returns.
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('spawn did not report a pid');
  // The exit is captured at spawn time — the kill escalation may well have
  // finished before any assertion thinks to listen.
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  return { pgid, exited };
}

/** Lets the spawned shell install its traps before a signal lands. */
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('escalateKillGroup', () => {
  it('kills the whole process group — leader and spawned helpers alike', async () => {
    // At signal time the group holds the shell leader plus its foreground
    // sleep helper — two distinct pids. (Background jobs are no good here:
    // non-job-control shells make them IGNORE SIGINT, so a `sleep &` member
    // would outlive the grace window by POSIX rule, not by any kill bug.)
    // `groupAlive` is false only when BOTH are gone: a leader-only kill
    // would leave the helper alive and the group persisting — exactly the
    // regression this test guards against.
    const { pgid, exited } = spawnGroup('bash', ['-c', 'sleep 300; sleep 300']);
    await settle(150);
    expect(groupAlive(pgid)).toBe(true);

    const outcome = await escalateKillGroup(pgid, { graceMs: 300 });

    expect(outcome).toBe('flushed');
    expect(groupAlive(pgid)).toBe(false);
    await exited; // settled, whichever way the leader chose to die
  }, 15_000);

  it('gives a trap-handling process its grace window to flush', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentmux-kill-'));
    dirs.push(dir);
    const flushed = path.join(dir, 'flushed.txt');
    // bash (not /bin/sh — dash dies on INT without running traps): the trap
    // writes the flush marker and exits; bash defers the trap until the
    // current `sleep` finishes, well inside the grace window.
    const { pgid } = spawnGroup('bash', [
      '-c',
      `trap 'echo flushed > ${flushed}; exit 0' INT; while :; do sleep 0.1; done`,
    ]);
    await settle(150);
    expect(groupAlive(pgid)).toBe(true);

    const outcome = await escalateKillGroup(pgid, { graceMs: 500 });

    expect(outcome).toBe('flushed');
    expect(groupAlive(pgid)).toBe(false);
    // The flush ran INSIDE the grace window — the process got its chance.
    expect(await readFile(flushed, 'utf8')).toContain('flushed');
  }, 15_000);

  it('escalates to SIGKILL when the process ignores SIGINT', async () => {
    // bash ignores INT outright (children inherit the ignore) — the only way
    // this group dies is the SIGKILL escalation.
    const { pgid } = spawnGroup('bash', ['-c', `trap '' INT; while :; do sleep 0.1; done`]);
    await settle(150);
    expect(groupAlive(pgid)).toBe(true);

    const outcome = await escalateKillGroup(pgid, { graceMs: 300 });

    expect(outcome).toBe('killed');
    expect(groupAlive(pgid)).toBe(false);
  }, 15_000);

  it('reports an already-dead group as already-gone', async () => {
    await expect(escalateKillGroup(999_999_999, { graceMs: 100 })).resolves.toBe('already-gone');
  });
});
