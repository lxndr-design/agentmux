import { describe, expect, it } from 'vitest';
import { DAEMON_DEFAULT_PORT, resolveDaemonOptions, sessionReadyEnvelope } from './index';

describe('resolveDaemonOptions', () => {
  it('defaults to the blueprint loopback port', () => {
    expect(DAEMON_DEFAULT_PORT).toBe(8787);
    expect(resolveDaemonOptions()).toEqual({ port: DAEMON_DEFAULT_PORT });
  });

  it('honors an explicit port', () => {
    expect(resolveDaemonOptions({ port: 9000 })).toEqual({ port: 9000 });
  });
});

describe('sessionReadyEnvelope', () => {
  it('emits a session.status ready envelope from the protocol package', () => {
    const envelope = sessionReadyEnvelope('sess_1');
    expect(envelope.kind).toBe('session.status');
    expect(envelope.payload).toEqual({ status: 'ready' });
  });
});
