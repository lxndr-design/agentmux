import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConnectorDetectReport } from '@agentmux/protocol';
import { useOnboardingStore } from '../state/onboardingStore.js';
import {
  authStateTone,
  authStatusLabel,
  helpForConnector,
  needsLoginGuidance,
  orderRows,
} from './connectorHelp.js';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    // Clipboard denial (permissions, jsdom) must not look like success.
    console.warn('agentmux: clipboard write failed', error);
    return false;
  }
}

function CopyButton({ testId, command }: { testId: string; command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="onboarding__copy"
      data-testid={testId}
      onClick={() => {
        void copyText(command).then((ok) => setCopied(ok));
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function ConnectorRow({ report }: { report: ConnectorDetectReport }): React.JSX.Element {
  const help = helpForConnector(report.connectorId);
  const label = help?.label ?? report.connectorId;
  const hasAuth = report.authState !== undefined;
  const needsLogin = report.authState !== undefined && needsLoginGuidance(report.authState);
  return (
    <div className="onboarding__row" data-testid={`onboarding-row-${report.connectorId}`}>
      <div className="onboarding__row-head">
        <span className="onboarding__label">{label}</span>
        <span className="onboarding__version">
          {report.installed ? (report.version ?? 'installed') : 'not installed'}
        </span>
        {hasAuth && report.authState !== undefined && (
          <span
            className={`onboarding__badge onboarding__badge--${authStateTone(report.authState)}`}
            data-testid={`onboarding-auth-${report.connectorId}`}
            title={report.authDetail ?? undefined}
          >
            {authStatusLabel(report.authState)}
          </span>
        )}
        {!hasAuth && (
          <span
            className="onboarding__badge"
            data-testid={`onboarding-auth-${report.connectorId}`}
            title="This connector does not report login state"
          >
            —
          </span>
        )}
      </div>
      {report.authDetail !== undefined && <p className="onboarding__detail">{report.authDetail}</p>}
      {!report.installed && help !== null && (
        <p className="onboarding__step">
          <code>{help.installCommand}</code>
          <CopyButton testId={`copy-${report.connectorId}-install`} command={help.installCommand} />
        </p>
      )}
      {report.installed && needsLogin && help !== null && (
        <>
          <p className="onboarding__step">
            <code>{help.loginCommand}</code>
            <CopyButton testId={`copy-${report.connectorId}-login`} command={help.loginCommand} />
          </p>
          <p className="onboarding__detail onboarding__detail--dim">{help.loginDetail}</p>
        </>
      )}
    </div>
  );
}

/**
 * The onboarding wizard — CLI detect() plus guided install/login steps
 * (blueprint "Init, run, kill, tombstone"). The wizard shows instructions and
 * STATUS ONLY: the CLIs own their auth flows, and no credential is ever
 * visible to, stored by, or sent through agentmux.
 */
export function OnboardingPane(): React.JSX.Element {
  const status = useOnboardingStore((state) => state.status);
  const results = useOnboardingStore(useShallow((state) => state.results));
  const error = useOnboardingStore((state) => state.error);
  const runDetect = useOnboardingStore((state) => state.runDetect);

  useEffect(() => {
    if (status === 'idle') void runDetect();
  }, [status, runDetect]);

  return (
    <div className="onboarding" data-testid="onboarding-pane">
      <h2 className="onboarding__title">CLI setup</h2>
      <p className="onboarding__privacy">
        agentmux supervises the official CLIs. Logging in happens in each CLI&apos;s own flow —
        credentials are never visible to, stored by, or sent through agentmux.
      </p>
      {status === 'detecting' && (
        <p className="onboarding__status" data-testid="onboarding-status">
          Checking for the CLIs…
        </p>
      )}
      {status === 'unavailable' && error !== null && (
        <p className="onboarding__error" data-testid="onboarding-error">
          {error}
        </p>
      )}
      {(status === 'ready' || status === 'unavailable') &&
        orderRows(results).map((report) => (
          <ConnectorRow key={report.connectorId} report={report} />
        ))}
      <button
        type="button"
        className="onboarding__recheck"
        data-testid="onboarding-recheck"
        onClick={() => void runDetect()}
      >
        Re-check
      </button>
    </div>
  );
}
