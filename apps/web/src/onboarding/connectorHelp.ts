import type { AuthState, ConnectorDetectReport } from '@agentmux/protocol';

/**
 * Per-connector onboarding copy — install and login are the USER's actions in
 * their own terminal (blueprint Q4): agentmux detects, guides, and re-checks;
 * it never installs or authenticates for them and never sees a credential.
 * Commands are the vendors' documented ones (F2e, F3a).
 */

export interface ConnectorHelp {
  id: string;
  label: string;
  installCommand: string;
  installDetail: string;
  loginCommand: string;
  loginDetail: string;
}

export const CONNECTOR_HELP: readonly ConnectorHelp[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    installDetail: 'The official Claude Code CLI, on PATH as `claude`.',
    loginCommand: 'claude auth login',
    loginDetail:
      'Starts the vendor login flow in your browser — a Claude subscription (Pro/Max) works; the CLI stores the credentials itself and agentmux never sees them (F2e).',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    installCommand: 'npm install -g @openai/codex',
    installDetail: 'The official Codex CLI, on PATH as `codex`.',
    loginCommand: 'codex login',
    loginDetail:
      'Sign in with ChatGPT for subscription access; the CLI stores the credentials itself and agentmux never sees them (F3a).',
  },
];

export function helpForConnector(id: string): ConnectorHelp | null {
  return CONNECTOR_HELP.find((help) => help.id === id) ?? null;
}

export function authStatusLabel(state: AuthState): string {
  switch (state) {
    case 'subscription':
      return 'Subscription';
    case 'api-key':
      return 'API key';
    case 'logged-in':
      return 'Logged in';
    case 'other':
      return 'Unknown mode';
    case 'none':
      return 'Not logged in';
    case 'unavailable':
      return 'Status unknown';
  }
}

/** Badge tone — pure mapping from protocol state to a color class. */
export function authStateTone(state: AuthState): 'ok' | 'warn' | 'bad' {
  if (state === 'subscription' || state === 'logged-in') return 'ok';
  if (state === 'none') return 'bad';
  return 'warn';
}

/** Anything not positively logged-in earns the guided login step. */
export function needsLoginGuidance(state: AuthState): boolean {
  return state !== 'subscription' && state !== 'logged-in';
}

/** Stable row order: the help registry's order first, then any unknown ids. */
export function orderRows(reports: readonly ConnectorDetectReport[]): ConnectorDetectReport[] {
  const known = reports
    .filter((report) => helpForConnector(report.connectorId) !== null)
    .sort(
      (a, b) =>
        CONNECTOR_HELP.findIndex((help) => help.id === a.connectorId) -
        CONNECTOR_HELP.findIndex((help) => help.id === b.connectorId),
    );
  const unknown = reports.filter((report) => helpForConnector(report.connectorId) === null);
  return [...known, ...unknown];
}
