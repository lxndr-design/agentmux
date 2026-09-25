import { useState } from 'react';
import { Markdown } from './markdown';
import type {
  StateItem,
  ThinkingItem,
  TimelineItem,
  TimelineVisualState,
  ToolItem,
  TurnItem,
  UsageTotals,
} from './timelineModel';

/**
 * Structured timeline — the blueprint's structured projection of one agent's
 * stream: markdown turns, collapsible thinking blocks, tool cards with live
 * status, diff blocks, state transitions, and a usage footer. Purely a view
 * over TimelineItems; all shaping rules live in timelineModel.
 */

function rowClass(kind: string, streaming: boolean): string {
  return streaming ? `tl-row tl-${kind} tl-streaming` : `tl-row tl-${kind}`;
}

function TurnRow({ item }: { item: TurnItem }) {
  return (
    <li
      className={rowClass('turn', item.streaming)}
      data-kind="turn"
      data-role={item.role}
      data-streaming={item.streaming || undefined}
      data-testid={`timeline-row-${item.key}`}
    >
      <span className="tl-kind">{item.role}</span>
      <span className="tl-text">
        {item.role === 'user' ? `→ ${item.text}` : <Markdown text={item.text} />}
        {item.streaming && (
          <span className="tl-caret" data-testid="stream-caret" aria-hidden="true" />
        )}
      </span>
    </li>
  );
}

function ThinkingRow({ item }: { item: ThinkingItem }) {
  // Expanded by default (the pane is for watching reasoning); collapsed state
  // is user-owned local UI state, not store state.
  const [expanded, setExpanded] = useState(true);
  return (
    <li
      className={rowClass('thinking', item.streaming)}
      data-kind="thinking"
      data-streaming={item.streaming || undefined}
      data-testid={`timeline-row-${item.key}`}
    >
      <span className="tl-kind">
        <button
          type="button"
          className="thinking-toggle"
          data-testid="thinking-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? '▾' : '▸'} thinking{item.streaming ? ' · streaming' : ''}
        </button>
      </span>
      {expanded && (
        <div className="tl-text thinking-text" data-testid="thinking-text">
          <Markdown text={item.text} />
          {item.streaming && (
            <span className="tl-caret" data-testid="thinking-caret" aria-hidden="true" />
          )}
        </div>
      )}
    </li>
  );
}

const TOOL_STATUS_GLYPH: Record<ToolItem['status'], string> = {
  running: '●',
  ok: '✓',
  error: '✗',
};

function ToolRow({ item }: { item: ToolItem }) {
  return (
    <li className="tl-row tl-tool" data-kind="tool_use" data-testid={`timeline-row-${item.key}`}>
      <div
        className="tool-card"
        data-testid={`tool-${item.callId}`}
        data-status={item.status}
        aria-busy={item.status === 'running'}
      >
        <div className="tool-card__head">
          <span className="tool-card__status" data-testid={`tool-status-${item.callId}`}>
            {TOOL_STATUS_GLYPH[item.status]} {item.status}
          </span>
          <span className="tl-chip">{item.tool}</span>
          {item.summary !== null && item.summary !== '' && (
            <span className="tool-card__summary">{item.summary}</span>
          )}
        </div>
        {item.command !== null && (
          <pre className="tool-command" data-testid={`command-${item.callId}`}>
            {item.command}
          </pre>
        )}
        {item.diff !== null && (
          <pre className="tool-diff" data-testid={`diff-${item.callId}`}>
            {item.diff}
          </pre>
        )}
        {item.paths !== undefined && item.paths.length > 0 && (
          <div className="tool-paths">
            {item.paths.map((path) => (
              <span key={path} className="tl-chip">
                {path}
              </span>
            ))}
          </div>
        )}
        {item.status !== 'running' && item.output !== null && (
          <pre className="tool-output" data-testid={`output-${item.callId}`}>
            {item.output.slice(0, 2000)}
          </pre>
        )}
      </div>
    </li>
  );
}

function StateRow({ item }: { item: StateItem }) {
  return (
    <li
      className="tl-row tl-state"
      data-kind="state_change"
      data-testid={`timeline-row-${item.key}`}
    >
      <span className="tl-kind">state</span>
      <span className="tl-text">
        {item.from} → {item.to}
      </span>
    </li>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'turn':
      return <TurnRow item={item} />;
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'state':
      return <StateRow item={item} />;
  }
}

/** Token/usage footer — the latest vendor-reported usage event. */
function UsageFooter({ usage }: { usage: UsageTotals | null }) {
  if (usage === null) return null;
  return (
    <footer className="usage-footer" data-testid="usage-footer">
      tokens {usage.tokensIn} in · {usage.tokensOut} out
      {usage.planQuota !== null ? ` · quota ${usage.planQuota}` : ''}
    </footer>
  );
}

export function Timeline({
  items,
  usage,
  visualState,
}: {
  items: TimelineItem[];
  usage: UsageTotals | null;
  visualState?: TimelineVisualState;
}) {
  return (
    <>
      <ul className="timeline" data-testid="timeline" data-visual-state={visualState ?? 'idle'}>
        {items.map((item) => (
          <TimelineRow key={item.key} item={item} />
        ))}
      </ul>
      <UsageFooter usage={usage} />
    </>
  );
}
