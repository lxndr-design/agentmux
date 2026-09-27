import { CliError } from './errors.js';

/** Where the daemon serves by default — loopback only, like the daemon binds. */
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8787';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DaemonClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  /** Overridable for tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Thin HTTP client for the daemon's automation API. Every failure becomes a
 * CliError with an actionable message — "cannot reach", "rejected token",
 * or the daemon's own error text.
 */
export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: DaemonClientOptions = {}) {
    if (options.token === undefined || options.token.length === 0) {
      throw new CliError(
        'no daemon token — pass --token or set AGENTMUX_TOKEN (the per-boot token the daemon printed at startup)',
      );
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_DAEMON_URL).replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listSessions(): Promise<unknown> {
    return this.request('GET', '/api/sessions');
  }

  async createSession(body: unknown): Promise<unknown> {
    return this.request('POST', '/api/sessions', body);
  }

  async enqueueTicket(body: unknown): Promise<unknown> {
    return this.request('POST', '/api/factory/tickets', body);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new CliError(
        `cannot reach the daemon at ${this.baseUrl} — is it running? (${causeText(cause)})`,
      );
    }

    if (response.status === 401) {
      throw new CliError(
        'the daemon rejected this token (401) — the token is per-boot; use the one the daemon printed at startup',
      );
    }

    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
    } catch {
      throw new CliError(
        `unexpected daemon response — non-JSON body from ${path} (${response.status})`,
      );
    }
    if (!response.ok) {
      const detail = errorField(payload) ?? raw.slice(0, 200);
      throw new CliError(`daemon error ${response.status} from ${path}: ${detail}`);
    }
    return payload;
  }
}

function causeText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function errorField(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const value = (payload as { error: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return undefined;
}
