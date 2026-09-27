import { z } from 'zod';
import {
  DEFAULT_WORKSPACE_ID,
  defaultWorkspaces,
  type WorkspaceRecord,
} from './workspacesModel.js';

/**
 * Workspace persistence — localStorage, same contract as layout persistence:
 * the browser owns this UI record (the daemon's journal holds sessions, not
 * shell chrome). Corrupt or wedged snapshots degrade to the default
 * workspace; they never break boot.
 */

export const WORKSPACES_STORAGE_KEY = 'agentmux.workspaces.v1';

export interface WorkspaceSnapshot {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string;
}

const snapshotSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      sessionIds: z.array(z.string()),
    }),
  ),
  activeWorkspaceId: z.string().min(1),
});

/**
 * Stored snapshots are normalized on read: the default workspace always
 * exists (older writes must never leave the shell without a floor group),
 * duplicate ids collapse, per-workspace session ids dedupe, and an unknown
 * active id falls back to default.
 */
export function normalizeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const byId = new Map<string, WorkspaceRecord>();
  for (const workspace of snapshot.workspaces) {
    if (!byId.has(workspace.id)) {
      byId.set(workspace.id, { ...workspace, sessionIds: [...new Set(workspace.sessionIds)] });
    }
  }
  if (!byId.has(DEFAULT_WORKSPACE_ID)) {
    byId.set(DEFAULT_WORKSPACE_ID, { id: DEFAULT_WORKSPACE_ID, name: 'default', sessionIds: [] });
  }
  const workspaces = [...byId.values()];
  const activeWorkspaceId = workspaces.some(
    (workspace) => workspace.id === snapshot.activeWorkspaceId,
  )
    ? snapshot.activeWorkspaceId
    : DEFAULT_WORKSPACE_ID;
  return { workspaces, activeWorkspaceId };
}

export function loadWorkspaceSnapshot(): WorkspaceSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = snapshotSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return null;
    return normalizeWorkspaceSnapshot(parsed.data);
  } catch (error) {
    console.warn('agentmux: stored workspaces unreadable — starting fresh', error);
    return null;
  }
}

/** Best-effort write; quota or private-mode failures cost only persistence. */
export function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('agentmux: saving workspaces failed', error);
  }
}

/** Boot-time snapshot: the stored one, or the bare default workspace. */
export function initialWorkspaceSnapshot(): WorkspaceSnapshot {
  return (
    loadWorkspaceSnapshot() ?? {
      workspaces: defaultWorkspaces(),
      activeWorkspaceId: DEFAULT_WORKSPACE_ID,
    }
  );
}
