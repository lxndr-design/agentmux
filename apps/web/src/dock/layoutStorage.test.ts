import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLayout,
  layoutStorageKey,
  loadStoredLayout,
  saveLayout,
  validateStoredLayout,
} from './layoutStorage.js';
import { KNOWN_DOCK_COMPONENTS } from './DockHost.js';

/**
 * Stored-layout validation: a layout is usable only when every panel names a
 * component the registry still serves — a layout written by another version
 * falls back to the default, never a crash or an empty dock.
 */

const KNOWN = new Set(['agent', 'terminal', 'files']);

function storedLayout(component: string, panelId = 'p1') {
  return {
    grid: { root: { type: 'branch', data: [] } },
    panels: { [panelId]: { id: panelId, contentComponent: component } },
    activeGroup: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('validateStoredLayout', () => {
  it('accepts a layout whose panels all reference known components', () => {
    const data = storedLayout('agent');
    expect(validateStoredLayout(data, KNOWN)).toEqual(data);
  });

  it('rejects panels referencing unknown components (older/newer app)', () => {
    expect(validateStoredLayout(storedLayout('mermaid'), KNOWN)).toBeNull();
  });

  it('rejects an empty panel set — persisting no panels would brick the dock', () => {
    expect(validateStoredLayout({ panels: {} }, KNOWN)).toBeNull();
  });

  it('rejects non-layout shapes instead of throwing', () => {
    for (const junk of [null, 'nope', 42, { panels: 'x' }, { nope: true }]) {
      expect(validateStoredLayout(junk, KNOWN)).toBeNull();
    }
  });
});

describe('layout storage round-trip', () => {
  it('saves and loads back the same object for the workspace key', () => {
    const data = storedLayout('terminal', 'agent-1');
    saveLayout('ws-a', data as never);
    expect(localStorage.getItem(layoutStorageKey('ws-a'))).not.toBeNull();
    expect(loadStoredLayout('ws-a')).toEqual(data);
  });

  it('keeps workspaces independent', () => {
    saveLayout('ws-a', storedLayout('agent', 'a1') as never);
    saveLayout('ws-b', storedLayout('files', 'b1') as never);
    expect(loadStoredLayout('ws-a')).toEqual(storedLayout('agent', 'a1'));
    expect(loadStoredLayout('ws-b')).toEqual(storedLayout('files', 'b1'));
  });

  it('returns null for a missing or corrupt entry, never throws', () => {
    expect(loadStoredLayout('ws-absent')).toBeNull();
    localStorage.setItem(layoutStorageKey('ws-a'), '{not json');
    expect(loadStoredLayout('ws-a')).toBeNull();
  });

  it('clear removes only that workspace', () => {
    saveLayout('ws-a', storedLayout('agent') as never);
    saveLayout('ws-b', storedLayout('agent') as never);
    clearLayout('ws-a');
    expect(loadStoredLayout('ws-a')).toBeNull();
    expect(loadStoredLayout('ws-b')).not.toBeNull();
  });
});

describe('the registry set', () => {
  it('serves every component a stored layout may reference', () => {
    // A stored layout naming a panel this version dropped must fall back —
    // this pins the set so removing a component is a conscious act.
    for (const component of ['agent', 'terminal', 'files', 'editor', 'diff', 'onboarding']) {
      expect(KNOWN_DOCK_COMPONENTS.has(component)).toBe(true);
    }
  });
});
