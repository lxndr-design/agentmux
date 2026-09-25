#!/usr/bin/env node
/**
 * Fake Claude CLI — speaks the verified stream-json protocol over stdout/stdin
 * so integration tests drive the full round-trip (spawn → events → prompt →
 * decision → resume → kill) without a real claude binary or API keys.
 *
 * Environment knobs (tests only):
 *   FAKE_SIGNALS_FILE   append "SIGINT" on receipt (kill-semantics evidence)
 *   FAKE_IGNORE_SIGINT  "1" = trap and ignore SIGINT, forcing SIGKILL escalation
 *   FAKE_CHILD_MARKER   spawn a long-lived child and write its pid here
 *                       (proves the whole process group dies on kill)
 */

import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

const SESSION_ID = 'fake-session';
let messageCounter = 0;
let toolCounter = 0;
let requestCounter = 0;

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const system = (subtype, extra = {}) =>
  out({ type: 'system', subtype, session_id: SESSION_ID, ...extra });

/** A streamed text turn — the full event family the real CLI emits. */
function runTextTurn(text, extraContent = []) {
  const id = `msg_${String(++messageCounter).padStart(3, '0')}`;
  const full = `Echo: ${text}`;
  out({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', content: [] },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Echo: ' } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'message_stop' },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text: full }, ...extraContent],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    result: full,
    session_id: SESSION_ID,
  });
}

/** A turn whose Bash call needs a human decision — the approval round-trip. */
function runApprovalTurn(command) {
  const toolUseId = `toolu_fake${String(++toolCounter).padStart(2, '0')}`;
  const requestId = `req_${String(++requestCounter).padStart(3, '0')}`;
  const id = `msg_${String(++messageCounter).padStart(3, '0')}`;
  out({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', content: [] },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'stream_event',
    event: { type: 'message_stop' },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 10 },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  });
  out({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command },
      tool_use_id: toolUseId,
    },
  });

  return {
    requestId,
    resolve: (decision) => {
      if (decision.response.behavior === 'deny') {
        // The CLI hands the denial message back to the model; the model reports it.
        runTextTurn(`denied: ${decision.response.message}`);
        return;
      }
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `ran: ${command}` }],
        },
        session_id: SESSION_ID,
      });
      runTextTurn(`ran: ${command}`);
    },
  };
}

const pending = new Map(); // request_id → resolver

const rl = readline.createInterface({ input: process.stdin, terminal: false });
// The real CLI emits system/init on startup, before any turn.
system('init', { cwd: process.cwd(), model: 'fake-model', permissionMode: 'default', tools: [] });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return; // tolerate garbage input, like the real CLI
  }
  if (frame.type === 'control_response') {
    const requestId = frame.response?.request_id;
    const resolver = requestId !== undefined ? pending.get(requestId) : undefined;
    if (resolver) {
      pending.delete(requestId);
      resolver(frame.response);
    }
    return;
  }
  if (frame.type !== 'user') return;
  const text = Array.isArray(frame.message?.content)
    ? frame.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    : '';
  if (text.startsWith('use:Bash ')) {
    const command = text.slice('use:Bash '.length);
    const { requestId, resolve } = runApprovalTurn(command);
    pending.set(requestId, resolve);
  } else {
    runTextTurn(text);
  }
});

process.on('SIGINT', () => {
  if (process.env.FAKE_SIGNALS_FILE !== undefined) {
    try {
      appendFileSync(process.env.FAKE_SIGNALS_FILE, 'SIGINT\n');
    } catch {
      // evidence best-effort; the exit path is what matters
    }
  }
  if (process.env.FAKE_IGNORE_SIGINT === '1') return; // force SIGKILL escalation
  process.exit(0);
});

const childMarker = process.env.FAKE_CHILD_MARKER;
if (childMarker !== undefined) {
  // A long-lived child in the same process group — group-kill evidence.
  const child = fork(process.argv[1], ['--stay-alive'], { stdio: 'ignore' });
  writeFileSync(childMarker, String(child.pid));
}

if (process.argv[2] === '--stay-alive') {
  setInterval(() => {}, 60_000); // never exits on its own; killed via the group
}
