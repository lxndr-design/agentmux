import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorDetectReport } from '@agentmux/protocol';
import { awaitDiscovery, useOnboardingStore } from './onboardingStore.js';
import { useSessionStore } from './sessionStore.js';

/**
 * The wizard's detect state machine, with the boot race that dogfooding
 * surfaced: a pane restored from a saved layout mounts before the session
 * store's discovery resolves, and the wizard must wait for the answer to
 * arrive instead of reporting the daemon absent while it is still being
 * found. The real detect round-trip is covered in e2e; detectConnectors is
 * stubbed here.
 */

vi.mock('../ws/detectClient.js', () => ({
  detectConnectors: vi.fn(),
}));

const { detectConnectors } = vi.mocked(await import('../ws/detectClient.js'));

const report: ConnectorDetectReport = {
  connectorId: 'claude-code',
  installed: false,
  authState: 'unavailable',
};

/** Reset both stores to their pre-boot shape. */
function resetStores(): void {
  useSessionStore.setState({ daemonUrl: null, daemonToken: null, demoAvailable: false });
  useOnboardingStore.setState({ status: 'idle', results: [], error: null });
  vi.mocked(detectConnectors).mockReset();
  vi.mocked(detectConnectors).mockResolvedValue([report]);
}

beforeEach(resetStores);

describe('runDetect', () => {
  it('waits for daemon discovery instead of failing while boot is in flight', async () => {
    // The pane mounts at boot — discovery has not landed yet.
    const pending = useOnboardingStore.getState().runDetect({ discoveryWaitMs: 5_000 });

    // Boot resolves mid-wait, as it does a beat after the wizard appears.
    useSessionStore.setState({
      daemonUrl: 'ws://127.0.0.1:8787',
      daemonToken: 't',
      demoAvailable: true,
    });
    await pending;

    expect(detectConnectors).toHaveBeenCalledWith('ws://127.0.0.1:8787', 't');
    expect(useOnboardingStore.getState().status).toBe('ready');
    expect(useOnboardingStore.getState().results).toEqual([report]);
    expect(useOnboardingStore.getState().error).toBeNull();
  });

  it('reports the daemon absent only after the bounded wait expires', async () => {
    await useOnboardingStore.getState().runDetect({ discoveryWaitMs: 60 });

    expect(useOnboardingStore.getState().status).toBe('unavailable');
    expect(useOnboardingStore.getState().error).toMatch(/No daemon is connected/);
    expect(detectConnectors).not.toHaveBeenCalled();
  });

  it('maps a failed detect round-trip to the unavailable error state', async () => {
    useSessionStore.setState({
      daemonUrl: 'ws://127.0.0.1:8787',
      daemonToken: 't',
      demoAvailable: true,
    });
    vi.mocked(detectConnectors).mockRejectedValue(new Error('detection timed out'));

    await useOnboardingStore.getState().runDetect({ discoveryWaitMs: 0 });

    expect(useOnboardingStore.getState().status).toBe('unavailable');
    expect(useOnboardingStore.getState().error).toBe('detection timed out');
  });
});

describe('awaitDiscovery', () => {
  it('returns as soon as the url appears', async () => {
    let url: string | null = null;
    const discover = (): { daemonUrl: string | null; daemonToken: string | null } => ({
      daemonUrl: url,
      daemonToken: url === null ? null : 't',
    });
    const pending = awaitDiscovery(discover, 5_000, () => {
      url = 'ws://daemon';
      return Promise.resolve();
    });
    await expect(pending).resolves.toMatchObject({ daemonUrl: 'ws://daemon' });
  });

  it('gives up after the window', async () => {
    const discover = (): { daemonUrl: string | null; daemonToken: string | null } => ({
      daemonUrl: null,
      daemonToken: null,
    });
    await expect(awaitDiscovery(discover, 60, () => Promise.resolve())).resolves.toMatchObject({
      daemonUrl: null,
    });
  });
});
