import type { Take } from './engine.ts';

export interface StaleSweepHolder {
  holder: string;
  label: string;
}

export const DEFAULT_STALE_SWEEP_HOLDERS: StaleSweepHolder[] = [
  { holder: 'mark', label: 'Mark-holder' },
  { holder: 'seb', label: 'Seb-holder' },
  { holder: 'brain', label: 'brain-holder' },
];

export interface StaleBetSweepOptions {
  now?: Date;
  staleAfterDays?: number;
  explicitDecisionAfterDays?: number;
  holders?: StaleSweepHolder[];
}

export interface StaleBetSweepItem {
  id: number;
  pageSlug: string;
  rowNum: number;
  claim: string;
  holder: string;
  holderLabel: string;
  weight: number;
  ageDays: number;
  referenceDate: string;
  referenceSource: 'due' | 'effective' | 'created';
  needsExplicitDecision: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const day = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (day) return new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));

  // Takes dates are TEXT by design and often carry month-level precision
  // (`YYYY-MM`). For a stale WIP-limit sweep, the deterministic conservative
  // anchor is the first day of that month.
  const month = value.match(/^(\d{4})-(\d{2})$/);
  if (month) return new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));

  return null;
}

function referenceForTake(take: Take): { date: Date; iso: string; source: StaleBetSweepItem['referenceSource'] } | null {
  const due = parseDateOnly(take.until_date);
  if (due) return { date: due, iso: due.toISOString().slice(0, 10), source: 'due' };

  const effective = parseDateOnly(take.since_date);
  if (effective) return { date: effective, iso: effective.toISOString().slice(0, 10), source: 'effective' };

  const created = parseDateOnly(take.created_at);
  if (created) return { date: created, iso: created.toISOString().slice(0, 10), source: 'created' };

  return null;
}

function normalizeOptions(opts: StaleBetSweepOptions = {}): Required<StaleBetSweepOptions> {
  return {
    now: opts.now ?? new Date(),
    staleAfterDays: opts.staleAfterDays ?? 7,
    explicitDecisionAfterDays: opts.explicitDecisionAfterDays ?? 14,
    holders: opts.holders ?? DEFAULT_STALE_SWEEP_HOLDERS,
  };
}

export function findStaleBetSweepItems(
  takes: Take[],
  opts: StaleBetSweepOptions = {},
): StaleBetSweepItem[] {
  const options = normalizeOptions(opts);
  const holderLabels = new Map(options.holders.map(h => [h.holder, h.label]));
  const holderOrder = new Map(options.holders.map((h, i) => [h.holder, i]));
  const today = utcDay(options.now);

  return takes
    .filter(t => t.kind === 'bet')
    .filter(t => t.active)
    .filter(t => t.resolved_at === null)
    .filter(t => holderLabels.has(t.holder))
    .map(t => {
      const ref = referenceForTake(t);
      if (!ref) return null;
      const ageDays = Math.floor((today - utcDay(ref.date)) / DAY_MS);
      if (ageDays <= options.staleAfterDays) return null;
      return {
        id: Number(t.id),
        pageSlug: t.page_slug,
        rowNum: t.row_num,
        claim: t.claim,
        holder: t.holder,
        holderLabel: holderLabels.get(t.holder)!,
        weight: Number(t.weight),
        ageDays,
        referenceDate: ref.iso,
        referenceSource: ref.source,
        needsExplicitDecision: ageDays > options.explicitDecisionAfterDays,
      } satisfies StaleBetSweepItem;
    })
    .filter((x): x is StaleBetSweepItem => x !== null)
    .sort((a, b) => {
      const holderDelta = (holderOrder.get(a.holder) ?? 999) - (holderOrder.get(b.holder) ?? 999);
      if (holderDelta !== 0) return holderDelta;
      if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
      const pageDelta = a.pageSlug.localeCompare(b.pageSlug);
      if (pageDelta !== 0) return pageDelta;
      return a.rowNum - b.rowNum;
    });
}

function countLine(holders: StaleSweepHolder[], items: StaleBetSweepItem[]): string {
  return holders
    .map(h => `${h.label}=${items.filter(i => i.holder === h.holder).length}`)
    .join(', ');
}

function referenceLabel(item: StaleBetSweepItem): string {
  if (item.referenceSource === 'due') return `due/target: ${item.referenceDate}`;
  if (item.referenceSource === 'effective') return `effective: ${item.referenceDate}`;
  return `created: ${item.referenceDate}`;
}

function renderItem(item: StaleBetSweepItem): string {
  return [
    `- ${item.claim}`,
    `  holder: ${item.holder}`,
    `  confidence: ${item.weight.toFixed(2)}`,
    `  age: ${item.ageDays} days`,
    `  ${referenceLabel(item)}`,
    `  source: ${item.pageSlug}#${item.rowNum}`,
    `  next: resolve / update date / leave active with reason`,
  ].join('\n');
}

export function buildBetResolutionSweepReport(
  takes: Take[],
  opts: StaleBetSweepOptions = {},
): string {
  const options = normalizeOptions(opts);
  const items = findStaleBetSweepItems(takes, options);
  const holderNames = options.holders.map(h => h.label).join(', ');

  if (items.length === 0) {
    return [
      'Bet-resolution sweep',
      `No stale unresolved bets across ${holderNames}.`,
    ].join('\n');
  }

  const lines: string[] = [
    'Bet-resolution sweep',
    `Counts by holder: ${countLine(options.holders, items)}`,
    '',
  ];

  const explicit = items.filter(i => i.needsExplicitDecision);
  if (explicit.length > 0) {
    lines.push(`Needs explicit decision (>${options.explicitDecisionAfterDays} days)`);
    for (const item of explicit) {
      lines.push(`- ${item.holderLabel}: ${item.claim} (${item.ageDays} days, ${item.pageSlug}#${item.rowNum})`);
    }
    lines.push('');
  }

  for (const holder of options.holders) {
    lines.push(`## ${holder.label}`);
    const holderItems = items.filter(i => i.holder === holder.holder);
    if (holderItems.length === 0) {
      lines.push('- none');
    } else {
      for (const item of holderItems) lines.push(renderItem(item));
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
