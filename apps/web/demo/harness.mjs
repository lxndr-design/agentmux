/**
 * Demo harness — a local HTTP control server over the REAL daemon. It gives
 * the walking skeleton a scripted fake session (legal protocol events only)
 * so the UI can be dogfooded and smoke-tested before the daemon supervisor
 * PR lands spawn/kill control. The supervisor replaces this file wholesale;
 * the event plane it drives (journal + gateway + auth + replay) is production.
 *
 * Control plane (HTTP, 127.0.0.1:8788) — the contract apps/web/src/demo/
 * demoClient.ts speaks:
 *   GET  /demo/config                        -> { wsUrl, token }
 *   POST /demo/sessions        {name}        -> { sessionId }
 *   POST /demo/sessions/:id/stop             -> { ok: true }
 *   POST /demo/sessions/:id/decision         -> { ok: true }
 *
 * The scripted session runs to waiting-approval and blocks there; an approval
 * decision resumes (approve*) or stops (deny) it — the same observable
 * behavior the connector PR will produce through stdin.
 *
 * Event plane (WS, 127.0.0.1:8787): the production daemon gateway, unchanged.
 * Run with: npm run demo (builds the workspace first, then runs this file).
 */
import http from 'node:http';
import { startDaemon } from '@agentmux/daemon';

const CONTROL_PORT = 8788;

const daemon = await startDaemon({ port: 8787, host: '127.0.0.1', journalPath: ':memory:' });
const wsPort = daemon.address().port;

/**
 * The scripted session — every transition is legal per
 * SESSION_STATE_TRANSITIONS. Prelude ends blocked on an approval; the rest
 * runs only after a decision.
 */
function preludeEvents() {
  return [
    { kind: 'state_change', from: 'created', to: 'starting' },
    { kind: 'state_change', from: 'starting', to: 'ready' },
    {
      kind: 'thinking',
      text: 'Tracing the auth bug — token refresh races on tab restore…',
      done: true,
    },
    { kind: 'state_change', from: 'ready', to: 'working' },
    {
      kind: 'turn',
      turnId: 't1',
      role: 'assistant',
      text: 'Reading the refresh handler.',
      done: true,
    },
    { kind: 'tool_use', callId: 'c1', tool: 'Read', summary: 'Read src/auth.ts' },
    {
      kind: 'tool_result',
      callId: 'c1',
      output: 'export function refresh() { /* … */ }',
      truncated: false,
    },
    { kind: 'tool_use', callId: 'c2', tool: 'Edit', summary: 'Edit src/auth.ts' },
    {
      kind: 'state_change',
      from: 'working',
      to: 'waiting-approval',
      request: {
        requestId: 'demo-1',
        tool: 'Edit',
        risk: 'medium',
        diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n-export function refresh() {\n+export function refresh(opts?: RefreshOptions) {\n+  if (opts?.force) bypass();\n',
      },
    },
  ];
}

function resumptionEvents() {
  return [
    { kind: 'state_change', from: 'waiting-approval', to: 'working' },
    {
      kind: 'turn',
      turnId: 't2',
      role: 'assistant',
      text: 'Patching the refresh handler; the diff surfaced in the approval column.',
      done: true,
    },
    { kind: 'usage', tokensIn: 1234, tokensOut: 567 },
  ];
}

/** sessionId -> { name, state, timers[] } */
const sessions = new Map();

function clearTimers(session) {
  for (const timer of session.timers) clearTimeout(timer);
  session.timers.length = 0;
}

function startSession(name) {
  const sessionId = `demo-${Math.random().toString(36).slice(2, 8)}`;
  const session = { name, state: 'created', timers: [] };
  sessions.set(sessionId, session);

  preludeEvents().forEach((event, index) => {
    // Small gaps so live-mode rendering is observable, not one burst.
    session.timers.push(
      setTimeout(() => {
        daemon.ingest(sessionId, event);
        if (event.kind === 'state_change') session.state = event.to;
      }, index * 150),
    );
  });
  return sessionId;
}

function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session === undefined) return false;
  clearTimers(session);
  if (session.state !== 'stopped' && session.state !== 'crashed') {
    // Any non-terminal state may transition to stopped; exit info rides along.
    daemon.ingest(sessionId, {
      kind: 'state_change',
      from: session.state,
      to: 'stopped',
      exit: { code: 0, reason: 'stopped by operator (demo)' },
    });
    session.state = 'stopped';
  }
  return true;
}

function deliverDecision(sessionId, decision) {
  const session = sessions.get(sessionId);
  if (session === undefined || session.state !== 'waiting-approval') return false;
  clearTimers(session);
  if (decision.decision === 'deny') {
    daemon.ingest(sessionId, {
      kind: 'state_change',
      from: 'waiting-approval',
      to: 'stopped',
      exit: { code: 0, reason: `denied: ${decision.reason ?? 'no reason given'}` },
    });
    session.state = 'stopped';
    return true;
  }
  resumptionEvents().forEach((event, index) => {
    session.timers.push(
      setTimeout(() => {
        daemon.ingest(sessionId, event);
        if (event.kind === 'state_change') session.state = event.to;
      }, index * 150),
    );
  });
  return true;
}

http
  .createServer((request, response) => {
    // The UI is served by `vite preview` on a different port, so every control
    // response needs CORS — and the JSON POSTs trigger a preflight.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json', ...cors });
      response.end(JSON.stringify(body));
    };
    const notFound = () => {
      response.writeHead(404, { 'content-type': 'text/plain', ...cors });
      response.end('demo harness control — see demo/harness.mjs\n');
    };
    const readBody = (handler) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => handler(raw));
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/demo/config') {
      json({ wsUrl: `ws://127.0.0.1:${wsPort}`, token: daemon.token });
      return;
    }
    if (request.method === 'POST' && request.url === '/demo/sessions') {
      readBody((raw) => {
        let name = 'agent';
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.name === 'string' && parsed.name !== '') name = parsed.name;
        } catch {
          // default name — the body is optional
        }
        json({ sessionId: startSession(name) });
      });
      return;
    }
    const stopMatch = /^\/demo\/sessions\/([^/]+)\/stop$/.exec(request.url ?? '');
    if (request.method === 'POST' && stopMatch !== null) {
      const stopped = stopSession(decodeURIComponent(stopMatch[1]));
      json({ ok: stopped });
      return;
    }
    const decisionMatch = /^\/demo\/sessions\/([^/]+)\/decision$/.exec(request.url ?? '');
    if (request.method === 'POST' && decisionMatch !== null) {
      readBody((raw) => {
        let decision;
        try {
          decision = JSON.parse(raw);
        } catch {
          decision = null;
        }
        if (
          decision === null ||
          typeof decision !== 'object' ||
          typeof decision.requestId !== 'string' ||
          !['approve', 'approve-for-session', 'deny'].includes(decision.decision)
        ) {
          response.writeHead(400, { 'content-type': 'text/plain', ...cors });
          response.end(
            'decision must be { requestId, decision: approve|approve-for-session|deny }',
          );
          return;
        }
        json({ ok: deliverDecision(decodeURIComponent(decisionMatch[1]), decision) });
      });
      return;
    }
    notFound();
  })
  .listen(CONTROL_PORT, '127.0.0.1', () => {
    console.log(`agentmux demo harness: control :${CONTROL_PORT}, ws :${wsPort}`);
  });
