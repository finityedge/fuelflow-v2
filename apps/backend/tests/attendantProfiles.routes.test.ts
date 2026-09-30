/**
 * Route-level tests for attendant micro-loss profiling.
 *
 * The service suite covers the arithmetic — the three signals, the median baseline, the merge
 * that a link has to produce. This file covers only who is allowed to ask, and it exists as its
 * own file for the same reason the leakage one does: this endpoint returns money attributed to
 * *named individuals*, and the failure mode of getting the access rule wrong is not an empty
 * screen, it is a manager being told that somebody else's staff are short.
 *
 * The reports are written straight to the tables rather than pushed through the PDF pipeline.
 * The pipeline has its own tests; a real PDF here would only add a way for this file to fail for
 * a reason that has nothing to do with what it is checking.
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
let foreignTenantId: string;
let stationId: string;
let otherStationId: string;
let foreignStationId: string;

let johnId: string;
let otherJohnId: string;
/** The login that can be joined to a record, for the `/attendants/me` block. */
let attendantUserId: string;

let ownerToken: string;
let managerToken: string;
let attendantToken: string;

/** The station's own materiality line, so a 50,000 shortfall is not by itself "one big shift". */
const THRESHOLD = 100_000;
/** Three of these on one person, and no single one of them over the line. */
const SMALL_SHORTFALL = 50_000;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * A parsed report carrying one row per attendant.
 *
 * `expected`/`collected` are written as the parser writes them, labels and all — the label is
 * the only place an unclaimed key's printed name comes from, so the unclaimed fixture below
 * would read as `J_MWANGI` with no name if it were left off. The label is required rather than
 * optional because the column is: every field the parser writes carries one.
 *
 * The tenant is a parameter and not the module-level one, because a report's tenant is its
 * station's tenant. Writing the foreign station's report into this tenant's rows would leave a
 * row the tenant scope *should* hide looking like it was hidden for the wrong reason — and the
 * first version of this fixture did exactly that, so the foreign attendant came back as an
 * unclaimed name in this tenant instead of not coming back at all.
 */
async function seedAttendantReport(
  station: string,
  rows: { slug: string; label: string; expected: number | null; collected: number | null }[],
  reportTenantId: string = tenantId
): Promise<string> {
  const report = await prisma.shiftReport.create({
    data: {
      tenantId: reportTenantId,
      stationId: station,
      status: 'PARSED',
      reportDate: new Date(),
      pdfFileName: 'seeded.pdf',
    },
    select: { id: true },
  });

  await prisma.extractedField.createMany({
    data: rows.flatMap((row) => [
      {
        tenantId: reportTenantId,
        shiftReportId: report.id,
        fieldName: `attendant:${row.slug}:expected`,
        label: `${row.label} - to collect`,
        group: 'ATTENDANT_RECONCILIATION',
        parsedValue: row.expected === null ? null : String(row.expected),
        amount: row.expected,
        confidence: 'HIGH',
        needsReview: false,
      },
      {
        tenantId,
        shiftReportId: report.id,
        fieldName: `attendant:${row.slug}:collected`,
        label: `${row.label} - collected`,
        group: 'ATTENDANT_RECONCILIATION',
        parsedValue: row.collected === null ? null : String(row.collected),
        amount: row.collected,
        confidence: 'HIGH',
        needsReview: false,
      },
    ]),
  });

  return report.id;
}

/** Three shifts on John, each individually inside the tolerance and each a little short. */
async function seedJohnShifts(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await seedAttendantReport(stationId, [
      {
        slug: 'JOHN_MWAKA',
        label: 'John Mwaka',
        expected: 3_200_000 + i,
        collected: 3_200_000 + i - SMALL_SHORTFALL,
      },
    ]);
  }
}

beforeAll(async () => {
  app = await buildApp();
  await resetDatabase();

  const passwordHash = await hashPassword('password123');

  const tenant = await prisma.tenant.create({ data: { name: 'Profiles Route Tenant' } });
  tenantId = tenant.id;

  const station = await prisma.station.create({
    data: { tenantId, name: 'Main Station', varianceThreshold: THRESHOLD },
  });
  stationId = station.id;
  const otherStation = await prisma.station.create({
    data: { tenantId, name: 'Second Station' },
  });
  otherStationId = otherStation.id;

  const owner = await prisma.user.create({
    data: { tenantId, email: 'owner@profiles.local', passwordHash, role: UserRole.OWNER },
  });
  const manager = await prisma.user.create({
    data: { tenantId, email: 'manager@profiles.local', passwordHash, role: UserRole.MANAGER },
  });
  await prisma.stationAssignment.create({ data: { userId: manager.id, stationId } });

  const attendant = await prisma.user.create({
    data: { tenantId, email: 'attendant@profiles.local', passwordHash, role: UserRole.ATTENDANT },
  });
  attendantUserId = attendant.id;

  const foreignTenant = await prisma.tenant.create({ data: { name: 'Profiles Foreign Tenant' } });
  foreignTenantId = foreignTenant.id;
  const foreignStation = await prisma.station.create({
    data: { tenantId: foreignTenant.id, name: 'Foreign Station' },
  });
  foreignStationId = foreignStation.id;

  /*
   * The same key on three stations.
   *
   * "John Mwaka" is a plausible name for two different people to share, and the key that comes
   * out of it is identical. Nothing here may merge them: `JOHN_MWAKA` at the main station and at
   * the second station are two people, and the foreign one is not this tenant's business at all.
   */
  const john = await prisma.attendant.create({
    data: { tenantId, stationId, name: 'John Mwaka', slug: 'JOHN_MWAKA' },
  });
  johnId = john.id;
  const otherJohn = await prisma.attendant.create({
    data: { tenantId, stationId: otherStationId, name: 'John Mwaka', slug: 'JOHN_MWAKA' },
  });
  otherJohnId = otherJohn.id;
  await prisma.attendant.create({
    data: { tenantId, stationId, name: 'Grace Kimaro', slug: 'GRACE_KIMARO' },
  });
  await prisma.attendant.create({
    data: {
      tenantId: foreignTenant.id,
      stationId: foreignStationId,
      name: 'John Mwaka',
      slug: 'JOHN_MWAKA',
    },
  });

  await seedJohnShifts();

  // Balances exactly, so the only thing that can put Grace on this screen is a bug.
  await seedAttendantReport(stationId, [
    { slug: 'GRACE_KIMARO', label: 'Grace Kimaro', expected: 5_000_000, collected: 5_000_000 },
  ]);

  // Nobody has claimed this key. It must still be reported, with the name the report printed.
  await seedAttendantReport(stationId, [
    { slug: 'J_MWANGI', label: 'J. Mwangi', expected: 1_000_000, collected: 900_000 },
  ]);

  // The second station's John. A 100,000 shortfall, over that station's own line of zero.
  await seedAttendantReport(otherStationId, [
    { slug: 'JOHN_MWAKA', label: 'John Mwaka', expected: 2_000_000, collected: 1_900_000 },
  ]);

  await seedAttendantReport(
    foreignStationId,
    [{ slug: 'JOHN_MWAKA', label: 'John Mwaka', expected: 9_000_000, collected: 1_000_000 }],
    foreignTenantId
  );

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

describe('GET /api/attendants/profiles', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/attendants/profiles' });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an attendant, however well assigned they are', async () => {
    // The one access rule in this file that is a decision rather than a consequence. Attendant
    // variance is a statement about a person, and this list is every colleague's. An attendant
    // being assigned to the station is not consent to read what the business suspects of the
    // people working beside them.
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles',
      headers: auth(attendantToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('gives an owner every station in their tenant, and nothing from anyone else’s', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles',
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.attendants).toHaveLength(3);
    expect(
      body.attendants.every((profile: { stationId: string }) => profile.stationId !== foreignStationId)
    ).toBe(true);
    // The 8,000,000 the foreign tenant's John is short by, which is far larger than anything in
    // this tenant and would dominate the totals block if the tenant scope leaked.
    expect(body.totals.variance).toBe(SMALL_SHORTFALL * 3 + 100_000);
    expect(body.unmapped).toHaveLength(1);
    expect(body.unmapped[0].stationId).toBe(stationId);
    expect(body.unmapped[0].slug).toBe('J_MWANGI');
  });

  it('sorts by what went missing, with the alerted first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles',
      headers: auth(ownerToken),
    });

    const body = response.json();
    // Both Johns carry an alert, so they lead in order of the money; Grace balanced and is last.
    // The order is asserted at the route because it is what the reader sees first, and the two
    // people sharing a name make it the only place the station tie-break is visible.
    expect(
      body.attendants.map((profile: { slug: string; stationId: string }) => [profile.slug, profile.stationId])
    ).toEqual([
      ['JOHN_MWAKA', stationId],
      ['JOHN_MWAKA', otherStationId],
      ['GRACE_KIMARO', stationId],
    ]);
  });

  it('gives a manager only the stations they are assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles',
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.attendants).toHaveLength(2);
    expect(
      body.attendants.every((profile: { stationId: string }) => profile.stationId === stationId)
    ).toBe(true);
    // The second station's 100,000 is outside the assignment and so is the foreign tenant's.
    expect(body.totals.variance).toBe(SMALL_SHORTFALL * 3);
    expect(body.totals.shiftsAnalysed).toBe(4);
  });

  it('refuses a manager a station they are not assigned to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${otherStationId}`,
      headers: auth(managerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a station in another tenant even to its own owner', async () => {
    // An owner's token says "any station of mine"; it cannot say whose station an id names.
    // Without the existence check this returns an empty 200, which reads as "nobody there is
    // short" rather than "that station is not yours".
    const response = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${foreignStationId}`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('filters to one station for an owner who is allowed both', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.stationId).toBe(stationId);
    expect(
      body.attendants.every((profile: { stationId: string }) => profile.stationId === stationId)
    ).toBe(true);
  });

  it('keeps a name nobody has claimed, and says what the report called it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    const body = response.json();
    const stray = body.unmapped.find((entry: { slug: string }) => entry.slug === 'J_MWANGI');

    expect(stray).toBeDefined();
    // Not `J_MWANGI`: nobody recognises a key on a list of people, and the prompt to link it
    // has to name them the way the paper did.
    expect(stray.name).toBe('J. Mwangi');
    expect(stray.variance).toBe(100_000);
  });

  it('reports the threshold its alerts were judged against, and the window asked for', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles?periodDays=7',
      headers: auth(ownerToken),
    });

    const body = response.json();
    expect(body.periodDays).toBe(7);
    expect(body.totals.varianceThreshold).toBe(THRESHOLD);
  });

  it('rejects a period outside the window the query allows', async () => {
    const tooLong = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles?periodDays=365',
      headers: auth(ownerToken),
    });
    const zero = await app.inject({
      method: 'GET',
      url: '/api/attendants/profiles?periodDays=0',
      headers: auth(ownerToken),
    });

    expect(tooLong.statusCode).toBe(400);
    expect(zero.statusCode).toBe(400);
  });
});

describe('attendant aliases', () => {
  const ALIAS = 'J_MWANGI';

  it('joins a printed spelling to a person, and lets go of it again', async () => {
    // The round trip in one test on purpose. Linking and unlinking are the same fact seen from
    // two sides, and splitting them across two `it`s would make the second one pass only if the
    // first ran — a suite that is green because of its order is not green.
    const link = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: ALIAS },
    });

    expect(link.statusCode).toBe(201);
    expect(link.json().attendant.aliases).toEqual([ALIAS]);

    const linked = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    const linkedBody = linked.json();
    const johns = linkedBody.attendants.filter(
      (profile: { slug: string }) => profile.slug === 'JOHN_MWAKA'
    );

    // The claim in one line: joining a name makes one history, not a second John Mwaka with
    // the stray shift. That was a real defect — accumulators bucket by printed key — and an
    // alias that produced two profiles would double-count the person on their own screen.
    expect(johns).toHaveLength(1);
    expect(johns[0].shifts).toBe(4);
    expect(johns[0].variance).toBe(SMALL_SHORTFALL * 3 + 100_000);
    expect(linkedBody.unmapped).toEqual([]);

    const unlink = await app.inject({
      method: 'DELETE',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases/${ALIAS}`,
      headers: auth(ownerToken),
    });

    expect(unlink.statusCode).toBe(200);
    expect(unlink.json().attendant.aliases).toEqual([]);

    const restored = await app.inject({
      method: 'GET',
      url: `/api/attendants/profiles?stationId=${stationId}`,
      headers: auth(ownerToken),
    });

    const restoredBody = restored.json();
    // Unlinking rewrites no report: the shift filed under the stray key simply stops counting
    // towards John and goes back to being a name nobody has claimed.
    expect(restoredBody.attendants.find((p: { slug: string }) => p.slug === 'JOHN_MWAKA').shifts).toBe(3);
    expect(restoredBody.unmapped.map((entry: { slug: string }) => entry.slug)).toEqual([ALIAS]);
  });

  it('derives the key from a printed name when that is what the caller has', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: { name: 'J. Mwangi' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().attendant.aliases).toEqual([ALIAS]);

    await app.inject({
      method: 'DELETE',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases/${ALIAS}`,
      headers: auth(ownerToken),
    });
  });

  it('refuses an attendant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(attendantToken),
      payload: { slug: ALIAS },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a manager on a station they are not assigned to', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${otherStationId}/attendants/${otherJohnId}/aliases`,
      headers: auth(managerToken),
      payload: { slug: ALIAS },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses to link an attendant’s own key back to them', async () => {
    // The row would be inert: the key already resolves to this attendant, exactly. Answering
    // 409 rather than accepting it silently is the difference between a settings screen that
    // did nothing and one that says why.
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: 'JOHN_MWAKA' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/own key/i);
  });

  it('refuses a key that is another attendant’s own key, and names who holds it', async () => {
    // An exact slug match is resolved before any alias, so this link would be created, drawn on
    // the screen, and never take effect — the worst kind of wrong, because it looks like it worked.
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: 'GRACE_KIMARO' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Grace Kimaro/);
  });

  it('refuses a key that is already joined to somebody else', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: ALIAS },
    });
    expect(first.statusCode).toBe(201);

    const grace = await prisma.attendant.findFirstOrThrow({
      where: { stationId, slug: 'GRACE_KIMARO' },
      select: { id: true },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${grace.id}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: ALIAS },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already joined to John Mwaka/i);

    await app.inject({
      method: 'DELETE',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases/${ALIAS}`,
      headers: auth(ownerToken),
    });
  });

  it('rejects a body that names neither a key nor a name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases`,
      headers: auth(ownerToken),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an attendant who is not on the station in the path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/stations/${stationId}/attendants/${otherJohnId}/aliases`,
      headers: auth(ownerToken),
      payload: { slug: ALIAS },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to unlink a key that was never joined', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/stations/${stationId}/attendants/${johnId}/aliases/NEVER_LINKED`,
      headers: auth(ownerToken),
    });

    expect(response.statusCode).toBe(404);
  });
});

/**
 * The identity side of the same feature: one person's own record, on the screen they open.
 *
 * This block exists because `/attendants/me` is the only read in this file that is *not* behind
 * `canReadProfiles`, so it is the only place the access rule is "resolved from the record"
 * rather than "refused by role". Getting that wrong does not produce a blank screen — it hands
 * one attendant a colleague's shortfall, which is the same harm the gate above prevents,
 * arriving by the other door. So the shape of the response is pinned here as tightly as the
 * role rule is above.
 */
describe('GET /api/attendants/me', () => {
  /** Join a record to the attendant login, or let go of it with `null`. */
  async function setLink(attendantId: string, station: string, userId: string | null) {
    return app.inject({
      method: 'PATCH',
      url: `/api/stations/${station}/attendants/${attendantId}`,
      headers: auth(ownerToken),
      payload: { userId },
    });
  }

  it('refuses an unauthenticated caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/attendants/me' });

    expect(response.statusCode).toBe(401);
  });

  it('says nobody has linked this login yet, rather than refusing', async () => {
    // The ordinary state of a fresh account. A 403 would send the person looking for an access
    // problem they do not have, and would be wrong about what happened: nothing was denied.
    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(attendantToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ linked: false, profile: null });
  });

  it('answers a manager and an owner the same way — neither is an attendant', async () => {
    // The endpoint is open to every role because the row it returns is the caller's own, and for
    // these two the honest answer is that there is no such row. What it must never become is a
    // way to read somebody else's: there is no parameter to pass and no id to guess.
    const asOwner = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(ownerToken),
    });
    const asManager = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(managerToken),
    });

    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json().linked).toBe(false);
    expect(asManager.statusCode).toBe(200);
    expect(asManager.json()).toMatchObject({ linked: false, profile: null });
  });

  it('gives a linked attendant their own figures, and nobody else’s', async () => {
    // The round trip in one test, as the alias block does: linking and unlinking are the same
    // fact seen from two sides, and splitting them would make the second pass only if the first
    // ran — a suite that is green because of its order is not green.
    const joined = await setLink(johnId, stationId, attendantUserId);
    expect(joined.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(attendantToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.linked).toBe(true);
    expect(body.profile.attendantId).toBe(johnId);
    expect(body.profile.slug).toBe('JOHN_MWAKA');
    expect(body.profile.shifts).toBe(3);
    expect(body.profile.variance).toBe(SMALL_SHORTFALL * 3);
    // The line a single shift is measured against, so the screen can name it rather than leaving
    // a bare shilling figure to be read as a verdict.
    expect(body.varianceThreshold).toBe(THRESHOLD);

    /*
     * The claim the endpoint rests on, asserted as a key set rather than as three spot checks.
     *
     * Grace balanced exactly and the unclaimed `J. Mwangi` shortfall is a real one; neither is
     * this person's business. A response shaped like the profiling screen's — carrying an
     * `attendants` array and an `unmapped` list — would hand the station's figures to the person
     * at the pump whatever the screen then chose to draw. Pinning the shape means adding either
     * of those to this endpoint fails a test rather than quietly opening a door.
     */
    expect(Object.keys(body).sort()).toEqual([
      'generatedAt',
      'linked',
      'periodDays',
      'profile',
      'varianceThreshold',
    ]);

    const letGo = await setLink(johnId, stationId, null);
    expect(letGo.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(attendantToken),
    });

    // The link is the whole of the authorisation, so removing it has to be enough on its own —
    // no cache, nothing left behind on the account.
    expect(after.json()).toMatchObject({ linked: false, profile: null });
  });

  it('reports the station the record belongs to, not the one the caller is assigned to', async () => {
    // The decision written up in the service: the link is the authorisation, so an owner joining
    // a login to a name at another station has said those are the same person, and the shifts
    // under that name are theirs wherever they were worked. Filtering by the caller's own
    // assignments would answer "nothing is linked to you" to somebody whose link works, which
    // reads as the link having failed.
    const joined = await setLink(otherJohnId, otherStationId, attendantUserId);
    expect(joined.statusCode).toBe(200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/attendants/me',
      headers: auth(attendantToken),
    });

    const body = response.json();
    expect(body.linked).toBe(true);
    expect(body.profile.attendantId).toBe(otherJohnId);
    expect(body.profile.stationId).toBe(otherStationId);
    // That station's own line is zero, and this shift is 100,000 short of it — nothing from the
    // first station, whose John is a different person with a different three shifts.
    expect(body.profile.shifts).toBe(1);
    expect(body.profile.variance).toBe(100_000);

    await setLink(otherJohnId, otherStationId, null);
  });

  it('takes the window it is asked for, and refuses one outside the bound', async () => {
    const week = await app.inject({
      method: 'GET',
      url: '/api/attendants/me?periodDays=7',
      headers: auth(attendantToken),
    });
    const tooLong = await app.inject({
      method: 'GET',
      url: '/api/attendants/me?periodDays=365',
      headers: auth(attendantToken),
    });

    // The same bound as the profiling screen, so a person and their manager can ask for the same
    // window — two screens built from different periods could not be reconciled by talking.
    expect(week.statusCode).toBe(200);
    expect(week.json().periodDays).toBe(7);
    expect(tooLong.statusCode).toBe(400);
  });
});
