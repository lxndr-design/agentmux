import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { DockHost } from './DockHost.js';
import { getDockApi } from './dockApiRef.js';
import { layoutStorageKey } from './layoutStorage.js';
import type { DockviewApi } from 'dockview-react';

/**
 * The serialization round-trip acceptance test, against the real dockview
 * instance in jsdom: arrange → serialize (the component persists on every
 * layout change) → unmount → remount → the arrangement is restored.
 */

const ready = (): Promise<DockviewApi> =>
  waitFor(() => {
    const api = getDockApi();
    if (api === null) throw new Error('dock not ready');
    return api;
  });

const panelIds = (api: DockviewApi): string[] => api.panels.map((panel) => panel.id);

// The full fresh-workspace shell: the five base panes plus the two
// observability panes, which restoreOrDefault guarantees on every dock.
const DEFAULT_PANELS = [
  'agent',
  'diff',
  'divergence',
  'editor',
  'files',
  'terminal',
  'usage',
].sort();

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('DockHost serialization round-trip', () => {
  it('restores an arranged layout after unmount/remount, per workspace', async () => {
    const first = render(<DockHost workspaceId="ws-a" />);
    const api = await ready();
    expect(panelIds(api).sort()).toEqual(DEFAULT_PANELS);

    // The user's arrangement: an extra onboarding panel joins the dock.
    act(() => {
      api.addPanel({ id: 'onboarding', component: 'onboarding', title: 'CLI setup' });
    });
    // DockHost persists on every layout change — wait for the write.
    await waitFor(() => expect(localStorage.getItem(layoutStorageKey('ws-a'))).not.toBeNull());
    const saved = JSON.parse(localStorage.getItem(layoutStorageKey('ws-a'))!) as {
      panels: Record<string, { contentComponent: string }>;
    };
    expect(Object.keys(saved.panels)).toContain('onboarding');

    first.unmount();
    // A different workspace in between must NOT see ws-a's layout.
    const second = render(<DockHost workspaceId="ws-b" />);
    await ready();
    expect(panelIds(getDockApi()!).sort()).toEqual(DEFAULT_PANELS);
    second.unmount();

    // Back to ws-a: the arrangement comes back from the stored serialization.
    const third = render(<DockHost workspaceId="ws-a" />);
    await ready();
    expect(panelIds(getDockApi()!).sort()).toEqual([...DEFAULT_PANELS, 'onboarding'].sort());
    third.unmount();
  });

  it('switching workspaces on a live dock saves the outgoing layout', async () => {
    const view = render(<DockHost workspaceId="ws-a" />);
    const api = await ready();
    act(() => {
      api.addPanel({ id: 'onboarding', component: 'onboarding', title: 'CLI setup' });
    });

    view.rerender(<DockHost workspaceId="ws-b" />);
    await waitFor(() => expect(localStorage.getItem(layoutStorageKey('ws-a'))).not.toBeNull());
    expect(panelIds(getDockApi()!)).not.toContain('onboarding');

    view.unmount();
    const again = render(<DockHost workspaceId="ws-a" />);
    await ready();
    expect(panelIds(getDockApi()!)).toContain('onboarding');
    again.unmount();
  });

  it('an unusable stored layout falls back to the default, never a crash', async () => {
    localStorage.setItem(
      layoutStorageKey('ws-a'),
      JSON.stringify({ panels: { p: { contentComponent: 'mermaid' } } }),
    );
    render(<DockHost workspaceId="ws-a" />);
    await ready();
    expect(panelIds(getDockApi()!).sort()).toEqual(DEFAULT_PANELS);
  });
});
