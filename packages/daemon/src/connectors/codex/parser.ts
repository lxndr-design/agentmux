import {
  canTransition,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ExitInfo,
  type SessionState,
} from '@agentmux/protocol';
import { classifyShellCommandRisk } from '../policy.js';
import {
  codexAppItemSchema,
  codexExecErrorSchema,
  codexExecItemEventSchema,
  codexExecThreadStartedSchema,
  codexExecTurnCompletedSchema,
  codexExecTurnFailedSchema,
  codexExecTurnStartedSchema,
  codexNotificationSchema,
  codexServerRequestSchema,
  encodeApprovalResponse,
  encodeV1ApprovalResponse,
  type CodexApprovalDecision,
} from './wire.js';

/**
 * The stream→protocol mapping — the connector's entire job (blueprint: "One
 * event model, many backends"), for BOTH Codex surfaces: app-server
 * notifications/requests (camelCase) and exec JSONL (snake_case). Also the
 * single owner of the session state machine: every state_change event in the
 * journal was emitted here, so an illegal transition is impossible by
 * construction.
 *
 * Tolerance contract (Q5): a schema drift is a warning, never a crash.
 * Unknown event types, unknown item types, and parse failures are recorded
 * (warnings + retained raw lines) and parsing continues.
 *
 * Dialect normalization: the two surfaces describe the same items with
 * different casings (`commandExecution` vs `command_execution`). Both
 * normalize to one item shape, so the mapping below is written once.
 */

/** Canonical item kinds after dialect normalization. */
type ItemKind =
  | 'agent-message'
  | 'reasoning'
  | 'command-execution'
  | 'file-change'
  | 'mcp-tool-call'
  | 'web-search'
  | 'todo-list'
  | 'error'
  | 'unknown';

interface NormalizedItem {
  id: string;
  kind: ItemKind;
  rawType: string;
  text?: string;
  /** Shell command — string as-is, argv array joined with spaces. */
  command?: string;
  output?: string;
  exitCode?: number | null;
  status?: string;
  changes?: Array<{ path: string; kind?: string }>;
  message?: string;
}

function normalizeItemKind(rawType: string): ItemKind {
  switch (rawType) {
    case 'agentMessage':
    case 'agent_message':
      return 'agent-message';
    case 'reasoning':
      return 'reasoning';
    case 'commandExecution':
    case 'command_execution':
      return 'command-execution';
    case 'fileChange':
    case 'file_change':
      return 'file-change';
    case 'mcpToolCall':
    case 'mcp_tool_call':
      return 'mcp-tool-call';
    case 'webSearch':
    case 'web_search':
      return 'web-search';
    case 'todoList':
    case 'todo_list':
      return 'todo-list';
    case 'error':
      return 'error';
    default:
      return 'unknown';
  }
}

/** Accepts both dialects' item objects into one normalized shape. */
function normalizeItem(raw: unknown): NormalizedItem | null {
  const parsed = codexAppItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const command =
    typeof item.command === 'string'
      ? item.command
      : Array.isArray(item.command) && item.command.every((part) => typeof part === 'string')
        ? (item.command as string[]).join(' ')
        : undefined;
  return {
    id: item.id,
    kind: normalizeItemKind(item.type),
    rawType: item.type,
    ...(typeof item.text === 'string' ? { text: item.text } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
    ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(item.changes !== undefined
      ? { changes: item.changes.map((change) => ({ path: change.path, kind: change.kind })) }
      : {}),
    ...(typeof item.message === 'string' ? { message: item.message } : {}),
  };
}

/**
 * One pending CLI prompt, correlated by the JSON-RPC request id, with the
 * response dialect that request expects back.
 */
interface PendingApproval {
  request: ApprovalRequest;
  dialect: 'v2' | 'v1';
  serverRequestId: string | number;
}

/**
 * Stateful-but-deterministic mapping: given a frame order, the event order is
 * fixed — which is what the golden fixtures pin. The session notifies it of
 * stdin-side facts (turn sent, decision sent) so every state transition still
 * flows through this one class.
 */
export class CodexEventMapper {
  private currentState: SessionState = 'created';
  private turnCounter = 0;
  /** The Codex turn id, when the CLI has announced one (app-server only). */
  private currentCodexTurnId: string | null = null;
  /** True between a sent turn and its completion — guards the done flush. */
  private turnOpen = false;
  /**
   * A turn completed while the machine sat in waiting-approval: the
   * completion is queued here and applied after the decision resolves
   * (waiting-approval may only return to working, never straight to ready).
   */
  private turnEndedWhileWaiting = false;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Items whose content arrived as deltas — their completed frame is a done marker, not a replay. */
  private readonly streamedItemIds = new Set<string>();
  /** fileChange items seen on the stream, by id — the file-change approval card's paths source. */
  private readonly knownFileChanges = new Map<string, NormalizedItem>();
  /** exec-only: the thread id from `thread.started`, needed for `exec resume`. */
  private execThreadId: string | null = null;
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

  /** exec-only: the thread id announced by `thread.started` (resume target). */
  getExecThreadId(): string | null {
    return this.execThreadId;
  }

  // ---- stdin-side notifications ------------------------------------------

  /** The connector spawned the PTY — the session's first journal entry. */
  notifyStarting(): void {
    this.transitionTo('starting');
  }

  /**
   * The CLI is accepting turns. app-server: the thread/start response. exec:
   * immediately at construction — there is no handshake; the container is
   * live even though no turn process exists yet.
   */
  notifyReady(): void {
    this.transitionTo('ready');
  }

  /** A user turn was sent — ready→working; already working = steered mid-turn. */
  notifyTurnSent(text: string): void {
    this.emit({
      kind: 'turn',
      turnId: `turn-${++this.turnCounter}`,
      role: 'user',
      text,
      done: true,
    });
    this.turnOpen = true;
    this.turnEndedWhileWaiting = false;
    if (this.currentState === 'ready') this.transitionTo('working');
  }

  /**
   * The decision, already encoded for the CLI's dialect — returned as the
   * stdin frame to write, or null when the request is unknown/resolved.
   */
  buildDecisionFrame(decision: ApprovalDecision): string | null {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (pending === undefined) {
      this.warn(`decision for unknown or already-resolved request ${decision.requestId}`);
      return null;
    }
    this.pendingApprovals.delete(decision.requestId);
    const codexDecision = this.v2Decision(decision.decision);
    const frame =
      pending.dialect === 'v1'
        ? encodeV1ApprovalResponse(pending.serverRequestId, {
            approve: decision.decision !== 'deny',
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          })
        : encodeApprovalResponse(pending.serverRequestId, codexDecision);
    this.afterDecisionSent();
    return frame;
  }

  /** The process group is gone — the tombstone transition. Idempotent. */
  emitTerminal(exit: ExitInfo, to: 'stopped' | 'crashed'): void {
    if (this.currentState === 'stopped' || this.currentState === 'crashed') return;
    this.transitionTo(to, { exit });
  }

  /**
   * exec mode: the turn's process exited — the turn boundary is the process
   * boundary. Turn content closes; the session state itself stays 'working'
   * between turns — the protocol machine enters 'ready' once at init (the
   * same pattern the Claude connector follows; working→ready is not a legal
   * transition).
   */
  notifyExecTurnEnded(): void {
    this.turnOpen = false;
  }

  // ---- app-server consumption ----------------------------------------------

  /** One stdout line of the app-server dialect. Response frames are the session's business, not ours. */
  consumeAppServerLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.unknownLines.push(trimmed);
      this.warn(
        `unparseable line retained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const frame = parsed as Record<string, unknown>;
    if (typeof frame.method === 'string') {
      this.onAppServerFrame(frame);
      return;
    }
    // {id, result} response frames are expected here only if the session's
    // routing sent one by mistake — flag it rather than swallow it.
    this.warn('response frame reached the mapper — session routing misordered');
    this.unknownLines.push(trimmed);
  }

  private onAppServerFrame(frame: Record<string, unknown>): void {
    if ('id' in frame) {
      const request = codexServerRequestSchema.safeParse(frame);
      if (!request.success) {
        this.unknownLines.push(JSON.stringify(frame));
        this.warn('server request failed schema — retained');
        return;
      }
      this.onServerRequest(
        request.data.id,
        request.data.method,
        request.data.params ?? {},
        JSON.stringify(frame),
      );
      return;
    }
    const notification = codexNotificationSchema.safeParse(frame);
    if (!notification.success) {
      this.unknownLines.push(JSON.stringify(frame));
      this.warn('notification failed schema — retained');
      return;
    }
    this.onNotification(
      notification.data.method,
      notification.data.params ?? {},
      JSON.stringify(frame),
    );
  }

  private onServerRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown>,
    raw: string,
  ): void {
    if (method === 'item/commandExecution/requestApproval') {
      const requestId = `codex-approval-${String(id)}`;
      const command = typeof params.command === 'string' ? params.command : undefined;
      const request: ApprovalRequest = {
        requestId,
        tool: 'shell',
        ...(command === undefined
          ? { risk: 'high' as const, command: JSON.stringify(params) }
          : { risk: classifyShellCommandRisk(command), command }),
      };
      this.enterWaitingApproval(requestId, { request, dialect: 'v2', serverRequestId: id });
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const requestId = `codex-approval-${String(id)}`;
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      const seen = itemId !== '' ? this.knownFileChanges.get(itemId) : undefined;
      const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined;
      const paths =
        seen?.changes?.map((change) => change.path) ?? (grantRoot !== undefined ? [grantRoot] : []);
      const request: ApprovalRequest = {
        requestId,
        tool: 'apply-patch',
        // File changes are worktree edits — the medium class, like Claude's Edit.
        ...(paths.length > 0
          ? { risk: 'medium' as const, paths }
          : { risk: 'medium' as const, command: JSON.stringify(params) }),
      };
      this.enterWaitingApproval(requestId, { request, dialect: 'v2', serverRequestId: id });
      return;
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      // v1 shapes; accepted tolerantly so an older CLI version still
      // round-trips. Decisions answer in the v1 dialect.
      const requestId = `codex-approval-${String(id)}`;
      const commandArgv = Array.isArray(params.command)
        ? params.command.filter((part): part is string => typeof part === 'string')
        : [];
      const rawChanges = params.file_changes ?? params.fileChanges;
      const changePaths = Array.isArray(rawChanges)
        ? rawChanges
            .map((change) => (change as { path?: unknown }).path)
            .filter((path): path is string => typeof path === 'string')
        : [];
      const grantRoot = typeof params.grant_root === 'string' ? params.grant_root : undefined;
      const request: ApprovalRequest =
        method === 'execCommandApproval'
          ? {
              requestId,
              tool: 'shell',
              ...(commandArgv.length > 0
                ? {
                    risk: classifyShellCommandRisk(commandArgv.join(' ')),
                    command: commandArgv.join(' '),
                  }
                : { risk: 'high' as const, command: JSON.stringify(params) }),
            }
          : {
              requestId,
              tool: 'apply-patch',
              risk: 'medium',
              ...(changePaths.length > 0
                ? { paths: changePaths }
                : grantRoot !== undefined
                  ? { paths: [grantRoot] }
                  : { command: JSON.stringify(params) }),
            };
      this.enterWaitingApproval(requestId, { request, dialect: 'v1', serverRequestId: id });
      return;
    }
    this.unknownLines.push(raw);
    this.warn(`server request "${method}" acknowledged without mapping`);
  }

  private onNotification(method: string, params: Record<string, unknown>, raw: string): void {
    switch (method) {
      case 'turn/started': {
        const turn = params.turn as { id?: unknown } | undefined;
        if (typeof turn?.id === 'string') this.currentCodexTurnId = turn.id;
        return;
      }
      case 'turn/completed': {
        this.onTurnCompleted(params.turn as { status?: unknown; error?: unknown } | undefined);
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = normalizeItem(params.item);
        if (item === null) {
          this.unknownLines.push(JSON.stringify(params));
          this.warn(`${method}: item failed schema — retained`);
          return;
        }
        if (method === 'item/started') this.onItemStarted(item);
        else this.onItemCompleted(item);
        return;
      }
      case 'item/updated': {
        // Progress-only on the wire; the completed frame is authoritative.
        return;
      }
      case 'item/agentMessage/delta': {
        const delta = this.deltaText(params);
        if (delta === null) return;
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        if (itemId !== '') this.streamedItemIds.add(itemId);
        this.emit({
          kind: 'turn',
          turnId: this.assistantTurnId(params),
          role: 'assistant',
          text: delta,
          done: false,
        });
        return;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const delta = this.deltaText(params);
        if (delta === null) return;
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        if (itemId !== '') this.streamedItemIds.add(itemId);
        this.emit({
          kind: 'thinking',
          text: delta,
          done: false,
          ...this.turnIdField(params),
        });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as
          { total?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined;
        const total = usage?.total ?? {};
        this.emit({
          kind: 'usage',
          tokensIn: typeof total.input_tokens === 'number' ? total.input_tokens : 0,
          tokensOut: typeof total.output_tokens === 'number' ? total.output_tokens : 0,
        });
        return;
      }
      case 'thread/started': {
        // Duplicates the thread/start response — nothing to map.
        return;
      }
      case 'thread/status/changed': {
        // idle/active flips mirror state we already track via turns.
        return;
      }
      case 'error':
      case 'warning': {
        const error = params.error as { message?: unknown } | undefined;
        this.warn(
          `CLI ${method}: ${typeof error?.message === 'string' ? error.message : JSON.stringify(params)}`,
        );
        return;
      }
      default:
        // Tolerance contract: unknown input is retained raw AND warned, so a
        // schema drift is diagnosable from the journal, never silent.
        this.unknownLines.push(raw);
        this.warn(`notification "${method}" acknowledged without mapping`);
    }
  }

  private onTurnCompleted(turn: { status?: unknown; error?: unknown } | undefined): void {
    const status = typeof turn?.status === 'string' ? turn.status : 'completed';
    const error = turn?.error as { message?: unknown } | undefined;
    if (status === 'failed') {
      this.warn(
        `turn failed: ${typeof error?.message === 'string' ? error.message : 'unknown error'}`,
      );
    } else if (status === 'interrupted') {
      this.warn('turn interrupted');
    }

    if (this.currentState === 'waiting-approval') {
      // The turn ended but a prompt is still open: the completion queues —
      // waiting-approval may only return to working.
      this.turnEndedWhileWaiting = true;
      this.warn('turn completed while waiting-approval — completion queued');
      return;
    }
    this.finishTurn();
  }

  private finishTurn(): void {
    this.emitTurnDone();
    this.currentCodexTurnId = null;
    this.turnOpen = false;
    // No ready transition here: the protocol machine enters 'ready' once at
    // init and 'working' persists between turns (Claude-connector pattern).
  }

  private onItemStarted(item: NormalizedItem): void {
    switch (item.kind) {
      case 'command-execution': {
        if (item.command !== undefined) {
          this.emit({
            kind: 'tool_use',
            callId: item.id,
            tool: 'shell',
            detail: { command: item.command },
          });
        }
        return;
      }
      case 'file-change': {
        this.knownFileChanges.set(item.id, item);
        if (item.changes !== undefined && item.changes.length > 0) {
          this.emit({
            kind: 'tool_use',
            callId: item.id,
            tool: 'apply-patch',
            detail: { paths: item.changes.map((change) => change.path) },
          });
        }
        return;
      }
      case 'mcp-tool-call': {
        this.emit({
          kind: 'tool_use',
          callId: item.id,
          tool: 'mcp',
          ...(item.message !== undefined || item.text !== undefined
            ? { summary: item.message ?? item.text }
            : {}),
        });
        return;
      }
      case 'web-search': {
        this.emit({
          kind: 'tool_use',
          callId: item.id,
          tool: 'web-search',
          ...(item.text !== undefined ? { summary: item.text } : {}),
        });
        return;
      }
      case 'todo-list': {
        this.emit({
          kind: 'tool_use',
          callId: item.id,
          tool: 'todo-list',
          ...(item.text !== undefined ? { summary: item.text } : {}),
        });
        return;
      }
      case 'error': {
        this.emit({
          kind: 'tool_use',
          callId: item.id,
          tool: 'error',
          ...(item.message !== undefined ? { summary: item.message } : {}),
        });
        return;
      }
      case 'agent-message':
      case 'reasoning':
      case 'unknown': {
        // Content arrives via deltas or the completed frame.
        if (item.kind === 'unknown') {
          this.warn(`item type "${item.rawType}" acknowledged without mapping`);
        }
        return;
      }
    }
  }

  private onItemCompleted(item: NormalizedItem): void {
    switch (item.kind) {
      case 'command-execution': {
        const failedByStatus = item.status === 'failed' || item.status === 'declined';
        this.emit({
          kind: 'tool_result',
          callId: item.id,
          output: item.output ?? '',
          truncated: false,
          ...((item.exitCode !== undefined && item.exitCode !== 0) ||
          (item.exitCode === undefined && failedByStatus)
            ? { isError: true }
            : {}),
        });
        return;
      }
      case 'file-change': {
        this.emit({
          kind: 'tool_result',
          callId: item.id,
          output: renderFileChanges(item),
          truncated: false,
          ...(item.status === 'failed' ? { isError: true } : {}),
        });
        return;
      }
      case 'agent-message': {
        const turnId = item.id;
        if (!this.streamedItemIds.has(item.id) && item.text !== undefined) {
          this.emit({ kind: 'turn', turnId, role: 'assistant', text: item.text, done: false });
        }
        this.emit({ kind: 'turn', turnId, role: 'assistant', text: '', done: true });
        return;
      }
      case 'reasoning': {
        if (!this.streamedItemIds.has(item.id)) {
          this.emit({
            kind: 'thinking',
            ...this.turnIdField({}),
            text: item.text ?? '',
            done: true,
          });
          return;
        }
        this.emit({
          kind: 'thinking',
          ...this.turnIdField({}),
          text: '',
          done: true,
        });
        return;
      }
      case 'mcp-tool-call': {
        this.emit({
          kind: 'tool_result',
          callId: item.id,
          output: item.output ?? item.text ?? item.message ?? '',
          truncated: false,
          ...(item.status === 'failed' ? { isError: true } : {}),
        });
        return;
      }
      case 'web-search':
      case 'todo-list': {
        this.emit({
          kind: 'tool_result',
          callId: item.id,
          output: item.text ?? '',
          truncated: false,
        });
        return;
      }
      case 'error': {
        this.emit({
          kind: 'tool_result',
          callId: item.id,
          output: item.message ?? '',
          truncated: false,
          isError: true,
        });
        return;
      }
      case 'unknown': {
        this.warn(`item type "${item.rawType}" completed without mapping`);
        return;
      }
    }
  }

  // ---- exec JSONL consumption ------------------------------------------------

  /** One stdout line of the exec dialect. */
  consumeExecLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.unknownLines.push(trimmed);
      this.warn(
        `unparseable line retained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const frame = parsed as Record<string, unknown>;
    const type = typeof frame.type === 'string' ? frame.type : '';
    switch (type) {
      case 'thread.started': {
        const event = codexExecThreadStartedSchema.safeParse(parsed);
        if (event.success) this.execThreadId = event.data.thread_id;
        return;
      }
      case 'turn.started': {
        // Shape retained via warnings when it fails; nothing to map.
        if (!codexExecTurnStartedSchema.safeParse(parsed).success) {
          this.unknownLines.push(trimmed);
          this.warn('turn.started failed schema — retained');
        }
        return;
      }
      case 'turn.completed': {
        const event = codexExecTurnCompletedSchema.safeParse(parsed);
        const usage = event.success ? event.data.usage : undefined;
        this.emit({
          kind: 'usage',
          tokensIn: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
          tokensOut: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
        });
        // The CLI's turn/completed is the turn boundary on this surface —
        // turn content closes here rather than at the process exit.
        this.notifyExecTurnEnded();
        return;
      }
      case 'turn.failed': {
        const event = codexExecTurnFailedSchema.safeParse(parsed);
        this.warn(
          `turn failed: ${event.success ? (event.data.error?.message ?? 'unknown error') : 'unknown error'}`,
        );
        this.notifyExecTurnEnded();
        return;
      }
      case 'error': {
        const event = codexExecErrorSchema.safeParse(parsed);
        this.warn(`CLI error: ${event.success ? (event.data.message ?? '') : ''}`);
        return;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const event = codexExecItemEventSchema.safeParse(parsed);
        if (!event.success) {
          this.unknownLines.push(trimmed);
          this.warn(`${type}: item failed schema — retained`);
          return;
        }
        const raw = event.data.item as Record<string, unknown>;
        const item = normalizeItem({
          ...raw,
          // snake_case → the normalizer's camelCase keys.
          ...(raw.aggregated_output !== undefined
            ? { aggregatedOutput: raw.aggregated_output }
            : {}),
          ...(raw.exit_code !== undefined ? { exitCode: raw.exit_code } : {}),
        });
        if (item === null) {
          this.unknownLines.push(trimmed);
          this.warn(`${type}: item failed normalization — retained`);
          return;
        }
        if (item.kind === 'unknown' && type !== 'item.updated') {
          // Unknown item types are retained raw like any other drift.
          this.unknownLines.push(trimmed);
        }
        if (type === 'item.started') this.onItemStarted(item);
        else if (type === 'item.completed') this.onItemCompleted(item);
        return;
      }
      default:
        this.unknownLines.push(trimmed);
        this.warn(`exec event type "${type || 'missing'}" retained without mapping`);
    }
  }

  // ---- shared helpers ------------------------------------------------------

  private enterWaitingApproval(requestId: string, pending: PendingApproval): void {
    if (this.currentState === 'working' || this.currentState === 'ready') {
      if (this.currentState === 'ready') {
        // Prompt before any turn activity: walk ready→working first so the
        // journal stays legal (blueprint transitions).
        this.transitionTo('working');
      }
      this.pendingApprovals.set(requestId, pending);
      this.transitionTo('waiting-approval', { request: pending.request });
      return;
    }
    if (this.currentState === 'waiting-approval') {
      // Concurrent prompts are held, not dropped; the next decision re-surfaces them.
      this.pendingApprovals.set(requestId, pending);
      this.warn(`concurrent approval ${requestId} held while waiting-approval`);
      return;
    }
    this.warn(`approval request in state ${this.currentState} — dropped with warning`);
  }

  private afterDecisionSent(): void {
    if (this.pendingApprovals.size > 0) {
      // A second prompt was held while waiting-approval — re-surface it now
      // that the machine is back in working.
      this.transitionTo('working');
      const next = [...this.pendingApprovals.values()][0];
      if (next) {
        this.pendingApprovals.delete(next.request.requestId);
        this.enterWaitingApproval(next.request.requestId, next);
      }
      return;
    }
    this.transitionTo('working');
    if (this.turnEndedWhileWaiting) {
      // The queued completion applies now: the turn is over, the machine may
      // finally settle back to ready.
      this.turnEndedWhileWaiting = false;
      this.finishTurn();
    }
  }

  private v2Decision(decision: ApprovalDecision['decision']): CodexApprovalDecision {
    switch (decision) {
      case 'approve':
        return 'accept';
      case 'approve-for-session':
        return 'acceptForSession';
      case 'deny':
        return 'decline';
    }
  }

  private deltaText(params: Record<string, unknown>): string | null {
    return typeof params.delta === 'string' ? params.delta : null;
  }

  private turnIdField(params: Record<string, unknown>): { turnId?: string } {
    if (typeof params.turnId === 'string') return { turnId: params.turnId };
    if (this.currentCodexTurnId !== null) return { turnId: this.currentCodexTurnId };
    return {};
  }

  private assistantTurnId(params: Record<string, unknown>): string {
    const turnId = typeof params.turnId === 'string' ? params.turnId : this.currentCodexTurnId;
    return turnId ?? `turn-local-${++this.turnCounter}`;
  }

  private emitTurnDone(): void {
    // exec turns are item-keyed and carry their own done markers; the
    // app-server flush pins the announced turn id when one is open.
    if (this.currentCodexTurnId === null || !this.turnOpen) return;
    this.emit({
      kind: 'turn',
      turnId: this.currentCodexTurnId,
      role: 'assistant',
      text: '',
      done: true,
    });
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

function renderFileChanges(item: NormalizedItem): string {
  const lines = (item.changes ?? []).map((change) => `${change.kind ?? 'update'}: ${change.path}`);
  if (item.status !== undefined) lines.push(`status: ${item.status}`);
  return lines.join('\n');
}
