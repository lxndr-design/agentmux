/**
 * Terminal placeholder — xterm.js and raw agent PTYs land in a later PR. The
 * pane exists so the dock has its second registered surface and the layout
 * contract is testable.
 */
export function TerminalPane() {
  return (
    <div className="terminal-pane" data-testid="terminal-pane">
      <p className="terminal-placeholder">Terminal — xterm.js lands in a later PR.</p>
    </div>
  );
}
