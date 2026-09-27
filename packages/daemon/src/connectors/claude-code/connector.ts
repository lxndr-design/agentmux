import { execFile } from 'node:child_process';
import { ClaudeCodeSession } from './session.js';
import { classifyAuthStatus, defaultAuthStatusRunner, type AuthStatusRunner } from './auth.js';
import type {
  AgentConnector,
  ConnectorDetectResult,
  SessionEventSink,
  SessionSpawnConfig,
} from '../types.js';

export const CLAUDE_CODE_CONNECTOR_ID = 'claude-code';

/** Runs `<binary> --version`; resolves `{ installed: false }` when missing. */
function versionProbe(binary: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolve({ installed: false });
        return;
      }
      // Output is a bare version like "2.0.1 (Claude Code)" — take the
      // first token, tolerate anything else.
      const version = stdout.trim().split(/\s+/)[0];
      resolve({
        installed: true,
        ...(version !== undefined && version !== '' ? { version } : {}),
      });
    });
  });
}

/**
 * The Claude Code connector: supervises the real `claude` CLI as a
 * stream-json subprocess (subscription auth stays with the CLI — F2e;
 * agentmux never sees a token). The CLI remains the agent; this class only
 * detects, spawns, and translates.
 */
export class ClaudeCodeConnector implements AgentConnector {
  readonly id = CLAUDE_CODE_CONNECTOR_ID;

  constructor(
    private readonly binary: string = 'claude',
    private readonly authStatusRunner: AuthStatusRunner = defaultAuthStatusRunner,
  ) {}

  async detect(): Promise<ConnectorDetectResult> {
    const probe = await versionProbe(this.binary);
    if (!probe.installed) return { installed: false };
    // Login state is a second, independent probe — its own failure must not
    // turn an installed CLI into a missing one.
    const auth = await this.authStatusRunner(this.binary).catch(() => ({ code: null }));
    return {
      installed: true,
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      ...classifyAuthStatus(auth.code),
    };
  }

  spawn(config: SessionSpawnConfig, sink: SessionEventSink): Promise<ClaudeCodeSession> {
    return Promise.resolve(
      ClaudeCodeSession.spawn({ ...config, command: config.command ?? this.binary }, sink),
    );
  }
}
