#!/usr/bin/env node
/**
 * Fake Codex CLI — speaks the verified app-server JSON-RPC dialect (and a
 * minimal exec JSONL mode) so integration tests drive the full round-trip
 * (spawn → handshake → events → approval prompt → decision → resume → kill)
 * without a real codex binary or ChatGPT credentials.
 *
 * Mode is chosen by argv: contains 'app-server' → JSON-RPC app-server
 * behavior; contains 'exec' → per-turn JSONL then exit 0.
 *
 * Environment knobs (tests only):
 *   FAKE_SIGNALS_FILE        append evidence lines: "SIGINT" on receipt,
 *                            "DECISION:<decision>" when a decision arrives
 *   FAKE_IGNORE_SIGINT       "1" = trap and ignore SIGINT → SIGKILL escalation
 *   FAKE_CHILD_MARKER        spawn a long-lived child and write its pid
 *                            (proves the whole process group dies on kill)
 *   FAKE_APPSERVER_APPROVAL  "1" = first turn raises a command approval
 *                            (request id 5001) and pauses until answered
 *   FAKE_ARGV_FILE           append JSON of process.argv per exec invocation
 *                            (resume-continuity evidence)
 */

import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

if (process.env.FAKE_IGNORE_SIGINT === '1') {
  process.on('SIGINT', () => {
    // Trap and keep running — forces the supervisor's SIGKILL escalation.
  });
}

if (process.env.FAKE_CHILD_MARKER) {
  // A long-lived child in the same process group: if the group kill works,
  // this child dies with the CLI (its pid proves it in the test).
  const child = fork(process.argv[1], ['--child'], { silent: true });
  writeFileSync(process.env.FAKE_CHILD_MARKER, String(child.pid));
  child.on('exit', () => process.exit(0));
  // Parent stays alive until killed; the child stays alive with it.
}

const argv = process.argv.slice(2);

if (argv.includes('--child')) {
  // The process-group canary: live until killed, exit 0 otherwise.
  setInterval(() => {}, 1_000);
} else if (argv.includes('app-server')) {
  let approvalOpen = false;

  const runTurn = () => {
    out({ method: 'turn/started', params: { turn: { id: 'turn_001' } } });
    out({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'r1', delta: 'thinking hard', turnId: 'turn_001' },
    });
    out({
      method: 'item/started',
      params: {
        item: { id: 'c1', type: 'commandExecution', command: 'echo hi', status: 'inProgress' },
      },
    });
    if (process.env.FAKE_APPSERVER_APPROVAL === '1') {
      approvalOpen = true;
      out({
        id: 5001,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thr_fake',
          turnId: 'turn_001',
          itemId: 'c1',
          command: 'rm -rf ./dist',
          cwd: process.cwd(),
          approvalPolicy: 'on-request',
        },
      });
      return; // the turn resumes when the decision frame arrives
    }
    finishTurn();
  };

  const finishTurn = () => {
    out({
      method: 'item/completed',
      params: {
        item: {
          id: 'c1',
          type: 'commandExecution',
          command: 'echo hi',
          aggregatedOutput: 'hi',
          exitCode: 0,
          status: 'completed',
        },
      },
    });
    out({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Done: ' } });
    out({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'ok' } });
    out({
      method: 'item/completed',
      params: { item: { id: 'm1', type: 'agentMessage', text: 'Done: ok' } },
    });
    out({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { total: { input_tokens: 21, output_tokens: 7 } } },
    });
    out({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  };

  readline
    .createInterface({ input: process.stdin, terminal: false })
    .on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (frame.method === 'initialize') {
        out({
          id: frame.id,
          result: { userAgent: { name: 'codex-cli', version: '0.42.0-fake' } },
        });
        return;
      }
      if (frame.method === 'thread/start') {
        out({ id: frame.id, result: { thread: { id: 'thr_fake' } } });
        return;
      }
      if (frame.method === 'turn/start') {
        out({ id: frame.id, result: { success: true } });
        runTurn();
        return;
      }
      if (approvalOpen && frame.id === 5001) {
        approvalOpen = false;
        const decision = frame.result?.decision ?? 'unanswered';
        if (process.env.FAKE_SIGNALS_FILE) {
          appendFileSync(process.env.FAKE_SIGNALS_FILE, `DECISION:${decision}\n`);
        }
        finishTurn();
      }
    })
    .on('close', () => process.exit(0));

  process.on('SIGINT', () => {
    if (process.env.FAKE_SIGNALS_FILE) {
      appendFileSync(process.env.FAKE_SIGNALS_FILE, 'SIGINT\n');
    }
    if (process.env.FAKE_IGNORE_SIGINT !== '1') process.exit(0);
  });
  // Stay alive awaiting turns until killed.
} else if (argv.includes('exec')) {
  // One exec turn: the prompt is the last positional argument.
  if (process.env.FAKE_ARGV_FILE) {
    appendFileSync(process.env.FAKE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
  }
  const prompt = argv[argv.length - 1] ?? '';
  out({ type: 'thread.started', thread_id: 'thr_exec_9' });
  out({ type: 'turn.started' });
  out({ type: 'item.started', item: { id: 'x_0', type: 'reasoning', text: '' } });
  out({
    type: 'item.completed',
    item: { id: 'x_0', type: 'reasoning', text: `considering: ${prompt}` },
  });
  out({ type: 'item.started', item: { id: 'x_1', type: 'agent_message', text: '' } });
  out({
    type: 'item.completed',
    item: { id: 'x_1', type: 'agent_message', text: `exec turn for: ${prompt}` },
  });
  out({
    type: 'turn.completed',
    usage: { input_tokens: 30, output_tokens: 12, cached_input_tokens: 0 },
  });
  process.exit(0);
} else {
  // Unknown invocation — surface it rather than hanging silently.
  process.stderr.write(`fake-codex: unexpected argv ${JSON.stringify(process.argv)}\n`);
  process.exit(2);
}
