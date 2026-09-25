import type { AgentEventEnvelope, SessionState } from '@agentmux/protocol';

/**
 * Rendered timeline view model — a pure projection of the envelope stream
 * (blueprint: "Three render modes per agent pane"; this is the structured
 * projection). The renderer below never sees raw envelopes; every consumer
 * renders TimelineItems, and every rule that shapes them lives here where it
 * is unit-testable:
 *
 * - streaming `turn`/`thinking` deltas merge into one item per turn/block
 *   (keyed by turnId; thinking merges only while contiguous, so separated
 *   blocks stay visually separate);
 * - `tool_use` opens a card in `running`; the matching `tool_result` (by
 *   callId) resolves it to `ok`/`error` and carries the output — the live
 *   status the tool chip shows;
 * - `state_change` renders as a transition row;
 * - `usage` collapses to the latest vendor-reported totals, rendered as the
 *   pane footer rather than a timeline row.
 */

export interface TurnItem {
  kind: 'turn';
  key: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  /** Streaming visual state: more chunks may still arrive. */
  streaming: boolean;
}

export interface ThinkingItem {
  kind: 'thinking';
  key: string;
  turnId: string | null;
  text: string;
  streaming: boolean;
}

export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolItem {
  kind: 'tool';
  key: string;
  callId: string;
  tool: string;
  summary: string | null;
  command: string | null;
  diff: string | null;
  paths: string[];
  status: ToolStatus;
  output: string | null;
  truncated: boolean;
}

export interface StateItem {
  kind: 'state';
  key: string;
  from: SessionState;
  to: SessionState;
}

export type TimelineItem = TurnItem | ThinkingItem | ToolItem | StateItem;

export type TimelineVisualState = 'idle' | 'streaming' | 'thinking' | 'tool-use';

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  planQuota: number | null;
}

export interface TimelineView {
  items: TimelineItem[];
  usage: UsageTotals | null;
}

export function buildTimelineItems(envelopes: readonly AgentEventEnvelope[]): TimelineView {
  const items: TimelineItem[] = [];
  const toolsByCallId = new Map<string, ToolItem>();
  const turnsByTurnId = new Map<string, TurnItem>();
  let openThinking: ThinkingItem | null = null;
  let usage: UsageTotals | null = null;

  for (const envelope of envelopes) {
    const event = envelope.payload;
    switch (event.kind) {
      case 'turn': {
        openThinking = null;
        const existing = turnsByTurnId.get(event.turnId);
        if (existing !== undefined) {
          existing.text += event.text;
          existing.streaming = !event.done;
          break;
        }
        const item: TurnItem = {
          kind: 'turn',
          key: `turn-${event.turnId}`,
          turnId: event.turnId,
          role: event.role,
          text: event.text,
          streaming: !event.done,
        };
        turnsByTurnId.set(event.turnId, item);
        items.push(item);
        break;
      }
      case 'thinking': {
        const turnId = event.turnId ?? null;
        if (openThinking !== null && (openThinking.turnId ?? null) === turnId) {
          openThinking.text += event.text;
          openThinking.streaming = !event.done;
          break;
        }
        const item: ThinkingItem = {
          kind: 'thinking',
          key: `thinking-${turnId ?? `seq${envelope.seq}`}`,
          turnId,
          text: event.text,
          streaming: !event.done,
        };
        openThinking = item;
        items.push(item);
        break;
      }
      case 'tool_use': {
        openThinking = null;
        const item: ToolItem = {
          kind: 'tool',
          key: `tool-${event.callId}`,
          callId: event.callId,
          tool: event.tool,
          summary: event.summary ?? null,
          command: event.detail?.command ?? null,
          diff: event.detail?.diff ?? null,
          paths: event.detail?.paths ?? [],
          status: 'running',
          output: null,
          truncated: false,
        };
        toolsByCallId.set(event.callId, item);
        items.push(item);
        break;
      }
      case 'tool_result': {
        openThinking = null;
        const existing = toolsByCallId.get(event.callId);
        if (existing !== undefined) {
          existing.output = event.output;
          existing.truncated = event.truncated;
          existing.status = event.isError === true ? 'error' : 'ok';
          break;
        }
        // Tolerant orphan: a result whose use fell outside the stream still
        // renders — never silently dropped.
        items.push({
          kind: 'tool',
          key: `tool-${event.callId}`,
          callId: event.callId,
          tool: 'result',
          summary: null,
          command: null,
          diff: null,
          paths: [],
          status: event.isError === true ? 'error' : 'ok',
          output: event.output,
          truncated: event.truncated,
        });
        break;
      }
      case 'state_change':
        openThinking = null;
        items.push({ kind: 'state', key: `state-${envelope.seq}`, from: event.from, to: event.to });
        break;
      case 'usage':
        usage = {
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          planQuota: event.planQuota ?? null,
        };
        break;
    }
  }

  return { items, usage };
}

/** The pane-level visual state: what the most recent event says the agent is doing. */
export function deriveVisualState(items: readonly TimelineItem[]): TimelineVisualState {
  const last = items[items.length - 1];
  if (last === undefined) return 'idle';
  if (last.kind === 'tool') return last.status === 'running' ? 'tool-use' : 'idle';
  if (last.kind === 'thinking') return last.streaming ? 'thinking' : 'idle';
  if (last.kind === 'turn') return last.streaming ? 'streaming' : 'idle';
  return 'idle';
}
