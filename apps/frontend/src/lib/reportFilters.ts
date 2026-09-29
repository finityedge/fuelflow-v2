/**
 * The reports list's filters, as values rather than as markup.
 *
 * The status filter is the one thing here worth arguing about. A mock of this screen offers
 * "All / Needs Review / Balanced / Failed", which mixes three different questions into one
 * row: whether a human still has to look at the report, whether the money reconciles, and
 * whether the PDF was readable at all. Selecting "Balanced" and "Failed" together is not a
 * question anyone can answer, and worse, "Balanced" is a claim this app cannot make from a
 * status field — a report whose every figure was read cleanly can still be three million
 * shillings short, and calling it balanced is the exact mistake the variance exists to catch.
 *
 * So the filter narrows by `status` and only by `status`, and the labels below are the same
 * words the pills on the rows use. Whether a shift adds up is answered by the variance
 * printed on each row, which is a fact rather than a filter.
 */

import type { ShiftReportState } from '@fuelflow/shared';

export type StatusFilter = 'ALL' | ShiftReportState;

/**
 * In the order a manager would ask the questions: what needs me, then what is fine, then
 * what is still running, then what is broken.
 */
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'PARSED', label: 'Nothing to review' },
  { value: 'PENDING', label: 'Reading…' },
  { value: 'FAILED', label: 'Couldn’t be read' },
];

export type DateRangeFilter = 'ALL' | '7' | '30' | '90';

export const DATE_RANGE_FILTERS: ReadonlyArray<{ value: DateRangeFilter; label: string }> = [
  { value: 'ALL', label: 'All time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

/**
 * A UTC day key, which is the form the API compares against.
 *
 * UTC and not local time because `reportDate` is stored as UTC midnight and handed back as
 * a UTC day key — so a range built any other way would disagree with the dates printed on
 * the rows it is filtering.
 */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The inclusive day bounds for a range, or nothing for "all time".
 *
 * The end is today rather than "now": a report dated today belongs to the range no matter
 * what time of day it is opened, and `2026-03-12T00:00:00Z` as an upper bound would have
 * excluded every shift on the 12th.
 */
export function dateRangeBounds(
  range: DateRangeFilter,
  today: Date = new Date()
): { from?: string; to?: string } {
  if (range === 'ALL') {
    return {};
  }

  const days = Number(range);
  const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: utcDayKey(start), to: utcDayKey(today) };
}
