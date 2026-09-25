import type { ApprovalRequest, ApprovalRisk } from '@agentmux/protocol';

/**
 * The host-side policy engine (blueprint: "The human in the loop" — policy
 * lives in the host so decisions behave identically in the UI, a headless
 * session, or a future remote client). Evaluation order, per request:
 *
 *   1. explicit deny rules      → auto-deny with the rule's reason
 *   2. preset allow rules       → auto-approve
 *   3. per-session grants       → auto-approve ("always for this session")
 *   4. otherwise                → escalate to the pinned approval column
 *
 * Presets are named after the Claude permission modes (F2c) and mapped per
 * connector — `claude-code` uses them natively; any other connector falls
 * back to the same shared vocabulary until it declares its own mapping.
 * No preset ever auto-approves a high-risk request: the column is the
 * conscience, and even the permissive preset keeps the human on the
 * dangerous classes (the dontAsk conflict note lives in the PR).
 */

export const POLICY_PRESETS = ['default', 'plan', 'acceptEdits', 'dontAsk'] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

/** Who resolved a request when no human did — carried on the decision event. */
export type AutoDecisionActor = 'policy' | 'timeout';

/**
 * A policy evaluation outcome. `escalate` shows the card; the auto actions
 * resolve the request inside the daemon, with the reason journaled and (for
 * denials) returned to the agent as the denial message.
 */
export type PolicyEvaluation =
  | { readonly action: 'escalate' }
  | { readonly action: 'auto-approve' }
  | { readonly action: 'auto-deny'; readonly reason: string };

/**
 * Declarative rules for one preset. `deny` wins over `allow` regardless of
 * order below — a preset that denies a class never grants it back, not even
 * via a session grant. Risk names the engine's trust boundary: `high` is
 * never in any preset's allow set.
 */
export interface PolicyRules {
  /** Explicit deny rules — evaluated first, overriding allow rules and grants. */
  readonly deny?: {
    readonly tools: ReadonlySet<string>;
    readonly reason: string;
  };
  /** Requests auto-approved without human eyes. */
  readonly allow?: {
    /** Tool-name allowlist; omitted = any tool. */
    readonly tools?: ReadonlySet<string>;
    /** Risk classes allowed; omitted = any risk except high (never auto-approved). */
    readonly risks?: ReadonlySet<ApprovalRisk>;
  };
}

/**
 * Tools that mutate files. Connector-agnostic on purpose: the policy engine
 * must not import from any one connector's module (the Codex connector
 * lands under the same engine). `apply_patch` is Codex's edit tool.
 */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
]);

const PLAN_DENY_REASON =
  'plan mode — file edits are denied until the plan is approved (preset: plan)';

/**
 * The Claude mapping (F2c modes → host behavior). `default` and `plan`
 * escalate everything that still reaches the host — the CLI's own mode
 * already restricts what asks; anything the CLI feels it must ask about
 * deserves human eyes. `acceptEdits` mirrors the CLI's in-worktree
 * auto-acceptance host-side. `dontAsk` approves whatever still surfaces,
 * minus the high-risk classes.
 */
const CLAUDE_RULES: Readonly<Record<PolicyPreset, PolicyRules>> = {
  default: {},
  plan: { deny: { tools: FILE_EDIT_TOOLS, reason: PLAN_DENY_REASON } },
  acceptEdits: { allow: { tools: FILE_EDIT_TOOLS, risks: new Set(['low', 'medium']) } },
  dontAsk: { allow: { risks: new Set(['low', 'medium']) } },
};

/** Fallback for connectors without their own mapping — the shared vocabulary. */
const GENERIC_RULES = CLAUDE_RULES;

/** Per-connector preset mapping; new connectors override entries here. */
const RULES_BY_CONNECTOR: Readonly<Record<string, Readonly<Record<PolicyPreset, PolicyRules>>>> = {
  'claude-code': CLAUDE_RULES,
};

export function rulesFor(connectorId: string, preset: PolicyPreset): PolicyRules {
  return RULES_BY_CONNECTOR[connectorId]?.[preset] ?? GENERIC_RULES[preset];
}

function allowedBy(rules: PolicyRules, request: ApprovalRequest): boolean {
  const allow = rules.allow;
  if (allow === undefined) return false;
  if (request.risk === 'high') return false; // the conscience is not waivable by preset
  if (allow.tools !== undefined && !allow.tools.has(request.tool)) return false;
  if (allow.risks !== undefined && !allow.risks.has(request.risk)) return false;
  return true;
}

interface SessionSelection {
  readonly rules: PolicyRules;
  readonly connectorId: string;
  readonly preset: PolicyPreset;
}

/** One grant from a human "always for this session" — exact tool + risk. */
interface SessionGrant {
  readonly tool: string;
  readonly risk: ApprovalRisk;
}

export interface PolicySelection {
  connectorId: string;
  preset: PolicyPreset;
}

/**
 * Per-session policy state: the selected preset's rules plus the grants
 * registered by human approve-for-session decisions. Sessions without an
 * explicit selection run the shared `default` preset — everything escalates.
 */
export class PolicyEngine {
  private readonly selections = new Map<string, SessionSelection>();
  private readonly grants = new Map<string, Set<SessionGrant>>();

  /** Selects the preset for a session; the connector's mapping applies. */
  select(sessionId: string, selection: PolicySelection): void {
    this.selections.set(sessionId, {
      connectorId: selection.connectorId,
      preset: selection.preset,
      rules: rulesFor(selection.connectorId, selection.preset),
    });
  }

  /** Records a human per-session grant (approve-for-session). */
  grant(sessionId: string, request: ApprovalRequest): void {
    let grants = this.grants.get(sessionId);
    if (grants === undefined) {
      grants = new Set();
      this.grants.set(sessionId, grants);
    }
    grants.add({ tool: request.tool, risk: request.risk });
  }

  /** The session's selection, or the shared default when none was made. */
  selectionFor(sessionId: string): PolicySelection {
    const selection = this.selections.get(sessionId);
    return selection === undefined
      ? { connectorId: 'generic', preset: 'default' }
      : { connectorId: selection.connectorId, preset: selection.preset };
  }

  /** Drops a session's selection and grants — called on terminal state. */
  forget(sessionId: string): void {
    this.selections.delete(sessionId);
    this.grants.delete(sessionId);
  }

  /** The engine's entire job — deny rules, allow rules, grants, then ask. */
  evaluate(sessionId: string, request: ApprovalRequest): PolicyEvaluation {
    const selection = this.selections.get(sessionId);
    const rules = selection?.rules ?? GENERIC_RULES.default;

    if (rules.deny !== undefined && rules.deny.tools.has(request.tool)) {
      return { action: 'auto-deny', reason: rules.deny.reason };
    }
    if (allowedBy(rules, request)) {
      return { action: 'auto-approve' };
    }
    const grants = this.grants.get(sessionId);
    if (
      grants !== undefined &&
      request.risk !== 'high' &&
      [...grants].some((grant) => grant.tool === request.tool && grant.risk === request.risk)
    ) {
      return { action: 'auto-approve' };
    }
    return { action: 'escalate' };
  }
}
