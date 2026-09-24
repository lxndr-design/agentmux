import { describe, expect, it } from 'vitest';
import { DAEMON_DEFAULT_HOST, DAEMON_DEFAULT_PORT, resolveDaemonOptions } from './config.js';

describe('resolveDaemonOptions', () => {
  it('defaults to the blueprint loopback bind', () => {
    expect(resolveDaemonOptions()).toEqual({
      port: DAEMON_DEFAULT_PORT,
      host: DAEMON_DEFAULT_HOST,
      journalPath: ':memory:',
    });
  });

  it('honors explicit loopback options', () => {
    expect(
      resolveDaemonOptions({ port: 9000, host: '::1', journalPath: 'journal.sqlite3' }),
    ).toEqual({ port: 9000, host: '::1', journalPath: 'journal.sqlite3' });
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
