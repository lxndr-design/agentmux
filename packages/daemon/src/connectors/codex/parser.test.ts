import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexEventMapper } from './parser.js';
import { classifyLoginStatus } from './login.js';
import { buildExecTurnArgs } from './exec-session.js';

/**
 * Parser tests over golden fixtures — the exec JSONL dialect and the
 * app-server dialect, plus tolerance behavior (unknown events retained,
 * schema drift warned, never a crash) and the decision-encoding contract.
 */

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

describe('exec JSONL golden stream', () => {
  it('maps the full exec event family to protocol events, in order', async () => {
    const ndjson = await readFixture('codex-exec.ndjson');
    const expected = JSON.parse(await readFixture('codex-exec.expected.json'));
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    for (const line of ndjson.split('\n')) {
      if (line.trim() !== '') mapper.consumeExecLine(line);
    }
    expect(events).toEqual(expected);
    // thread.started is the resume target for `codex exec resume`.
    expect(mapper.getExecThreadId()).toBe('thr_exec_01');
  });

  it('retains unparseable lines and unknown event types with warnings', () => {
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    mapper.consumeExecLine('this is not json');
    mapper.consumeExecLine(
      '{"type":"item.started","item":{"type":"differentFutureItem","id":"u1"}}',
    );
    expect(events).toEqual([]);
    expect(mapper.getUnknownLines()).toHaveLength(2);
    expect(mapper.getWarnings().length).toBeGreaterThanOrEqual(2);
  });

  it('builds the exec resume argv with the prior thread id', () => {
    const fresh = buildExecTurnArgs({ cwd: '/w', sandbox: 'read-only', prompt: 'do it' });
    expect(fresh).toEqual(['exec', '--json', '--cd', '/w', '--sandbox', 'read-only', 'do it']);
    const resumed = buildExecTurnArgs({
      cwd: '/w',
      sandbox: 'workspace-write',
      prompt: 'again',
      resumeThreadId: 'thr_exec_01',
    });
    expect(resumed).toEqual([
      'exec',
      'resume',
      'thr_exec_01',
      '--json',
      '--cd',
      '/w',
      '--sandbox',
      'workspace-write',
      'again',
    ]);
  });
});

describe('app-server golden stream', () => {
  it('maps deltas, items, and the approval round-trip; the queued completion applies after the decision', async () => {
    const ndjson = await readFixture('codex-appserver.ndjson');
    const expected = JSON.parse(await readFixture('codex-appserver.expected.json'));
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    mapper.notifyStarting();
    mapper.notifyReady();
    mapper.notifyTurnSent('fix the bug');
    for (const line of ndjson.split('\n')) {
      if (line.trim() !== '') mapper.consumeAppServerLine(line);
    }
    // The decision is encoded in the v2 dialect and addressed to the server
    // request id — full disclosure in, exact frame out.
    const frame = mapper.buildDecisionFrame({
      requestId: 'codex-approval-7',
      decision: 'approve',
    });
    expect(frame).toBe('{"id":7,"result":{"decision":"accept"}}');
    expect(events).toEqual(expected);
    expect(mapper.getWarnings().some((w) => w.includes('completion queued'))).toBe(true);
  });
});

describe('tolerance contract', () => {
  it('retains unknown notifications and failed-schema server requests without emitting', () => {
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    mapper.notifyStarting();
    mapper.consumeAppServerLine('{"method":"brandNew/notification","params":{"x":1}}');
    mapper.consumeAppServerLine('{"id":"srv-1","method":"item/mystery/requestApproval"}');
    mapper.consumeAppServerLine('not json at all');
    expect(events).toEqual([{ kind: 'state_change', from: 'created', to: 'starting' }]);
    expect(mapper.getUnknownLines()).toHaveLength(3);
  });

  it('answers a v1 execCommandApproval prompt in the v1 dialect', () => {
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    mapper.notifyStarting();
    mapper.notifyReady();
    mapper.consumeAppServerLine(
      JSON.stringify({
        id: 9,
        method: 'execCommandApproval',
        params: { command: ['bash', '-lc', 'ls -la'], cwd: '/w' },
      }),
    );
    const approvalEvent = events.find(
      (event) =>
        (event as { kind?: string }).kind === 'state_change' &&
        (event as { to?: string }).to === 'waiting-approval',
    ) as { request: { requestId: string; command: string; risk: string } };
    expect(approvalEvent.request.command).toBe('bash -lc ls -la');
    expect(
      mapper.buildDecisionFrame({
        requestId: approvalEvent.request.requestId,
        decision: 'deny',
        reason: 'no',
      }),
    ).toBe('{"id":9,"result":{"decision":{"denied":{"rejection":"no"}}}}');
  });

  it('maps a fileChange approval with paths correlated from the seen item', () => {
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    mapper.notifyStarting();
    mapper.notifyReady();
    mapper.notifyTurnSent('edit files');
    mapper.consumeAppServerLine(
      JSON.stringify({
        method: 'item/started',
        params: {
          item: {
            id: 'fc_1',
            type: 'fileChange',
            status: 'inProgress',
            changes: [{ path: 'src/a.ts', kind: 'update' }],
          },
        },
      }),
    );
    mapper.consumeAppServerLine(
      JSON.stringify({
        id: 'srv-77',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thr', turnId: 't', itemId: 'fc_1' },
      }),
    );
    const waiting = events.find(
      (event) =>
        (event as { kind?: string }).kind === 'state_change' &&
        (event as { to?: string }).to === 'waiting-approval',
    ) as { request: { requestId: string; tool: string; risk: string; paths?: string[] } };
    expect(waiting.request.tool).toBe('apply-patch');
    expect(waiting.request.paths).toEqual(['src/a.ts']);
    // String server request ids are answered verbatim.
    expect(
      mapper.buildDecisionFrame({
        requestId: waiting.request.requestId,
        decision: 'approve-for-session',
      }),
    ).toBe('{"id":"srv-77","result":{"decision":"acceptForSession"}}');
  });

  it('refuses a decision for an unknown or already-resolved request with a warning, not a crash', () => {
    const events: unknown[] = [];
    const mapper = new CodexEventMapper((event) => events.push(event));
    expect(
      mapper.buildDecisionFrame({ requestId: 'codex-approval-404', decision: 'approve' }),
    ).toBeNull();
    expect(mapper.getWarnings().some((w) => w.includes('unknown or already-resolved'))).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('login-state classification', () => {
  it('distinguishes ChatGPT subscription, API key, none, and unavailable', () => {
    expect(classifyLoginStatus('Logged in using ChatGPT', 0)).toBe('chatgpt');
    expect(classifyLoginStatus('Logged in using an API key', 0)).toBe('api-key');
    expect(classifyLoginStatus('some other success wording', 0)).toBe('other');
    expect(classifyLoginStatus('Not logged in', 1)).toBe('none');
    expect(classifyLoginStatus('', null)).toBe('unavailable');
  });
});
