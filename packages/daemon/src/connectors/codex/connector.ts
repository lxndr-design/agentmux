import { execFile } from 'node:child_process';
import { CodexExecSession } from './exec-session.js';
import { authFieldsFor, detectLoginState } from './login.js';
import { CodexSession } from './session.js';
import type {
  AgentConnector,
  ConnectorDetectResult,
  SessionEventSink,
  SessionSpawnConfig,
} from '../types.js';

export const CODEX_CONNECTOR_ID = 'codex';

/** Which Codex surface a session uses. app-server is the default: it is the only one with an in-band approval channel. */
export type CodexSessionMode = 'app-server' | 'exec';

/**
 * The Codex connector: supervises the real `codex` CLI (subscription auth
 * stays with the CLI's own login — F3a; agentmux never sees a token). The
 * CLI remains the agent; this class only detects, spawns, and translates.
 */
export class CodexConnector implements AgentConnector {
  readonly id = CODEX_CONNECTOR_ID;

  constructor(
    private readonly binary: string = 'codex',
    private readonly mode: CodexSessionMode = 'app-server',
  ) {}

  async detect(): Promise<ConnectorDetectResult> {
    const version = await versionProbe(this.binary);
    if (!version.installed) return { installed: false };
    const login = await detectLoginState(this.binary).catch(() => 'unavailable' as const);
    return {
      installed: true,
      ...(version.version !== undefined ? { version: version.version } : {}),
      ...authFieldsFor(login),
    };
  }

  async spawn(
    config: SessionSpawnConfig,
    sink: SessionEventSink,
  ): Promise<CodexSession | CodexExecSession> {
    // The real CLI's auth is checked up front so "agent won't start" comes
    // with the fix (Q4: the user installs and authenticates; agentmux
    // detects and guides). Test substitutions skip the probe.
    if (config.command === undefined) {
      const login = await detectLoginState(this.binary);
      if (login === 'none' || login === 'unavailable') {
        const probe = await versionProbe(this.binary);
        if (!probe.installed) {
          throw new Error(
            'Codex CLI not found — install it (`npm install -g @openai/codex`), then run `codex login` (Sign in with ChatGPT). agentmux supervises the official CLI and never sees or stores credentials.',
          );
        }
        if (login === 'none') {
          throw new Error(
            "Codex CLI is not authenticated — run `codex login` (Sign in with ChatGPT) or `codex login --api-key`. Credentials stay in the CLI's own config; agentmux never sees them.",
          );
        }
        // Installed but the status probe failed: proceed — the handshake
        // itself surfaces any real breakage, with the exit code attached.
      }
    }
    const resolved = { ...config, command: config.command ?? this.binary };
    return this.mode === 'exec'
      ? CodexExecSession.spawn(resolved, sink)
      : CodexSession.spawn(resolved, sink);
  }
}

function versionProbe(binary: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolve({ installed: false });
        return;
      }
      // Output is a bare version like "codex-cli 0.42.0" — take the first
      // token, tolerate anything else.
      const version = stdout.trim().split(/\s+/)[0];
      resolve({
        installed: true,
        ...(version !== undefined && version !== '' ? { version } : {}),
      });
    });
  });
}
