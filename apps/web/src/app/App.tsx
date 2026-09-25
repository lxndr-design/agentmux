import { useEffect } from 'react';
import { Shell } from './Shell';
import { useSessionStore } from '../state/sessionStore.js';

/**
 * App = boot wiring + the shell. The boot effect discovers the daemon (demo
 * harness in this skeleton) exactly once; tests render <Shell/> directly
 * against a pre-seeded store.
 */
export function App() {
  const booted = useSessionStore((state) => state.booted);
  const boot = useSessionStore((state) => state.boot);

  useEffect(() => {
    if (!booted) {
      void boot();
    }
  }, [booted, boot]);

  return <Shell />;
}
