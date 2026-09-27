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
  /** Detect all connectors through the daemon gateway (one-shot WS connection). */
  runDetect(): Promise<void>;
}

export type OnboardingStore = OnboardingStoreState & OnboardingStoreActions;

/**
 * CLI-detection state for the onboarding wizard. The daemon owns the probes;
 * this store only carries their answer. Login state is STATUS — the wizard
 * guides the user to the CLIs' own auth flows and never sees a credential.
 */
export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  status: 'idle',
  results: [],
  error: null,

  async runDetect() {
    if (get().status === 'detecting') return;
    const { daemonUrl, daemonToken } = useSessionStore.getState();
    if (daemonUrl === null) {
      set({
        status: 'unavailable',
        error: 'No daemon is connected — start the agentmux daemon, then re-check.',
      });
      return;
    }
    set({ status: 'detecting', error: null });
    try {
      const results = await detectConnectors(daemonUrl, daemonToken);
      set({ status: 'ready', results });
    } catch (error) {
      set({ status: 'unavailable', error: (error as Error).message });
    }
  },
}));
