/**
 * Integration tests for the dashboard totals.
 *
 * The dashboard is the only screen that adds shifts together, and adding variances
 * together is where this feature can lie. A shift that is three million short and a shift
 * that is three million over sum to zero — a month containing both would be reported as
 * perfectly clean by anything that keeps a single running total. The assertions below
 * exist to make that specific failure impossible to reintroduce.
 *
 * Same fixture caveat as the rest of the suite: no real Petronite report was available, so
 * these documents are built to the spec's structure. This proves the arithmetic and the
 * grouping; it does not prove the parser against live station output.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { enqueuePdfParse } = vi.hoisted(() => ({ enqueuePdfParse: vi.fn(async () => {}) }));

vi.mock('../src/jobs/queues.js', () => ({ enqueuePdfParse }));

import { prisma, withTenantScope } from '../src/prisma/client.js';
import {
  createShiftReport,
  getShiftReportDetail,
  processShiftReport,
} from '../src/services/shiftReport.service.js';
import { getDashboardSummary } from '../src/services/dashboard.service.js';
import { buildTextPdf } from './helpers/pdf.js';
import { NOT_A_REPORT_LINES, TIDY_REPORT_LINES } from './helpers/fixtures.js';

/**
 * The mirror of the tidy fixture: more cash recorded than was sold.
 *
 * Deliberately the same magnitude as TIDY's variance, so a total that nets the two
 * directions cancels to exactly zero and the test can catch it doing so.
 */
const OVER_COLLECTED_LINES = [
  'PETRONITE FUEL STATION',
  'SHIFT REPORT',
  'Station: Main Station',
  'Date: 15/03/2026',
  'Shift: Night',
  'TOTALIZER SALES ................ 10,000,000',
  'CASH COLLECTED ................. 13,000,000',
  'ATTENDANTS',
  'JOHN MWAKA ....... 10,000,000 13,000,000',
  'TANK DIP',
  'TANK 1 PMS 12,000 11,500',
];

/**
 * Rewrites a fixture's date line to `daysAgo` before today.
 *
 * The shared fixtures carry fixed dates in March 2026, which is in the past. A dashboard
 * window is anchored to now, so using them unchanged would put every report outside the
 * period and the tests would pass by describing an empty dashboard. The period arithmetic
 * is exactly what is under test here, so the dates have to move with the clock.
 */
function datedDaysAgo(lines: string[], daysAgo: number): string[] {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const stamp = [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');

  return lines.map((line) => (line.startsWith('Date: ') ? `Date: ${stamp}` : line));
}

/** How old the two reconciled shifts are, in days. Both inside a 30-day window. */
const SHORT_SHIFT_AGE = 3;
const OVER_SHIFT_AGE = 2;

let storageDir: string;
let tenantId: string;
let stationA: string;
let stationB: string;

async function uploadAndProcess(lines: string[], stationId: string, fileName: string): Promise<string> {
  const { id } = await withTenantScope(tenantId, () =>
    createShiftReport({ tenantId, stationId, fileName, data: buildTextPdf(lines) })
  );
  await withTenantScope(tenantId, () => processShiftReport(id, tenantId));
  return id;
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'fuelflow-dashboard-'));
  process.env.STORAGE_DIR = storageDir;

  const tenant = await prisma.tenant.create({ data: { name: 'Dashboard Test Tenant' } });
  tenantId = tenant.id;

  const a = await prisma.station.create({ data: { tenantId, name: 'Main Station' } });
  stationA = a.id;
  const b = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  stationB = b.id;

  // The two shifts that must not cancel each other, one that never parsed, and one at a
  // station the restricted user is not assigned to.
  await uploadAndProcess(datedDaysAgo(TIDY_REPORT_LINES, SHORT_SHIFT_AGE), stationA, 'short-shift.pdf');
  await uploadAndProcess(datedDaysAgo(OVER_COLLECTED_LINES, OVER_SHIFT_AGE), stationA, 'over-shift.pdf');
  await uploadAndProcess(NOT_A_REPORT_LINES, stationA, 'not-a-report.pdf');
  await uploadAndProcess(datedDaysAgo(TIDY_REPORT_LINES, SHORT_SHIFT_AGE), stationB, 'other-station.pdf');
}, 120_000);

afterAll(async () => {
  await prisma.extractedField.deleteMany({ where: { tenantId } });
  await prisma.shiftReport.deleteMany({ where: { tenantId } });
  await prisma.station.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
}, 60_000);

describe('dashboard variance totals', () => {
  it('keeps money unaccounted for separate from money over-collected instead of netting them', async () => {
    const summary = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 90 })
    );

    // The two directions are both present and both non-zero...
    expect(summary.variance.unaccounted).toBe(3_000_000);
    expect(summary.variance.overCollected).toBe(3_000_000);

    // ...and the net still exists for context, but it is not the headline. If a future
    // change collapses these into one figure, `unaccounted` becomes 0 here and this fails.
    expect(summary.variance.net).toBe(0);
    expect(summary.variance.computed).toBe(2);
  }, 60_000);

  it('counts a report that never parsed without inventing a variance for it', async () => {
    const summary = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 90 })
    );

    expect(summary.totals.reports).toBe(3);
    expect(summary.totals.failed).toBe(1);
    expect(summary.variance.notComputed).toBe(1);

    // A failed parse has no variance, so plotting it at zero would read as a clean shift.
    expect(summary.trend).toHaveLength(2);
    expect(summary.trend.some((point) => point.status === 'FAILED')).toBe(false);
  }, 60_000);

  it('does not call a report with a flagged field "read without a flag"', async () => {
    const summary = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 90 })
    );

    // The tidy fixture parses cleanly but carries one adjustment the parser will not
    // accept without a human. That is not `readCleanly`.
    expect(summary.totals.needsReview).toBeGreaterThan(0);
    expect(summary.totals.fieldsFlagged).toBeGreaterThan(0);
    expect(summary.totals.readCleanly).toBeLessThan(summary.totals.reports);
  }, 60_000);

  it('sorts every report into exactly one state', async () => {
    const summary = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 90 })
    );

    const { readCleanly, needsReview, failed, pending, reports } = summary.totals;

    // The four counters are shown as separate cards, so a report falling outside all of
    // them would simply vanish from the dashboard without anything looking wrong.
    expect(readCleanly + needsReview + failed + pending).toBe(reports);
  }, 60_000);
  it('scopes every total to the reports the caller may see', async () => {
    const restricted = await withTenantScope(tenantId, () =>
      getDashboardSummary({ restrictToStationIds: [stationA], periodDays: 90 })
    );
    const everything = await withTenantScope(tenantId, () =>
      getDashboardSummary({ periodDays: 90 })
    );

    expect(restricted.totals.reports).toBe(3);
    expect(everything.totals.reports).toBe(4);
    expect(restricted.recent.every((row) => row.stationId === stationA)).toBe(true);
  }, 60_000);

  it('yields an empty dashboard for a user assigned to no stations', async () => {
    const none = await withTenantScope(tenantId, () =>
      getDashboardSummary({ restrictToStationIds: [], periodDays: 90 })
    );

    // An empty assignment list must mean "nothing", never "no filter".
    expect(none.totals.reports).toBe(0);
    expect(none.trend).toHaveLength(0);
    expect(none.variance.largest).toBeNull();
  }, 60_000);

  it('excludes reports whose shift date falls outside the period', async () => {
    const narrow = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 1 })
    );

    // Both reconciled shifts are dated two and three days ago, so a one-day window holds
    // neither. The failed report is still in it: its date was never read, so it falls back
    // to when it was uploaded, which is now.
    expect(narrow.totals.reports).toBe(1);
    expect(narrow.totals.failed).toBe(1);
    expect(narrow.variance.computed).toBe(0);
    expect(narrow.variance.notComputed).toBe(1);
    expect(narrow.trend).toHaveLength(0);

    // They are counted, not merely dropped: a dashboard that shows nothing to someone who
    // has just uploaded two reports needs to be able to say where they went.
    expect(narrow.totals.outsidePeriod).toBe(2);
  }, 60_000);

  it('reports the largest single variance, and its direction', async () => {
    const summary = await withTenantScope(tenantId, () =>
      getDashboardSummary({ stationId: stationA, periodDays: 90 })
    );

    const largest = summary.variance.largest;
    expect(largest).not.toBeNull();
    expect(Math.abs(largest!.variance)).toBe(3_000_000);

    // The recorded value must be one a reader can go and look at, not an aggregate wearing
    // a single report's name.
    const detail = await withTenantScope(tenantId, () => getShiftReportDetail(largest!.reportId));
    expect(detail).not.toBeNull();
    expect(detail!.summary.variance).toBe(largest!.variance);
  }, 60_000);
});
