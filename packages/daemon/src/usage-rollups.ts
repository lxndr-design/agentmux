import type { AgentEventEnvelope, UsageRollups, UsageRollupRow } from '@agentmux/protocol';
import type { EventJournal } from './journal.js';

/**
 * Usage rollups (blueprint: "Cost & token tracking" — "Rollup per agent /
 * task / day from the journal"). The journal has no task identifier and no
 * metered cost field in v1, so the honest grain is session × UTC day from
 * journaled usage events — the aggregation the budget caps feed when the
 * code factory arrives.
 *
 * Usage events are per-event deltas (protocol contract), so aggregation is a
 * plain sum.
 */

export interface UsageRollupServiceOptions {
  readonly journal: EventJournal;
}

export class UsageRollupService {
  private readonly journal: EventJournal;

  constructor(options: UsageRollupServiceOptions) {
    this.journal = options.journal;
  }

  /**
   * Current rollup over every journaled usage event, all sessions. Async to
   * match the gateway's read-port shape (the divergence read is async; one
   * uniform await keeps the RPC handler single-shaped).
   */
  async list(): Promise<UsageRollups> {
    return aggregateUsage(this.journal.eventsByKind('usage'));
  }
}

/**
 * Pure: journaled usage envelopes → session × UTC-day rows plus totals.
 * Rows sort by session then day; the totals row sums every event exactly
 * once, so rows and totals always agree.
 */
export function aggregateUsage(
  records: ReadonlyArray<{ sessionId: string; envelope: AgentEventEnvelope }>,
): UsageRollups {
  interface Bucket {
    tokensIn: number;
    tokensOut: number;
    events: number;
  }
  const buckets = new Map<string, Bucket>();
  const totals = { tokensIn: 0, tokensOut: 0, events: 0 };
  for (const { sessionId, envelope } of records) {
    if (envelope.payload.kind !== 'usage') {
      continue; // Defensive — eventsByKind already filtered, but never sum blind.
    }
    const day = utcDay(envelope.ts);
    const key = `${sessionId}\u0000${day}`;
    const bucket = buckets.get(key) ?? { tokensIn: 0, tokensOut: 0, events: 0 };
    bucket.tokensIn += envelope.payload.tokensIn;
    bucket.tokensOut += envelope.payload.tokensOut;
    bucket.events += 1;
    buckets.set(key, bucket);
    totals.tokensIn += envelope.payload.tokensIn;
    totals.tokensOut += envelope.payload.tokensOut;
    totals.events += 1;
  }
  const rows: UsageRollupRow[] = [...buckets.entries()]
    .map(([key, bucket]) => {
      const separator = key.indexOf('\u0000');
      const sessionId = key.slice(0, separator);
      const day = key.slice(separator + 1);
      return { sessionId, day, ...bucket };
    })
    .sort((a, b) =>
      a.sessionId === b.sessionId
        ? a.day.localeCompare(b.day)
        : a.sessionId.localeCompare(b.sessionId),
    );
  return { rows, totals };
}

/** The UTC calendar day of a host timestamp, `YYYY-MM-DD`. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
