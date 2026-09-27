import { z } from 'zod';

/**
 * CLI detection contract — what the daemon's connector registry reports about
 * each agent CLI's install and login state, and what the onboarding wizard
 * renders (blueprint Q4: the user installs and authenticates the CLIs;
 * agentmux detects and guides). Credentials are the user's own: the CLIs
 * manage their own subscription auth in their own config/keychain, so this
 * contract carries STATUS ONLY — never tokens, never account secrets
 * (F2e/F3a).
 */

/** Where a CLI's login stands, as the CLI's own status probe reports it. */
export const authStateSchema = z.enum([
  /** Logged in with the vendor subscription (ChatGPT plan / Claude Pro/Max). */
  'subscription',
  /** Logged in with an API key — metered billing, not the subscription path. */
  'api-key',
  /** Logged in; the CLI's status probe does not distinguish the mode. */
  'logged-in',
  /** Logged in with an unrecognized mode. */
  'other',
  /** Installed but not logged in. */
  'none',
  /** The status probe itself failed (or the CLI documents none). */
  'unavailable',
]);
export type AuthState = z.infer<typeof authStateSchema>;

export const connectorDetectSchema = z.object({
  /** Stable connector id — 'claude-code', 'codex', … (connector registry keys). */
  connectorId: z.string().min(1),
  installed: z.boolean(),
  version: z.string().min(1).optional(),
  authState: authStateSchema.optional(),
  /** Human-readable diagnostic rendered next to the state. */
  authDetail: z.string().min(1).optional(),
});
export type ConnectorDetectReport = z.infer<typeof connectorDetectSchema>;
