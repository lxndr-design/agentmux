import { DEFAULT_DAEMON_URL } from './client.js';
import { enqueueTicket, runTask } from './commands.js';
import { CliError } from './errors.js';

export const USAGE = `agentmux — drive the local agentmux daemon (loopback automation API)

Usage:
  agentmux run "<task>"
      Spawn a session, hand it the task, print its stream pointer. The agent's
      own git workflow produces the PR.

  agentmux factory enqueue --title=<t> --spec=<s> [options]
      Queue a code-factory ticket. Queue write only — the daemon's scheduler
      owns execution.

  agentmux help
      Show this help.

Options for 'run':
  --connector=<id>      Connector to spawn (default: claude-code).
  --session=<id>        Session id (default: daemon-assigned).

Options for 'factory enqueue':
  --title=<t>           Ticket title (required).
  --spec=<s>            Ticket spec / acceptance criteria (required).
  --repo=<r>            Repository hint (optional).
  --base=<b>            Base branch (default: the daemon's default).
  --policy=<p>          guarded | supervised (default: guarded).
  --budget=<usd>        Per-ticket budget cap.
  --retries=<n>         Bounded retries after a failed verification gate.
  --best-of-n=<n>       Candidate count (winner advances, rest discarded).

Connection:
  --url=<u>             Daemon base URL (default: ${DEFAULT_DAEMON_URL}, or AGENTMUX_URL).
  --token=<t>           Per-boot daemon token (default: AGENTMUX_TOKEN).

Exit codes: 0 ok · 1 failure · 2 usage.
`;

export interface CliIo {
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
  readonly env: Readonly<Record<string, string | undefined>>;
}

const EXIT_OK = 0;

/** Entry point — returns the process exit code; never throws. */
export async function main(argv: readonly string[], io: CliIo = processIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.stdout.write(USAGE);
      return EXIT_OK;
    }
    if (command === 'run') return await cmdRun(rest, io);
    if (command === 'factory') return await cmdFactory(rest, io);
    io.stderr.write(`agentmux: unknown command '${command}'\n\n${USAGE}`);
    return 2;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    io.stderr.write(`agentmux: ${errorMessage(error)}\n`);
    return exitCode;
  }
}

async function cmdRun(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseArgs(argv);
  const result = await runTask({
    task: rest.join(' '),
    baseUrl: connectionUrl(io, flags),
    token: connectionToken(io, flags),
    connectorId: flags.get('connector'),
    sessionId: flags.get('session'),
  });
  io.stdout.write(`session ${result.session.id} is ${result.session.state}\n`);
  io.stdout.write(
    `stream: ${result.stream.url} — subscribe with session id "${result.stream.sessionId}", replay from seq ${result.stream.lastSeq}\n`,
  );
  return EXIT_OK;
}

async function cmdFactory(argv: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'enqueue') {
    io.stderr.write(
      `agentmux: unknown factory command '${sub ?? ''}' — expected 'enqueue'\n\n${USAGE}`,
    );
    return 2;
  }
  const { flags } = parseArgs(rest);
  const result = await enqueueTicket({
    title: flags.get('title'),
    spec: flags.get('spec'),
    repo: flags.get('repo'),
    baseBranch: flags.get('base'),
    policyClass: flags.get('policy'),
    budgetUsd: optionalNumber(flags, 'budget'),
    retries: optionalNumber(flags, 'retries'),
    bestOfN: optionalNumber(flags, 'best-of-n'),
    baseUrl: connectionUrl(io, flags),
    token: connectionToken(io, flags),
  });
  io.stdout.write(
    `ticket ${result.ticket.id} queued (${result.ticket.state}, policy ${result.ticket.policyClass})\n`,
  );
  return EXIT_OK;
}

// --- env/flag wiring -------------------------------------------------------

function connectionUrl(io: CliIo, flags: ReadonlyMap<string, string>): string | undefined {
  return flags.get('url') ?? io.env.AGENTMUX_URL;
}

function connectionToken(io: CliIo, flags: ReadonlyMap<string, string>): string | undefined {
  return flags.get('token') ?? io.env.AGENTMUX_TOKEN;
}

// --- pure argv parsing -----------------------------------------------------

export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, string>;
  readonly rest: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags.set(arg.slice(2), 'true');
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function optionalNumber(flags: ReadonlyMap<string, string>, key: string): number | undefined {
  const raw = flags.get(key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${key} must be a number, got '${raw}'`, 2);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  };
}
