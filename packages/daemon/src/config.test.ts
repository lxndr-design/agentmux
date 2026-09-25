import { describe, expect, it } from 'vitest';
import { DAEMON_DEFAULT_HOST, DAEMON_DEFAULT_PORT, resolveDaemonOptions } from './config.js';

describe('resolveDaemonOptions', () => {
  it('defaults to the blueprint loopback bind and the process cwd workspace', () => {
    expect(resolveDaemonOptions()).toEqual({
      port: DAEMON_DEFAULT_PORT,
      host: DAEMON_DEFAULT_HOST,
      journalPath: ':memory:',
      workspaceRoot: process.cwd(),
      runtime: 'worktree',
    });
  });

  it('honors explicit loopback options and workspace root', () => {
    expect(
      resolveDaemonOptions({
        port: 9000,
        host: '::1',
        journalPath: 'journal.sqlite3',
        workspaceRoot: '/tmp/ws',
        runtime: 'local',
      }),
    ).toEqual({
      port: 9000,
      host: '::1',
      journalPath: 'journal.sqlite3',
      workspaceRoot: '/tmp/ws',
      runtime: 'local',
    });
  });

  it('refuses an unknown runtime at boot, with the v2 plan named', () => {
    expect(() => resolveDaemonOptions({ runtime: 'ssh' as never })).toThrowError(
      /SSH and Docker runtimes are planned for v2/,
    );
  });

  it('normalizes localhost to the IPv4 loopback', () => {
    expect(resolveDaemonOptions({ host: 'localhost' }).host).toBe('127.0.0.1');
  });

  it('refuses non-loopback hosts at boot — the daemon never faces the LAN', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(() => resolveDaemonOptions({ host }), `host ${host}`).toThrowError(/loopback only/);
    }
  });
});
