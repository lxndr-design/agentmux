import type { AgentEvent, ApprovalDecision, ExitInfo, SessionState } from '@agentmux/protocol';

/**
 * Vendor-neutral connector contracts (blueprint: "One event model, many
 * backends"). A connector adapts one agent CLI to the normalized protocol;
 * everything above this file only ever sees protocol events. The Claude Code
 * connector is the first implementation — the Codex connector is the second
 * data point that proves the abstraction.
 */

/** Result of `detect()` — the onboarding wizard renders install/auth steps from it. */
export interface ConnectorDetectResult {
  installed: boolean;
  version?: string;
  /**
   * Subscription-auth state for CLIs that log in outside agentmux (Codex:
   * ChatGPT plan vs API key vs none — F3a/F3b). Credentials are the user's
   * own and stay with the CLI; this only reports what the CLI itself reports.
   */
  authState?: 'subscription' | 'api-key' | 'other' | 'none' | 'unavailable';
  /** Human-readable auth diagnostic rendered next to the state. */
  authDetail?: string;
}

/**
 * Spawn configuration. `command` and `extraArgs` exist so tests can substitute
 * a fake CLI (never a real claude binary, never API keys); production resolves
 * `claude` on PATH. The user's subscription credentials stay with the CLI's
 * own config/keychain — agentmux never sees or stores a token (F2e).
 */
export interface SessionSpawnConfig {
  sessionId: string;
  /** Working directory — the session's git worktree by default. */
  cwd: string;
  /** CLI permission preset chosen at spawn; nothing here routes around approvals. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  model?: string;
  command?: string;
  /** Prepended to the connector's flag list (a fake CLI script path in tests). */
  extraArgs?: string[];
}

/** Where the session pushes normalized events (the daemon journals then fans out). */
export interface SessionEventSink {
  onEvent(event: AgentEvent): void;
}

/**
 * A live agent session. `exit` settles exactly once, when the process group
 * is gone and the terminal state_change has been emitted.
 */
export interface AgentSession {
  readonly id: string;
  /** Mirrors the protocol state machine — the parser is the single owner. */
  readonly state: SessionState;
  /** Sends one user turn over stream-json stdin. */
  send(text: string): void;
  /** Answers a pending approval (the round-trip closes over the CLI's stdin). */
  respondToApproval(decision: ApprovalDecision): void;
  /** Graceful-then-forced process-group kill: SIGINT → grace → SIGKILL. */
  kill(options?: { graceMs?: number }): Promise<ExitInfo>;
  /** Settles when the session reaches a terminal state. */
  exit: Promise<ExitInfo>;
}

export interface AgentConnector {
  /** Stable connector id — 'claude-code', 'codex', … */
  readonly id: string;
  detect(): Promise<ConnectorDetectResult>;
  spawn(config: SessionSpawnConfig, sink: SessionEventSink): Promise<AgentSession>;
}
