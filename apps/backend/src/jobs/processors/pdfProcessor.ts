import type { Job } from 'bullmq';
import { withTenantScope } from '../../prisma/client.js';
import { processShiftReport } from '../../services/shiftReport.service.js';
import type { PdfParseJob } from '../queues.js';

/**
 * Parse one uploaded shift report.
 *
 * The worker has no request behind it, so it opens the tenant scope itself. That matters:
 * without it the tenant-scoped Prisma extension injects nothing and the queries run
 * unscoped.
 */
export async function pdfProcessor(job: Job<PdfParseJob>) {
  const { shiftReportId, tenantId } = job.data;

  await withTenantScope(tenantId, () => processShiftReport(shiftReportId, tenantId));

  return { shiftReportId, status: 'processed' };
}
