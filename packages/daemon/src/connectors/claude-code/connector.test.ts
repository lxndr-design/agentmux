import { describe, expect, it } from 'vitest';
import { ClaudeCodeConnector } from './connector.js';

/**
 * Connector-level detection: install comes from `--version`, login state
 * from the injected status runner. `process.execPath` stands in for a real
 * CLI (`node --version` prints a version), so no machine state is touched.
 */
describe('ClaudeCodeConnector.detect', () => {
  it('reports install + login state for a present binary', async () => {
    const connector = new ClaudeCodeConnector(process.execPath, async () => ({ code: 0 }));
    const result = await connector.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toMatch(/^v\d/);
    expect(result.authState).toBe('logged-in');
  });

  it('reports not-installed and skips the auth probe for a missing binary', async () => {
    let authProbed = false;
    const connector = new ClaudeCodeConnector('agentmux-no-such-binary-fixture', async () => {
      authProbed = true;
      return { code: 0 };
    });
    const result = await connector.detect();
    expect(result).toEqual({ installed: false });
    expect(authProbed).toBe(false);
  });

  it('keeps an installed CLI installed when the auth probe fails', async () => {
    const connector = new ClaudeCodeConnector(process.execPath, async () => {
      throw new Error('probe exploded');
    });
    const result = await connector.detect();
    expect(result.installed).toBe(true);
    expect(result.authState).toBe('unavailable');
  });
});
