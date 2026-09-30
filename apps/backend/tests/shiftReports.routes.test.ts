/**
 * Route-level tests for settling flagged figures in bulk.
 *
 * The service suite covers what a batch acceptance does to a row — the flag, the audit
 * columns, the report's state once it is done. This file covers only the request: who is
 * allowed to ask, which ids the route will take, and what the caller is told when a batch is
 * partly or wholly refused.
 *
 * The reports are written straight to the tables rather than pushed through the PDF pipeline.
 * The pipeline has its own tests, and a real PDF here would only add a way for this file to
 * fail for a reason that has nothing to do with what it is checking — the route does not know
 * where a row came from.
 *
 * The one id shape worth naming up front: a batch that settles nothing *and* found nothing is
 * a 404, because every id belonging to some other report means the client has lost track of
 * which report it is looking at. A batch that settled nothing because the figures were already
 * settled is a 200 that says so — those are different mistakes and an operator fixing one by
 * reloading the page should not be sent chasing the other.
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { UserRole } from '@fuelflow/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/prisma/client.js';
import { resetDatabase } from './helpers/db.js';
import { hashPassword } from '../src/services/password.service.js';
import { createAccessToken } from '../src/services/token.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

let tenantId: string;
let stationId: string;
let otherStationId: string;

let ownerToken: string;
let managerToken: string;
let attendantToken: string;

/** The report the refusals are exercised against: it carries one of every state a row can be in. */
let reportId: string;
/** A single flagged figure and nothing else, so the report's own state follows from one accept. */
let singleReportId: string;
/** A second report on the same station, so an id can be named against the wrong report. */
let otherReportId: string;
/** A report at the station the manager is not assigned to. */
let unassignedReportId: string;
/** A report belonging to another tenant entirely. */
let foreignReportId: string;

/** Flagged, with a figure on it: the one thing this route is actually for. */
let readableId: string;
/** Flagged with nothing read: a row a person cannot sign off, because there is nothing to sign. */
let blankId: string;
/** Already settled by a colleague: the state the "already checked" answer is for. */
let settledId: string;
/** The single flagged figure of `singleReportId`. */
let singleId: string;
/** A figure on the other report of the same station. */
let otherReportFieldId: string;
/** A figure on a report in the other tenant. */
let foreignFieldId: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * A report with exactly the fields asked for, written as the parser would leave them.
 *
 * The `tenantId` is a parameter rather than the module-level one because a field's tenant is
 * its report's tenant. Writing the foreign report's rows into this tenant would leave rows the
 * scope *should* hide looking like they were hidden for the wrong reason — the same trap the
 * profiling route fixtures document, and the reason the foreign case below can be trusted.
 */
async function seedReport(options: {
  station: string;
  reportTenantId?: string;
  fields: {
    fieldName: string;
    needsReview: boolean;
    parsedValue?: string | null;
    settled?: boolean;
  }[];
}): Promise<{ reportId: string; fieldIds: string[] }> {
  const reportTenantId = options.reportTenantId ?? tenantId;

  const report = await prisma.shiftReport.create({
    data: {
      tenantId: reportTenantId,
      stationId: options.station,
      status: 'NEEDS_REVIEW',
      reportDate: new Date('2026-03-14'),
      pdfFileName: 'seeded.pdf',
    },
    select: { id: true },
  });

  const fieldIds: string[] = [];
  for (const field of options.fields) {
    const created = await prisma.extractedField.create({
      data: {
        tenantId: reportTenantId,
        shiftReportId: report.id,
        fieldName: field.fieldName,
        label: field.fieldName,
        group: 'CASH_PAYMENTS',
        parsedValue: field.parsedValue ?? null,
        amount: field.parsedValue ? Number(field.parsedValue.replace(/[^0-9.-]/g, '')) : null,
        confidence: field.needsReview ? 'LOW' : 'HIGH',
        needsReview: field.needsReview,
        ...(field.settled
          ? { correctedAt: new Date(), correctedBy: 'someone-else', reviewAction: 'ACCEPTED' as const }
          : {}),
      },
      select: { id: true },
    });
    fieldIds.push(created.id);
  }

  return { reportId: report.id, fieldIds };
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const passwordHash = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'Shift Review Route Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({ data: { tenantId, name: 'Main Station' } });
  stationId = station.id;
  const otherStation = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  otherStationId = otherStation.id;

  const owner = await prisma.user.create({
    data: { tenantId, email: 'owner@review.local', passwordHash, role: UserRole.OWNER },
  });
  const manager = await prisma.user.create({
    data: { tenantId, email: 'manager@review.local', passwordHash, role: UserRole.MANAGER },
  });
  // Assigned to the main station only, which is what makes the unassigned report below a real
  // test of the station check rather than of the role check.
  await prisma.stationAssignment.create({ data: { userId: manager.id, stationId } });

  const attendant = await prisma.user.create({
    data: { tenantId, email: 'attendant@review.local', passwordHash, role: UserRole.ATTENDANT },
  });
  // Assigned to the station and still refused: the role gate is what answers this route, not the
  // assignment — correcting a figure is a management act and being at the station is not the
  // same as being answerable for the shift.
  await prisma.stationAssignment.create({ data: { userId: attendant.id, stationId } });

  const foreignTenant = await prisma.tenant.create({ data: { name: 'Shift Review Foreign' } });
  const foreignStation = await prisma.station.create({
    data: { tenantId: foreignTenant.id, name: 'Foreign Station' },
  });

  const main = await seedReport({
    station: stationId,
    fields: [
      { fieldName: 'cash_collected', needsReview: true, parsedValue: '9,120,000' },
      { fieldName: 'pump_totalizer_sales', needsReview: true, parsedValue: null },
      // Settled: the flag is already off and the row already carries a reviewer, which is the
      // whole of what makes this a second acceptance rather than a first.
      { fieldName: 'bank_deposit_total', needsReview: false, parsedValue: '5,000,000', settled: true },
      { fieldName: 'credit_sale:T123ABC', needsReview: false, parsedValue: '850,000' },
    ],
  });
  reportId = main.reportId;
  [readableId, blankId, settledId] = main.fieldIds as [string, string, string];

  const single = await seedReport({
    station: stationId,
    fields: [{ fieldName: 'cashback_discount', needsReview: true, parsedValue: '50,000' }],
  });
  singleReportId = single.reportId;
  singleId = single.fieldIds[0]!;

  const other = await seedReport({
    station: stationId,
    fields: [{ fieldName: 'shift_expense', needsReview: true, parsedValue: '25,000' }],
  });
  otherReportId = other.reportId;
  otherReportFieldId = other.fieldIds[0]!;

  const unassigned = await seedReport({
    station: otherStationId,
    fields: [{ fieldName: 'cash_collected', needsReview: true, parsedValue: '1,000' }],
  });
  unassignedReportId = unassigned.reportId;

  const foreign = await seedReport({
    station: foreignStation.id,
    reportTenantId: foreignTenant.id,
    fields: [{ fieldName: 'cash_collected', needsReview: true, parsedValue: '2,000' }],
  });
  foreignReportId = foreign.reportId;
  foreignFieldId = foreign.fieldIds[0]!;

  ownerToken = createAccessToken({ sub: owner.id, tenantId, role: owner.role, stationIds: [] });
  managerToken = createAccessToken({
    sub: manager.id,
    tenantId,
    role: manager.role,
    stationIds: [stationId],
  });
  attendantToken = createAccessToken({
    sub: attendant.id,
    tenantId,
    role: attendant.role,
    stationIds: [stationId],
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await resetDatabase();
  await prisma.$disconnect();
});

/**
 * The one call this file is about, so the url is written once.
 *
 * `async` rather than a bare return on purpose: `app.inject` returns a chainable builder, and
 * awaiting it is what makes the response available. Handing the builder back would compile into
 * a caller that reads `response.statusCode` off something that has not been sent yet.
 */
async function accept(report: string, token: string, payload: object) {
  return app.inject({
    method: 'POST',
    url: `/api/shift-reports/${report}/fields/accept`,
    headers: auth(token),
    payload,
  });
}

describe('POST /api/shift-reports/:id/fields/accept', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/shift-reports/${reportId}/fields/accept`,
      payload: { fieldIds: [readableId] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an attendant, however well assigned they are', async () => {
    const response = await accept(reportId, attendantToken, { fieldIds: [readableId] });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a manager on a station they are not assigned to', async () => {
    const response = await accept(unassignedReportId, managerToken, { fieldIds: [] });
    // Refused before the body is read, so an empty batch is not what produced this: the station
    // check runs first on purpose, and a 400 here would mean a caller could probe for reports
    // they cannot see by watching which error came back.
    expect(response.statusCode).toBe(403);
  });

  it('refuses a report that does not exist', async () => {
    const response = await accept('00000000-0000-0000-0000-000000000000', ownerToken, {
      fieldIds: [readableId],
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/not found/i);
  });

  it('refuses to settle a figure that is not on the report in the path', async () => {
    const response = await accept(reportId, ownerToken, { fieldIds: [otherReportFieldId] });

    // 404 rather than a 200 reporting nothing happened: naming an id from another report is the
    // client looking at a different report than it thinks, and "these figures are not here" is
    // the fact that unsticks it.
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/on this report/i);
  });

  it('refuses a figure that belongs to another tenant', async () => {
    const response = await accept(foreignReportId, ownerToken, { fieldIds: [foreignFieldId] });

    // The report does not exist as far as this tenant is concerned — the tenant scope answers
    // before the station check ever runs, which is why the foreign tenant's owner cannot reach
    // it either, whatever their token claims about stations.
    expect(response.statusCode).toBe(404);
  });

  it('settles a flagged figure and reports the report’s state once it is done', async () => {
    const response = await accept(singleReportId, ownerToken, { fieldIds: [singleId] });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toEqual([singleId]);
    expect(body.skipped).toEqual([]);
    // Nothing is left asking for a person, so the report leaves the queue — the state the screen
    // moves on with, without a second request to find out.
    expect(body.status).toBe('PARSED');

    const row = await prisma.extractedField.findUniqueOrThrow({ where: { id: singleId } });
    expect(row.needsReview).toBe(false);
    expect(row.parsedValue).toBe('50,000');
    expect(row.reviewAction).toBe('ACCEPTED');
  });

  it('reports a partly settled batch instead of failing the request', async () => {
    const response = await accept(reportId, ownerToken, {
      fieldIds: [readableId, blankId, settledId, otherReportFieldId],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // The three refusals are three different things and each is named, because a manager staring
    // at a screen that says "some of those did not work" cannot tell which row to look at.
    expect(body.accepted).toEqual([readableId]);
    expect(body.skipped).toEqual([
      { fieldId: blankId, reason: 'nothing_read' },
      { fieldId: settledId, reason: 'not_flagged' },
      { fieldId: otherReportFieldId, reason: 'not_found' },
    ]);
    // Still asking for a person: the blank row is untouched and the other report's figure is still
    // flagged where it lives.
    expect(body.status).toBe('NEEDS_REVIEW');

    const blank = await prisma.extractedField.findUniqueOrThrow({ where: { id: blankId } });
    expect(blank.needsReview).toBe(true);
    expect(blank.reviewAction).toBeNull();

    // The already-settled row keeps the reviewer who settled it. A second acceptance re-stamping
    // the row would rewrite who checked the figure, which is the one thing the audit column is
    // for.
    const settled = await prisma.extractedField.findUniqueOrThrow({ where: { id: settledId } });
    expect(settled.correctedBy).toBe('someone-else');

    // A figure named against the wrong report is not settled on the report it really belongs to.
    const elsewhere = await prisma.extractedField.findUniqueOrThrow({
      where: { id: otherReportFieldId },
    });
    expect(elsewhere.needsReview).toBe(true);
    expect(elsewhere.shiftReportId).toBe(otherReportId);
  });

  it('rejects a batch with no ids in it', async () => {
    const response = await accept(reportId, ownerToken, { fieldIds: [] });

    // 400 rather than a no-op 200: an empty batch is a client that built the request wrong — a
    // card with nothing on it, a filter that matched nothing — and answering 200 would let a
    // screen report success for a request that settled nothing at all.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/invalid request/i);
  });

  it('rejects a batch larger than the route will take', async () => {
    const tooMany = Array.from({ length: 101 }, (_unused, index) => `field-${index}`);
    const response = await accept(reportId, ownerToken, { fieldIds: tooMany });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a body that is not a list of ids', async () => {
    const response = await accept(reportId, ownerToken, { fieldIds: 'all of them' });

    expect(response.statusCode).toBe(400);
  });
});
