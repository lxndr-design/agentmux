import { DockviewApi, DockviewReadyEvent, DockviewReact } from 'dockview-react';
import { AgentPane } from '../panes/AgentPane';
import { TerminalPane } from '../panes/TerminalPane';
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

const components = {
  agent: AgentPanel,
  terminal: TerminalPanel,
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
  };

  return (
    <div className="dock-host" data-testid="dock-host">
      <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
    </div>
  );
}
