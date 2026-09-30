/**
 * The findings sheet, against the three screens it summarises.
 *
 * This file exists because of the one property that makes the sheet worth handing to a
 * prospective customer: it must say the same thing as the dashboard, the attendants screen and
 * the wet-stock screen. The sheet is built by calling those three services, so agreement is
 * true by construction — which is exactly why it is worth asserting anyway. "By construction"
 * is a claim about code that a later refactor is free to invalidate, and the failure mode here
 * is a printed document disagreeing with the screen an owner was shown while it was being
 * written. A test is the only thing that notices.
 *
 * The figures are written straight to the tables rather than pushed through a PDF. The parser
 * has its own suite; a real file here would only add a way for this one to fail for a reason
 * that has nothing to do with what it checks.
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getFindingsSheet } from '../src/services/findings.service.js';
import { getDashboardSummary } from '../src/services/dashboard.service.js';
import { getAttendantProfiles } from '../src/services/attendantProfile.service.js';
import { getTankLeakage } from '../src/services/tankLeakage.service.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';

let tenantId: string;
let stationId: string;
let quietStationId: string;

const PERIOD_DAYS = 30;

/** Days ago, so the period filter is decided by the fixture rather than by the clock. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

interface SeedReportInput {
  station?: string;
  daysAgo: number;
  status?: 'PARSED' | 'NEEDS_REVIEW' | 'FAILED';
  fileName?: string;
  /** Pump totalizer sales. Null leaves the field off entirely. */
  sales?: number | null;
  /** Cash collected. Null leaves the field off entirely. */
  cash?: number | null;
  attendant?: { slug: string; label: string; expected: number; collected: number };
  /** `book_stock` and `closing_dip` for `TANK_1`. */
  tank?: { book: number; dip: number };
  /** Marks a figure on the report as waiting on a human, which is what makes a sheet provisional. */
  flagSales?: boolean;
}

async function seedReport(input: SeedReportInput): Promise<string> {
  const report = await prisma.shiftReport.create({
    data: {
      tenantId,
      stationId: input.station ?? stationId,
      status: input.status ?? 'PARSED',
      reportDate: daysAgo(input.daysAgo),
      pdfFileName: input.fileName ?? `shift-${input.daysAgo}.pdf`,
    },
    select: { id: true },
  });

  const fields: {
    fieldName: string;
    label: string;
    group: 'CASH_PAYMENTS' | 'ATTENDANT_RECONCILIATION' | 'TANK_READINGS';
    parsedValue: string | null;
    amount: number | null;
    needsReview: boolean;
  }[] = [];

  if (input.sales !== undefined && input.sales !== null) {
    fields.push({
      fieldName: 'pump_totalizer_sales',
      label: 'Pump totalizer sales',
      group: 'CASH_PAYMENTS',
      parsedValue: String(input.sales),
      amount: input.sales,
      needsReview: input.flagSales ?? false,
    });
  }

  if (input.cash !== undefined && input.cash !== null) {
    fields.push({
      fieldName: 'cash_collected',
      label: 'Cash collected',
      group: 'CASH_PAYMENTS',
      parsedValue: String(input.cash),
      amount: input.cash,
      needsReview: false,
    });
  }

  if (input.attendant) {
    fields.push(
      {
        fieldName: `attendant:${input.attendant.slug}:expected`,
        label: `${input.attendant.label} - to collect`,
        group: 'ATTENDANT_RECONCILIATION',
        parsedValue: String(input.attendant.expected),
        amount: input.attendant.expected,
        needsReview: false,
      },
      {
        fieldName: `attendant:${input.attendant.slug}:collected`,
        label: `${input.attendant.label} - collected`,
        group: 'ATTENDANT_RECONCILIATION',
        parsedValue: String(input.attendant.collected),
        amount: input.attendant.collected,
        needsReview: false,
      }
    );
  }

  if (input.tank) {
    fields.push(
      {
        fieldName: 'tank:TANK_1:book_stock',
        label: 'Tank 1 book stock',
        group: 'TANK_READINGS',
        parsedValue: String(input.tank.book),
        amount: input.tank.book,
        needsReview: false,
      },
      {
        fieldName: 'tank:TANK_1:closing_dip',
        label: 'Tank 1 closing dip',
        group: 'TANK_READINGS',
        parsedValue: String(input.tank.dip),
        amount: input.tank.dip,
        needsReview: false,
      }
    );
  }

  if (fields.length > 0) {
    await prisma.extractedField.createMany({
      data: fields.map((field) => ({
        tenantId,
        shiftReportId: report.id,
        confidence: 'HIGH' as const,
        ...field,
      })),
    });
  }

  return report.id;
}

beforeAll(async () => {
  await resetDatabase();

  const tenant = await prisma.tenant.create({ data: { name: 'Findings Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({
    data: { tenantId, name: 'Main Station', location: 'Dar es Salaam', varianceThreshold: 100_000 },
  });
  stationId = station.id;

  const quiet = await prisma.station.create({ data: { tenantId, name: 'Quiet Station' } });
  quietStationId = quiet.id;

  await prisma.tank.create({
    data: {
      tenantId,
      stationId,
      name: 'Tank 1',
      slug: 'TANK_1',
      capacityLitres: 20_000,
      leakThresholdLitres: 50,
    },
  });
  await prisma.attendant.create({
    data: { tenantId, stationId, name: 'John Mwaka', slug: 'JOHN_MWAKA' },
  });

  // Short by 100,000. The worst shift, and the one the headline is about.
  await seedReport({
    daysAgo: 3,
    sales: 5_000_000,
    cash: 4_900_000,
    attendant: { slug: 'JOHN_MWAKA', label: 'John Mwaka', expected: 5_000_000, collected: 4_950_000 },
    tank: { book: 10_000, dip: 9_900 },
  });

  // Over-collected by 50,000 — the figure that must not simply net against the one above.
  await seedReport({ daysAgo: 2, sales: 3_000_000, cash: 3_050_000 });

  // Nothing readable at all. It counts as a report and in no money figure.
  await seedReport({ daysAgo: 1, status: 'FAILED', fileName: 'unreadable.pdf' });
}, 60_000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('getFindingsSheet', () => {
  it('carries the money figures the dashboard reports, to the shilling', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });
    const dashboard = await getDashboardSummary({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.money.reports).toBe(dashboard.totals.reports);
    expect(sheet.money.shiftsCompared).toBe(dashboard.variance.computed);
    expect(sheet.money.unaccounted).toBe(dashboard.variance.unaccounted);
    expect(sheet.money.overCollected).toBe(dashboard.variance.overCollected);
    expect(sheet.money.net).toBe(dashboard.variance.net);
    expect(sheet.money.flaggedFields).toBe(dashboard.totals.fieldsFlagged);
    expect(sheet.money.failedReports).toBe(dashboard.totals.failed);
    expect(sheet.money.largest).toEqual(dashboard.variance.largest);
  });

  it('carries the attendant profiles the attendants screen reports', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });
    const profiles = await getAttendantProfiles({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.attendants).toEqual(profiles.attendants);
    expect(sheet.totals.attendants).toEqual(profiles.totals);
    expect(sheet.unattributed.attendants).toEqual(profiles.unmapped);
  });

  it('carries the tanks the wet-stock screen reports', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });
    const leakage = await getTankLeakage({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.tanks).toEqual(leakage.tanks);
    expect(sheet.totals.tanks).toEqual(leakage.totals);
    expect(sheet.unattributed.tanks).toEqual(leakage.unmapped);
  });

  it('keeps the short and over-collected shifts apart, rather than netting them away', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.money.unaccounted).toBe(100_000);
    expect(sheet.money.overCollected).toBe(50_000);
    expect(sheet.money.net).toBe(50_000);
    expect(sheet.money.shiftsCompared).toBe(2);
    expect(sheet.money.reports).toBe(3);
    expect(sheet.money.failedReports).toBe(1);
  });

  it('lists every shift in the period, oldest first, with a null rather than a zero for an unreadable one', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.shifts).toHaveLength(3);
    expect(sheet.shifts.map((row) => row.fileName)).toEqual([
      'shift-3.pdf',
      'shift-2.pdf',
      'unreadable.pdf',
    ]);
    expect(sheet.shifts.map((row) => row.variance)).toEqual([100_000, -50_000, null]);
    expect(sheet.shifts.map((row) => row.status)).toEqual(['PARSED', 'PARSED', 'FAILED']);
  });

  it('has a per-shift table that adds up to the money total beside it', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });

    const summed = sheet.shifts.reduce((total, row) => total + (row.variance ?? 0), 0);

    // The two halves of the document are built by different code paths — the totals by the
    // dashboard service, the table by this one's own query — so this is the assertion that
    // catches the day one of them starts filtering differently from the other.
    expect(summed).toBe(sheet.money.net);
  });

  it('states the money figure in the headline, in the same words the table uses', async () => {
    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.headlines[0]).toContain('TZS 50,000');
    expect(sheet.headlines[0]).toContain('2 reconciled shifts');
    expect(sheet.headlines.join(' ')).toContain('1 report could not be read');
  });

  it('says a station is clean rather than saying nothing, when it is clean', async () => {
    // A blank findings sheet and a clean one look identical, and they are opposite findings.
    // The document that goes to a prospective customer is the one place that distinction has
    // to survive.
    const sheet = await getFindingsSheet({ stationId: quietStationId, periodDays: PERIOD_DAYS });

    expect(sheet.money.reports).toBe(0);
    expect(sheet.headlines[0]).toContain('No shift reports were uploaded');
    expect(sheet.provisional).toBe(false);
    expect(sheet.shifts).toEqual([]);
  });

  it('refuses a station that is not in this tenant', async () => {
    // Only reachable through the service rather than the route, which rejects it first. The
    // check is here as well because the service is the thing that would leak another tenant's
    // figures if the route's guard were ever refactored away.
    await expect(getFindingsSheet({ stationId: 'not-a-station', periodDays: PERIOD_DAYS })).rejects.toThrow(
      /Station not found/i
    );
  });
});

describe('getFindingsSheet, provisionality', () => {
  it('marks the whole document when any figure under it may still move', async () => {
    const flagged = await seedReport({
      daysAgo: 1,
      sales: 1_000_000,
      cash: 1_000_000,
      flagSales: true,
    });

    const sheet = await getFindingsSheet({ stationId, periodDays: PERIOD_DAYS });

    expect(sheet.provisional).toBe(true);
    expect(sheet.money.flaggedFields).toBeGreaterThan(0);
    expect(sheet.headlines.join(' ')).toContain('still has to be checked by a person');

    // The shift is in the table with the flag counted against it, so a reader can find the
    // figure the warning is about rather than being told to go and look.
    const row = sheet.shifts.find((entry) => entry.reportId === flagged);
    expect(row?.flaggedFields).toBe(1);

    await prisma.extractedField.deleteMany({ where: { shiftReportId: flagged } });
    await prisma.shiftReport.delete({ where: { id: flagged } });
  });

  it('does not call a document provisional on the strength of a clean period', async () => {
    const sheet = await getFindingsSheet({ stationId: quietStationId, periodDays: PERIOD_DAYS });

    expect(sheet.provisional).toBe(false);
  });
});
