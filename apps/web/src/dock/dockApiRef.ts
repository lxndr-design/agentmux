import type { DockviewApi } from 'dockview-react';

/**
 * Module-level handle to the live DockviewApi — chrome outside the dock (the
 * ribbon's CLI-setup button) adds/focuses panels without prop-drilling
 * through the shell. Same pattern as the WS clients beside the store: handles
 * live beside the render state, never inside it.
 */

let api: DockviewApi | null = null;

export function setDockApi(next: DockviewApi | null): void {
  api = next;
}

export function getDockApi(): DockviewApi | null {
  return api;
}

/** Adds (or focuses) the onboarding pane. No-op before the dock is ready. */
export function openOnboardingPanel(): void {
  if (api === null) return;
  const existing = api.getPanel('onboarding');
  if (existing !== undefined) {
    existing.focus();
    return;
  }
  api.addPanel({ id: 'onboarding', component: 'onboarding', title: 'CLI setup' });
}
