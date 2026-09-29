import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import {
  ACCEPTED_UPLOAD_MIME,
  MAX_UPLOAD_BYTES,
  correctFieldBodySchema,
  listShiftReportsQuerySchema,
} from '../schemas/shiftReport.schema.js';
import {
  correctExtractedField,
  createShiftReport,
  getShiftReportDetail,
  listShiftReports,
  reparseShiftReport,
} from '../services/shiftReport.service.js';
import { hasStationAccess, requireRole } from '../middleware/rbac.js';
import { requireRequestUser } from '../middleware/auth.js';
import { prisma } from '../prisma/client.js';
import { readPdf } from '../config/storage.js';

const canManage = requireRole([UserRole.OWNER, UserRole.MANAGER]);

function parseRouteId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

/**
 * Buffers the multipart body before doing anything with it.
 *
 * The station ID arrives as one part among several, in whatever order the client sent
 * them, so nothing can be validated until the whole thing has been read. Reading it all
 * first also means a rejected request has not yet written a file to disk.
 */
async function collectUpload(request: FastifyRequest): Promise<
  | { ok: true; stationId: string; fileName: string; data: Buffer }
  | { ok: false; status: number; error: string }
> {
  let stationId: string | null = null;
  let fileName = 'shift-report.pdf';
  let data: Buffer | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (data) {
          // Drain and ignore extras rather than erroring: a manager selecting two files
          // by accident should still get their first one processed.
          await part.toBuffer();
          continue;
        }
        if (part.mimetype !== ACCEPTED_UPLOAD_MIME) {
          return { ok: false, status: 415, error: 'Only PDF files can be uploaded.' };
        }
        fileName = part.filename || fileName;
        data = await part.toBuffer();
      } else if (part.fieldname === 'stationId' && typeof part.value === 'string') {
        stationId = part.value;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/file size|limit/i.test(message)) {
      return {
        ok: false,
        status: 413,
        error: `That file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
      };
    }
    return { ok: false, status: 400, error: 'The upload could not be read. Please try again.' };
  }

  if (!data || data.length === 0) {
    return { ok: false, status: 400, error: 'No PDF file was included in the upload.' };
  }
  if (!stationId) {
    return { ok: false, status: 400, error: 'A station must be selected for the report.' };
  }

  if (!data.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return { ok: false, status: 415, error: 'That file is not a PDF.' };
  }

  return { ok: true, stationId, fileName, data };
}

export async function shiftReportRoutes(app: FastifyInstance) {
  app.post('/shift-reports/upload', { preHandler: canManage }, async (request, reply) => {
    const user = requireRequestUser(request);
    const upload = await collectUpload(request);
    if (!upload.ok) {
      return reply.status(upload.status).send({ error: upload.error });
    }

    if (!hasStationAccess(user, upload.stationId)) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }

    const station = await prisma.station.findUnique({ where: { id: upload.stationId } });
    if (!station) {
      return reply.status(404).send({ error: 'Station not found' });
    }

    const result = await createShiftReport({
      tenantId: user.tenantId,
      stationId: upload.stationId,
      fileName: upload.fileName,
      data: upload.data,
    });

    // 202: the report exists and parsing is under way, but nothing has been read yet.
    return reply.status(202).send(result);
  });

  app.get('/shift-reports', async (request, reply) => {
    const user = requireRequestUser(request);
    const query = listShiftReportsQuerySchema.parse(request.query);

    if (query.stationId && !hasStationAccess(user, query.stationId)) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }

    const reports = await listShiftReports(query);

    // A manager assigned to specific stations should not see another station's reports
    // in the list, so the filter is applied here rather than trusted to the query string.
    const visible =
      user.role === UserRole.OWNER
        ? reports
        : reports.filter((report) => user.stationIds.includes(report.stationId));

    return reply.send({ reports: visible });
  });

  app.get<{ Params: { id: string } }>('/shift-reports/:id', async (request, reply) => {
    const user = requireRequestUser(request);
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.status(400).send({ error: 'Invalid report id' });
    }

    const detail = await getShiftReportDetail(id);
    if (!detail) {
      return reply.status(404).send({ error: 'Shift report not found' });
    }

    if (!hasStationAccess(user, detail.report.stationId)) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }

    return reply.send(detail);
  });

  app.get<{ Params: { id: string } }>('/shift-reports/:id/file', async (request, reply) => {
    const user = requireRequestUser(request);
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.status(400).send({ error: 'Invalid report id' });
    }

    const report = await prisma.shiftReport.findUnique({ where: { id } });
    if (!report?.pdfFileUrl) {
      return reply.status(404).send({ error: 'No uploaded file for this report' });
    }
    if (!hasStationAccess(user, report.stationId)) {
      return reply.status(403).send({ error: 'Forbidden: station access denied' });
    }

    try {
      const data = await readPdf(report.pdfFileUrl);
      return reply
        .header('Content-Disposition', `inline; filename="${report.pdfFileName ?? 'shift-report.pdf'}"`)
        .type('application/pdf')
        .send(data);
    } catch {
      return reply.status(404).send({ error: 'The uploaded file is no longer available' });
    }
  });

  app.patch<{ Params: { id: string; fieldId: string } }>(
    '/shift-reports/:id/fields/:fieldId',
    { preHandler: canManage },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const fieldId = parseRouteId(request.params.fieldId);
      if (!fieldId) {
        return reply.status(400).send({ error: 'Invalid field id' });
      }

      // Fetch first so station access is checked before anything is written.
      const existing = await prisma.extractedField.findUnique({ where: { id: fieldId } });
      if (!existing || existing.shiftReportId !== request.params.id) {
        return reply.status(404).send({ error: 'Field not found on this report' });
      }

      const report = await prisma.shiftReport.findUnique({ where: { id: existing.shiftReportId } });
      if (!report) {
        return reply.status(404).send({ error: 'Shift report not found' });
      }
      if (!hasStationAccess(user, report.stationId)) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }

      const body = correctFieldBodySchema.parse(request.body);
      const result = await correctExtractedField(fieldId, body, user.id);
      if (!result) {
        return reply.status(404).send({ error: 'Field not found' });
      }

      // The report's review state comes back with the field so the screen can move
      // straight to "Reconciliation Complete" without a second round trip.
      return reply.send(result);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/shift-reports/:id/reparse',
    { preHandler: canManage },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const id = parseRouteId(request.params.id);
      if (!id) {
        return reply.status(400).send({ error: 'Invalid report id' });
      }

      const report = await prisma.shiftReport.findUnique({ where: { id } });
      if (!report) {
        return reply.status(404).send({ error: 'Shift report not found' });
      }
      if (!hasStationAccess(user, report.stationId)) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }

      const queued = await reparseShiftReport(id, user.tenantId);
      if (!queued) {
        return reply.status(409).send({ error: 'No uploaded file is available to parse' });
      }

      return reply.status(202).send({ id, status: 'PENDING' });
    }
  );
}
