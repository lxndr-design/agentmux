import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@agentmux/protocol';
import { EventJournal } from './journal.js';
import { aggregateUsage, UsageRollupService } from './usage-rollups.js';

// Multi-day fixtures use fixed UTC instants so the day buckets are exact:
// 2026-09-26 10:00 UTC and 2026-09-27 01:00 UTC — different days, same session.
const DAY_1 = Date.UTC(2026, 8, 26, 10, 0, 0);
const DAY_2 = Date.UTC(2026, 8, 27, 1, 0, 0);

const usage = (tokensIn: number, tokensOut: number, planQuota?: number): AgentEvent => ({
  kind: 'usage',
  tokensIn,
  tokensOut,
  ...(planQuota === undefined ? {} : { planQuota }),
});

function envelope(
  sessionId: string,
  seq: number,
  ts: number,
  event: AgentEvent,
): AgentEventEnvelope {
  return { sessionId, seq, ts, payload: event };
}

const record = (sessionId: string, seq: number, ts: number, event: AgentEvent) => ({
  sessionId,
  envelope: envelope(sessionId, seq, ts, event),
});

function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentmux-usage-')), 'journal.sqlite3');
}

const open: EventJournal[] = [];
function makeJournal(): EventJournal {
  const journal = new EventJournal(tempJournalPath());
  open.push(journal);
  return journal;
}

afterEach(() => {
  for (const journal of open) journal.close();
  open.length = 0;
});

describe('aggregateUsage — pure aggregation', () => {
  it('groups deltas by session x UTC day with agreeing totals', () => {
    const rollups = aggregateUsage([
      record('sess-a', 0, DAY_1, usage(100, 40)),
      record('sess-a', 1, DAY_1, usage(50, 10)),
      record('sess-a', 2, DAY_2, usage(7, 3)),
      record('sess-b', 0, DAY_1, usage(200, 150)),
    ]);
    expect(rollups.rows).toEqual([
      { sessionId: 'sess-a', day: '2026-09-26', tokensIn: 150, tokensOut: 50, events: 2 },
      { sessionId: 'sess-a', day: '2026-09-27', tokensIn: 7, tokensOut: 3, events: 1 },
      { sessionId: 'sess-b', day: '2026-09-26', tokensIn: 200, tokensOut: 150, events: 1 },
    ]);
    expect(rollups.totals).toEqual({ tokensIn: 357, tokensOut: 203, events: 4 });
  });

  it('folds usage events that carry planQuota — the quota level is footer state, not rollup grain', () => {
    const rollups = aggregateUsage([
      record('sess-a', 0, DAY_1, usage(10, 5, 42)),
      record('sess-a', 1, DAY_1, usage(10, 5)),
    ]);
    expect(rollups.rows).toEqual([
      { sessionId: 'sess-a', day: '2026-09-26', tokensIn: 20, tokensOut: 10, events: 2 },
    ]);
  });

  it('counts zero-token events — an event is evidence even when it moved nothing', () => {
    const rollups = aggregateUsage([record('sess-a', 0, DAY_1, usage(0, 0))]);
    expect(rollups.rows).toEqual([
      { sessionId: 'sess-a', day: '2026-09-26', tokensIn: 0, tokensOut: 0, events: 1 },
    ]);
  });

  it('returns empty rows and zero totals for an empty journal', () => {
    expect(aggregateUsage([])).toEqual({
      rows: [],
      totals: { tokensIn: 0, tokensOut: 0, events: 0 },
    });
  });
});

describe('UsageRollupService — fixture journal', () => {
  it('aggregates journaled usage events and ignores every other kind', async () => {
    const journal = makeJournal();
    journal.append('sess-a', usage(120, 30, 42));
    journal.append('sess-a', { kind: 'turn', turnId: 't1', role: 'user', text: 'go', done: true });
    journal.append('sess-a', usage(80, 20));
    journal.append('sess-b', usage(11, 9));

    const rollups = await new UsageRollupService({ journal }).list();
    const today = new Date().toISOString().slice(0, 10);
    expect(rollups.rows).toEqual([
      { sessionId: 'sess-a', day: today, tokensIn: 200, tokensOut: 50, events: 2 },
      { sessionId: 'sess-b', day: today, tokensIn: 11, tokensOut: 9, events: 1 },
    ]);
    expect(rollups.totals).toEqual({ tokensIn: 211, tokensOut: 59, events: 3 });
  });

  it('reads the journal after close-and-reopen — rollups are history, not memory', async () => {
    const path = tempJournalPath();
    const first = new EventJournal(path);
    first.append('sess-a', usage(500, 100));
    first.close();

    const reopened = new EventJournal(path);
    open.push(reopened);
    const rollups = await new UsageRollupService({ journal: reopened }).list();
    expect(rollups.totals).toEqual({
      tokensIn: 500,
      tokensOut: 100,
      events: 1,
    });
  });
});
