import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentmux/protocol';
import { EventJournal } from './journal.js';
import { MIGRATIONS } from './migrations.js';

const turn = (text: string): AgentEvent => ({
  kind: 'turn',
  turnId: 't1',
  role: 'assistant',
  text,
  done: false,
});

function tempJournalPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentmux-journal-')), 'journal.sqlite3');
}

const open: EventJournal[] = [];
function makeJournal(path: string = tempJournalPath()): EventJournal {
  const journal = new EventJournal(path);
  open.push(journal);
  return journal;
}

afterEach(() => {
  for (const journal of open) journal.close();
  open.length = 0;
});

describe('EventJournal', () => {
  it('applies migrations on first boot and records the schema version', () => {
    const path = tempJournalPath();
    makeJournal(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(
        raw
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it('reopens idempotently — a second boot applies nothing new', () => {
    const path = tempJournalPath();
    makeJournal(path).close();
    makeJournal(path);
    const raw = new Database(path);
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    } finally {
      raw.close();
    }
  });

  it('assigns gapless monotonic seq per session with independent counters', () => {
    const journal = makeJournal();
    for (let seq = 0; seq < 5; seq++) {
      expect(journal.append('sess-a', turn(`chunk ${seq}`)).seq).toBe(seq);
    }
    expect(journal.append('sess-b', turn('other session')).seq).toBe(0);
    expect(journal.append('sess-a', turn('after that')).seq).toBe(5);
    expect(journal.latestSeq('sess-a')).toBe(5);
    expect(journal.latestSeq('sess-b')).toBe(0);
    expect(journal.latestSeq('sess-unknown')).toBeUndefined();
  });

  it('rejects protocol violations before anything is written', () => {
    const journal = makeJournal();
    expect(() =>
      journal.append('sess-a', {
        kind: 'state_change',
        from: 'working',
        to: 'waiting-approval',
      } as AgentEvent),
    ).toThrowError(/waiting-approval requires/);
    expect(() => journal.append('sess-a', { kind: 'nonsense' } as AgentEvent)).toThrowError();
    expect(journal.latestSeq('sess-a')).toBeUndefined();
    expect(journal.replay('sess-a')).toEqual([]);
  });

  it('enforces append-only at the database level, not just the API', () => {
    const path = tempJournalPath();
    const journal = makeJournal(path);
    journal.append('sess-a', turn('immutable'));
    const raw = new Database(path);
    try {
      expect(() => raw.exec('UPDATE events SET ts = 1')).toThrowError(/append-only/);
      expect(() => raw.exec('DELETE FROM events')).toThrowError(/append-only/);
    } finally {
      raw.close();
    }
  });

  it('replays envelopes in order, strictly after the resume cursor', () => {
    const journal = makeJournal();
    for (let seq = 0; seq < 6; seq++) {
      journal.append('sess-a', turn(`chunk ${seq}`));
    }
    expect(journal.replay('sess-a').map((envelope) => envelope.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(journal.replay('sess-a', 3).map((envelope) => envelope.seq)).toEqual([4, 5]);
    expect(journal.replay('sess-a', 5)).toEqual([]);
  });

  it('persists across close and reopen with identical replay', () => {
    const path = tempJournalPath();
    const first = makeJournal(path);
    for (let seq = 0; seq < 4; seq++) {
      first.append('sess-a', turn(`chunk ${seq}`));
    }
    const before = first.replay('sess-a');
    first.close();

    const reopened = makeJournal(path);
    expect(reopened.replay('sess-a')).toEqual(before);
  });

  it('round-trips every protocol event kind and lists sessions', () => {
    const journal = makeJournal();
    const events: AgentEvent[] = [
      { kind: 'state_change', from: 'created', to: 'starting' },
      { kind: 'thinking', text: 'considering the diff…', done: false },
      { kind: 'turn', turnId: 't1', role: 'user', text: 'fix it', done: true },
      { kind: 'tool_use', callId: 'c1', tool: 'Bash', detail: { command: 'npm test' } },
      { kind: 'tool_result', callId: 'c1', output: 'ok', truncated: false },
      { kind: 'usage', tokensIn: 100, tokensOut: 42 },
      {
        kind: 'state_change',
        from: 'working',
        to: 'waiting-approval',
        request: { requestId: 'r1', tool: 'Bash', risk: 'medium', command: 'rm -rf ./dist' },
      },
    ];
    for (const event of events) {
      journal.append('sess-a', event);
    }
    expect(journal.replay('sess-a').map((envelope) => envelope.payload)).toEqual(events);
    expect(journal.sessions()).toEqual(['sess-a']);
  });
});
