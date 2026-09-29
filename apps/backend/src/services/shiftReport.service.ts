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
  ShiftReport as ShiftReportRow,
} from '@prisma/client';
import type { ReconciliationSummary, ShiftReportDetail, ShiftReportListItem } from '@fuelflow/shared';
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

export async function listShiftReports(options: {
  stationId?: string;
  limit?: number;
}): Promise<ShiftReportListItem[]> {
  const reports = await prisma.shiftReport.findMany({
    where: options.stationId ? { stationId: options.stationId } : undefined,
    orderBy: { uploadedAt: 'desc' },
    take: options.limit ?? 25,
    include: {
      station: { select: { name: true } },
      _count: { select: { extractedFields: { where: { needsReview: true } } } },
    },
  });

  return reports.map((report) => ({
    id: report.id,
    stationId: report.stationId,
    stationName: report.station?.name ?? null,
    fileName: report.pdfFileName,
    reportDate: report.reportDate ? report.reportDate.toISOString().slice(0, 10) : null,
    status: report.status,
    uploadedAt: report.uploadedAt.toISOString(),
    failureReason: report.failureReason,
    needsReviewCount: report._count.extractedFields,
  }));
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
