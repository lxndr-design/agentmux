import { useMemo } from 'react';
import { useSessionStore } from '../state/sessionStore.js';
import { useFilesStore } from '../state/filesStore.js';
import { FsClient } from './fsClient.js';

/**
 * One shared FS client per gateway endpoint, created reactively from the
 * boot config the session store discovers. The FS change feed routes into
 * the files store (with the client itself as the RPC port for refreshes).
 */

const clients = new Map<string, FsClient>();

export function getOrCreateFsClient(url: string, token: string): FsClient {
  const endpoint = `${url}|${token}`;
  const existing = clients.get(endpoint);
  if (existing !== undefined) {
    return existing;
  }
  const client = new FsClient({
    url: `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
    onFsChange: (change) => {
      useFilesStore.getState().noteFsChange(client, change);
    },
  });
  client.start();
  clients.set(endpoint, client);
  return client;
}

export function useFsClient(): FsClient | null {
  const url = useSessionStore((state) => state.daemonUrl);
  const token = useSessionStore((state) => state.daemonToken);
  return useMemo(() => {
    if (url === null || token === null) {
      return null;
    }
    return getOrCreateFsClient(url, token);
  }, [url, token]);
}

/** Test seam — drops every cached client so a suite starts from zero. */
export function resetFsClientsForTests(): void {
  for (const client of clients.values()) {
    client.stop();
  }
  clients.clear();
}
