import type { ApprovalRequest, ApprovalRisk } from '@agentmux/protocol';

/**
 * Approval-card policy shared by every connector (blueprint: "The human in
 * the loop"). The Claude connector contributed it first; the Codex connector
 * is the second consumer — one risk model, one full-disclosure rule,
 * regardless of CLI.
 */

/** Read-only tools — the connector's default risk classes (the policy engine refines these). */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TaskOutput']);
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Commands that put a shell call into the high-risk class (destructive or network egress). */
const HIGH_RISK_COMMAND =
  /\b(rm\s+-[a-z]*[rf]|dd\s|mkfs|shutdown|reboot|:\(\)\s*\{\s*:\|&\s*\};|curl\b|wget\b|ssh\b|scp\b|nc\b|ncat\b|git\s+push\s+.*--force|git\s+push\s+-f)/;

/**
 * Risk class for a shell command line — destructive or network-egress
 * commands are high, everything else medium.
 */
export function classifyShellCommandRisk(command: string): ApprovalRisk {
  return HIGH_RISK_COMMAND.test(command) ? 'high' : 'medium';
}

/**
 * Default risk classification for an approval card. Unknown tools fail
 * closed (high) — the column is the conscience, not a convenience.
 */
export function classifyRisk(tool: string, input: unknown): ApprovalRisk {
  if (tool === 'Bash' || tool === 'BashOutput') {
    const command =
      typeof (input as { command?: unknown } | null)?.command === 'string'
        ? (input as { command: string }).command
        : '';
    return classifyShellCommandRisk(command);
  }
  if (READ_ONLY_TOOLS.has(tool)) return 'low';
  if (FILE_EDIT_TOOLS.has(tool)) return 'medium';
  return 'high';
}

/**
 * Full disclosure for the approval card — never a summary alone. The exact
 * command for shell tools, the before/after content for file edits, the full
 * input for anything else.
 */
export function buildApprovalDetail(
  tool: string,
  input: unknown,
): Pick<ApprovalRequest, 'command' | 'diff' | 'paths'> {
  const record = (input ?? {}) as Record<string, unknown>;
  const command = record.command;
  if (typeof command === 'string') return { command };
  const filePath = record.file_path ?? record.notebook_path ?? record.path;
  const paths = typeof filePath === 'string' ? [filePath] : [];
  if (
    tool === 'Edit' &&
    typeof record.old_string === 'string' &&
    typeof record.new_string === 'string'
  ) {
    return { paths, diff: renderBeforeAfter(record.old_string, record.new_string) };
  }
  if (tool === 'Write' && typeof record.content === 'string') {
    return { paths, diff: renderBeforeAfter('', record.content) };
  }
  // Unknown tool shape: the full input is the disclosure.
  return { paths: paths.length > 0 ? paths : undefined, command: JSON.stringify(input) };
}

function renderBeforeAfter(before: string, after: string): string {
  return `--- before\n${before}\n+++ after\n${after}`;
}
