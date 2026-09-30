/**
 * Integration tests for attendant micro-loss profiling.
 *
 * Four claims here are worth more than the rest of the file.
 *
 * The first is that the profile is *about a person*, not about a shift. Each of John Mwaka's
 * shifts is 50,000 short — inside the station's own 100,000 line, so nothing on the dashboard
 * would ever flag one of them. Three of them together are 150,000, and the point of this module
 * is that the aggregate is what nobody was computing. `John is short on every comparable shift`
 * is that claim.
 *
 * The second is that the signals are distinguishable at all. Grace Kimaro was balanced for four
 * shifts and has been short on the last three: her *total* is small and her short-share is below
 * the persistence line, so neither of the other two signals reaches her. What changed is her
 * own behaviour, and the only way to say that is against her own history.
 *
 * The third is that nothing is stored and nothing is destroyed by a link. Joining a second
 * spelling of a name moves shifts into a person's history and letting it go moves them back
 * out — with no report, field or total touched. `linking a spelling moves the shifts` is that.
 *
 * The fourth is that a key nobody has claimed is still reported. A name printed on a report
 * with no `Attendant` row behind it is exactly the case where a repeated shortfall has nowhere
 * to be recorded, so dropping it would leave the money with no trace at all.
 *
 * Same fixture caveat as the rest of the suite: the documents are built to the spec's structure
 * rather than captured from a live station, so this proves the arithmetic, the grouping and the
 * alerting, not the parser against real output.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { enqueuePdfParse } = vi.hoisted(() => ({ enqueuePdfParse: vi.fn(async () => {}) }));

vi.mock('../src/jobs/queues.js', () => ({ enqueuePdfParse }));

import { prisma, withTenantScope } from '../src/prisma/client.js';
import { createShiftReport, processShiftReport } from '../src/services/shiftReport.service.js';
import { getAttendantProfiles } from '../src/services/attendantProfile.service.js';
import { linkAttendantAlias, unlinkAttendantAlias } from '../src/services/station.service.js';
import { buildTextPdf } from './helpers/pdf.js';

const comma = new Intl.NumberFormat('en-US');

interface AttendantLine {
  name: string;
  expected: number;
  collected: number;
}

/**
 * A report carrying only the attendant section.
 *
 * `PETRONITE`, `SHIFT REPORT` and `ATTENDANTS` are three of the template markers, which is the
 * count a document needs before it is treated as a shift report at all — so this is the
 * smallest fixture that reaches the attendant arithmetic without dragging the money and tank
 * sections along behind it. `RECONCILIATION` closes the block.
 */
function attendantReport(daysAgo: number, rows: AttendantLine[]): string[] {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const stamp = [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('/');

  const lines = ['PETRONITE FUEL STATION', 'SHIFT REPORT', `Date: ${stamp}`, 'ATTENDANTS'];

  for (const row of rows) {
    lines.push(`${row.name}    ${comma.format(row.expected)}   ${comma.format(row.collected)}`);
  }

  lines.push('RECONCILIATION');

  return lines;
}

let storageDir: string;
let tenantId: string;
let stationA: string;
let stationB: string;

/** The station's own materiality line, well above every ordinary shortfall in the fixture. */
const THRESHOLD = 100_000;

/** The ages of the shifts the in-period assertions are built from. */
const DAYS_AGO = {
  /** John Mwaka — three shifts, each 50,000 short, every one of them under the threshold. */
  john: [9, 8, 7] as const,
  /** John again, outside a 30-day window and inside a 90-day one. */
  johnOld: 60,
  /** Grace Kimaro — balanced shifts first… */
  graceBalanced: [14, 13, 12, 11] as const,
  /** …then three short ones, which is the change the drift signal is for. */
  graceShort: [4, 3, 2] as const,
  /** Peter John — two surpluses and one large shortfall, so the median has something to be. */
  peterLarge: 5,
  peterSurplus: 4,
  peterOlderSurplus: 6,
  /** Aisha Said — net over the period despite one short shift. */
  aishaSurplus: 6,
  aishaShort: 3,
  /** The name nobody has claimed, on two separate shifts. */
  unclaimed: [6, 5] as const,
  /** The other station's shift, which a restricted caller must not see. */
  stationB: 2,
};

const SHORTFALL = {
  john: 50_000,
  johnOld: 30_000,
  grace: 10_000,
  peterLarge: 250_000,
  peterSurplus: 40_000,
  peterOlderSurplus: 30_000,
  aishaSurplus: 80_000,
  aishaShort: 20_000,
  unclaimed: 20_000,
  stationB: 90_000,
};

let johnAttendantId: string;
let graceAttendantId: string;

async function uploadAndProcess(lines: string[], stationId: string, fileName: string): Promise<string> {
  const { id } = await withTenantScope(tenantId, () =>
    createShiftReport({ tenantId, stationId, fileName, data: buildTextPdf(lines) })
  );
  await withTenantScope(tenantId, () => processShiftReport(id, tenantId));
  return id;
}

function short(name: string, amount: number): AttendantLine {
  return { name, expected: 1_000_000, collected: 1_000_000 - amount };
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'fuelflow-attendant-'));
  process.env.STORAGE_DIR = storageDir;

  const tenant = await prisma.tenant.create({ data: { name: 'Attendant Profile Test Tenant' } });
  tenantId = tenant.id;

  // A real materiality line, so a single large shortfall is distinguishable from the ordinary
  // ones. Left at the 0 default — as a freshly created station would be — every shortfall of
  // any size would read as a single-shift alert and the other two signals would never be
  // reached, which is the noise the schema's default is deliberately asking somebody to fix.
  const a = await prisma.station.create({
    data: { tenantId, name: 'Main Station', varianceThreshold: THRESHOLD },
  });
  stationA = a.id;
  const b = await prisma.station.create({ data: { tenantId, name: 'Second Station' } });
  stationB = b.id;

  const john = await prisma.attendant.create({
    data: { tenantId, stationId: stationA, name: 'John Mwaka', slug: 'JOHN_MWAKA' },
  });
  johnAttendantId = john.id;

  const grace = await prisma.attendant.create({
    data: { tenantId, stationId: stationA, name: 'Grace Kimaro', slug: 'GRACE_KIMARO' },
  });
  graceAttendantId = grace.id;

  await prisma.attendant.createMany({
    data: [
      { tenantId, stationId: stationA, name: 'Peter John', slug: 'PETER_JOHN' },
      { tenantId, stationId: stationA, name: 'Aisha Said', slug: 'AISHA_SAID' },
      { tenantId, stationId: stationA, name: 'Halima Juma', slug: 'HALIMA_JUMA' },
    ],
  });

  // A person of the same name on the other station. `JOHN_MWAKA` at two stations is two
  // different people, and anything keyed by slug alone would merge their histories.
  await prisma.attendant.create({
    data: { tenantId, stationId: stationB, name: 'John Mwaka', slug: 'JOHN_MWAKA' },
  });

  // John — three short shifts, none of them individually over the station's line.
  for (const daysAgo of DAYS_AGO.john) {
    await uploadAndProcess(
      attendantReport(daysAgo, [short('JOHN MWAKA', SHORTFALL.john)]),
      stationA,
      `john-${daysAgo}.pdf`
    );
  }

  // John — an older shortfall, outside a 30-day window.
  await uploadAndProcess(
    attendantReport(DAYS_AGO.johnOld, [short('JOHN MWAKA', SHORTFALL.johnOld)]),
    stationA,
    'john-old.pdf'
  );

  // Grace — four balanced shifts, then three short ones. The change is hers, not the station's.
  for (const daysAgo of DAYS_AGO.graceBalanced) {
    await uploadAndProcess(
      attendantReport(daysAgo, [{ name: 'GRACE KIMARO', expected: 1_000_000, collected: 1_000_000 }]),
      stationA,
      `grace-${daysAgo}.pdf`
    );
  }
  for (const daysAgo of DAYS_AGO.graceShort) {
    await uploadAndProcess(
      attendantReport(daysAgo, [short('GRACE KIMARO', SHORTFALL.grace)]),
      stationA,
      `grace-short-${daysAgo}.pdf`
    );
  }

  // Peter — one shortfall well over the line, and twice a shift where he handed over more than
  // he was due. Two surpluses rather than one, so his baseline is a median of three figures
  // and the choice of median over mean is doing something observable.
  await uploadAndProcess(
    attendantReport(DAYS_AGO.peterLarge, [short('PETER JOHN', SHORTFALL.peterLarge)]),
    stationA,
    'peter-large.pdf'
  );
  await uploadAndProcess(
    attendantReport(DAYS_AGO.peterSurplus, [
      {
        name: 'PETER JOHN',
        expected: 1_000_000,
        collected: 1_000_000 + SHORTFALL.peterSurplus,
      },
    ]),
    stationA,
    'peter-surplus.pdf'
  );
  await uploadAndProcess(
    attendantReport(DAYS_AGO.peterOlderSurplus, [
      {
        name: 'PETER JOHN',
        expected: 1_000_000,
        collected: 1_000_000 + SHORTFALL.peterOlderSurplus,
      },
    ]),
    stationA,
    'peter-older-surplus.pdf'
  );

  // Aisha — a large surplus that outweighs her one short shift.
  await uploadAndProcess(
    attendantReport(DAYS_AGO.aishaSurplus, [
      { name: 'AISHA SAID', expected: 1_000_000, collected: 1_000_000 + SHORTFALL.aishaSurplus },
    ]),
    stationA,
    'aisha-surplus.pdf'
  );
  await uploadAndProcess(
    attendantReport(DAYS_AGO.aishaShort, [short('AISHA SAID', SHORTFALL.aishaShort)]),
    stationA,
    'aisha-short.pdf'
  );

  // The unclaimed spelling — `J_MWANGI`, which is what `slugify('J. Mwangi')` produces and what
  // `JOHN_MWAKA` is not. No `Attendant` row answers to it until somebody links it.
  //
  // This is the shape the alias feature exists for, and it is also a regression guard on the
  // parser: until the attendant stripper was narrowed, the leading `J.` was eaten as a row index
  // and this key came out as `MWANGI`, which is what `P. Mwangi` produces too. Two different
  // people would have shared one profile.
  for (const daysAgo of DAYS_AGO.unclaimed) {
    await uploadAndProcess(
      attendantReport(daysAgo, [short('J. Mwangi', SHORTFALL.unclaimed)]),
      stationA,
      `unclaimed-${daysAgo}.pdf`
    );
  }

  // The other station's shift, deliberately a different figure so a total that merged the two
  // stations' `JOHN_MWAKA` could not land on both answers.
  await uploadAndProcess(
    attendantReport(DAYS_AGO.stationB, [short('JOHN MWAKA', SHORTFALL.stationB)]),
    stationB,
    'station-b.pdf'
  );

  /*
   * Halima's shift, written straight to the database rather than through the parser.
   *
   * This is the state a report is in when a manager has cleared a figure that was read wrong:
   * an `expected` with no `collected` beside it. The parser itself never emits that shape — it
   * writes both figures or a single `row` field — so the only way to test what the module does
   * with it is to put it there. The claim being tested is that the shift is counted as
   * incomparable and, above all, that it is not scored as a zero collected figure: that would
   * invent a shortfall the size of the whole day's takings on a named person's record.
   */
  const halimaDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  await prisma.shiftReport.create({
    data: {
      tenantId,
      stationId: stationA,
      status: 'PARSED',
      reportDate: halimaDate,
      uploadedAt: halimaDate,
      pdfFileName: 'halima-missing-collected.pdf',
      extractedFields: {
        create: [
          {
            tenantId,
            fieldName: 'attendant:HALIMA_JUMA:expected',
            label: 'HALIMA JUMA - to collect',
            group: 'ATTENDANT_RECONCILIATION',
            parsedValue: '2000000',
            amount: 2_000_000,
            confidence: 'LOW',
            needsReview: true,
            reviewNote: 'The collected figure for this attendant could not be read',
          },
        ],
      },
    },
  });
}, 240_000);

afterAll(async () => {
  await prisma.attendantAlias.deleteMany({ where: { tenantId } });
  await prisma.extractedField.deleteMany({ where: { tenantId } });
  await prisma.shiftReport.deleteMany({ where: { tenantId } });
  await prisma.attendant.deleteMany({ where: { tenantId } });
  await prisma.station.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
}, 60_000);

async function profilesAt30Days(stationId: string | null = stationA) {
  return withTenantScope(tenantId, () =>
    getAttendantProfiles({ stationId: stationId ?? undefined, periodDays: 30 })
  );
}

function findPerson(
  result: Awaited<ReturnType<typeof getAttendantProfiles>>,
  slug: string
) {
  const person = result.attendants.find((entry) => entry.slug === slug);
  if (!person) {
    throw new Error(
      `No ${slug} in the profile result: ${result.attendants.map((p) => p.slug).join(', ') || 'none'}`
    );
  }
  return person;
}

function findUnmapped(
  result: Awaited<ReturnType<typeof getAttendantProfiles>>,
  slug: string
) {
  const person = result.unmapped.find((entry) => entry.slug === slug);
  if (!person) {
    throw new Error(
      `No ${slug} in the unmapped list: ${result.unmapped.map((p) => p.slug).join(', ') || 'none'}`
    );
  }
  return person;
}

describe('attendant profiles', () => {
  it('adds up a run of shifts that are each too small to flag on their own', async () => {
    const john = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');

    // The claim in one place: 50,000 is under the 100,000 line, three of them are not.
    expect(john.worstShift).toBeLessThan(THRESHOLD);
    expect(john.shifts).toBe(3);
    expect(john.shiftsShort).toBe(3);
    expect(john.variance).toBe(3 * SHORTFALL.john);
    expect(john.alert?.signal).toBe('recurring_shortfall');
    expect(john.alert?.amount).toBe(3 * SHORTFALL.john);
  });

  it('carries the person’s name and station, not just the key the parser printed', async () => {
    const john = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');

    expect(john.name).toBe('John Mwaka');
    expect(john.stationId).toBe(stationA);
    expect(john.stationName).toBe('Main Station');
    expect(john.attendantId).toBe(johnAttendantId);
  });

  it('says a shortfall is provisional while a contributing figure is still flagged', async () => {
    // Halima's single figure needs review, so her shift may still move — but it contributes no
    // variance, so what is being asserted is that an unconfirmed figure never becomes a
    // number on its own.
    const halima = findPerson(await profilesAt30Days(), 'HALIMA_JUMA');

    expect(halima.shifts).toBe(0);
    expect(halima.shiftsNotComparable).toBe(1);
    expect(halima.variance).toBe(0);
    expect(halima.baselineVariance).toBeNull();
    expect(halima.alert).toBeNull();
  });

  it('reads a run of small shortfalls as a pattern rather than a bad week', async () => {
    const grace = findPerson(await profilesAt30Days(), 'GRACE_KIMARO');

    expect(grace.shifts).toBe(7);
    expect(grace.shiftsShort).toBe(3);
    expect(grace.variance).toBe(3 * SHORTFALL.grace);
    expect(grace.alert?.signal).toBe('worsening_drift');
  });

  it('points at the shift rather than the person when one shift is over the line', async () => {
    const peter = findPerson(await profilesAt30Days(), 'PETER_JOHN');

    expect(peter.worstShift).toBe(SHORTFALL.peterLarge);
    expect(peter.alert?.signal).toBe('single_shift');
    expect(peter.alert?.amount).toBe(SHORTFALL.peterLarge);
    // The alert names the shift, so the manager can open it — that is the whole difference
    // between this signal and the other two.
    expect(peter.alert?.reportId).not.toBeNull();
    expect(peter.alert?.date).not.toBeNull();
  });

  it('writes the single-shift alert in a sentence a manager can read', async () => {
    const peter = findPerson(await profilesAt30Days(), 'PETER_JOHN');
    const message = peter.alert?.message ?? '';
    const shiftDay = new Date(Date.now() - DAYS_AGO.peterLarge * 24 * 60 * 60 * 1000);
    const spoken = shiftDay.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

    expect(message).toBe(
      `Short by TZS ${comma.format(SHORTFALL.peterLarge)} on the ${spoken} shift — at or over this station's TZS ${comma.format(THRESHOLD)} line for a single shift.`
    );
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(peter.alert?.date).toBe(shiftDay.toISOString().slice(0, 10));
  });

  it('says nothing about a person who is net over the period', async () => {
    const aisha = findPerson(await profilesAt30Days(), 'AISHA_SAID');

    expect(aisha.variance).toBe(SHORTFALL.aishaShort - SHORTFALL.aishaSurplus);
    expect(aisha.variance).toBeLessThan(0);
    expect(aisha.alert).toBeNull();
  });

  it('uses the median shift as the baseline, so one large shortfall does not define it', async () => {
    // Peter's three shifts are -30,000, +250,000 and -40,000. Their *mean* is 60,000, which
    // would say his typical shift is 60,000 short — the opposite of the truth, and it would
    // make every later shift read as an improvement on a normal he never had. His typical
    // shift is the median, -30,000, which is what a reader of "their usual shift" means.
    const peter = findPerson(await profilesAt30Days(), 'PETER_JOHN');

    expect(peter.shifts).toBe(3);
    expect(peter.baselineVariance).toBe(-SHORTFALL.peterOlderSurplus);
    expect(peter.recentVariance).toBe(
      (SHORTFALL.peterLarge - SHORTFALL.peterSurplus - SHORTFALL.peterOlderSurplus) / 3
    );
  });

  it('keeps the trend oldest first, so it reads in the order the shifts were worked', async () => {
    const grace = findPerson(await profilesAt30Days(), 'GRACE_KIMARO');
    const dates = grace.trend.map((point) => point.date);

    expect(dates).toEqual([...dates].sort());
    expect(grace.trend).toHaveLength(7);
    // The last three are the change: this is the ordering the drift signal depends on.
    expect(grace.trend.slice(-3).every((point) => point.variance > 0)).toBe(true);
    expect(grace.trend.slice(0, 4).every((point) => point.variance === 0)).toBe(true);
  });

  it('counts what the person collected, so a shortfall has a scale', async () => {
    const john = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');

    expect(john.collected).toBe(3 * (1_000_000 - SHORTFALL.john));
  });

  it('keeps an unclaimed name instead of dropping it', async () => {
    const result = await profilesAt30Days();
    const unclaimed = findUnmapped(result, 'J_MWANGI');

    expect(unclaimed.shifts).toBe(2);
    expect(unclaimed.variance).toBe(2 * SHORTFALL.unclaimed);
    // The screen offers to link this name, and a person recognises the name the report
    // printed far sooner than they recognise the key it produced.
    expect(unclaimed.name).toBe('J. Mwangi');
    expect(unclaimed.stationName).toBe('Main Station');

    // And it is not double-counted: nobody has claimed it, so it is not in anyone's profile.
    expect(result.attendants.some((person) => person.slug === 'J_MWANGI')).toBe(false);
  });

  it('separates the same printed name at two different stations', async () => {
    const result = await profilesAt30Days(null);
    const matches = result.attendants.filter((person) => person.slug === 'JOHN_MWAKA');

    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((person) => person.stationId))).toEqual(
      new Set([stationA, stationB])
    );
    // The station's own `JOHN_MWAKA` is still the three-shift one, not a merge of the two.
    expect(findPerson(result, 'JOHN_MWAKA').stationId).toBe(stationA);
    expect(matches.find((person) => person.stationId === stationB)?.variance).toBe(
      SHORTFALL.stationB
    );
  });

  it('lists whoever is worst first, with a surplus below everyone who is short', async () => {
    const result = await profilesAt30Days();
    const order = result.attendants.map((person) => person.slug);

    // Every alerting person ahead of every person who is not, however large a surplus is —
    // the question this screen answers is where money is going.
    expect(order.slice(0, 3)).toEqual(['PETER_JOHN', 'JOHN_MWAKA', 'GRACE_KIMARO']);
    expect(order.indexOf('AISHA_SAID')).toBeGreaterThan(order.indexOf('HALIMA_JUMA'));
  });

  it('totals the period', async () => {
    const { totals } = await profilesAt30Days();

    expect(totals.attendants).toBe(5);
    expect(totals.shiftsAnalysed).toBe(15);
    expect(totals.variance).toBe(
      3 * SHORTFALL.john +
        3 * SHORTFALL.grace +
        (SHORTFALL.peterLarge - SHORTFALL.peterSurplus - SHORTFALL.peterOlderSurplus) +
        (SHORTFALL.aishaShort - SHORTFALL.aishaSurplus)
    );
    expect(totals.attendantsShort).toBe(3);
    expect(totals.attendantsAlerting).toBe(3);
    // Reported so the screen can say what "over the line" was judged against.
    expect(totals.varianceThreshold).toBe(THRESHOLD);
  });

  it('moves the window the period asks for', async () => {
    const thirty = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');
    const ninety = findPerson(
      await withTenantScope(tenantId, () =>
        getAttendantProfiles({ stationId: stationA, periodDays: 90 })
      ),
      'JOHN_MWAKA'
    );

    expect(thirty.shifts).toBe(3);
    expect(ninety.shifts).toBe(4);
    expect(ninety.variance).toBe(3 * SHORTFALL.john + SHORTFALL.johnOld);
  });

  it('shows one station to a caller restricted to one station', async () => {
    const result = await withTenantScope(tenantId, () =>
      getAttendantProfiles({ periodDays: 30, restrictToStationIds: [stationA] })
    );

    expect(result.attendants.every((person) => person.stationId === stationA)).toBe(true);
    expect(result.attendants.some((person) => person.stationId === stationB)).toBe(false);
    expect(result.totals.attendants).toBe(5);
  });

  it('shows a restricted caller nothing rather than everything when they have no stations', async () => {
    // The empty array is the case that reads as "no restriction" if it is written as a falsy
    // check anywhere along the way, and the result would be one manager seeing the tenant.
    const result = await withTenantScope(tenantId, () =>
      getAttendantProfiles({ periodDays: 30, restrictToStationIds: [] })
    );

    expect(result.attendants).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.totals.attendants).toBe(0);
  });
});

describe('attendant name links', () => {
  it('moves the shifts into the person’s history, and back out again', async () => {
    const before = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');
    expect(before.shifts).toBe(3);

    const linked = await withTenantScope(tenantId, () =>
      linkAttendantAlias(tenantId, stationA, johnAttendantId, { slug: 'J_MWANGI' })
    );
    expect(linked.aliases).toEqual(['J_MWANGI']);

    const after = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');
    expect(after.shifts).toBe(5);
    expect(after.variance).toBe(3 * SHORTFALL.john + 2 * SHORTFALL.unclaimed);
    /*
     * One profile, not two.
     *
     * This is the assertion that pins the link to being a *merge*. Resolving each printed key
     * to a person and then still bucketing by the key would leave John Mwaka in the list twice
     * — once with three shifts and once with two — each judged on its own, and a shortfall that
     * only exists across the two would go unseen by every signal. Two people's money, one name,
     * and no error anywhere: the failure mode this whole module exists to avoid.
     */
    const result = await profilesAt30Days();
    expect(result.attendants.filter((person) => person.slug === 'JOHN_MWAKA')).toHaveLength(1);
    expect(result.attendants).toHaveLength(5);
    // And the key is gone from the unclaimed list, which is what makes the link worth making.
    expect(result.unmapped.some((person) => person.slug === 'J_MWANGI')).toBe(false);

    /*
     * Nothing was rewritten. The link is a row, so letting it go puts the shifts back under the
     * unclaimed name — no report, no field and no total was touched by either operation, which
     * is the property that makes this safe to do from a screen with no confirmation step.
     */
    await withTenantScope(tenantId, () => unlinkAttendantAlias(stationA, johnAttendantId, 'J_MWANGI'));

    const restored = findPerson(await profilesAt30Days(), 'JOHN_MWAKA');
    expect(restored.shifts).toBe(3);
    expect(restored.variance).toBe(3 * SHORTFALL.john);
    expect(findUnmapped(await profilesAt30Days(), 'J_MWANGI').shifts).toBe(2);
  });

  it('derives the key from a name when that is what the caller has', async () => {
    // The unmapped list holds a key, but somebody filling in a settings form holds the
    // spelling as the paper prints it. Both have to resolve to a key the parser would write.
    const linked = await withTenantScope(tenantId, () =>
      linkAttendantAlias(tenantId, stationA, graceAttendantId, { name: 'G. Kimaro' })
    );

    expect(linked.aliases).toEqual(['G_KIMARO']);

    await withTenantScope(tenantId, () => unlinkAttendantAlias(stationA, graceAttendantId, 'G_KIMARO'));
  });

  it('refuses a key that is already somebody else’s own', async () => {
    // The profile service resolves an exact slug before any alias, so this link would be
    // created, appear on the settings screen, and never take effect. Better a 409 that says so.
    await expect(
      withTenantScope(tenantId, () =>
        linkAttendantAlias(tenantId, stationA, johnAttendantId, { slug: 'GRACE_KIMARO' })
      )
    ).rejects.toThrow(/already belongs to/);
  });

  it('refuses a key the attendant already answers to', async () => {
    await expect(
      withTenantScope(tenantId, () =>
        linkAttendantAlias(tenantId, stationA, johnAttendantId, { slug: 'JOHN_MWAKA' })
      )
    ).rejects.toThrow(/own key/);
  });

  it('does not touch a spelling that is not joined', async () => {
    await expect(
      withTenantScope(tenantId, () => unlinkAttendantAlias(stationA, johnAttendantId, 'NEVER_LINKED'))
    ).rejects.toThrow(/not joined/);
  });
});
