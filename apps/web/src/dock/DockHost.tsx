import { useEffect, useRef } from 'react';
import { DockviewApi, DockviewReadyEvent, DockviewReact } from 'dockview-react';
import { AgentPane } from '../panes/AgentPane';
import { TerminalPane } from '../panes/TerminalPane';
import { FileTreePane } from '../panes/FileTreePane';
import { EditorPane } from '../panes/EditorPane';
import { DiffPane } from '../panes/DiffPane';
import { DivergencePane } from '../panes/DivergencePane';
import { UsagePane } from '../panes/UsagePane';
import { loadStoredLayout, saveLayout, validateStoredLayout } from './layoutStorage.js';
import { OnboardingPane } from '../onboarding/OnboardingPane';
import { setDockApi } from './dockApiRef.js';
import 'dockview-react/dist/styles/dockview.css';

/**
 * The dockable center. Everything inside this component the user may
 * rearrange; everything outside it (the approval column) is pinned shell
 * chrome. Panels read the session store directly — a pane is a view over the
 * store, never its owner (blueprint: "Rendering a firehose, calmly").
 *
 * Layout persistence: dockview's own serialization, saved to localStorage per
 * workspace and restored on launch (blueprint: "layout is serialized per
 * workspace and restored on launch"). An unusable stored layout falls back to
 * the default — never a crash, never an empty dock.
 */

function AgentPanel() {
  return <AgentPane />;
}

function TerminalPanel() {
  return <TerminalPane />;
}

function FileTreePanel() {
  return <FileTreePane />;
}

function EditorPanel() {
  return <EditorPane />;
}

function DiffPanel() {
  return <DiffPane />;
}

function DivergencePanel() {
  return <DivergencePane />;
}

function UsagePanel() {
  return <UsagePane />;
}

function OnboardingPanel() {
  return <OnboardingPane />;
}

const components = {
  agent: AgentPanel,
  terminal: TerminalPanel,
  files: FileTreePanel,
  editor: EditorPanel,
  diff: DiffPanel,
  divergence: DivergencePanel,
  usage: UsagePanel,
  onboarding: OnboardingPanel,
};

/** Component keys the registry serves — stored layouts are validated against this. */
export const KNOWN_DOCK_COMPONENTS: ReadonlySet<string> = new Set(Object.keys(components));

/** The fresh-workspace layout — also the fallback for unusable stored ones. */
export function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({ id: 'agent', component: 'agent', title: 'agent' });
  api.addPanel({
    id: 'terminal',
    component: 'terminal',
    title: 'terminal',
    position: { referencePanel: 'agent', direction: 'below' },
  });
  api.addPanel({
    id: 'files',
    component: 'files',
    title: 'files',
    // Own group on the left (classic file-tree placement). Positioning it
    // relative to nothing would tab it into the agent group and hide the
    // terminal pane's group in the walking-skeleton test.
    position: { referencePanel: 'agent', direction: 'left' },
  });
  api.addPanel({
    id: 'editor',
    component: 'editor',
    title: 'editor',
    position: { referencePanel: 'agent', direction: 'right' },
  });
  api.addPanel({
    id: 'diff',
    component: 'diff',
    title: 'diff',
    position: { referencePanel: 'editor', direction: 'below' },
  });
  ensureObservabilityPanes(api);
}

/**
 * The observability panes are a shell invariant, not a user-arranged extra:
 * add whichever are missing after any default build or stored-layout restore.
 * Legacy stored layouts (saved before these panes existed, or during the
 * clear-race) self-heal here instead of staying pane-less forever.
 */
function ensureObservabilityPanes(api: DockviewApi): void {
  if (!api.panels.some((p) => p.id === 'divergence')) {
    api.addPanel({
      id: 'divergence',
      component: 'divergence',
      title: 'divergence',
      position: { referencePanel: 'diff', direction: 'below' },
    });
  }
  if (!api.panels.some((p) => p.id === 'usage')) {
    api.addPanel({
      id: 'usage',
      component: 'usage',
      title: 'usage',
      position: { referencePanel: 'divergence', direction: 'below' },
    });
  }
}

function restoreOrDefault(api: DockviewApi, workspaceId: string): void {
  const stored = validateStoredLayout(loadStoredLayout(workspaceId), KNOWN_DOCK_COMPONENTS);
  if (stored !== null) {
    api.fromJSON(stored);
  } else {
    // No usable stored layout (fresh workspace, unknown component, empty
    // layout) — drop whatever is mounted and start from the default.
    api.clear();
    buildDefaultLayout(api);
  }
  ensureObservabilityPanes(api);
}

export function DockHost({ workspaceId }: { workspaceId: string | null }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const workspaceRef = useRef<string | null>(null);

  useEffect(() => {
    // Dock chrome outside the dock (the ribbon's CLI-setup button) needs the
    // live api handle; clear it on unmount so stale adds can't happen.
    return () => setDockApi(null);
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (api === null || workspaceId === null) return;
    // Workspace switch: save the outgoing layout under its own id before the
    // incoming one is restored, so each workspace keeps its own arrangement.
    if (workspaceRef.current !== workspaceId) {
      if (workspaceRef.current !== null) {
        saveLayout(workspaceRef.current, api.toJSON());
      }
      workspaceRef.current = workspaceId;
    }
    restoreOrDefault(api, workspaceId);
  }, [workspaceId]);

  const onReady = (event: DockviewReadyEvent) => {
    const api: DockviewApi = event.api;
    apiRef.current = api;
    setDockApi(api);
    if (workspaceId !== null) {
      workspaceRef.current = workspaceId;
      restoreOrDefault(api, workspaceId);
    }
    // Persist every layout change under the active workspace id. Restores
    // fire this too, with the just-loaded layout — an idempotent write.
    api.onDidLayoutChange(() => {
      const active = workspaceRef.current;
      if (active !== null) {
        saveLayout(active, api.toJSON());
      }
    });
  };

  return (
    <div className="dock-host" data-testid="dock-host">
      <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
    </div>
  );
}
