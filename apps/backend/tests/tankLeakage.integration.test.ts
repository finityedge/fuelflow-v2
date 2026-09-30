/**
 * Integration tests for wet-stock leakage.
 *
 * Two claims here are worth more than the rest of the file and are tested directly.
 *
 * The first is that a leak is a *pattern*. A tank losing thirty litres a shift is losing fuel
 * at a rate that empties it in a season, and every one of those shifts is individually
 * unremarkable — below any threshold, inside the noise of the tape. A leak detector that only
 * looks at one shift at a time cannot see it. `Tank 2` below is that tank.
 *
 * The second is that nothing about this is stored. A manager correcting a dip that was read
 * wrong has to see the leak number move, because the shift where the misread happened is
 * exactly the shift a manager is looking at when they open this screen. `clears the alert when
 * the dip it was built from is corrected` is that claim.
 *
 * Same fixture caveat as the rest of the suite: no real Petronite report was available, so the
 * documents are built to the spec's structure. This proves the arithmetic, the grouping and the
 * alerting; it does not prove the parser against live station output.
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
  processShiftReport,
} from '../src/services/shiftReport.service.js';
import { getTankLeakage } from '../src/services/tankLeakage.service.js';
import { buildTextPdf } from './helpers/pdf.js';

const comma = new Intl.NumberFormat('en-US');

interface TankLine {
  label: string;
  book?: number;
  /** Omitted entirely when null, which is how a report with a missing dip is built. */
  dip?: number | null;
}

/**
 * A report carrying only the tank section.
 *
 * `PETRONITE`, `SHIFT REPORT` and `TANK DIP` are three of the template markers, which is the
 * count a document needs to be treated as a shift report at all — so this is the smallest
 * fixture that reaches the tank arithmetic without dragging the money fields along.
 */
function tankReport(daysAgo: number, tanks: TankLine[]): string[] {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const stamp = [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');

  const lines = ['PETRONITE FUEL STATION', 'SHIFT REPORT', `Date: ${stamp}`, 'TANK DIP'];

  for (const tank of tanks) {
    const figures = [tank.book, tank.dip]
      .filter((value): value is number => value !== null && value !== undefined)
      .map((value) => comma.format(value))
      .join(' ');

    lines.push(`TANK ${tank.label} PMS ${figures}`.trim());
  }

  return lines;
}

let storageDir: string;
let tenantId: string;
let stationA: string;
let stationB: string;
let userId: string;

async function uploadAndProcess(lines: string[], stationId: string, fileName: string): Promise<string> {
  const { id } = await withTenantScope(tenantId, () =>
    createShiftReport({ tenantId, stationId, fileName, data: buildTextPdf(lines) })
  );
  await withTenantScope(tenantId, () => processShiftReport(id, tenantId));
  return id;
}

/**
 * The age of every shift the in-period assertions are built from.
 *
 * All comfortably inside a 30-day window and comfortably clear of each other, so the ordering
 * assertions are about the sort and not about which day a shift landed on.
 */
const DAYS_AGO = {
  tank1Short: 5,
  tank2Persistent: [4, 3, 2, 1] as const,
  tank2MissingDip: 6,
  tank4Surplus: 3,
  tank5NoThreshold: 4,
  unmapped: [4, 3] as const,
  /** Outside a 30-day window, inside a 90-day one. This is what the period test moves. */
  tank1OldShort: 60,
  /** The other station's shift, which a restricted caller must not see. */
  stationB: 2,
};

/** The shift that trips Tank 1's single-shift alert, kept so a correction can be applied to it. */
let tank1AlertReportId: string;
let tank1DipFieldId: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'fuelflow-leakage-'));
  process.env.STORAGE_DIR = storageDir;

  const tenant = await prisma.tenant.create({ data: { name: 'Leakage Test Tenant' } });
  tenantId = tenant.id;

  const a = await prisma.station.create({ data: { tenantId, name: 'Main Station' } });
  stationA = a.id;
  const b = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  stationB = b.id;

  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `leakage-${Date.now()}@example.test`,
      passwordHash: 'x',
      role: 'OWNER',
    },
  });
  userId = user.id;

  /**
   * Tank 1: capacity only, so the threshold is the 0.5% fallback — 100 L.
   * Tank 2: small capacity, 40 L threshold, and the persistent leak.
   * Tank 4: a tank *above* its book figure, to prove a surplus is not a leak.
   * Tank 5: no capacity and no threshold, so there is no honest line to alert on.
   *
   * Tank 3 is deliberately absent: the reports name it and nothing answers to it.
   */
  await prisma.tank.createMany({
    data: [
      { tenantId, stationId: stationA, name: 'Tank 1', slug: 'TANK_1', product: 'PMS', capacityLitres: 20_000 },
      { tenantId, stationId: stationA, name: 'Tank 2', slug: 'TANK_2', product: 'AGO', capacityLitres: 8_000 },
      { tenantId, stationId: stationA, name: 'Tank 4', slug: 'TANK_4', product: 'PMS', capacityLitres: 5_000 },
      { tenantId, stationId: stationA, name: 'Tank 5', slug: 'TANK_5', product: 'IK' },
    ],
  });

  // A tank on the other station with the *same* slug as one here. Two stations' TANK_1 are two
  // different tanks, and anything that keyed by slug alone would merge their leak totals.
  await prisma.tank.create({
    data: { tenantId, stationId: stationB, name: 'Tank 1', slug: 'TANK_1', product: 'PMS', capacityLitres: 10_000 },
  });

  // Tank 1 — one large shortfall, well clear of the 100 L threshold.
  tank1AlertReportId = await uploadAndProcess(
    tankReport(DAYS_AGO.tank1Short, [{ label: '1', book: 20_000, dip: 19_000 }]),
    stationA,
    'tank1-short.pdf'
  );

  // Tank 1 — an older shortfall, outside a 30-day window.
  await uploadAndProcess(
    tankReport(DAYS_AGO.tank1OldShort, [{ label: '1', book: 20_000, dip: 19_500 }]),
    stationA,
    'tank1-old.pdf'
  );

  // Tank 2 — four shifts of 30 L each. Every one of them is under the 40 L threshold; together
  // they are three times over it. This is the leak no single shift reveals.
  for (const daysAgo of DAYS_AGO.tank2Persistent) {
    await uploadAndProcess(
      tankReport(daysAgo, [{ label: '2', book: 8_000, dip: 7_970 }]),
      stationA,
      `tank2-${daysAgo}.pdf`
    );
  }

  // Tank 2 — a shift whose dip was never read. It must be counted as incomparable and must not
  // contribute a variance of its own.
  await uploadAndProcess(
    tankReport(DAYS_AGO.tank2MissingDip, [{ label: '2', book: 8_000 }]),
    stationA,
    'tank2-missing-dip.pdf'
  );

  // Tank 4 — more in the tank than the paperwork claims.
  await uploadAndProcess(
    tankReport(DAYS_AGO.tank4Surplus, [{ label: '4', book: 5_000, dip: 5_600 }]),
    stationA,
    'tank4-surplus.pdf'
  );

  // Tank 5 — a large shortfall with no threshold and no capacity to derive one from.
  await uploadAndProcess(
    tankReport(DAYS_AGO.tank5NoThreshold, [{ label: '5', book: 30_000, dip: 25_000 }]),
    stationA,
    'tank5-unmeasurable.pdf'
  );

  // Tank 3 — named by the reports, owned by no Tank row.
  for (const daysAgo of DAYS_AGO.unmapped) {
    await uploadAndProcess(
      tankReport(daysAgo, [{ label: '3', book: 10_000, dip: 9_800 }]),
      stationA,
      `tank3-${daysAgo}.pdf`
    );
  }

  // The other station's shift. Deliberately a *different* figure from station A's same-keyed
  // tank, so a leak total that merged the two by slug alone could not land on both answers.
  await uploadAndProcess(
    tankReport(DAYS_AGO.stationB, [{ label: '1', book: 9_000, dip: 8_400 }]),
    stationB,
    'station-b.pdf'
  );

  /*
   * Note the key: `1`, not `TANK_1`.
   *
   * The page reads `TANK 1 PMS 20,000 19,000` and the parser keys the tank by the identifier
   * after the word TANK, while station settings derives `TANK_1` from the name "Tank 1". The
   * two spellings never meet on their own, which is the mismatch that kept this module
   * blocked, and the reason the service matches on `tankIdentity` rather than on the slug.
   * The lookup below is written against the parser's spelling on purpose, so that a change
   * that quietly made the two agree would show up here.
   */
  const field = await prisma.extractedField.findFirst({
    where: {
      tenantId,
      shiftReportId: tank1AlertReportId,
      fieldName: 'tank:1:closing_dip',
    },
    select: { id: true },
  });
  if (!field) {
    throw new Error('The Tank 1 dip field was not extracted; the fixture no longer reaches the parser.');
  }
  tank1DipFieldId = field.id;
}, 180_000);

afterAll(async () => {
  await prisma.tank.deleteMany({ where: { tenantId } });
  await prisma.extractedField.deleteMany({ where: { tenantId } });
  await prisma.shiftReport.deleteMany({ where: { tenantId } });
  await prisma.station.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
}, 60_000);

function findTank(result: Awaited<ReturnType<typeof getTankLeakage>>, slug: string) {
  const tank = result.tanks.find((entry) => entry.slug === slug);
  if (!tank) {
    throw new Error(`No ${slug} in the leakage result: ${result.tanks.map((t) => t.slug).join(', ') || 'none'}`);
  }
  return tank;
}

async function leakageAt30Days(stationId?: string) {
  return withTenantScope(tenantId, () => getTankLeakage({ stationId: stationId ?? stationA, periodDays: 30 }));
}

describe('tank leakage', () => {
  it('reports book minus dip per shift, and adds them up over the period', async () => {
    const result = await leakageAt30Days();

    const tank2 = findTank(result, 'TANK_2');
    expect(tank2.shifts).toBe(4);
    expect(tank2.trend).toHaveLength(4);
    expect(tank2.trend.every((point) => point.varianceLitres === 30)).toBe(true);
    expect(tank2.varianceLitres).toBe(120);
    expect(tank2.worstShiftLitres).toBe(30);
  });

  it('orders the trend oldest first, so the line reads in the order the shifts were worked', async () => {
    const tank2 = findTank(await leakageAt30Days(), 'TANK_2');

    const dates = tank2.trend.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('counts a shift with no dip as incomparable instead of scoring it as zero', async () => {
    const tank2 = findTank(await leakageAt30Days(), 'TANK_2');

    // Five shifts name Tank 2; four could be compared. Had the missing dip been read as 0 L
    // this tank would carry an invented 8,000 L loss and head the whole screen.
    expect(tank2.shiftsNotComparable).toBe(1);
    expect(tank2.shifts).toBe(4);
    expect(tank2.varianceLitres).toBe(120);
  });

  it('alerts on one shift when a single shortfall clears the threshold', async () => {
    const tank1 = findTank(await leakageAt30Days(), 'TANK_1');

    // No threshold was set, so this is the 0.5% of 20,000 L fallback.
    expect(tank1.thresholdLitres).toBe(100);
    expect(tank1.alert?.signal).toBe('single_shift');
    expect(tank1.alert?.litres).toBe(1_000);
    expect(tank1.alert?.reportId).toBe(tank1AlertReportId);
  });

  it('writes the alert in a sentence a manager can read', async () => {
    const tank1 = findTank(await leakageAt30Days(), 'TANK_1');
    const message = tank1.alert?.message ?? '';

    // The alert is shown to a manager verbatim and is the whole reason the screen exists, so it
    // has to read as prose. The date in particular is spelled out: the machine-readable day is
    // carried alongside in `date`, and a raw ISO string inside a sentence is not the shape any
    // other date in this product is shown in.
    const shiftDay = new Date(Date.now() - DAYS_AGO.tank1Short * 24 * 60 * 60 * 1000);
    const spoken = shiftDay.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

    expect(message).toBe(
      `Short by 1,000 L on the ${spoken} shift — more than the 100 L this tank is allowed to be out by.`
    );
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // And the sentence and the machine field must name the same day, not merely both exist.
    expect(tank1.alert?.date).toBe(shiftDay.toISOString().slice(0, 10));
  });

  it('alerts on a run of small shortfalls that no single shift would reveal', async () => {
    const tank2 = findTank(await leakageAt30Days(), 'TANK_2');

    // Every shift is 30 L against a 40 L threshold — so this can only be caught by looking at
    // the shifts together, which is the entire point of the module.
    expect(tank2.thresholdLitres).toBe(40);
    expect(tank2.worstShiftLitres).toBeLessThan(tank2.thresholdLitres!);
    expect(tank2.alert?.signal).toBe('persistent_shortfall');
    expect(tank2.alert?.litres).toBe(120);
    expect(tank2.alert?.message).toMatch(/4 of 4 shifts/);
  });

  it('does not call a tank with more fuel than its book figure a leak', async () => {
    const tank4 = findTank(await leakageAt30Days(), 'TANK_4');

    expect(tank4.varianceLitres).toBe(-600);
    expect(tank4.alert).toBeNull();
    expect(tank4.worstShiftLitres).toBe(0);
  });

  it('will not alert on a tank with neither a threshold nor a capacity to derive one', async () => {
    const tank5 = findTank(await leakageAt30Days(), 'TANK_5');

    // The shortfall is real and huge, but the station has told us nothing about what this tank
    // should hold, so there is no honest line to draw. The figures are still shown.
    expect(tank5.thresholdLitres).toBeNull();
    expect(tank5.alert).toBeNull();
    expect(tank5.varianceLitres).toBe(5_000);
  });

  it('puts alerting tanks first, then the worst of the rest', async () => {
    const result = await leakageAt30Days();

    expect(result.tanks.map((tank) => tank.slug)).toEqual(['TANK_1', 'TANK_2', 'TANK_5', 'TANK_4']);
    expect(result.totals.tanksAlerting).toBe(2);
  });

  it('reports a tank the reports name but nothing owns, rather than dropping it', async () => {
    const result = await leakageAt30Days();

    // `3`, not `TANK_3`: this is the parser's spelling, and it is what a station settings
    // screen would have to offer a human to add the missing tank.
    expect(result.tanks.some((tank) => tank.slug === '3')).toBe(false);
    const tank3 = result.unmapped.find((entry) => entry.slug === '3');
    expect(tank3).toMatchObject({ stationId: stationA, shifts: 2, varianceLitres: 400 });
  });

  it('moves the totals with the period, because the window is the question', async () => {
    const thirty = await leakageAt30Days();
    const ninety = await withTenantScope(tenantId, () =>
      getTankLeakage({ stationId: stationA, periodDays: 90 })
    );

    // Tank 1 has a second, older shortfall 60 days back: outside a 30-day window, inside a
    // 90-day one. Same data, same tank, two honest answers.
    expect(findTank(thirty, 'TANK_1').varianceLitres).toBe(1_000);
    expect(findTank(ninety, 'TANK_1').varianceLitres).toBe(1_500);
    expect(findTank(ninety, 'TANK_1').shifts).toBe(2);
  });

  it('keeps two stations’ identically keyed tanks apart', async () => {
    const onlyA = await leakageAt30Days();
    const onlyB = await leakageAt30Days(stationB);

    expect(onlyA.tanks.every((tank) => tank.stationId === stationA)).toBe(true);
    expect(onlyB.tanks).toHaveLength(1);
    // Both stations have a TANK_1 and the two are not merged: 1,000 L missing at one,
    // 600 L at the other, where the figures differ precisely so a slug-only key would show
    // the same total on both.
    expect(findTank(onlyA, 'TANK_1').varianceLitres).toBe(1_000);
    expect(findTank(onlyB, 'TANK_1').varianceLitres).toBe(600);
    expect(findTank(onlyB, 'TANK_1').stationId).toBe(stationB);
  });

  it('shows a restricted caller only the stations they may see', async () => {
    const restricted = await withTenantScope(tenantId, () =>
      getTankLeakage({ periodDays: 30, restrictToStationIds: [stationB] })
    );

    expect(restricted.tanks.every((tank) => tank.stationId === stationB)).toBe(true);
    expect(restricted.tanks).toHaveLength(1);
  });

  it('gives a caller with no stations nothing, rather than everything', async () => {
    // `in: []` matches nothing. The failure this guards against is a fallback that reads an
    // empty assignment list as "unrestricted" and shows a manager every station in the tenant.
    const none = await withTenantScope(tenantId, () =>
      getTankLeakage({ periodDays: 30, restrictToStationIds: [] })
    );

    expect(none.tanks).toEqual([]);
    expect(none.unmapped).toEqual([]);
  });

  it('clears the alert when the dip it was built from is corrected', async () => {
    // The whole reason none of this is stored. A manager reads the shift, sees the tape says
    // 19,950 and not 19,000, and corrects it — and the leak has to be gone the moment they do,
    // not after some recompute step that may or may not have run.
    await withTenantScope(tenantId, () =>
      correctExtractedField(tank1DipFieldId, { parsedValue: '19950', note: 'tape reread' }, userId)
    );

    const tank1 = findTank(await leakageAt30Days(), 'TANK_1');
    expect(tank1.varianceLitres).toBe(50);
    expect(tank1.alert).toBeNull();

    // Put it back, so this test does not decide the outcome of the ones after it.
    await withTenantScope(tenantId, () =>
      correctExtractedField(tank1DipFieldId, { parsedValue: '19000' }, userId)
    );
    expect(findTank(await leakageAt30Days(), 'TANK_1').alert?.signal).toBe('single_shift');
  });

  it('brings a tank into the arithmetic when a correction supplies the figure it lacked', async () => {
    const flagged = await uploadAndProcess(
      tankReport(9, [{ label: '9', book: 40_000 }]),
      stationA,
      'tank9-review.pdf'
    );
    await prisma.tank.create({
      data: { tenantId, stationId: stationA, name: 'Tank 9', slug: 'TANK_9', capacityLitres: 40_000 },
    });

    const field = await prisma.extractedField.findFirst({
      where: { tenantId, shiftReportId: flagged, fieldName: 'tank:9:closing_dip' },
      select: { id: true },
    });
    expect(field).not.toBeNull();

    const tank9 = findTank(await leakageAt30Days(), 'TANK_9');
    // The dip is missing *and* flagged, so it is counted as incomparable and the tank has no
    // point to be provisional about — but the flag itself is what a later correction clears.
    expect(tank9.shiftsNotComparable).toBe(1);
    expect(tank9.shifts).toBe(0);

    await withTenantScope(tenantId, () =>
      correctExtractedField(field!.id, { parsedValue: '39500' }, userId)
    );

    const corrected = findTank(await leakageAt30Days(), 'TANK_9');
    expect(corrected.shifts).toBe(1);
    expect(corrected.varianceLitres).toBe(500);
    expect(corrected.provisional).toBe(false);
    expect(corrected.alert?.signal).toBe('single_shift');
  });
});
