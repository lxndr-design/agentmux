import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_ID,
  defaultWorkspaces,
  isActiveWorkspaceSession,
  withSessionAssigned,
  withWorkspaceCreated,
  withWorkspaceDeleted,
  workspaceOfSession,
  type WorkspaceRecord,
} from './workspacesModel.js';

/** Pure derivations for named session groups — the store calls these. */

function ws(id: string, sessionIds: string[]): WorkspaceRecord {
  return { id, name: id, sessionIds };
}

describe('withWorkspaceCreated', () => {
  it('appends a trimmed, non-duplicate workspace', () => {
    const next = withWorkspaceCreated(defaultWorkspaces(), 'w1', '  review  ');
    expect(next.map((workspace) => workspace.name)).toEqual(['default', 'review']);
  });

  it('ignores blank and duplicate names — no phantom groups', () => {
    const base = defaultWorkspaces();
    expect(withWorkspaceCreated(base, 'w1', '   ').length).toBe(1);
    expect(
      withWorkspaceCreated(withWorkspaceCreated(base, 'w1', 'default'), 'w2', 'x').length,
    ).toBe(2);
  });
});

describe('withWorkspaceDeleted', () => {
  it('refuses the default workspace and unknown ids', () => {
    expect(withWorkspaceDeleted(defaultWorkspaces(), DEFAULT_WORKSPACE_ID)).toBeNull();
    expect(withWorkspaceDeleted(defaultWorkspaces(), 'ghost')).toBeNull();
  });

  it('moves sessions of the deleted workspace into the default one', () => {
    const base = [ws('default', ['s0']), ws('review', ['s1', 's2'])];
    const next = withWorkspaceDeleted(base, 'review');
    expect(next).not.toBeNull();
    expect(next!.workspaces).toEqual([ws('default', ['s0', 's1', 's2'])]);
  });
});

describe('withSessionAssigned', () => {
  it('moves a session out of every other workspace', () => {
    const base = [ws('default', ['s1']), ws('review', [])];
    expect(withSessionAssigned(base, 's1', 'review')).toEqual([
      ws('default', []),
      ws('review', ['s1']),
    ]);
  });

  it('is idempotent and ignores unknown targets', () => {
    const base = [ws('default', []), ws('review', ['s1'])];
    expect(withSessionAssigned(base, 's1', 'review')).toEqual(base);
    expect(withSessionAssigned(base, 's1', 'ghost')).toEqual(base);
  });
});

describe('isActiveWorkspaceSession', () => {
  const base = [ws('default', []), ws('review', ['s1'])];

  it('shows filed sessions only in their own workspace', () => {
    expect(isActiveWorkspaceSession(base, 'review', 's1')).toBe(true);
    expect(isActiveWorkspaceSession(base, 'default', 's1')).toBe(false);
  });

  it('shows unfiled sessions in the default workspace so they never vanish', () => {
    expect(isActiveWorkspaceSession(base, 'default', 's-unfiled')).toBe(true);
    expect(isActiveWorkspaceSession(base, 'review', 's-unfiled')).toBe(false);
  });
});

describe('workspaceOfSession', () => {
  it('finds the owning workspace or null when unfiled', () => {
    const base = [ws('default', []), ws('review', ['s1'])];
    expect(workspaceOfSession(base, 's1')?.id).toBe('review');
    expect(workspaceOfSession(base, 's9')).toBeNull();
  });
});
