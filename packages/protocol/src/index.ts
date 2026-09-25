/**
 * Normalized agent-event protocol — the one contract every backend (CLI
 * connector, future API or MCP adapter) compiles down to. Everything above
 * the connectors only ever sees this module.
 *
 * Types are derived from the zod schemas via `z.infer` — there are no
 * hand-written duplicates. The schemas are the single source of truth.
 */

export * from './util.js';
export * from './session.js';
export * from './approval.js';
export * from './events.js';
export * from './envelope.js';
export * from './fs.js';
