/**
 * The CLI's only error type — every failure a user can act on becomes one of
 * these with an exit code the shell can script against (1 runtime, 2 usage).
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
