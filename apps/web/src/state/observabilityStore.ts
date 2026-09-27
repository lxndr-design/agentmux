import { create } from 'zustand';
import type { DivergenceEntry, UsageRollups } from '@agentmux/protocol';

/**
 * Observability state for the divergence panel and the usage view — the
 * FsRpc-port pattern from the files store: panes hand in a client, the store
 * performs the read and guards against stale responses (only the latest
 * request's result is applied).
 */

/** What the store needs from the RPC layer — the ObservabilityClient satisfies this. */
export interface ObservabilityPort {
  requestDivergence(): Promise<DivergenceEntry[]>;
  requestUsageRollups(): Promise<UsageRollups>;
}

interface ObservabilityState {
  divergence: DivergenceEntry[] | null;
  divergenceLoading: boolean;
  divergenceError: string | null;
  rollups: UsageRollups | null;
  rollupsLoading: boolean;
  rollupsError: string | null;
}

interface ObservabilityActions {
  refreshDivergence: (client: ObservabilityPort) => Promise<void>;
  refreshRollups: (client: ObservabilityPort) => Promise<void>;
}

export type ObservabilityStore = ObservabilityState & ObservabilityActions;

/** Monotonic ticks — a response older than the newest request is dropped. */
let divergenceTick = 0;
let rollupsTick = 0;

export const useObservabilityStore = create<ObservabilityState & ObservabilityActions>((set) => ({
  divergence: null,
  divergenceLoading: false,
  divergenceError: null,
  rollups: null,
  rollupsLoading: false,
  rollupsError: null,

  refreshDivergence: async (client) => {
    const tick = ++divergenceTick;
    set({ divergenceLoading: true, divergenceError: null });
    try {
      const entries = await client.requestDivergence();
      if (tick === divergenceTick) {
        set({ divergence: entries, divergenceLoading: false });
      }
    } catch (error) {
      if (tick === divergenceTick) {
        set({ divergenceLoading: false, divergenceError: (error as Error).message });
      }
    }
  },

  refreshRollups: async (client) => {
    const tick = ++rollupsTick;
    set({ rollupsLoading: true, rollupsError: null });
    try {
      const rollups = await client.requestUsageRollups();
      if (tick === rollupsTick) {
        set({ rollups, rollupsLoading: false });
      }
    } catch (error) {
      if (tick === rollupsTick) {
        set({ rollupsLoading: false, rollupsError: (error as Error).message });
      }
    }
  },
}));

/** Test seam — clears state and ticks so a suite starts from zero. */
export function resetObservabilityStoreForTests(): void {
  divergenceTick = 0;
  rollupsTick = 0;
  useObservabilityStore.setState({
    divergence: null,
    divergenceLoading: false,
    divergenceError: null,
    rollups: null,
    rollupsLoading: false,
    rollupsError: null,
  });
}
