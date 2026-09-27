import { useCallback, useEffect } from 'react';
import { useObservabilityClient } from '../ws/useObservabilityClient.js';
import { useObservabilityStore } from '../state/observabilityStore.js';

/**
 * UsagePane — cost/token rollups (blueprint: "Cost & token tracking", parity
 * row "Rollup per agent / task / day from the journal"). Read-only view over
 * journaled usage events, aggregated daemon-side per session × UTC day; the
 * journal has no task ids or metered cost in v1, so the table says tokens
 * and event counts, never invented dollars.
 */

const REFRESH_INTERVAL_MS = 15_000;

export function UsagePane() {
  const client = useObservabilityClient();
  const rollups = useObservabilityStore((state) => state.rollups);
  const loading = useObservabilityStore((state) => state.rollupsLoading);
  const error = useObservabilityStore((state) => state.rollupsError);
  const refresh = useObservabilityStore((state) => state.refreshRollups);

  const refreshNow = useCallback(() => {
    if (client !== null) {
      void refresh(client);
    }
  }, [client, refresh]);

  useEffect(() => {
    refreshNow();
    const timer = setInterval(refreshNow, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshNow]);

  return (
    <div className="usage-pane" data-testid="usage-pane">
      <div className="usage-pane__header">
        <span className="usage-pane__title">Usage</span>
        <button
          type="button"
          className="pane-button"
          onClick={refreshNow}
          disabled={client === null}
        >
          Refresh
        </button>
      </div>
      {error !== null && (
        <div className="divergence-pane__error" role="alert">
          {error}
          <button type="button" className="pane-button" onClick={refreshNow}>
            Retry
          </button>
        </div>
      )}
      {loading && rollups === null && <div className="pane-empty">Aggregating the journal…</div>}
      {!loading && rollups !== null && rollups.rows.length === 0 && (
        <div className="pane-empty">
          No usage journaled yet — tokens appear as agents complete turns.
        </div>
      )}
      {rollups !== null && rollups.rows.length > 0 && (
        <table className="usage-pane__table">
          <thead>
            <tr>
              <th scope="col">session</th>
              <th scope="col">day (UTC)</th>
              <th scope="col">tokens in</th>
              <th scope="col">tokens out</th>
              <th scope="col">events</th>
            </tr>
          </thead>
          <tbody>
            {rollups.rows.map((row) => (
              <tr key={`${row.sessionId}:${row.day}`}>
                <td>{row.sessionId}</td>
                <td>{row.day}</td>
                <td>{row.tokensIn.toLocaleString('en-US')}</td>
                <td>{row.tokensOut.toLocaleString('en-US')}</td>
                <td>{row.events}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>total</td>
              <td>{rollups.totals.tokensIn.toLocaleString('en-US')}</td>
              <td>{rollups.totals.tokensOut.toLocaleString('en-US')}</td>
              <td>{rollups.totals.events}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
