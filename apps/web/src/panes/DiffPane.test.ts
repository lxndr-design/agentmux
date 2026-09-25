import { describe, expect, it } from 'vitest';
import { diffRows } from './DiffPane.js';

describe('diffRows', () => {
  it('renders whole lines even for a single-line edit', () => {
    const rows = diffRows(
      'hello from the agentmux file flow',
      'hello from the agentmux file flow — verified',
    );
    expect(rows).toEqual([
      { kind: 'del', text: 'hello from the agentmux file flow' },
      { kind: 'add', text: 'hello from the agentmux file flow — verified' },
    ]);
  });

  it('renders identical content as context rows only', () => {
    const rows = diffRows('a\nb\n', 'a\nb\n');
    expect(rows).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
    ]);
  });

  it('does not render the trailing empty line of a newline-terminated file', () => {
    const rows = diffRows('a\nb\n', 'a\nc\n');
    expect(rows).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ]);
  });
});
