import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { SessionState } from '@agentmux/protocol';
import type { FactoryQueue } from './factory-queue.js';
import type { EventJournal } from './journal.js';
import { InitHookError } from './init-hook.js';
import { WorktreeError } from './worktree.js';
import type { Supervisor } from './supervisor.js';

/**
 * The automation API (blueprint: "Scripting / automation API", F4f parity
 * with `mux server`): a token-authenticated HTTP surface on the daemon for
 * the `agentmux` CLI and scripted use. Same per-boot token as the WS
 * gateway; the server itself binds loopback by construction (config.ts
 * refuses any non-loopback host), so the API is local-only like everything
 * else in v1 (open question Q10).
 *
 * Deliberately small — the factory scheduler is a separate workstream, so
 * enqueue is a queue write, not a run:
 *
 *   POST /api/sessions             create a session (supervisor.start)
 *   GET  /api/sessions             list live sessions
 *   GET  /api/sessions/:id/stream  stream pointer (WS url + replay cursor)
 *   POST /api/factory/tickets      enqueue a factory ticket
 *
 * Security notes: the token check runs before any routing, and the
 * supervisor's `command`/`extraArgs` test seams are intentionally absent
 * from the wire schemas — the API can choose among installed connectors,
 * never execute an arbitrary binary.
 */

/** Request-body cap — tickets and session specs are small by nature. */
const MAX_BODY_BYTES = 1_048_576;

const SESSION_ID_MESSAGE = 'session id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}';

const createSessionBodySchema = z.object({
  /** Server-assigned (`sess_…`) when omitted. */
  sessionId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, SESSION_ID_MESSAGE)
    .optional(),
  connectorId: z.string().min(1),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan']).optional(),
  model: z.string().min(1).optional(),
  useMainCheckout: z.boolean().optional(),
  initialTask: z.string().min(1).optional(),
});

const enqueueTicketBodySchema = z.object({
  title: z.string().min(1).max(200),
  spec: z.string().min(1).max(100_000),
  repo: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  runtime: z.enum(['worktree', 'local']).optional(),
  policyClass: z.enum(['guarded', 'supervised']).optional(),
  budgetUsd: z.number().positive().optional(),
  retries: z.number().int().min(0).max(10).optional(),
  bestOfN: z.number().int().min(1).max(10).optional(),
});

/** Where to subscribe for a session's live event stream. */
export interface StreamPointer {
  sessionId: string;
  /** The only v1 transport — the gateway's WS, same per-boot token. */
  transport: 'ws';
  /** The gateway endpoint; authenticate with `Authorization: Bearer`. */
  url: string;
  /** Newest journaled seq — subscribe with `fromSeq` to resume exactly here. */
  lastSeq: number | null;
  state: SessionState;
}

export interface HttpApiOptions {
  token: string;
  journal: EventJournal;
  supervisor: Supervisor;
  queue: FactoryQueue;
  /** The daemon's bound endpoint — resolved per request (port-0 boots). */
  address: () => { host: string; port: number };
}

export class HttpApi {
  constructor(private readonly options: HttpApiOptions) {}

  /** Entry point for every non-upgrade request on the daemon's HTTP server. */
  handle(request: IncomingMessage, response: ServerResponse): void {
    void this.dispatch(request, response).catch((error: unknown) => {
      // Route handlers map their own typed errors; a throw here is a bug.
      // Answer 500 so the connection never hangs, then stop writing.
      this.json(response, 500, { error: describe(error) });
    });
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      this.json(response, 404, { error: 'agentmux daemon — WebSocket endpoint and /api only' });
      return;
    }
    if (!this.authorized(request)) {
      this.json(response, 401, { error: 'missing or invalid bearer token' });
      return;
    }

    const method = request.method ?? '';
    const streamMatch = /^\/api\/sessions\/([^/]+)\/stream$/.exec(url.pathname);
    if (method === 'POST' && url.pathname === '/api/sessions') {
      await this.createSession(request, response);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/sessions') {
      this.json(response, 200, { sessions: this.options.supervisor.list() });
      return;
    }
    if (method === 'GET' && streamMatch !== null) {
      this.streamPointerRoute(decodeURIComponent(streamMatch[1] ?? ''), response);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/factory/tickets') {
      await this.enqueueTicket(request, response);
      return;
    }
    this.json(response, 404, { error: `no such API route: ${method} ${url.pathname}` });
  }

  /**
   * Bearer-token check against the per-boot token, constant-time. Header
   * only — unlike the WS upgrade path there is no `?token=` fallback, since
   * HTTP clients can always set headers and query strings end up in logs.
   */
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (header === undefined) return false;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || token === undefined) return false;
    const left = Buffer.from(token, 'utf8');
    const right = Buffer.from(this.options.token, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private async createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request, response);
    if (body === undefined) return;
    const parsed = createSessionBodySchema.safeParse(body);
    if (!parsed.success) {
      this.json(response, 400, { error: parsed.error.message });
      return;
    }
    const sessionId = parsed.data.sessionId ?? `sess_${randomBytes(8).toString('hex')}`;
    // Built field-by-field: the supervisor's `command`/`extraArgs` are test
    // seams and must stay unreachable from the wire.
    const startRequest = {
      sessionId,
      connectorId: parsed.data.connectorId,
      permissionMode: parsed.data.permissionMode,
      model: parsed.data.model,
      useMainCheckout: parsed.data.useMainCheckout,
      initialTask: parsed.data.initialTask,
    };
    try {
      const session = await this.options.supervisor.start(startRequest);
      this.json(response, 201, {
        session,
        stream: this.streamPointer(sessionId, session.state),
      });
    } catch (error) {
      this.json(response, startErrorStatus(error), { error: describe(error) });
    }
  }

  private streamPointerRoute(sessionId: string, response: ServerResponse): void {
    const session = this.options.supervisor.get(sessionId);
    if (session === undefined) {
      this.json(response, 404, { error: `no live session '${sessionId}'` });
      return;
    }
    this.json(response, 200, this.streamPointer(sessionId, session.state));
  }

  private async enqueueTicket(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request, response);
    if (body === undefined) return;
    const parsed = enqueueTicketBodySchema.safeParse(body);
    if (!parsed.success) {
      this.json(response, 400, { error: parsed.error.message });
      return;
    }
    const ticket = this.options.queue.enqueue(parsed.data);
    this.json(response, 201, { ticket });
  }

  private streamPointer(sessionId: string, state: SessionState): StreamPointer {
    const { host, port } = this.options.address();
    return {
      sessionId,
      transport: 'ws',
      url: `ws://${host}:${port}/`,
      lastSeq: this.options.journal.latestSeq(sessionId) ?? null,
      state,
    };
  }

  /** Reads and size-caps the body; answers the error response itself. */
  private async readBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<unknown | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        this.json(response, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
        request.destroy();
        return undefined;
      }
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) {
      this.json(response, 400, { error: 'a JSON body is required' });
      return undefined;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      this.json(response, 400, { error: 'body must be valid JSON' });
      return undefined;
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

/**
 * Error → status mapping for `supervisor.start` failures. The duplicate and
 * unknown-connector checks read the supervisor's own error messages (its
 * thrown contract, pinned by tests); worktree and init-hook failures carry
 * typed codes.
 */
function startErrorStatus(error: unknown): number {
  if (error instanceof WorktreeError) {
    return error.code === 'E_EXISTS' ? 409 : 500;
  }
  if (error instanceof InitHookError) return 500;
  const message = describe(error);
  if (message.includes('already exists')) return 409;
  if (message.startsWith('unknown connector')) return 400;
  return 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
