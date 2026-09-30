import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UserRole } from '@fuelflow/shared';
import {
  ACCEPTED_UPLOAD_MIME,
  MAX_UPLOAD_BYTES,
  acceptFieldsBodySchema,
  correctFieldBodySchema,
  listShiftReportsQuerySchema,
} from '../schemas/shiftReport.schema.js';
import {
  acceptExtractedFields,
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

/**
 * Who may open a shift report, rather than merely be posted to the station it belongs to.
 *
 * Being assigned to a station is what `hasStationAccess` answers, and for the list and the
 * dashboard that is the right question — those return the station's own totals, which belong to
 * the forecourt. A report's *detail* is a different document: it carries every colleague's
 * attendant row, with the money each of them was due and handed over, and the profiling screen's
 * numbers are derived from exactly those rows. Serving it to an attendant would hand them the
 * per-person attribution that `GET /api/attendants/profiles` refuses with a 403 on the stated
 * ground that the list is every colleague's — the same data refused by one route and returned by
 * another is not a policy, it is an oversight. The findings sheet reaches the same conclusion
 * about the same figures: an attendant being assigned to the station is not consent to be given
 * a document about the people working beside them.
 *
 * The uploaded PDF is gated with it, because it is the same document in its original form: the
 * attendant rows are printed on it.
 *
 * This is deliberately not applied to `GET /shift-reports` or `GET /dashboard`. Those carry the
 * shift's totals — totalizer, cash, mobile money, credit, the variance between them — and name
 * nobody; an attendant's own screen shows them their share of the same arithmetic, so hiding the
 * station's version of it would withhold the denominator rather than a secret.
 */
const canReadReport = requireRole([UserRole.OWNER, UserRole.MANAGER]);

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

    // A manager assigned to specific stations should not see another station's reports.
    // This travels into the query rather than being applied to the result: filtering a
    // page after it has been cut short shows fewer rows than it claims to, and the count
    // that says "showing 25 of 63" would be counting rows the page will not show.
    const page = await listShiftReports({
      ...query,
      restrictToStationIds: user.role === UserRole.OWNER ? undefined : user.stationIds,
    });

    return reply.send(page);
  });

  app.get<{ Params: { id: string } }>(
    '/shift-reports/:id',
    { preHandler: canReadReport },
    async (request, reply) => {
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
    }
  );

  app.get<{ Params: { id: string } }>(
    '/shift-reports/:id/file',
    { preHandler: canReadReport },
    async (request, reply) => {
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
    }
  );

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

  /**
   * Settle several flagged figures at once, each keeping the value it already has.
   *
   * Not a loop over the PATCH above, and not only because of the round trips: the PATCH takes a
   * value, and "accept" is precisely the statement that the stored value is right. Reaching for
   * the correction route here would mean sending the figure back from the browser to have the
   * server store what it already had — which is a request that can change a number while telling
   * the audit trail nobody touched it.
   */
  app.post<{ Params: { id: string } }>(
    '/shift-reports/:id/fields/accept',
    { preHandler: canManage },
    async (request, reply) => {
      const user = requireRequestUser(request);
      const id = parseRouteId(request.params.id);
      if (!id) {
        return reply.status(400).send({ error: 'Invalid report id' });
      }

      // The report is loaded first so station access is checked before anything is written —
      // same order as the single-field route, and for the same reason.
      const report = await prisma.shiftReport.findUnique({ where: { id } });
      if (!report) {
        return reply.status(404).send({ error: 'Shift report not found' });
      }
      if (!hasStationAccess(user, report.stationId)) {
        return reply.status(403).send({ error: 'Forbidden: station access denied' });
      }

      const body = acceptFieldsBodySchema.parse(request.body);
      const result = await acceptExtractedFields(id, body.fieldIds, user.id);

      // Every id belongs to another report or to none. That is a different mistake from "these
      // figures are already settled", and it is the client having lost track of which report it
      // is looking at — so it gets the same 404 the single-field route gives for a field from
      // somewhere else, rather than a 200 reporting that nothing happened.
      if (result.accepted.length === 0 && result.skipped.every((row) => row.reason === 'not_found')) {
        return reply.status(404).send({ error: 'None of those figures are on this report' });
      }

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
