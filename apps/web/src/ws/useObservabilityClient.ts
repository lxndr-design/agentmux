import { useMemo } from 'react';
import { useSessionStore } from '../state/sessionStore.js';
import { ObservabilityClient } from './observabilityClient.js';

/**
 * One shared observability client per gateway endpoint, created reactively
 * from the boot config the session store discovers (the useFsClient pattern).
 */

const clients = new Map<string, ObservabilityClient>();

export function getOrCreateObservabilityClient(url: string, token: string): ObservabilityClient {
  const endpoint = `${url}|${token}`;
  const existing = clients.get(endpoint);
  if (existing !== undefined) {
    return existing;
  }
  const client = new ObservabilityClient({
    url: `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
  });
  client.start();
  clients.set(endpoint, client);
  return client;
}

export function useObservabilityClient(): ObservabilityClient | null {
  const url = useSessionStore((state) => state.daemonUrl);
  const token = useSessionStore((state) => state.daemonToken);
  return useMemo(() => {
    if (url === null || token === null) {
      return null;
    }
    return getOrCreateObservabilityClient(url, token);
  }, [url, token]);
}

/** Test seam — drops every cached client so a suite starts from zero. */
export function resetObservabilityClientsForTests(): void {
  for (const client of clients.values()) {
    client.stop();
  }
  clients.clear();
}
