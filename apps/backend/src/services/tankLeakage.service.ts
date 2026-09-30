import type {
  TankLeakageAlert,
  TankLeakagePoint,
  TankLeakageResponse,
  TankLeakageTank,
  UnmappedTank,
} from '@fuelflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { tankReadingsFromFields } from '../parsing/tankVariance.js';
import { tankIdentity } from '../parsing/slug.js';
import type { SummaryInput } from '../parsing/types.js';

/**
 * Wet-stock leakage: is a tank losing fuel that nobody is accounting for?
 *
 * ## Why this is computed rather than stored
 *
 * The variance comes out of two figures the parser read, and a manager can correct either of
 * them. Storing the subtraction would mean the leak screen kept reporting the number the
 * parser got wrong until something remembered to recompute — and the shift where a misread
 * dip was corrected is exactly the shift a manager is looking at when they open this screen.
 * So nothing is stored: every load re-derives from the fields, the same way the money
 * variance does, and a correction moves the leak number immediately.
 *
 * ## Two signals, because a leak and a robbery are different shapes
 *
 * A robbery is one large shortfall. A leak is a small one repeated until the tank is dry, and
 * no single shift of it would ever be worth a phone call — which is precisely why it survives
 * so long at a station that only looks at daily figures. Alerting on the daily figure alone
 * would catch the first and never the second, so both are tested and reported distinctly.
 */

/**
 * How many reports the period is drawn from.
 *
 * The same in-memory period filter as the dashboard, and the same reason: a report's shift
 * date is what puts it in the window, and `reportDate` falls back to `uploadedAt` when the
 * parser could not read one, which is not an indexable predicate. The cap bounds the scan; a
 * station producing more than 300 shift reports in the window is past the scale this answers
 * for. It drops the oldest reports, so the trend starts later rather than being distorted.
 */
const MAX_SCANNED_REPORTS = 300;

const DEFAULT_PERIOD_DAYS = 30;

/**
 * The fallback single-shift threshold, as a fraction of tank capacity.
 *
 * 0.5% is roughly where tank gauging noise stops explaining a difference: on a 20,000 L tank
 * it is 100 L, which is about the smallest figure that is not the tape, the temperature or a
 * misplaced decimal point. Used only when the station has set no threshold of its own.
 */
const DEFAULT_LEAK_THRESHOLD_FRACTION = 0.005;

/**
 * Comparable shifts needed before "this keeps happening" is a fair thing to say.
 *
 * Two shifts agreeing is a coincidence. Three shortfalls in one direction on one tank is
 * already hard to explain without the tank being involved.
 */
const PERSISTENCE_MIN_SHIFTS = 3;

/**
 * Share of comparable shifts that must be short for it to read as a property of the tank
 * rather than of the reading.
 *
 * Deliberately a majority and not all: a dipstick read after a delivery landed, or a shift
 * where the tape was misread by 50 L, is normal, and requiring every shift would mean a real
 * leak stopped alerting the first time somebody happened to record it correctly.
 */
const PERSISTENCE_SHORT_SHARE = 0.6;

const litreFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function litres(value: number): string {
  return `${litreFormat.format(Math.round(value))} L`;
}

/** An ISO day, which is all the trend and the alert messages need. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const spokenDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  // The day is already fixed by `dayKey`; formatting it in the server's own zone would put a
  // report filed on the 1st into the previous month for anyone running east of UTC.
  timeZone: 'UTC',
});

/**
 * `2026-09-30` -> `30 Sep 2026`, for a date a person reads.
 *
 * `dayKey` is the right shape for a field a client sorts or compares, and the wrong one inside
 * a sentence: the alert is shown to a manager as written, and every other date in the product
 * reads `30 Sep 2026`. The two shapes are kept apart rather than one being derived from the
 * other so that neither can drift into the other's job.
 */
function spokenDate(isoDay: string): string {
  const parsed = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDay;
  }
  return spokenDateFormat.format(parsed);
}

export interface TankLeakageOptions {
  periodDays?: number;
  /** One station, already access-checked by the route. */
  stationId?: string;
  /**
   * The stations this user may see at all. `undefined` means every station in the tenant (an
   * owner); an empty array means none and must yield an empty result rather than a full one.
   * The tenant is not a parameter — the Prisma extension scopes `ShiftReport` and `Tank` to
   * the request's tenant on its own.
   */
  restrictToStationIds?: string[];
}

/** A tank's figures while they are being accumulated, before the verdict is decided. */
interface Accumulator {
  stationId: string;
  stationName: string | null;
  slug: string;
  points: TankLeakagePoint[];
  /** Shifts the tank appeared on where a figure was missing, so nothing could be compared. */
  shiftsNotComparable: number;
}

/**
 * The threshold a tank is actually measured against.
 *
 * Reported back to the screen as the figure used, not the figure stored, so the screen and
 * the alert can never disagree about what "too much" meant for a given tank. Returning null
 * is a real answer: with neither a threshold nor a capacity there is no honest line to draw,
 * and such a tank is shown with its numbers but never alerted on alone.
 */
function resolveThreshold(tank: {
  leakThresholdLitres: number | null;
  capacityLitres: number | null;
}): number | null {
  if (tank.leakThresholdLitres !== null && tank.leakThresholdLitres > 0) {
    return tank.leakThresholdLitres;
  }
  if (tank.capacityLitres !== null && tank.capacityLitres > 0) {
    return Math.round(tank.capacityLitres * DEFAULT_LEAK_THRESHOLD_FRACTION);
  }
  return null;
}

/**
 * Decide whether a tank is worth telling somebody about.
 *
 * Single-shift is tested first and wins: if one shift already crossed the line the manager
 * needs that shift, not a summary of a month.
 */
function decideAlert(input: {
  thresholdLitres: number | null;
  varianceLitres: number;
  worstShiftLitres: number;
  worstShift: TankLeakagePoint | null;
  shifts: number;
  shiftsShort: number;
}): TankLeakageAlert | null {
  const { thresholdLitres, varianceLitres, worstShiftLitres, worstShift, shifts, shiftsShort } = input;

  if (thresholdLitres === null) {
    return null;
  }

  if (worstShiftLitres >= thresholdLitres && worstShift) {
    return {
      signal: 'single_shift',
      message: `Short by ${litres(worstShiftLitres)} on the ${spokenDate(
        worstShift.date
      )} shift — more than the ${litres(thresholdLitres)} this tank is allowed to be out by.`,
      reportId: worstShift.reportId,
      date: worstShift.date,
      litres: worstShiftLitres,
    };
  }

  // The leak that no single shift reveals. Every shift here is individually unremarkable;
  // it is the repetition and the accumulation that make it worth acting on.
  const shortShare = shifts > 0 ? shiftsShort / shifts : 0;
  if (
    shifts >= PERSISTENCE_MIN_SHIFTS &&
    shortShare >= PERSISTENCE_SHORT_SHARE &&
    varianceLitres >= thresholdLitres
  ) {
    return {
      signal: 'persistent_shortfall',
      message: `Short on ${shiftsShort} of ${shifts} shifts, ${litres(
        varianceLitres
      )} in total. A loss this slow is inside the noise of any one shift and only shows up when they are added together.`,
      reportId: null,
      date: null,
      litres: varianceLitres,
    };
  }

  return null;
}

/** The columns of a `Tank` this module reads. */
type IndexedTank = {
  id: string;
  stationId: string;
  name: string;
  slug: string;
  product: string | null;
  capacityLitres: number | null;
  leakThresholdLitres: number | null;
};

/**
 * Build the parsed-slug-to-`Tank` lookup for a set of stations.
 *
 * The two sides do not spell a tank the same way — the parser keys the row `TANK 1 PMS …` as
 * `1` while station settings keys the name "Tank 1" as `TANK_1` — so matching is done on the
 * identity behind both spellings. See `tankIdentity` for why that is a rule rather than a
 * change to either side.
 *
 * An exact slug match wins over a normalised one. Both spellings are legal values for a
 * `Tank.slug`, so a station that has somehow ended up with a row for each would otherwise have
 * its readings land on whichever row the database happened to return first.
 */
function indexTanks(tanks: IndexedTank[]): (stationId: string, parsedSlug: string) => IndexedTank | undefined {
  const exact = new Map<string, IndexedTank>();
  const normalised = new Map<string, IndexedTank>();

  for (const tank of tanks) {
    const exactKey = `${tank.stationId}:${tank.slug}`;
    if (!exact.has(exactKey)) {
      exact.set(exactKey, tank);
    }

    const identityKey = `${tank.stationId}:${tankIdentity(tank.slug)}`;
    if (!normalised.has(identityKey)) {
      normalised.set(identityKey, tank);
    }
  }

  return (stationId, parsedSlug) =>
    exact.get(`${stationId}:${parsedSlug}`) ?? normalised.get(`${stationId}:${tankIdentity(parsedSlug)}`);
}

export async function getTankLeakage(
  options: TankLeakageOptions = {}
): Promise<TankLeakageResponse> {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
  const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;

  const where: Prisma.ShiftReportWhereInput = options.stationId
    ? { stationId: options.stationId }
    : options.restrictToStationIds
      ? { stationId: { in: options.restrictToStationIds } }
      : {};

  const [reports, tanks] = await Promise.all([
    prisma.shiftReport.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      take: MAX_SCANNED_REPORTS,
      select: {
        id: true,
        stationId: true,
        reportDate: true,
        uploadedAt: true,
        station: { select: { name: true } },
        // Only what the tank arithmetic reads. The review screen's labels and region text
        // are of no use to a leak total, and selecting them would multiply the payload of a
        // query that runs over every report in the period.
        extractedFields: { select: { fieldName: true, amount: true, needsReview: true } },
      },
    }),
    prisma.tank.findMany({
      where: options.stationId
        ? { stationId: options.stationId }
        : options.restrictToStationIds
          ? { stationId: { in: options.restrictToStationIds } }
          : {},
      select: {
        id: true,
        stationId: true,
        name: true,
        slug: true,
        product: true,
        capacityLitres: true,
        leakThresholdLitres: true,
      },
    }),
  ]);

  /** Keyed `stationId:slug`, because `TANK_1` at two stations is two different tanks. */
  const accumulators = new Map<string, Accumulator>();
  /** Distinct report ids that contributed at least one tank reading. */
  const shiftsAnalysed = new Set<string>();

  for (const report of reports) {
    // The shift's own date puts it in the window; the upload date is the fallback for a
    // report whose date was never read. Same rule as the dashboard, so the two screens
    // never disagree about which shifts a period contains.
    const effective = report.reportDate ?? report.uploadedAt;
    if (effective.getTime() < since) {
      continue;
    }

    const readings = tankReadingsFromFields(report.extractedFields as SummaryInput[]);
    if (readings.length === 0) {
      continue;
    }

    shiftsAnalysed.add(report.id);

    for (const reading of readings) {
      const key = `${report.stationId}:${reading.slug}`;
      const accumulator = accumulators.get(key) ?? {
        stationId: report.stationId,
        stationName: report.station?.name ?? null,
        slug: reading.slug,
        points: [],
        shiftsNotComparable: 0,
      };

      if (reading.varianceLitres === null) {
        // The tank was on the report but a figure was missing. Counted, never treated as
        // zero: a missing dip is not a full tank, and scoring it as one would either invent
        // a loss the size of the book figure or hide a real one behind a bad reading.
        accumulator.shiftsNotComparable += 1;
      } else {
        accumulator.points.push({
          reportId: report.id,
          date: dayKey(effective),
          varianceLitres: reading.varianceLitres,
          provisional: reading.provisional,
        });
      }

      accumulators.set(key, accumulator);
    }
  }

  const tankByKey = indexTanks(tanks);

  const mapped: TankLeakageTank[] = [];
  const unmapped: UnmappedTank[] = [];

  for (const accumulator of accumulators.values()) {
    // Oldest first, so the trend reads in the order the shifts were worked and ties on one
    // day keep the order they were uploaded in.
    const points = [...accumulator.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const varianceLitres = points.reduce((sum, point) => sum + point.varianceLitres, 0);
    const shortfalls = points.filter((point) => point.varianceLitres > 0);
    const worstShift = shortfalls.reduce<TankLeakagePoint | null>(
      (worst, point) => (worst === null || point.varianceLitres > worst.varianceLitres ? point : worst),
      null
    );
    const worstShiftLitres = worstShift?.varianceLitres ?? 0;

    const tank = tankByKey(accumulator.stationId, accumulator.slug);

    // A slug with no `Tank` row is not dropped. The station's reports name a tank the
    // settings do not, and the leak on it is as real as any other — the screen asks for it
    // to be named rather than quietly leaving it out of the total.
    if (!tank) {
      unmapped.push({
        stationId: accumulator.stationId,
        stationName: accumulator.stationName,
        slug: accumulator.slug,
        shifts: points.length,
        varianceLitres,
      });
      continue;
    }

    const thresholdLitres = resolveThreshold(tank);
    const shifts = points.length;

    mapped.push({
      tankId: tank.id,
      name: tank.name,
      slug: tank.slug,
      stationId: accumulator.stationId,
      stationName: accumulator.stationName,
      product: tank.product,
      capacityLitres: tank.capacityLitres,
      thresholdLitres,
      varianceLitres,
      worstShiftLitres,
      shifts,
      shiftsShort: shortfalls.length,
      shiftsNotComparable: accumulator.shiftsNotComparable,
      capacityPercent:
        tank.capacityLitres && tank.capacityLitres > 0
          ? (varianceLitres / tank.capacityLitres) * 100
          : null,
      provisional: points.some((point) => point.provisional),
      alert: decideAlert({
        thresholdLitres,
        varianceLitres,
        worstShiftLitres,
        worstShift,
        shifts,
        shiftsShort: shortfalls.length,
      }),
      trend: points,
    });
  }

  // Worst first: anything carrying an alert, then by the litres that went missing. A tank
  // that is *over* its book figure is not a leak and sorts below every tank that is short,
  // however large its surplus — the question this screen answers is where fuel is going.
  mapped.sort((a, b) => {
    const aAlerting = a.alert ? 1 : 0;
    const bAlerting = b.alert ? 1 : 0;
    if (aAlerting !== bAlerting) {
      return bAlerting - aAlerting;
    }
    return b.varianceLitres - a.varianceLitres;
  });

  unmapped.sort((a, b) => b.varianceLitres - a.varianceLitres);

  return {
    periodDays,
    generatedAt: new Date().toISOString(),
    stationId: options.stationId ?? null,
    tanks: mapped,
    unmapped,
    totals: {
      tanks: mapped.length,
      shiftsAnalysed: shiftsAnalysed.size,
      varianceLitres: mapped.reduce((sum, tank) => sum + tank.varianceLitres, 0),
      tanksShort: mapped.filter((tank) => tank.varianceLitres > 0).length,
      tanksAlerting: mapped.filter((tank) => tank.alert !== null).length,
    },
  };
}
