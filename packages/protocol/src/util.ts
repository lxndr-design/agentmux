/**
 * Exhaustiveness helper for consumers of the agent-event union. A `switch`
 * over `event.kind` ends with `default: return assertNever(event)` — when the
 * union grows, every unhandled consumer stops compiling instead of silently
 * dropping the new variant at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated-union member: ${JSON.stringify(value)}`);
}
