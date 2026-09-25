import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './timelineModel.js';
import { Timeline } from './Timeline';

const turnItem: TimelineItem = {
  kind: 'turn',
  key: 'turn-t1',
  turnId: 't1',
  role: 'assistant',
  text: 'All done.',
  streaming: false,
};

const runningTool: TimelineItem = {
  kind: 'tool',
  key: 'tool-c1',
  callId: 'c1',
  tool: 'Bash',
  summary: 'npm test',
  command: 'npm test',
  diff: null,
  paths: [],
  status: 'running',
  output: null,
  truncated: false,
};

describe('Timeline', () => {
  it('renders the usage footer when totals exist', () => {
    render(
      <Timeline
        items={[]}
        usage={{ tokensIn: 1234, tokensOut: 567, planQuota: 42 }}
        visualState="idle"
      />,
    );
    const footer = screen.getByTestId('usage-footer');
    expect(footer).toHaveTextContent('tokens 1234 in');
    expect(footer).toHaveTextContent('567 out');
    expect(footer).toHaveTextContent('quota 42');
  });

  it('omits the usage footer without totals', () => {
    render(<Timeline items={[]} usage={null} visualState="idle" />);
    expect(screen.queryByTestId('usage-footer')).toBeNull();
  });

  it('exposes the streaming visual state via data attribute', () => {
    render(
      <Timeline
        items={[{ ...turnItem, text: 'Wri', streaming: true }]}
        usage={null}
        visualState="streaming"
      />,
    );
    expect(screen.getByTestId('timeline')).toHaveAttribute('data-visual-state', 'streaming');
    expect(screen.getByTestId('timeline-row-turn-t1')).toHaveAttribute('data-streaming', 'true');
    expect(screen.getByTestId('timeline-row-turn-t1')).toHaveClass('tl-streaming');
  });

  it('exposes thinking and tool-use visual states the same way', () => {
    const thinkingItem: TimelineItem = {
      kind: 'thinking',
      key: 'thinking-x',
      turnId: null,
      text: 'hmm',
      streaming: true,
    };
    const { rerender } = render(
      <Timeline items={[thinkingItem]} usage={null} visualState="thinking" />,
    );
    expect(screen.getByTestId('timeline')).toHaveAttribute('data-visual-state', 'thinking');

    rerender(<Timeline items={[runningTool]} usage={null} visualState="tool-use" />);
    expect(screen.getByTestId('timeline')).toHaveAttribute('data-visual-state', 'tool-use');
    expect(screen.getByTestId('tool-c1')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('tool-c1')).toHaveTextContent('● running');
  });

  it('marks resolved tool cards ok or error', () => {
    const { rerender } = render(
      <Timeline
        items={[{ ...runningTool, status: 'ok' as const, output: 'ok' }]}
        usage={null}
        visualState="idle"
      />,
    );
    expect(screen.getByTestId('tool-c1')).toHaveTextContent('✓ ok');

    rerender(
      <Timeline
        items={[{ ...runningTool, status: 'error' as const, output: 'boom' }]}
        usage={null}
        visualState="idle"
      />,
    );
    expect(screen.getByTestId('tool-c1')).toHaveTextContent('✗ error');
  });

  it('renders diff blocks inside tool cards', () => {
    render(
      <Timeline
        items={[{ ...runningTool, tool: 'Edit', status: 'running', diff: '--- a/x\n+++ b/x' }]}
        usage={null}
        visualState="tool-use"
      />,
    );
    expect(screen.getByTestId('diff-c1')).toHaveTextContent('--- a/x');
  });

  it('renders every item kind with stable test ids', () => {
    const items: TimelineItem[] = [
      { kind: 'turn', key: 'turn-t1', turnId: 't1', role: 'user', text: 'hello', streaming: false },
      { kind: 'thinking', key: 'thinking-x', turnId: null, text: 'deep thought', streaming: false },
      runningTool,
      { kind: 'state', key: 'state-0', from: 'ready', to: 'working' },
    ];
    render(<Timeline items={items} usage={null} visualState="idle" />);
    expect(screen.getByTestId('timeline-row-turn-t1')).toHaveTextContent('user');
    expect(screen.getByTestId('timeline-row-turn-t1')).toHaveTextContent('hello');
    expect(screen.getByTestId('timeline-row-thinking-x')).toHaveTextContent('deep thought');
    expect(screen.getByTestId('timeline-row-tool-c1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-row-state-0')).toHaveTextContent('ready → working');
    expect(screen.getByTestId('timeline').querySelectorAll('li')).toHaveLength(4);
  });
});
