import { describe, expect, test } from 'bun:test';
import type { Take } from '../src/core/engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import {
  DEFAULT_STALE_SWEEP_HOLDERS,
  buildBetResolutionSweepReport,
  findStaleBetSweepItems,
} from '../src/core/takes-stale-sweep.ts';

const NOW = new Date('2026-05-13T12:00:00Z');

function bet(overrides: Partial<Take>): Take {
  return {
    id: 1,
    page_id: 1,
    page_slug: 'beliefs/fixture',
    row_num: 1,
    claim: 'Fixture bet',
    kind: 'bet',
    holder: 'mark-neville',
    weight: 0.6,
    since_date: null,
    until_date: null,
    source: null,
    superseded_by: null,
    active: true,
    resolved_at: null,
    resolved_outcome: null,
    resolved_quality: null,
    resolved_value: null,
    resolved_unit: null,
    resolved_source: null,
    resolved_by: null,
    created_at: '2026-05-01T09:00:00Z',
    updated_at: '2026-05-01T09:00:00Z',
    ...overrides,
  };
}

describe('stale bet-resolution sweep', () => {
  test('default holders use canonical mark-neville Mark-holder, never legacy mark', () => {
    expect(DEFAULT_STALE_SWEEP_HOLDERS).toEqual([
      { holder: 'mark-neville', label: 'Mark-holder' },
      { holder: 'seb', label: 'Seb-holder' },
      { holder: 'brain', label: 'brain-holder' },
    ]);
  });

  test('no stale bets produces one quiet non-nagging line', () => {
    const report = buildBetResolutionSweepReport([], {
      now: NOW,
      holders: DEFAULT_STALE_SWEEP_HOLDERS,
    });

    expect(report).toContain('Bet-resolution sweep');
    expect(report).toContain('Status: GREEN');
    expect(report).toContain('Holders checked: mark-neville, seb, brain.');
    expect(report).not.toContain('failed');
    expect(report).not.toContain('shame');
  });

  test('Mark-holder stale bet is counted and rendered separately', () => {
    const report = buildBetResolutionSweepReport([
      bet({ holder: 'mark-neville', claim: 'Mark prediction needs a check', weight: 0.72, until_date: '2026-05-05' }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(report).toContain('Counts by holder: Mark-holder=1, Seb-holder=0, brain-holder=0');
    expect(report).toContain('## Mark-holder');
    expect(report).toContain('Mark prediction needs a check');
    expect(report).toContain('holder: mark-neville');
    expect(report).not.toContain('holder: mark\n');
    expect(report).toContain('confidence: 0.72');
    expect(report).toContain('age: 8 days');
    expect(report).toContain('due/target: 2026-05-05');
    expect(report).toContain('status: stale');
    expect(report).toContain('severity: yellow');
    expect(report).toContain('action: ask_holder');
    expect(report).toContain('prompt target: mark');
    expect(report).toContain('why now: crossed 7-day stale threshold');
  });

  test('Seb-holder stale bet is counted without mixing with Mark-holder', () => {
    const report = buildBetResolutionSweepReport([
      bet({ holder: 'seb', claim: 'Seb operational bet needs review', until_date: '2026-05-04' }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(report).toContain('Counts by holder: Mark-holder=0, Seb-holder=1, brain-holder=0');
    expect(report).toContain('## Mark-holder\n- none');
    expect(report).toContain('## Seb-holder');
    expect(report).toContain('Seb operational bet needs review');
  });

  test('brain-holder stale bet is counted separately', () => {
    const report = buildBetResolutionSweepReport([
      bet({ holder: 'brain', claim: 'Brain-system bet needs review', since_date: '2026-05-03', until_date: null }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(report).toContain('Counts by holder: Mark-holder=0, Seb-holder=0, brain-holder=1');
    expect(report).toContain('## brain-holder');
    expect(report).toContain('Brain-system bet needs review');
    expect(report).toContain('effective: 2026-05-03');
  });

  test('month-precision due dates are used before created_at fallback', () => {
    const stale = findStaleBetSweepItems([
      bet({ holder: 'mark-neville', claim: 'Month target stale', until_date: '2026-05', created_at: '2026-05-12T09:00:00Z' }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(stale).toHaveLength(1);
    expect(stale[0].claim).toBe('Month target stale');
    expect(stale[0].referenceSource).toBe('due');
    expect(stale[0].referenceDate).toBe('2026-05-01');
    expect(stale[0].ageDays).toBe(12);
  });

  test('items older than 14 days are called out as needing explicit decision', () => {
    const report = buildBetResolutionSweepReport([
      bet({ holder: 'mark-neville', claim: 'Old bet needs explicit decision', until_date: '2026-04-28' }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(report).toContain('Needs explicit decision (>14 days)');
    expect(report).toContain('Old bet needs explicit decision');
  });

  test('missing due date falls back to created_at for age calculation', () => {
    const stale = findStaleBetSweepItems([
      bet({ holder: 'mark-neville', claim: 'Fallback stale', created_at: '2026-05-05T23:59:00Z', until_date: null, since_date: null }),
      bet({ id: 2, row_num: 2, holder: 'mark-neville', claim: 'Fallback fresh', created_at: '2026-05-06T00:01:00Z', until_date: null, since_date: null }),
    ], { now: NOW, holders: DEFAULT_STALE_SWEEP_HOLDERS });

    expect(stale).toHaveLength(1);
    expect(stale[0].claim).toBe('Fallback stale');
    expect(stale[0].referenceSource).toBe('created');
    expect(stale[0].ageDays).toBe(8);
  });

  test('takes stale-sweep CLI path is read-only and deterministic for configured holders', async () => {
    const calls: unknown[] = [];
    const engine = {
      listTakes: async (opts: unknown) => {
        calls.push(opts);
        if ((opts as { holder: string }).holder !== 'mark-neville') return [];
        return [bet({ holder: 'mark-neville', claim: 'CLI stale bet', until_date: '2026-05-05' })];
      },
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      await runTakes(engine as any, [
        'stale-sweep',
        '--now', '2026-05-13T12:00:00Z',
        '--holders', 'mark-neville:Mark-holder,seb:Seb-holder,brain:brain-holder',
      ]);
    } finally {
      console.log = original;
    }

    expect(calls).toEqual([
      { holder: 'mark-neville', kind: 'bet', active: true, resolved: false, sortBy: 'created_at', limit: 500 },
      { holder: 'seb', kind: 'bet', active: true, resolved: false, sortBy: 'created_at', limit: 500 },
      { holder: 'brain', kind: 'bet', active: true, resolved: false, sortBy: 'created_at', limit: 500 },
    ]);
    expect(lines.join('\n')).toContain('Counts by holder: Mark-holder=1, Seb-holder=0, brain-holder=0');
    expect(lines.join('\n')).toContain('CLI stale bet');
  });
});
