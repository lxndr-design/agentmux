import { DockviewApi, DockviewReadyEvent, DockviewReact } from 'dockview-react';
import { AgentPane } from '../panes/AgentPane';
import { TerminalPane } from '../panes/TerminalPane';
import { FileTreePane } from '../panes/FileTreePane';
import { EditorPane } from '../panes/EditorPane';
import { DiffPane } from '../panes/DiffPane';
import 'dockview-react/dist/styles/dockview.css';

/**
 * The dockable center. Everything inside this component the user may
 * rearrange; everything outside it (the approval column) is pinned shell
 * chrome. Panels read the session store directly — a pane is a view over the
 * store, never its owner (blueprint: "Rendering a firehose, calmly").
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

const components = {
  agent: AgentPanel,
  terminal: TerminalPanel,
  files: FileTreePanel,
  editor: EditorPanel,
  diff: DiffPanel,
};

export function DockHost() {
  const onReady = (event: DockviewReadyEvent) => {
    const api: DockviewApi = event.api;
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
  };

  return (
    <div className="dock-host" data-testid="dock-host">
      <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
    </div>
  );
}
