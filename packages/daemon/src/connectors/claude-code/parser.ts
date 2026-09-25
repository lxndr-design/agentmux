import {
  canTransition,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ExitInfo,
  type SessionState,
} from '@agentmux/protocol';
import { claudeStreamLineSchema, type ClaudePermissionResult } from './wire.js';

import { buildApprovalDetail, classifyRisk } from '../policy.js';

// Risk classification and disclosure live in the shared policy module (the
// Codex connector is the second consumer); re-exported for the tests.
export { buildApprovalDetail, classifyRisk };

/**
 * The stream→protocol mapping — the connector's entire job (blueprint: "One
 * event model, many backends"). Also the single owner of the session state
 * machine: every state_change event in the journal was emitted here, so an
 * illegal transition is impossible by construction.
 *
 * Tolerance contract (Q5): a schema drift is a warning, never a crash.
 * Unknown frame kinds and parse failures are recorded (warnings + retained
 * raw lines) and parsing continues.
 */

interface OpenToolBlock {
  callId: string;
  name: string;
  json: string;
}

/**
 * Stateful-but-pure mapping: deterministic given the frame order. The session
 * notifies it of stdin-side facts (turn sent, decision sent) so every state
 * transition still flows through this one class.
 */
export class ClaudeStreamParser {
  private currentState: SessionState = 'created';
  private currentTurnId: string | null = null;
  private turnCounter = 0;
  /** stream_event block index → open tool_use input accumulation. */
  private readonly openToolBlocks = new Map<number, OpenToolBlock>();
  private readonly emittedToolCallIds = new Set<string>();
  private readonly streamedMessageIds = new Set<string>();
  /** CLI permission prompts awaiting a decision (requestId → request). */
  private readonly pendingApprovals = new Map<string, ApprovalRequest>();
  private readonly warnings: string[] = [];
  private readonly unknownLines: string[] = [];

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  get state(): SessionState {
    return this.currentState;
  }

  getWarnings(): readonly string[] {
    return this.warnings;
  }

  getUnknownLines(): readonly string[] {
    return this.unknownLines;
  }

  // ---- stdin-side notifications ------------------------------------------

  /**
   * The connector spawned the PTY: the session's first journal entry. Ready
   * arrives later, from the CLI's own system/init frame.
   */
  notifyStarting(): void {
    this.transitionTo('starting');
  }

  /** A user turn was written to stdin — ready→working; already working = queued mid-stream. */
  notifyTurnSent(text: string): void {
    this.emit({
      kind: 'turn',
      turnId: `turn-${++this.turnCounter}`,
      role: 'user',
      text,
      done: true,
    });
    if (this.currentState === 'ready') this.transitionTo('working');
  }

  /** A decision was written to stdin — the pending prompt resolves. */
  notifyDecisionSent(decision: ApprovalDecision): void {
    if (!this.pendingApprovals.delete(decision.requestId)) {
      this.warn(`decision for unknown or already-resolved request ${decision.requestId}`);
      return;
    }
    if (this.pendingApprovals.size > 0) {
      // A second prompt was held while waiting-approval — re-surface it now
      // that the machine is back in working.
      this.transitionTo('working');
      const next = [...this.pendingApprovals.values()][0];
      if (next) {
        this.pendingApprovals.delete(next.requestId);
        this.enterWaitingApproval(next);
      }
      return;
    }
    this.transitionTo('working');
  }

  /** The process group is gone — the tombstone transition. Idempotent. */
  emitTerminal(exit: ExitInfo, to: 'stopped' | 'crashed'): void {
    // Idempotence only: every non-terminal parser state can reach both
    // terminal states, and notifyStarting() means the parser never rests in
    // 'created' — so no forced fallback path exists here.
    if (this.currentState === 'stopped' || this.currentState === 'crashed') return;
    this.transitionTo(to, { exit });
  }

  // ---- stdout consumption -------------------------------------------------

  /** One stdout line → zero or more protocol events. Tolerant by design. */
  consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      // PTY noise or a torn frame: keep the raw bytes, keep going.
      this.unknownLines.push(trimmed);
      this.warn(
        `unparseable line retained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const frame = claudeStreamLineSchema.safeParse(parsed);
    if (!frame.success) {
      this.unknownLines.push(trimmed);
      this.warn(`unknown frame type "${String((parsed as { type?: unknown }).type)}" retained`);
      return;
    }

    switch (frame.data.type) {
      case 'system':
        this.onSystem(frame.data);
        break;
      case 'stream_event':
        this.onStreamEvent(frame.data);
        break;
      case 'assistant':
        this.onAssistantMessage(frame.data);
        break;
      case 'user':
        this.onUserMessage(frame.data);
        break;
      case 'result':
        this.onResult(frame.data);
        break;
      case 'control_request':
        this.onControlRequest(frame.data);
        break;
      case 'control_cancel_request':
        this.onControlCancel(frame.data);
        break;
      case 'control_response':
        // The CLI answering a host→CLI request (or echo residue). Nothing to
        // map for v1 — acknowledged, retained via passthrough, no event.
        break;
    }
  }

  private onSystem(frame: { subtype?: string }): void {
    if (frame.subtype !== 'init') {
      this.warn(`system/${frame.subtype ?? 'unknown'} frame acknowledged without mapping`);
      return;
    }
    if (this.currentState === 'starting') {
      this.transitionTo('ready');
    } else if (this.currentState !== 'ready') {
      this.warn(`init frame in unexpected state ${this.currentState}`);
    }
  }

  private onStreamEvent(frame: { event: { type: string } & Record<string, unknown> }): void {
    const event = frame.event;
    switch (event.type) {
      case 'message_start': {
        const message = (event as { message?: { id?: unknown } }).message;
        const id = typeof message?.id === 'string' ? message.id : null;
        this.currentTurnId = id ?? `turn-local-${++this.turnCounter}`;
        // The complete assistant frame for this id follows the stream_events —
        // mark it streamed now so it never re-emits its content.
        if (id !== null) this.streamedMessageIds.add(id);
        break;
      }
      case 'content_block_start': {
        const index = typeof event.index === 'number' ? event.index : -1;
        const block = (event as { content_block?: Record<string, unknown> }).content_block ?? {};
        if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          // Record only — the real input arrives via input_json_delta chunks.
          // Emitting here would publish `{}` as the tool's input; the full
          // input is emitted at content_block_stop once assembled.
          this.openToolBlocks.set(index, { callId: block.id, name: block.name, json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = (event as { delta?: Record<string, unknown> }).delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit({
            kind: 'turn',
            turnId: this.currentTurnId ?? `turn-local-${++this.turnCounter}`,
            role: 'assistant',
            text: delta.text,
            done: false,
          });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.emit({
            kind: 'thinking',
            text: delta.thinking,
            done: false,
            ...(this.currentTurnId !== null ? { turnId: this.currentTurnId } : {}),
          });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = typeof event.index === 'number' ? event.index : -1;
          const open = this.openToolBlocks.get(index);
          if (open) open.json += delta.partial_json;
        }
        // signature_delta and friends: retention by passthrough only.
        break;
      }
      case 'content_block_stop': {
        const index = typeof event.index === 'number' ? event.index : -1;
        const open = this.openToolBlocks.get(index);
        if (open) {
          this.openToolBlocks.delete(index);
          if (open.json.length === 0) {
            // No deltas streamed for this block — the complete assistant
            // frame is the input's only carrier; leave emission to it.
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(open.json);
          } catch {
            // Torn input_json: emitting a half-input card would misrepresent
            // the tool call; the complete assistant frame emits instead.
            this.warn(
              `tool_use ${open.callId}: unparseable input_json retained, deferring to complete frame`,
            );
            break;
          }
          this.emitToolUse(open.callId, open.name, parsed);
        }
        break;
      }
      case 'message_stop': {
        this.emitTurnDone();
        break;
      }
      default:
        // message_start is handled above; message_delta etc. carry no mapping for v1.
        break;
    }
  }

  private onAssistantMessage(frame: {
    message: {
      id?: string;
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
    };
  }): void {
    const message = frame.message;
    const turnId = message.id ?? `turn-local-${++this.turnCounter}`;
    const alreadyStreamed = message.id !== undefined && this.streamedMessageIds.has(message.id);
    if (message.id !== undefined) this.streamedMessageIds.add(message.id);

    const content = message.content ?? [];

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && !alreadyStreamed) {
        this.emit({
          kind: 'turn',
          turnId,
          role: 'assistant',
          text: block.text,
          done: false,
        });
      } else if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        !alreadyStreamed
      ) {
        this.emit({
          kind: 'thinking',
          text: block.thinking,
          done: true,
          turnId,
        });
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        // Dedupe against the stream_event emission of the same block.
        if (!this.emittedToolCallIds.has(block.id)) {
          this.emitToolUse(block.id, block.name, block.input);
        }
      }
    }
    if (!alreadyStreamed) this.emitTurnDone(turnId);
  }

  private onUserMessage(frame: { message: { content?: unknown } }): void {
    const content = frame.message.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      const candidate = block as {
        type?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      if (candidate.type === 'tool_result' && typeof candidate.tool_use_id === 'string') {
        this.emit({
          kind: 'tool_result',
          callId: candidate.tool_use_id,
          output: renderToolResultContent(candidate.content),
          truncated: false,
          ...(candidate.is_error === true ? { isError: true } : {}),
        });
      }
      // Text-only user frames: PTY echo residue (or --replay-user-messages,
      // which we never enable). User turns enter the stream via
      // notifyTurnSent — never from stdout.
    }
  }

  private onResult(frame: {
    usage?: { input_tokens?: number; output_tokens?: number };
    is_error?: boolean;
  }): void {
    // Cache tokens are tracked separately by the future cost rollup; v1 maps
    // the base counts.
    const tokensIn = frame.usage?.input_tokens ?? 0;
    const tokensOut = frame.usage?.output_tokens ?? 0;
    this.emit({ kind: 'usage', tokensIn, tokensOut });
  }

  private onControlRequest(frame: {
    request_id: string;
    request: { subtype: string; tool_name?: string; input?: unknown };
  }): void {
    if (frame.request.subtype !== 'can_use_tool') {
      this.warn(`control request subtype "${frame.request.subtype}" acknowledged without mapping`);
      return;
    }
    const tool = frame.request.tool_name ?? 'unknown';
    const input = frame.request.input;
    const request: ApprovalRequest = {
      requestId: frame.request_id,
      tool,
      risk: classifyRisk(tool, input),
      ...buildApprovalDetail(tool, input),
    };

    if (this.currentState === 'working') {
      this.enterWaitingApproval(request);
      return;
    }
    if (this.currentState === 'waiting-approval') {
      // Concurrent prompts are held, not dropped; the next decision re-surfaces them.
      this.pendingApprovals.set(request.requestId, request);
      this.warn(`concurrent can_use_tool ${request.requestId} held while waiting-approval`);
      return;
    }
    // Prompt before any turn activity: walk ready→working first so the
    // journal stays legal (blueprint transitions).
    if (this.currentState === 'ready') {
      this.transitionTo('working');
      this.enterWaitingApproval(request);
      return;
    }
    this.warn(`can_use_tool in state ${this.currentState} — dropped with warning`);
  }

  private onControlCancel(frame: { request_id: string }): void {
    if (!this.pendingApprovals.delete(frame.request_id)) return;
    if (this.pendingApprovals.size === 0 && this.currentState === 'waiting-approval') {
      this.transitionTo('working');
    }
  }

  // ---- shared helpers ------------------------------------------------------

  private enterWaitingApproval(request: ApprovalRequest): void {
    this.pendingApprovals.set(request.requestId, request);
    this.transitionTo('waiting-approval', { request });
  }

  private emitToolUse(callId: string, name: string, input: unknown): void {
    this.emittedToolCallIds.add(callId);
    this.emit({
      kind: 'tool_use',
      callId,
      tool: name,
      detail: buildApprovalDetail(name, input),
    });
  }

  private emitTurnDone(messageId?: string): void {
    // The complete assistant frame's own id wins: its content events are
    // tagged with it, so its done marker must match even while a stream_event
    // turn id is still buffered. currentTurnId serves the message_stop path,
    // which has no id of its own.
    const turnId = messageId ?? this.currentTurnId;
    this.currentTurnId = null;
    if (turnId === undefined || turnId === null) return;
    this.emit({ kind: 'turn', turnId, role: 'assistant', text: '', done: true });
  }

  private transitionTo(
    to: SessionState,
    extra: { request?: ApprovalRequest; exit?: ExitInfo } = {},
  ): void {
    if (!canTransition(this.currentState, to)) {
      this.warn(`illegal transition ${this.currentState}→${to} suppressed`);
      return;
    }
    const from = this.currentState;
    this.currentState = to;
    this.emit({ kind: 'state_change', from, to, ...extra });
  }

  private warn(message: string): void {
    this.warnings.push(message);
  }
}

/** Tool-result content is a string or an array of blocks — render honestly. */
function renderToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === 'text' && typeof candidate.text === 'string'
          ? candidate.text
          : JSON.stringify(block);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

export type { ClaudePermissionResult };
