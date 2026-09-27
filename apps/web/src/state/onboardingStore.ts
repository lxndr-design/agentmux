import { create } from 'zustand';
import type { ConnectorDetectReport } from '@agentmux/protocol';
import { detectConnectors } from '../ws/detectClient.js';
import { useSessionStore } from './sessionStore.js';

export type OnboardingStatus = 'idle' | 'detecting' | 'ready' | 'unavailable';

interface OnboardingStoreState {
  status: OnboardingStatus;
  /** Latest daemon report — empty until the first successful detect. */
  results: ConnectorDetectReport[];
  error: string | null;
}

interface OnboardingStoreActions {
  /**
   * Detect all connectors through the daemon gateway (one-shot WS connection).
   * `discoveryWaitMs` overrides how long the call waits for boot discovery to
   * land before reporting the daemon absent (tests shrink the window).
   */
  runDetect(options?: { discoveryWaitMs?: number }): Promise<void>;
}

export type OnboardingStore = OnboardingStoreState & OnboardingStoreActions;

/** Longest the wizard waits for boot discovery before reporting the daemon absent. */
export const DISCOVERY_WAIT_MS = 2_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Boot discovery races the wizard: a pane restored from a saved layout mounts
 * before the session store's config fetch resolves, and an instant null check
 * would report a healthy daemon as absent. Polls briefly for discovery to land
 * instead of failing while the answer is still in flight.
 */
export async function awaitDiscovery(
  getState: () => { daemonUrl: string | null; daemonToken: string | null },
  waitMs: number,
  delay: (ms: number) => Promise<void> = sleep,
): Promise<{ daemonUrl: string | null; daemonToken: string | null }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = getState();
    if (state.daemonUrl !== null || Date.now() >= deadline) return state;
    await delay(50);
  }
}

/**
 * CLI-detection state for the onboarding wizard. The daemon owns the probes;
 * this store only carries their answer. Login state is STATUS — the wizard
 * guides the user to the CLIs' own auth flows and never sees a credential.
 */
export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  status: 'idle',
  results: [],
  error: null,

  async runDetect(options?: { discoveryWaitMs?: number }) {
    if (get().status === 'detecting') return;
    set({ status: 'detecting', error: null });
    const discovered = await awaitDiscovery(
      useSessionStore.getState,
      options?.discoveryWaitMs ?? DISCOVERY_WAIT_MS,
    );
    const { daemonUrl, daemonToken } = discovered;
    if (daemonUrl === null) {
      set({
        status: 'unavailable',
        error: 'No daemon is connected — start the agentmux daemon, then re-check.',
      });
      return;
    }
    try {
      const results = await detectConnectors(daemonUrl, daemonToken);
      set({ status: 'ready', results });
    } catch (error) {
      set({ status: 'unavailable', error: (error as Error).message });
    }
  },
}));
