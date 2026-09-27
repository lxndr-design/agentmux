import { z } from 'zod';
import type { SerializedDockview } from 'dockview-react';

/**
 * Layout persistence — Dockview's own serialization (toJSON/fromJSON) stored
 * per workspace in localStorage (blueprint: "layout is serialized per
 * workspace and restored on launch"). The browser owns this record: layout is
 * a disposable-client concern, never daemon state.
 */

export function layoutStorageKey(workspaceId: string): string {
  return `agentmux.layout.v1.${workspaceId}`;
}

/**
 * Only the parts restore depends on are pinned down; grid geometry and any
 * newer dockview fields ride through untouched (passthrough). The stored
 * form is produced by `api.toJSON()` — this schema checks the pieces that
 * decide whether a restore is safe, not the full recursive grid shape.
 */
const storedLayoutSchema = z
  .object({
    panels: z.record(z.string(), z.object({ contentComponent: z.string() }).passthrough()),
  })
  .passthrough();

/**
 * A stored layout is usable only when every panel references a component the
 * registry still knows — a layout written by a different agentmux version
 * falls back to the default rather than crashing restore. An empty layout is
 * rejected too: persisting "no panels" would brick the dock after a reload.
 */
export function validateStoredLayout(
  data: unknown,
  knownComponents: ReadonlySet<string>,
): SerializedDockview | null {
  const parsed = storedLayoutSchema.safeParse(data);
  if (!parsed.success) return null;
  const panels = Object.values(parsed.data.panels);
  if (panels.length === 0) return null;
  for (const panel of panels) {
    if (!knownComponents.has(panel.contentComponent)) return null;
  }
  // Partially validated by design — the unchecked remainder is dockview's own
  // toJSON output, consumed only by dockview's fromJSON.
  return parsed.data as unknown as SerializedDockview;
}

/** Returns the raw stored JSON, or null when absent/corrupt. Never throws. */
export function loadStoredLayout(workspaceId: string): unknown {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(layoutStorageKey(workspaceId));
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch (error) {
    console.warn('agentmux: stored layout unreadable — using the default layout', error);
    return null;
  }
}

/** Best-effort write; quota or private-mode failures cost only persistence. */
export function saveLayout(workspaceId: string, layout: SerializedDockview): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(layoutStorageKey(workspaceId), JSON.stringify(layout));
  } catch (error) {
    console.warn('agentmux: saving the layout failed', error);
  }
}

export function clearLayout(workspaceId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(layoutStorageKey(workspaceId));
  } catch (error) {
    console.warn('agentmux: clearing the stored layout failed', error);
  }
}
