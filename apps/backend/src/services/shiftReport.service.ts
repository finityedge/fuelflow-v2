/**
 * Shift report upload, parsing and review.
 *
 * Three rules shape this file:
 *
 *  1. Uploading never waits on parsing. The row is created and the job queued, so a
 *     manager on a slow connection gets their report ID back in the time it takes to
 *     transfer the file.
 *  2. A parse that half-works is recorded as half-working, field by field. Nothing here
 *     collapses a partial result into a failure.
 *  3. The reconciliation figures are always recomputed from the stored fields, never read
 *     back from the parse output, so a correction immediately moves the headline number.
 */

import { randomUUID } from 'node:crypto';
import type {
  ExtractedField as ExtractedFieldRow,
  Prisma,
  ShiftReport as ShiftReportRow,
} from '@prisma/client';
import type {
  ReconciliationSummary,
  ShiftReportDetail,
  ShiftReportListItem,
  ShiftReportState,
} from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { readPdf, savePdf } from '../config/storage.js';
import { enqueuePdfParse } from '../jobs/queues.js';
import { extractPdfText } from '../parsing/pdfText.js';
import { computeSummary, parseShiftReportText } from '../parsing/petronite.js';
import { parseAmount } from '../parsing/amount.js';
import type { ParseResult } from '../parsing/types.js';

export interface CreateShiftReportInput {
  tenantId: string;
  stationId: string;
  fileName: string;
  data: Buffer;
}

export interface CreateShiftReportResult {
  id: string;
  status: string;
  /** Set when the report was stored but could not be queued for parsing. */
  queueWarning: string | null;
}

/** The parse never blocks the upload: the row exists first, the job is queued second. */
export async function createShiftReport(input: CreateShiftReportInput): Promise<CreateShiftReportResult> {
  const id = randomUUID();
  const storageKey = `${input.tenantId}/${id}.pdf`;

  await savePdf(storageKey, input.data);

  await prisma.shiftReport.create({
    data: {
      id,
      tenantId: input.tenantId,
      stationId: input.stationId,
      status: 'PENDING',
      pdfFileUrl: storageKey,
      pdfFileName: input.fileName,
    },
  });

  let queueWarning: string | null = null;
  try {
    await enqueuePdfParse({ shiftReportId: id, tenantId: input.tenantId });
  } catch (error) {
    // The PDF is safely stored and the row exists, so this is recoverable: the manager
    // gets a report they can retry rather than an upload that vanished.
    queueWarning = 'The report was uploaded but could not be queued for parsing.';
    console.error('Failed to enqueue PDF parse job', { shiftReportId: id, error });
  }

  return { id, status: 'PENDING', queueWarning };
}

/**
 * Extract the text, parse it, and record the outcome.
 *
 * Runs outside any request, so it opens its own tenant scope and tolerates being run
 * twice for the same report: existing fields are replaced rather than appended.
 */
export async function processShiftReport(shiftReportId: string, tenantId: string): Promise<void> {
  const report = await prisma.shiftReport.findUnique({ where: { id: shiftReportId } });
  if (!report || report.tenantId !== tenantId) {
    throw new Error(`Shift report ${shiftReportId} not found for tenant ${tenantId}`);
  }

  let parseResult: ParseResult;
  try {
    if (!report.pdfFileUrl) {
      throw new Error('No uploaded file is recorded for this report.');
    }
    const text = await extractPdfText(await readPdf(report.pdfFileUrl));
    parseResult = parseShiftReportText(text);
  } catch (error) {
    // Anything thrown here is about the file, not about our understanding of the
    // template, so the message goes to the manager as-is.
    const reason = error instanceof Error ? error.message : 'The uploaded file could not be read.';
    await prisma.shiftReport.update({
      where: { id: shiftReportId },
      data: {
        status: 'FAILED',
        failureReason: reason,
      },
    });
    await prisma.extractedField.deleteMany({ where: { shiftReportId } });
    return;
  }

  const reportDate = parseResult.reportDate ? new Date(`${parseResult.reportDate}T00:00:00.000Z`) : null;

  await prisma.$transaction([
    prisma.extractedField.deleteMany({ where: { shiftReportId } }),
    prisma.extractedField.createMany({
      data: parseResult.fields.map((field) => ({
        shiftReportId,
        tenantId,
        fieldName: field.fieldName,
        label: field.label,
        group: field.group,
        rawValue: field.rawValue,
        parsedValue: field.parsedValue,
        amount: field.amount,
        confidence: field.confidence,
        needsReview: field.needsReview,
        reviewNote: field.reviewNote,
        regionText: field.regionText,
      })),
    }),
    prisma.shiftReport.update({
      where: { id: shiftReportId },
      data: {
        status: parseResult.status,
        reportDate,
        // A report that failed must not keep a stale reason from an earlier attempt.
        failureReason: parseResult.failureReason,
        parsedData: {
          summary: parseResult.summary,
          diagnostics: parseResult.diagnostics,
          fieldCount: parseResult.fields.length,
        },
      },
    }),
  ]);
}

/** Recompute the status from the fields, so it always reflects what a human has cleared. */
async function refreshReportStatus(shiftReportId: string): Promise<void> {
  const [total, pending] = await Promise.all([
    prisma.extractedField.count({ where: { shiftReportId } }),
    prisma.extractedField.count({ where: { shiftReportId, needsReview: true } }),
  ]);

  if (total === 0) {
    return;
  }

  await prisma.shiftReport.update({
    where: { id: shiftReportId },
    data: { status: pending > 0 ? 'NEEDS_REVIEW' : 'PARSED' },
  });
}

export async function getShiftReportDetail(shiftReportId: string): Promise<ShiftReportDetail | null> {
  const report = await prisma.shiftReport.findUnique({
    where: { id: shiftReportId },
    include: {
      station: { select: { name: true } },
      extractedFields: {
        orderBy: [{ group: 'asc' }, { fieldName: 'asc' }],
      },
    },
  });

  if (!report) {
    return null;
  }

  const { station, extractedFields, ...rest } = report;

  const summary = computeSummary(
    extractedFields.map((field) => ({
      fieldName: field.fieldName,
      label: field.label,
      group: field.group,
      rawValue: field.rawValue,
      parsedValue: field.parsedValue,
      amount: field.amount,
      confidence: field.confidence,
      needsReview: field.needsReview,
      reviewNote: field.reviewNote,
      regionText: field.regionText,
    }))
  );

  return {
    report: { ...serializeReport(rest), stationName: station?.name ?? null },
    fields: extractedFields.map(serializeField),
    summary,
    needsReviewCount: extractedFields.filter((field) => field.needsReview).length,
  };
}

export interface ListShiftReportsOptions {
  /** One station, already access-checked by the route. */
  stationId?: string;
  /**
   * The stations this user may see. `undefined` means every station in the tenant (an
   * owner); an empty array means none, and must yield no reports rather than all of them —
   * `in: []` matches nothing, which is the right answer.
   */
  restrictToStationIds?: string[];
  status?: ShiftReportState;
  /** Inclusive ISO days, matched against the report's own date. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/**
 * The date a report belongs to: the shift's own date, or the upload date when the parser
 * never read one.
 *
 * Written as an `OR` rather than a `COALESCE` because that is the form Prisma can push
 * into SQL, and it is kept in the database rather than applied after loading so that the
 * count below covers exactly the rows the page will show. A report uploaded today can
 * carry a date from last month, so the two are genuinely different questions and the
 * report's own date is the one that answers "which shift is this".
 *
 * The bounds are UTC midnights, which is not arbitrary: `reportDate` is written as UTC
 * midnight when the parse succeeds, and the API hands its day back as a UTC day key, so a
 * `from`/`to` pair matches those days exactly. The `uploadedAt` branch is a real timestamp
 * and so only approximately bounded — it exists for reports whose date was never read, and
 * being a few hours out at the edge of a range there is not worth a timezone this app does
 * not have.
 */
function dayRangeFilter(from?: string, to?: string): Prisma.ShiftReportWhereInput[] {
  if (!from && !to) {
    return [];
  }

  const start = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
  // The end of the day named, not the start of it: "to 20 September" that excluded
  // everything uploaded on the 20th would be a filter nobody meant to apply.
  const end = to ? new Date(`${to}T23:59:59.999Z`) : undefined;
  const bounds = {
    ...(start ? { gte: start } : {}),
    ...(end ? { lte: end } : {}),
  };

  return [
    { reportDate: bounds },
    { reportDate: null, uploadedAt: bounds },
  ];
}

/**
 * One page of the reports list.
 *
 * The tenant is not filtered here on purpose — the Prisma client extension in
 * `prisma/client.ts` adds it to every `ShiftReport` query, reads included, so a `tenantId`
 * in this `where` would be the same clause written twice. What *is* here is the station
 * filter, which the extension knows nothing about, and it is applied in the query rather
 * than to the result because the count below has to be the count of rows this person can
 * see. A page filtered after being cut short shows fewer rows than it claims to.
 */
export async function listShiftReports(
  options: ListShiftReportsOptions
): Promise<{ reports: ShiftReportListItem[]; total: number }> {
  const dayRange = dayRangeFilter(options.from, options.to);

  const where: Prisma.ShiftReportWhereInput = {
    ...(options.stationId
      ? { stationId: options.stationId }
      : options.restrictToStationIds
        ? { stationId: { in: options.restrictToStationIds } }
        : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(dayRange.length > 0 ? { OR: dayRange } : {}),
  };

  // Only the columns the row renders and the three the reconciliation reads. The list
  // never shows a label or a region's text, and on a page of a hundred rows that is a lot
  // of payload to send for nothing.
  const [reports, total] = await Promise.all([
    prisma.shiftReport.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      take: options.limit ?? 25,
      skip: options.offset ?? 0,
      select: {
        id: true,
        stationId: true,
        pdfFileName: true,
        reportDate: true,
        status: true,
        uploadedAt: true,
        failureReason: true,
        station: { select: { name: true } },
        extractedFields: { select: { fieldName: true, amount: true, needsReview: true } },
      },
    }),
    prisma.shiftReport.count({ where }),
  ]);

  const rows = reports.map((report) => {
    const summary = computeSummary(report.extractedFields);

    return {
      id: report.id,
      stationId: report.stationId,
      stationName: report.station?.name ?? null,
      fileName: report.pdfFileName,
      reportDate: report.reportDate ? report.reportDate.toISOString().slice(0, 10) : null,
      status: report.status,
      uploadedAt: report.uploadedAt.toISOString(),
      failureReason: report.failureReason,
      needsReviewCount: report.extractedFields.filter((field) => field.needsReview).length,
      summary,
    };
  });

  return { reports: rows, total };
}

/**
 * Record a manager's correction to one field.
 *
 * Clearing the review flag is the point of the action, not a side effect: the field has
 * now been looked at by a human, which is exactly what the flag was asking for.
 */
export async function correctExtractedField(
  fieldId: string,
  input: { parsedValue: string },
  userId: string
): Promise<{ field: ReturnType<typeof serializeField>; status: string } | null> {
  const existing = await prisma.extractedField.findUnique({ where: { id: fieldId } });
  if (!existing) {
    return null;
  }

  const amount = parseAmount(input.parsedValue);

  const updated = await prisma.extractedField.update({
    where: { id: fieldId },
    data: {
      parsedValue: input.parsedValue,
      amount,
      // A human has now read this figure, so it is authoritative.
      confidence: 'HIGH',
      needsReview: false,
      reviewNote: null,
      correctedAt: new Date(),
      correctedBy: userId,
    },
  });

  await refreshReportStatus(existing.shiftReportId);

  const report = await prisma.shiftReport.findUnique({
    where: { id: existing.shiftReportId },
    select: { status: true },
  });

  return { field: serializeField(updated), status: report?.status ?? 'PENDING' };
}

/** Queue another parse attempt for a stored report — the retry path after a failure. */
export async function reparseShiftReport(shiftReportId: string, tenantId: string): Promise<boolean> {
  const report = await prisma.shiftReport.findUnique({ where: { id: shiftReportId } });
  if (!report || !report.pdfFileUrl) {
    return false;
  }

  await prisma.shiftReport.update({
    where: { id: shiftReportId },
    data: { status: 'PENDING', failureReason: null },
  });

  await enqueuePdfParse({ shiftReportId, tenantId });
  return true;
}

function serializeReport(report: ShiftReportRow) {
  return {
    id: report.id,
    tenantId: report.tenantId,
    stationId: report.stationId,
    reportDate: report.reportDate ? report.reportDate.toISOString().slice(0, 10) : null,
    status: report.status,
    pdfFileUrl: report.pdfFileUrl,
    pdfFileName: report.pdfFileName,
    uploadedAt: report.uploadedAt.toISOString(),
    failureReason: report.failureReason,
    parsedData: (report.parsedData as Record<string, unknown> | null) ?? null,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
  };
}

function serializeField(field: ExtractedFieldRow) {
  return {
    id: field.id,
    shiftReportId: field.shiftReportId,
    tenantId: field.tenantId,
    fieldName: field.fieldName,
    label: field.label,
    group: field.group,
    rawValue: field.rawValue,
    parsedValue: field.parsedValue,
    amount: field.amount,
    confidence: field.confidence,
    needsReview: field.needsReview,
    reviewNote: field.reviewNote,
    regionText: field.regionText,
    correctedAt: field.correctedAt ? field.correctedAt.toISOString() : null,
    correctedBy: field.correctedBy,
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString(),
  };
}

export type { ReconciliationSummary };
