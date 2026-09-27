import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@agentmux/protocol';
import { createAgentEventEnvelope } from '@agentmux/protocol';
import { buildTimelineItems, deriveVisualState } from './timelineModel.js';

function envelope(seq: number, payload: AgentEventEnvelope['payload']): AgentEventEnvelope {
  return createAgentEventEnvelope('s1', seq, payload);
}

describe('buildTimelineItems — turn', () => {
  it('renders a single done turn as one non-streaming item', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'Hello.', done: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'turn',
      key: 'turn-t1',
      turnId: 't1',
      role: 'assistant',
      text: 'Hello.',
      streaming: false,
    });
  });

  it('merges streaming deltas by turnId and closes on done', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'Fix ', done: false }),
      envelope(1, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'the ', done: false }),
      envelope(2, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'bug.', done: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'turn', text: 'Fix the bug.', streaming: false });
  });

  it('keeps the turn streaming while chunks are still arriving', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'Hel', done: false }),
    ]);
    expect(items[0]).toMatchObject({ streaming: true });
  });

  it('keeps one turn row when the turn resumes after an intervening tool call', () => {
    // Real CLIs stream text, run a tool, then stream more text within the
    // same turn — the row rejoins by turnId and stays in journal position.
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'one ', done: false }),
      envelope(1, { kind: 'tool_use', callId: 'c1', tool: 'Read' }),
      envelope(2, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'two', done: true }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['turn', 'tool']);
    expect(items[0]).toMatchObject({ kind: 'turn', text: 'one two' });
  });
});

describe('buildTimelineItems — thinking', () => {
  it('merges contiguous thinking chunks into one block', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'thinking', text: 'Tracing ', done: false }),
      envelope(1, { kind: 'thinking', text: 'the race…', done: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'thinking',
      text: 'Tracing the race…',
      streaming: false,
    });
  });

  it('closes the open thinking block when another event arrives', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'thinking', text: 'a', done: false }),
      envelope(1, { kind: 'turn', turnId: 't1', role: 'assistant', text: 'x', done: true }),
      envelope(2, { kind: 'thinking', text: 'b', done: false }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['thinking', 'turn', 'thinking']);
  });

  it('keys blocks by turnId when the chunk carries one', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'thinking', text: 'correlated ', done: false, turnId: 't1' }),
      envelope(1, { kind: 'thinking', text: 'reasoning', done: true, turnId: 't1' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'thinking',
      key: 'thinking-t1',
      text: 'correlated reasoning',
    });
  });
});

describe('buildTimelineItems — tool_use / tool_result', () => {
  it('opens a running card and resolves it from the matching result', () => {
    const { items } = buildTimelineItems([
      envelope(0, {
        kind: 'tool_use',
        callId: 'c1',
        tool: 'Edit',
        summary: 'Edit src/auth.ts',
        detail: { command: 'edit src/auth.ts', paths: ['src/auth.ts'] },
      }),
      envelope(1, { kind: 'tool_result', callId: 'c1', output: 'ok', truncated: false }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      callId: 'c1',
      tool: 'Edit',
      summary: 'Edit src/auth.ts',
      command: 'edit src/auth.ts',
      paths: ['src/auth.ts'],
      status: 'ok',
      output: 'ok',
    });
  });

  it('marks the card errored when the result says so', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'tool_use', callId: 'c1', tool: 'Bash', detail: { command: 'make' } }),
      envelope(1, {
        kind: 'tool_result',
        callId: 'c1',
        output: 'boom',
        truncated: false,
        isError: true,
      }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'tool', status: 'error', output: 'boom' });
  });

  it('carries a diff block from the use detail', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@';
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'tool_use', callId: 'c1', tool: 'Edit', detail: { diff } }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'tool', status: 'running', diff });
  });

  it('renders an orphan result rather than dropping it', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'tool_result', callId: 'cx', output: 'late', truncated: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      tool: 'result',
      output: 'late',
      truncated: true,
      status: 'ok',
    });
  });
});

describe('buildTimelineItems — state_change and usage', () => {
  it('renders state transitions as rows', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'state_change', from: 'ready', to: 'working' }),
    ]);
    expect(items[0]).toMatchObject({ kind: 'state', from: 'ready', to: 'working' });
  });

  it('collapses usage events to the latest totals instead of rows', () => {
    const { items, usage } = buildTimelineItems([
      envelope(0, { kind: 'usage', tokensIn: 10, tokensOut: 5 }),
      envelope(1, { kind: 'usage', tokensIn: 1234, tokensOut: 567, planQuota: 42 }),
    ]);
    expect(items).toHaveLength(0);
    expect(usage).toEqual({ tokensIn: 1234, tokensOut: 567, planQuota: 42 });
  });

  it('returns usage null when no usage event arrived', () => {
    const { usage } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'user', text: 'hi', done: true }),
    ]);
    expect(usage).toBeNull();
  });
});

describe('deriveVisualState', () => {
  it('is idle for an empty stream', () => {
    expect(deriveVisualState([])).toBe('idle');
  });

  it('is streaming when the last item is an open turn', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'turn', turnId: 't1', role: 'assistant', text: '…', done: false }),
    ]);
    expect(deriveVisualState(items)).toBe('streaming');
  });

  it('is thinking when the last item is an open thinking block', () => {
    const { items } = buildTimelineItems([
      envelope(0, { kind: 'thinking', text: '…', done: false }),
    ]);
    expect(deriveVisualState(items)).toBe('thinking');
  });

  it('is tool-use while a tool card is running, idle once resolved', () => {
    const running = buildTimelineItems([
      envelope(0, { kind: 'tool_use', callId: 'c1', tool: 'Bash' }),
    ]);
    expect(deriveVisualState(running.items)).toBe('tool-use');

    const resolved = buildTimelineItems([
      envelope(0, { kind: 'tool_use', callId: 'c1', tool: 'Bash' }),
      envelope(1, { kind: 'tool_result', callId: 'c1', output: '', truncated: false }),
    ]);
    expect(deriveVisualState(resolved.items)).toBe('idle');
  });
});
