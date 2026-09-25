import { z } from 'zod';

/**
 * Demo control client — test/dev scaffolding ONLY.
 *
 * The daemon has no spawn/kill surface yet (the supervisor and automation API
 * are later PRs), so the walking skeleton drives sessions through a local
 * demo harness (demo/harness.mjs): a scripted fake agent plus a loopback
 * control endpoint. The harness runs in-process with the real daemon, so
 * everything the browser sees is the genuine journal → gateway → WS path;
 * only the agent itself is fake.
 *
 * Approval decisions have no demo route at all: they flow the production WS
 * `decide` message into the daemon's approval engine (see wsClient.ts), which
 * is the same path real connector sessions use.
 *
 * When the control endpoint is absent (production daemon, no harness), every
 * call here is unreachable and the UI degrades: start/stop disabled.
 */

/** '' in the harness-served build means same origin (the harness fronts it). */
const BASE = ((import.meta.env.VITE_DEMO_CONTROL_URL as string | undefined) ?? '').replace(
  /\/+$/,
  '',
);

export const demoConfigSchema = z.object({
  /** WS endpoint of the daemon, e.g. `ws://127.0.0.1:8787` (or a proxied path). */
  wsUrl: z.string().url(),
  token: z.string().min(1),
});
export type DemoConfig = z.infer<typeof demoConfigSchema>;

const startedSessionSchema = z.object({ sessionId: z.string().min(1) });
const okSchema = z.object({ ok: z.boolean() });

export async function fetchDemoConfig(): Promise<DemoConfig> {
  const response = await fetch(`${BASE}/demo/config`);
  if (!response.ok) {
    throw new Error(`demo control responded ${response.status}`);
  }
  return demoConfigSchema.parse(await response.json());
}

export async function startDemoSession(name: string): Promise<string> {
  const response = await fetch(`${BASE}/demo/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(`demo start failed: ${response.status}`);
  }
  return startedSessionSchema.parse(await response.json()).sessionId;
}

export async function stopDemoSession(sessionId: string): Promise<void> {
  const response = await fetch(`${BASE}/demo/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`demo stop failed: ${response.status}`);
  }
  okSchema.parse(await response.json());
}
