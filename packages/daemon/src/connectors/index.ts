/**
 * Connector module — vendor-neutral contracts plus one directory per CLI.
 * Each new CLI is one adapter (detect → spawn → normalize); nothing above
 * this module knows a vendor's wire format (blueprint: "One event model,
 * many backends").
 */
export * from './types.js';
export * from './claude-code/wire.js';
export * from './claude-code/parser.js';
export * from './claude-code/session.js';
export * from './claude-code/connector.js';
export * from './codex/wire.js';
export * from './codex/parser.js';
export * from './codex/session.js';
export * from './codex/exec-session.js';
export * from './codex/login.js';
export * from './codex/connector.js';
