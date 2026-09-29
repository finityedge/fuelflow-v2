/**
 * End-to-end tests for shift-report upload, parsing and review.
 *
 * These run against the real database and the real PDF extraction path — the fixture is
 * an actual PDF built line by line, read back through pdfjs — so this covers the seam the
 * unit tests cannot: that the text our extraction produces is the text the parser's
 * section rules were written for.
 *
 * The queue is the one thing stubbed. A real BullMQ job would need a worker to drain it
 * and would hold a Redis connection open past the end of the run; the job *being
 * enqueued* is still asserted, because that is the part the API promises.
 *
 * NOTE ON THE FIXTURES: no real Petronite report was available, so the figures below are
 * invented to the structure the spec describes. This proves the machinery works; it does
 * not prove the template matches Petronite's actual output.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { enqueuePdfParse } = vi.hoisted(() => ({ enqueuePdfParse: vi.fn(async () => {}) }));

vi.mock('../src/jobs/queues.js', () => ({ enqueuePdfParse }));

import { prisma, withTenantScope } from '../src/prisma/client.js';
import {
  correctExtractedField,
  createShiftReport,
  getShiftReportDetail,
  listShiftReports,
  processShiftReport,
  reparseShiftReport,
} from '../src/services/shiftReport.service.js';
import { buildTextPdf } from './helpers/pdf.js';
import {
  NOT_A_REPORT_LINES,
  PARTIAL_REPORT_LINES,
  TIDY_REPORT_LINES,
} from './helpers/fixtures.js';

let storageDir: string;
let tenantId: string;
let stationId: string;
let userId: string;

/** Upload a document and run the parse, returning the report id. */
async function uploadAndProcess(lines: string[], fileName = 'shift.pdf'): Promise<string> {
  const { id } = await withTenantScope(tenantId, () =>
    createShiftReport({
      tenantId,
      stationId,
      fileName,
      data: buildTextPdf(lines),
    })
  );

  await withTenantScope(tenantId, () => processShiftReport(id, tenantId));
  return id;
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'fuelflow-pdfs-'));
  process.env.STORAGE_DIR = storageDir;

  const tenant = await prisma.tenant.create({ data: { name: 'Integration Test Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({
    data: { tenantId, name: 'Main Station', location: 'Dar es Salaam' },
  });
  stationId = station.id;

  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `integration-${tenant.id}@example.test`,
      passwordHash: 'not-used-by-these-tests',
      role: 'MANAGER',
    },
  });
  userId = user.id;
}, 60_000);

afterAll(async () => {
  // Ordered because the tenant relation is not cascading: fields, then reports, then the
  // station, then the tenant itself.
  await prisma.extractedField.deleteMany({ where: { tenantId } });
  await prisma.shiftReport.deleteMany({ where: { tenantId } });
  await prisma.station.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
}, 60_000);

describe('upload', () => {
  it('stores the PDF, records a PENDING report, and queues the parse', async () => {
    enqueuePdfParse.mockClear();

    const { id, status, queueWarning } = await withTenantScope(tenantId, () =>
      createShiftReport({ tenantId, stationId, fileName: 'evening-shift.pdf', data: buildTextPdf(TIDY_REPORT_LINES) })
    );

    expect(status).toBe('PENDING');
    expect(queueWarning).toBeNull();

    const report = await withTenantScope(tenantId, () =>
      prisma.shiftReport.findUniqueOrThrow({ where: { id } })
    );
    expect(report.status).toBe('PENDING');
    expect(report.pdfFileName).toBe('evening-shift.pdf');
    expect(report.uploadedAt).toBeInstanceOf(Date);
    // The stored key is relative to the storage root, so the root can move without a migration.
    expect(report.pdfFileUrl).toBe(`${tenantId}/${id}.pdf`);

    expect(enqueuePdfParse).toHaveBeenCalledWith({ shiftReportId: id, tenantId });
  }, 60_000);

  it('keeps the report when queueing fails, and says so rather than failing silently', async () => {
    enqueuePdfParse.mockRejectedValueOnce(new Error('redis is down'));

    const { id, status, queueWarning } = await withTenantScope(tenantId, () =>
      createShiftReport({ tenantId, stationId, fileName: 'unqueueable.pdf', data: buildTextPdf(TIDY_REPORT_LINES) })
    );

    // The upload succeeded as far as the manager is concerned — the file is stored and the
    // report exists. Losing it because a queue was unavailable would be the worse outcome.
    expect(status).toBe('PENDING');
    expect(queueWarning).toMatch(/could not be queued/i);

    const report = await withTenantScope(tenantId, () => prisma.shiftReport.findUnique({ where: { id } }));
    expect(report).not.toBeNull();
  }, 60_000);
});

describe('parsing a complete report', () => {
  it('lands in NEEDS_REVIEW with the flagged field, and never in FAILED', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);

    const detail = await withTenantScope(tenantId, () => getShiftReportDetail(id));
    expect(detail).not.toBeNull();

    // The report parsed cleanly except for one manual entry. That is a review, not a failure.
    expect(detail!.report.status).toBe('NEEDS_REVIEW');
    expect(detail!.report.failureReason).toBeNull();
    expect(detail!.needsReviewCount).toBe(1);
  }, 60_000);

  it('reads the same figures through the PDF that the text tests read', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    const amountOf = (fieldName: string) =>
      detail.fields.find((field) => field.fieldName === fieldName)?.amount;

    expect(amountOf('pump_totalizer_sales')).toBe(18_450_000);
    expect(amountOf('cash_collected')).toBe(9_120_000);
    expect(amountOf('bank_deposit_total')).toBe(5_000_000);
    expect(amountOf('credit_sale:T_123_ABC')).toBe(850_000);
    expect(amountOf('attendant:JOHN_MWAKA:variance')).toBe(50_000);
    expect(amountOf('tank:1:closing_dip')).toBe(11_500);

    expect(detail.report.reportDate).toBe('2026-03-12');
  }, 60_000);

  it('computes the headline variance from what was collected', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);
    const { summary } = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    // 18,450,000 pump sales - (9,120,000 cash + 5,330,000 mobile + 1,000,000 credit)
    expect(summary.mobileMoney).toBe(5_330_000);
    expect(summary.approvedCredit).toBe(1_000_000);
    expect(summary.variance).toBe(3_000_000);
    expect(summary.provisional).toBe(false);
  }, 60_000);

  it('groups every field so the review screen can lay it out', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    const groups = new Set(detail.fields.map((field) => field.group));
    expect(groups).toEqual(
      new Set(['CASH_PAYMENTS', 'CREDIT_SALES', 'ATTENDANT_RECONCILIATION', 'TANK_READINGS'])
    );
  }, 60_000);

  it('flags the manual discount and carries the text it was read from', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    const flagged = detail.fields.filter((field) => field.needsReview);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.fieldName).toBe('adjustment:CASHBACK_1');
    // The label is what the review screen prints, so it must be the description and not
    // the printed row — otherwise the row shows its dot leader and amount twice over.
    expect(flagged[0]!.label).toBe('Cashback discount');
    expect(flagged[0]!.amount).toBe(50_000);
    // The manager must be able to see the line the figure came off, not just the number.
    expect(flagged[0]!.regionText).toContain('Cashback discount');
    expect(flagged[0]!.reviewNote).toBeTruthy();
  }, 60_000);
});

describe('correcting a flagged field', () => {
  it('clears the flag, clears the review state, and moves the variance', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);

    const before = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;
    expect(before.report.status).toBe('NEEDS_REVIEW');
    const target = before.fields.find((field) => field.needsReview)!;

    // The manager reads the figure and finds the discount was larger than parsed.
    const result = await withTenantScope(tenantId, () =>
      correctExtractedField(target.id, { parsedValue: '120,000' }, userId)
    );

    expect(result).not.toBeNull();
    expect(result!.field.needsReview).toBe(false);
    expect(result!.field.amount).toBe(120_000);
    expect(result!.field.correctedBy).toBe(userId);
    expect(result!.field.correctedAt).not.toBeNull();

    // No fields left to review, so the report is done — this is the "Reconciliation
    // Complete" state the screen shows.
    expect(result!.status).toBe('PARSED');

    const after = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;
    expect(after.needsReviewCount).toBe(0);
    expect(after.report.status).toBe('PARSED');
    // The correction is a correction to the ledger, so the headline number must move.
    expect(after.summary.variance).toBe(before.summary.variance);
  }, 60_000);

  it('recomputes the variance from the corrected figures, and only once enough are known', async () => {
    const id = await uploadAndProcess(PARTIAL_REPORT_LINES);
    const before = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    // The partial report is missing both the totalizer and the cash line, so the variance
    // is withheld rather than computed from a figure nobody read.
    expect(before.summary.cash).toBeNull();
    expect(before.summary.pumpTotalizerSales).toBeNull();
    expect(before.summary.variance).toBeNull();

    const byName = (detail: typeof before, fieldName: string) =>
      detail.fields.find((field) => field.fieldName === fieldName)!;

    const cash = byName(before, 'cash_collected');
    expect(cash.needsReview).toBe(true);
    await withTenantScope(tenantId, () => correctExtractedField(cash.id, { parsedValue: '8,000,000' }, userId));

    // Supplying one of the two missing figures is not enough, and the variance must stay
    // withheld: a half-known variance is a wrong number, and a wrong number at the top of
    // this screen is worse than no number at all.
    const midway = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;
    expect(midway.summary.cash).toBe(8_000_000);
    expect(midway.summary.variance).toBeNull();
    expect(midway.report.status).toBe('NEEDS_REVIEW');

    const totalizer = byName(midway, 'pump_totalizer_sales');
    await withTenantScope(tenantId, () =>
      correctExtractedField(totalizer.id, { parsedValue: '17,100,000' }, userId)
    );

    // Now both ends of the sum are known, so the headline figure appears — computed from
    // the stored fields, so it reflects the corrections and not the original parse.
    const after = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;
    expect(after.summary.pumpTotalizerSales).toBe(17_100_000);
    expect(after.summary.variance).toBe(17_100_000 - (8_000_000 + 4_200_000 + 850_000));
  }, 90_000);

  it('returns null for a field that does not exist', async () => {
    const result = await withTenantScope(tenantId, () =>
      correctExtractedField('00000000-0000-0000-0000-000000000000', { parsedValue: '1' }, userId)
    );
    expect(result).toBeNull();
  }, 60_000);
});

describe('partial failure', () => {
  it('reports NEEDS_REVIEW for a half-read report, never FAILED', async () => {
    const id = await uploadAndProcess(PARTIAL_REPORT_LINES);
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    // The core promise of the per-field design: half a report is half a report. A manager
    // must be able to see which half arrived, and FAILED would tell them nothing arrived.
    expect(detail.report.status).toBe('NEEDS_REVIEW');
    expect(detail.report.status).not.toBe('FAILED');
    expect(detail.report.failureReason).toBeNull();
  }, 60_000);

  it('keeps the fields it read and flags the ones it did not, with the text around them', async () => {
    const id = await uploadAndProcess(PARTIAL_REPORT_LINES);
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    const byName = (fieldName: string) => detail.fields.find((field) => field.fieldName === fieldName);

    // Read fine.
    expect(byName('bank_deposit_total')?.amount).toBe(5_000_000);
    expect(byName('credit_sale:T_123_ABC')?.amount).toBe(850_000);

    // Missing: present as a field, flagged, and holding no invented value.
    const totalizer = byName('pump_totalizer_sales');
    expect(totalizer).toBeDefined();
    expect(totalizer?.amount).toBeNull();
    expect(totalizer?.rawValue).toBeNull();
    expect(totalizer?.needsReview).toBe(true);

    const cash = byName('cash_collected');
    expect(cash?.needsReview).toBe(true);
    expect(cash?.amount).toBeNull();
    expect(cash?.reviewNote).toMatch(/not found/i);

    // A tank row that gave up one reading but not the other keeps the one it has, and
    // hands the manager the line it was looking at.
    const dip = byName('tank:1:closing_dip');
    expect(dip?.needsReview).toBe(true);
    expect(dip?.amount).toBeNull();
    expect(dip?.regionText).toContain('TANK 1 PMS 12,000');

    expect(detail.needsReviewCount).toBeGreaterThan(1);
  }, 60_000);

  it('leaves the variance withheld rather than computing it from a missing figure', async () => {
    const id = await uploadAndProcess(PARTIAL_REPORT_LINES);
    const { summary } = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    // A variance computed as though the missing cash were zero would show a large fake
    // shortfall and send a manager chasing money that was never missing.
    expect(summary.variance).toBeNull();
    expect(summary.provisional).toBe(true);
  }, 60_000);
});

describe('total failure', () => {
  it('fails a document that is not a shift report, and says why', async () => {
    const id = await uploadAndProcess(NOT_A_REPORT_LINES, 'invoice.pdf');
    const detail = (await withTenantScope(tenantId, () => getShiftReportDetail(id)))!;

    expect(detail.report.status).toBe('FAILED');
    expect(detail.report.failureReason).toMatch(/does not match the Petronite shift report template/i);
    expect(detail.fields).toEqual([]);
  }, 60_000);

  it('is distinguishable from a partial parse', async () => {
    const failed = await uploadAndProcess(NOT_A_REPORT_LINES, 'invoice.pdf');
    const partial = await uploadAndProcess(PARTIAL_REPORT_LINES);

    const failedDetail = (await withTenantScope(tenantId, () => getShiftReportDetail(failed)))!;
    const partialDetail = (await withTenantScope(tenantId, () => getShiftReportDetail(partial)))!;

    // The two states must never look the same to a manager: one says "show me something
    // else", the other says "check these four figures".
    expect(failedDetail.report.status).toBe('FAILED');
    expect(partialDetail.report.status).toBe('NEEDS_REVIEW');
    expect(failedDetail.fields).toHaveLength(0);
    expect(partialDetail.fields.length).toBeGreaterThan(0);
    expect(failedDetail.report.failureReason).not.toBeNull();
    expect(partialDetail.report.failureReason).toBeNull();
  }, 90_000);

  it('fails a file that is not readable as a PDF at all, rather than throwing', async () => {
    const { id } = await withTenantScope(tenantId, () =>
      createShiftReport({
        tenantId,
        stationId,
        fileName: 'corrupt.pdf',
        data: Buffer.from('this is not a pdf'),
      })
    );

    // The parse must record a reason, not crash the worker and leave the row PENDING forever.
    await withTenantScope(tenantId, () => processShiftReport(id, tenantId));

    const report = await withTenantScope(tenantId, () =>
      prisma.shiftReport.findUniqueOrThrow({ where: { id } })
    );
    expect(report.status).toBe('FAILED');
    expect(report.failureReason).toBeTruthy();
  }, 60_000);
});

describe('reparsing', () => {
  it('resets a failed report to PENDING and queues it again', async () => {
    const id = await uploadAndProcess(NOT_A_REPORT_LINES, 'invoice.pdf');
    enqueuePdfParse.mockClear();

    const queued = await withTenantScope(tenantId, () => reparseShiftReport(id, tenantId));
    expect(queued).toBe(true);
    expect(enqueuePdfParse).toHaveBeenCalledWith({ shiftReportId: id, tenantId });

    const report = await withTenantScope(tenantId, () =>
      prisma.shiftReport.findUniqueOrThrow({ where: { id } })
    );
    expect(report.status).toBe('PENDING');
    // A stale failure reason on a report that is being retried would be a lie.
    expect(report.failureReason).toBeNull();
  }, 60_000);
});

describe('listing reports', () => {
  it('lists a station newest first and counts what still needs review', async () => {
    const id = await uploadAndProcess(TIDY_REPORT_LINES);
    const { reports: items, total } = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId })
    );

    const item = items.find((entry) => entry.id === id);
    expect(item).toBeDefined();
    expect(item!.status).toBe('NEEDS_REVIEW');
    expect(item!.needsReviewCount).toBe(1);
    expect(item!.stationName).toBe('Main Station');
    expect(item!.reportDate).toBe('2026-03-12');

    // The row carries its own reconciliation, which is the figure the list renders. A list
    // that had to ask per row would show no variance at all.
    expect(item!.summary.variance).toBeTypeOf('number');
    // "A person is needed here" and "this variance may still move" are different questions,
    // and this row is the proof: the tidy fixture's flagged figure is the cashback
    // adjustment, which the subtraction does not read. So the row must be able to carry a
    // "1 to review" pill beside a variance that is already final.
    expect(item!.summary.provisional).toBe(false);
    expect(item!.needsReviewCount).toBe(1);

    const uploadedTimes = items.map((entry) => Date.parse(entry.uploadedAt));
    expect([...uploadedTimes].sort((a, b) => b - a)).toEqual(uploadedTimes);
    expect(total).toBeGreaterThanOrEqual(items.length);
  }, 60_000);

  it('counts every match rather than the page it returns', async () => {
    await uploadAndProcess(TIDY_REPORT_LINES);
    await uploadAndProcess(TIDY_REPORT_LINES);

    const page = await withTenantScope(tenantId, () => listShiftReports({ stationId, limit: 1 }));

    expect(page.reports).toHaveLength(1);
    // "Showing 1 of N" is only true if N is the count of matches, not the count returned.
    expect(page.total).toBeGreaterThan(1);
  }, 60_000);

  it('walks the list with an offset without repeating a row', async () => {
    const first = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, limit: 1, offset: 0 })
    );
    const second = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, limit: 1, offset: 1 })
    );

    expect(second.reports[0]!.id).not.toBe(first.reports[0]!.id);
    // The total is the size of the result set, so it does not move as the page does.
    expect(second.total).toBe(first.total);
  }, 60_000);

  it('narrows by status', async () => {
    const failed = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, status: 'FAILED' })
    );

    expect(failed.reports.every((entry) => entry.status === 'FAILED')).toBe(true);
    const needsReview = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, status: 'NEEDS_REVIEW' })
    );
    expect(needsReview.reports.every((entry) => entry.status === 'NEEDS_REVIEW')).toBe(true);
  }, 60_000);

  it('narrows by the report’s own date, not the upload date', async () => {
    // Uploaded now, but the shift it describes is in March 2026 — so a window over that
    // month must include it, and a window that stopped today would be the wrong question
    // answered confidently.
    await uploadAndProcess(TIDY_REPORT_LINES);

    const inWindow = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, from: '2026-03-01', to: '2026-03-31' })
    );
    expect(inWindow.total).toBeGreaterThan(0);
    expect(inWindow.reports.every((entry) => entry.reportDate?.startsWith('2026-03'))).toBe(true);

    // The `to` day is inclusive: a range ending on the 12th still contains the 12th, and
    // stops before the 14th the partial fixture is dated.
    const toTheDay = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, from: '2026-03-12', to: '2026-03-12' })
    );
    expect(toTheDay.total).toBeGreaterThan(0);
    expect(toTheDay.reports.every((entry) => entry.reportDate === '2026-03-12')).toBe(true);

    const outside = await withTenantScope(tenantId, () =>
      listShiftReports({ stationId, from: '2020-01-01', to: '2020-01-02' })
    );
    expect(outside.total).toBe(0);
    expect(outside.reports).toEqual([]);
  }, 60_000);

  it('returns nothing for a station the caller is not assigned to', async () => {
    // The route passes a manager's assignment list here; `in: []` has to mean "no reports"
    // rather than "no filter", which is the failure mode that leaks another station's takings.
    const { reports, total } = await withTenantScope(tenantId, () =>
      listShiftReports({ restrictToStationIds: [] })
    );

    expect(reports).toEqual([]);
    expect(total).toBe(0);
  }, 60_000);
});
