import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';

export const PDF_PARSE_QUEUE = 'pdf-parse';

export interface PdfParseJob {
  shiftReportId: string;
  /**
   * Carried on the job because the worker runs outside any request, so there is no
   * tenant scope to read it from. This is what lets the worker open one deliberately
   * rather than querying unscoped by accident.
   */
  tenantId: string;
}

export const pdfParseQueue = new Queue<PdfParseJob>(PDF_PARSE_QUEUE, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

/**
 * No fixed jobId: BullMQ treats a repeated jobId as a duplicate and drops it while the
 * original is still retained, which would silently break re-parsing a failed report.
 * Duplicate parses are harmless instead — the write is a single transaction that
 * replaces the report's fields wholesale, so the last one to finish is the record.
 */
export async function enqueuePdfParse(payload: PdfParseJob) {
  return pdfParseQueue.add('parse', payload);
}
