import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACES_STORAGE_KEY,
  initialWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  normalizeWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from './workspaceStorage.js';
import { DEFAULT_WORKSPACE_ID } from './workspacesModel.js';

/** Workspace snapshot persistence: corrupt storage degrades to default, never breaks boot. */

function snapshot(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaces: [
      { id: DEFAULT_WORKSPACE_ID, name: 'default', sessionIds: [] },
      { id: 'w1', name: 'review', sessionIds: ['s1'] },
    ],
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('normalizeWorkspaceSnapshot', () => {
  it('re-adds the default workspace when a stale write lost it', () => {
    const next = normalizeWorkspaceSnapshot({
      workspaces: [{ id: 'w1', name: 'review', sessionIds: [] }],
      activeWorkspaceId: 'w1',
    });
    expect(next.workspaces.map((workspace) => workspace.id)).toEqual(['w1', DEFAULT_WORKSPACE_ID]);
    expect(next.activeWorkspaceId).toBe('w1');
  });

  it('collapses duplicate ids and dedupes session ids', () => {
    const next = normalizeWorkspaceSnapshot({
      workspaces: [
        { id: 'w1', name: 'first', sessionIds: ['s1', 's1'] },
        { id: 'w1', name: 'second', sessionIds: [] },
        { id: DEFAULT_WORKSPACE_ID, name: 'default', sessionIds: [] },
      ],
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    expect(next.workspaces).toHaveLength(2);
    expect(next.workspaces.find((workspace) => workspace.id === 'w1')).toEqual({
      id: 'w1',
      name: 'first',
      sessionIds: ['s1'],
    });
  });

  it('falls back to the default workspace for an unknown active id', () => {
    const next = normalizeWorkspaceSnapshot(snapshot({ activeWorkspaceId: 'ghost' }));
    expect(next.activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });
});

describe('load / save round-trip', () => {
  it('saves and loads back the same snapshot', () => {
    saveWorkspaceSnapshot(snapshot());
    expect(loadWorkspaceSnapshot()).toEqual(snapshot());
  });

  it('returns null when nothing is stored or the shape is invalid', () => {
    expect(loadWorkspaceSnapshot()).toBeNull();
    localStorage.setItem(WORKSPACES_STORAGE_KEY, '{not json');
    expect(loadWorkspaceSnapshot()).toBeNull();
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify({ workspaces: 'x' }));
    expect(loadWorkspaceSnapshot()).toBeNull();
  });

  it('initialWorkspaceSnapshot falls back to the bare default group', () => {
    const fresh = initialWorkspaceSnapshot();
    expect(fresh).toEqual({
      workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'default', sessionIds: [] }],
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    });
    saveWorkspaceSnapshot(snapshot({ activeWorkspaceId: 'w1' }));
    expect(initialWorkspaceSnapshot().activeWorkspaceId).toBe('w1');
  });
});
