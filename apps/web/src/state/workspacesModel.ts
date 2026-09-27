/**
 * Workspaces — named session groups (blueprint persistence item: "layout
 * save/restore, workspaces"). Pure derivations only: the store owns the
 * state transitions and calls these; localStorage lives in
 * workspaceStorage.ts. Every function is total — invalid requests return the
 * input unchanged rather than throwing at click time.
 */

export interface WorkspaceRecord {
  id: string;
  name: string;
  /** Member session ids; a session belongs to at most one workspace. */
  sessionIds: string[];
}

/** The floor workspace: always present, never deletable. */
export const DEFAULT_WORKSPACE_ID = 'default';

export function defaultWorkspaces(): WorkspaceRecord[] {
  return [{ id: DEFAULT_WORKSPACE_ID, name: 'default', sessionIds: [] }];
}

/**
 * Ribbon visibility rule: a session is visible in the active workspace when
 * it is a member of it. A session named in NO workspace is "unfiled" —
 * unfiled sessions show in the default workspace so store-seeded or
 * pre-worktree sessions never vanish from the ribbon.
 */
export function isActiveWorkspaceSession(
  workspaces: readonly WorkspaceRecord[],
  activeWorkspaceId: string,
  sessionId: string,
): boolean {
  const filedSomewhere = workspaces.some((workspace) => workspace.sessionIds.includes(sessionId));
  if (!filedSomewhere) return activeWorkspaceId === DEFAULT_WORKSPACE_ID;
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  return active?.sessionIds.includes(sessionId) ?? false;
}

export function withWorkspaceCreated(
  workspaces: readonly WorkspaceRecord[],
  id: string,
  name: string,
): WorkspaceRecord[] {
  const trimmed = name.trim();
  // Blank names and duplicate names add confusion, not groups — ignore both.
  if (trimmed === '') return [...workspaces];
  if (workspaces.some((workspace) => workspace.name === trimmed)) return [...workspaces];
  return [...workspaces, { id, name: trimmed, sessionIds: [] }];
}

/**
 * Deletes a workspace, moving its sessions to the default one. Returns null
 * when the request is refused (the default workspace itself, or an unknown
 * id) so the store can leave state untouched.
 */
export function withWorkspaceDeleted(
  workspaces: readonly WorkspaceRecord[],
  id: string,
): { workspaces: WorkspaceRecord[] } | null {
  if (id === DEFAULT_WORKSPACE_ID) return null;
  const target = workspaces.find((workspace) => workspace.id === id);
  if (target === undefined) return null;
  return {
    workspaces: workspaces
      .filter((workspace) => workspace.id !== id)
      .map((workspace) =>
        workspace.id === DEFAULT_WORKSPACE_ID
          ? { ...workspace, sessionIds: [...workspace.sessionIds, ...target.sessionIds] }
          : workspace,
      ),
  };
}

/** Moves a session into the target workspace, removing it from every other. */
export function withSessionAssigned(
  workspaces: readonly WorkspaceRecord[],
  sessionId: string,
  workspaceId: string,
): WorkspaceRecord[] {
  const targetExists = workspaces.some((workspace) => workspace.id === workspaceId);
  if (!targetExists) return [...workspaces];
  return workspaces.map((workspace) => {
    const without = workspace.sessionIds.filter((id) => id !== sessionId);
    return {
      ...workspace,
      sessionIds: workspace.id === workspaceId ? [...without, sessionId] : without,
    };
  });
}

/** The workspace a session currently belongs to, if filed anywhere. */
export function workspaceOfSession(
  workspaces: readonly WorkspaceRecord[],
  sessionId: string,
): WorkspaceRecord | null {
  return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId)) ?? null;
}
