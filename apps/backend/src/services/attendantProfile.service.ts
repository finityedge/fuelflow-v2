import type {
  AttendantLossAlert,
  AttendantProfile,
  AttendantProfilesResponse,
  AttendantVariancePoint,
  MyAttendantProfile,
  UnmappedAttendant,
} from '@fuelflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { attendantReadingsFromFields } from '../parsing/attendantVariance.js';
import type { AttendantFieldInput } from '../parsing/attendantVariance.js';

/**
 * Attendant micro-loss profiling: who is quietly short, and has it changed?
 *
 * ## Why this exists at all
 *
 * The dashboard already shows that a shift came up short. What it cannot show is that the
 * *same person* came up short by a small amount on eleven of their last fourteen shifts,
 * because each of those shifts is individually inside the station's tolerance and therefore
 * indistinguishable from a busy day. The loss is not in any shift; it is in the aggregate, and
 * the aggregate has never been computed.
 *
 * ## Why nothing is stored
 *
 * Same reason as the tank side: the variance comes out of two figures the parser read and a
 * manager can correct, so storing it would mean the profile kept reporting the figure the
 * parser got wrong until something recomputed. Every load re-derives from the fields.
 *
 * ## Why there are three signals and not one
 *
 * "Short" is not one kind of event. One large shortfall is a question about a shift; a run of
 * small ones is a question about a person; a *change* in a person's own pattern is a question
 * about what happened to them. A station-wide threshold can raise only the first, because the
 * other two are statements about an individual's history and there is nothing station-wide to
 * compare them against. So the drift signal is defined without reference to any threshold at
 * all — see `decideAlert`.
 */

/**
 * How many reports the period is drawn from.
 *
 * The same in-memory period filter as the dashboard and the leakage screen, and the same
 * reason: a report's shift date is what puts it in the window, and `reportDate` falls back to
 * `uploadedAt` when the parser could not read one, which is not an indexable predicate.
 */
const MAX_SCANNED_REPORTS = 300;

const DEFAULT_PERIOD_DAYS = 30;

/**
 * Comparable shifts needed before "this keeps happening" is a fair thing to say.
 *
 * Two short shifts agreeing is a coincidence. Three in the same direction on one person is
 * already hard to explain without the person being involved.
 */
const PERSISTENCE_MIN_SHIFTS = 3;

/**
 * Share of comparable shifts that must be short for it to read as a property of the person
 * rather than of the week they had.
 *
 * Deliberately a majority and not all. Requiring every shift would mean a real pattern stopped
 * being reported the first time somebody balanced to the shilling, which is exactly what
 * happens when a person knows they are being watched.
 */
const PERSISTENCE_SHORT_SHARE = 0.6;

/**
 * The window `worsening_drift` compares against everything before it.
 *
 * Three is the shortest run that is a run rather than a bad afternoon, and it is checked
 * against `PERSISTENCE_MIN_SHIFTS` deliberately: a person whose recent shifts are all short
 * *and* whose earlier ones mostly were too is not drifting, they are the `recurring_shortfall`
 * case, and the two signals should not both fire and say the same thing twice.
 */
const DRIFT_WINDOW = 3;

/**
 * The share of earlier shifts that may have been short before "this has changed" stops being
 * the honest description.
 *
 * Below a half: if most of their earlier shifts were short as well, nothing has changed and
 * the pattern is the recurring one.
 */
const DRIFT_PRIOR_SHORT_SHARE_CEILING = 0.5;

const moneyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function shillings(value: number): string {
  return `${value < 0 ? '-' : ''}TZS ${moneyFormat.format(Math.abs(Math.round(value)))}`;
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

/** `2026-09-30` -> `30 Sep 2026`, for a date a person reads. */
function spokenDate(isoDay: string): string {
  const parsed = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDay;
  }
  return spokenDateFormat.format(parsed);
}

export interface AttendantProfileOptions {
  periodDays?: number;
  /** One station, already access-checked by the route. */
  stationId?: string;
  /**
   * The stations this user may see at all. `undefined` means every station in the tenant (an
   * owner); an empty array means none and must yield an empty result rather than a full one.
   * The tenant is not a parameter — the Prisma extension scopes the models on its own.
   */
  restrictToStationIds?: string[];
}

/**
 * One person's figures while they are being accumulated, before the verdict is decided.
 *
 * One of these per *person*, not per printed name. Every spelling that resolved to the same
 * `Attendant` — their own key, and each name joined to them — lands in the same accumulator,
 * which is the whole point of a link: joining "J. Mwangi" to John Mwaka has to make one
 * history out of the two, not a second John Mwaka with half as many shifts.
 */
interface Accumulator {
  stationId: string;
  stationName: string | null;
  /** The `Attendant` this belongs to, or null for a name nobody has claimed. */
  attendant: IndexedAttendant | null;
  /** The key the parser printed. What the link prompt shows, and the identity of a stray name. */
  parsedSlug: string;
  /** The name as the first report that carried one printed it. Used when nobody is named. */
  label: string | null;
  points: AttendantVariancePoint[];
  /** Shifts the person appeared on where a figure was missing, so nothing was compared. */
  shiftsNotComparable: number;
  collected: number;
}

/**
 * The median of a list. Zero for an empty list.
 *
 * The median rather than the mean is what makes a baseline usable: one large shortfall — the
 * very event the "one large shift" signal is for — would drag a mean far enough that the
 * person's *typical* shift looked worse than it is, and every following shift would then read
 * as an improvement.
 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Decide whether an attendant is worth telling somebody about.
 *
 * `single_shift` is tested first and wins: if one shift already crossed the station's own
 * materiality line, the manager needs that shift, not a summary of a month.
 *
 * `worsening_drift` deliberately takes no threshold. Any figure invented here would be a
 * business judgement made on a station's behalf, and the codebase already refuses to do that
 * with `Station.varianceThreshold` — a station that has not chosen a tolerance gets told about
 * everything rather than having one invented for it. Drift is instead a statement that needs
 * no invented number: their recent shifts were all short and their earlier ones were not.
 */
function decideAlert(input: {
  attendance: {
    variance: number;
    worstShift: number;
    worstShiftPoint: AttendantVariancePoint | null;
    shifts: number;
    shiftsShort: number;
    recentWindow: AttendantVariancePoint[];
    earlierShifts: AttendantVariancePoint[];
  };
  varianceThreshold: number;
}): AttendantLossAlert | null {
  const { variance, worstShift, worstShiftPoint, shifts, shiftsShort, recentWindow, earlierShifts } =
    input.attendance;

  if (worstShift > 0 && worstShift >= input.varianceThreshold && worstShiftPoint) {
    return {
      signal: 'single_shift',
      message: `Short by ${shillings(worstShift)} on the ${spokenDate(
        worstShiftPoint.date
      )} shift — at or over this station's ${shillings(input.varianceThreshold)} line for a single shift.`,
      reportId: worstShiftPoint.reportId,
      date: worstShiftPoint.date,
      amount: worstShift,
    };
  }

  // Small amounts, same direction, often enough to have added up. Every shift here is
  // individually unremarkable, which is the whole reason it survives.
  const shortShare = shifts > 0 ? shiftsShort / shifts : 0;
  if (shifts >= PERSISTENCE_MIN_SHIFTS && shortShare >= PERSISTENCE_SHORT_SHARE && variance > 0) {
    return {
      signal: 'recurring_shortfall',
      message: `Short on ${shiftsShort} of ${shifts} shifts, ${shillings(
        variance
      )} in total. No single one of those shifts was large enough to be worth a second look.`,
      reportId: null,
      date: null,
      amount: variance,
    };
  }

  // What changed. Tested against their own history rather than the station's, because the
  // question is whether this person's behaviour moved, not whether it is unusual in general.
  if (shifts >= DRIFT_WINDOW + 1 && recentWindow.length === DRIFT_WINDOW) {
    const recentAllShort = recentWindow.every((point) => point.variance > 0);
    const earlierShort = earlierShifts.filter((point) => point.variance > 0).length;
    const earlierShortShare = earlierShifts.length > 0 ? earlierShort / earlierShifts.length : 0;

    if (recentAllShort && earlierShortShare < DRIFT_PRIOR_SHORT_SHARE_CEILING) {
      const recentTotal = recentWindow.reduce((sum, point) => sum + point.variance, 0);
      return {
        signal: 'worsening_drift',
        message: `Their last ${DRIFT_WINDOW} shifts were all short — ${shillings(
          recentTotal
        )} together — where the ${earlierShifts.length} before them were not.`,
        reportId: null,
        date: null,
        amount: recentTotal,
      };
    }
  }

  return null;
}

/** The columns of an `Attendant` this module reads. */
type IndexedAttendant = {
  id: string;
  stationId: string;
  name: string;
  slug: string;
  userId: string | null;
};

/**
 * Build the parsed-slug-to-`Attendant` lookup for a set of stations.
 *
 * Two things can put a parsed key on an attendant, and they are checked in that order:
 *
 *   1. the key **is** their slug — the common case, because the parser and the settings screen
 *      both derive it with `slugify` from the same name;
 *   2. the key has been **linked** to them as an alias, which is how "J. Mwangi" joins
 *      "John Mwangi" after somebody says the two are the same person.
 *
 * An exact match is checked first so that linking a name can never take a person's own key away
 * from them — the alias mechanism is for keys nothing else claims.
 */
function indexAttendants(
  attendants: IndexedAttendant[],
  aliases: { attendantId: string; stationId: string; slug: string }[]
): (stationId: string, parsedSlug: string) => IndexedAttendant | undefined {
  const byId = new Map(attendants.map((attendant) => [attendant.id, attendant]));

  const exact = new Map<string, IndexedAttendant>();
  for (const attendant of attendants) {
    const key = `${attendant.stationId}:${attendant.slug}`;
    if (!exact.has(key)) {
      exact.set(key, attendant);
    }
  }

  const linked = new Map<string, IndexedAttendant>();
  for (const alias of aliases) {
    const attendant = byId.get(alias.attendantId);
    if (!attendant) {
      continue;
    }
    const key = `${alias.stationId}:${alias.slug}`;
    if (!linked.has(key)) {
      linked.set(key, attendant);
    }
  }

  return (stationId, parsedSlug) =>
    exact.get(`${stationId}:${parsedSlug}`) ?? linked.get(`${stationId}:${parsedSlug}`);
}

export async function getAttendantProfiles(
  options: AttendantProfileOptions = {}
): Promise<AttendantProfilesResponse> {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
  const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;

  const stationWhere: Prisma.StationWhereInput = options.stationId
    ? { id: options.stationId }
    : options.restrictToStationIds
      ? { id: { in: options.restrictToStationIds } }
      : {};

  const where: Prisma.ShiftReportWhereInput = options.stationId
    ? { stationId: options.stationId }
    : options.restrictToStationIds
      ? { stationId: { in: options.restrictToStationIds } }
      : {};

  const [reports, attendants, aliases, stations] = await Promise.all([
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
        // Only what the variance reads. The review screen's region text and raw values would
        // multiply the payload of a query that runs over every report in the period.
        extractedFields: { select: { fieldName: true, label: true, amount: true, needsReview: true } },
      },
    }),
    prisma.attendant.findMany({
      where: options.stationId
        ? { stationId: options.stationId }
        : options.restrictToStationIds
          ? { stationId: { in: options.restrictToStationIds } }
          : {},
      select: { id: true, stationId: true, name: true, slug: true, userId: true },
    }),
    prisma.attendantAlias.findMany({
      where: options.stationId
        ? { stationId: options.stationId }
        : options.restrictToStationIds
          ? { stationId: { in: options.restrictToStationIds } }
          : {},
      select: { attendantId: true, stationId: true, slug: true },
    }),
    // The single-shift signal is judged against each station's own materiality line, so the
    // station rows are needed and not just their ids.
    prisma.station.findMany({
      where: stationWhere,
      select: { id: true, varianceThreshold: true },
    }),
  ]);

  const thresholdByStation = new Map(stations.map((station) => [station.id, station.varianceThreshold]));

  /*
   * Resolved before anything is accumulated, and deliberately.
   *
   * Bucketing by the printed key first and resolving to a person afterwards would put every
   * spelling of one name in its own bucket, so a link would produce a second profile for the
   * same attendant rather than one history — John Mwaka appearing twice with three shifts and
   * two, each judged separately, and the recurring shortfall that spans both going unseen.
   * Resolving here means the bucket key can be the person.
   */
  const attendantByKey = indexAttendants(attendants, aliases);

  const accumulators = new Map<string, Accumulator>();

  for (const report of reports) {
    // The shift's own date puts it in the window; the upload date is the fallback for a
    // report whose date was never read. Same rule as the dashboard and the leakage screen, so
    // no two screens disagree about which shifts a period contains.
    const effective = report.reportDate ?? report.uploadedAt;
    if (effective.getTime() < since) {
      continue;
    }

    const readings = attendantReadingsFromFields(report.extractedFields as AttendantFieldInput[]);
    if (readings.length === 0) {
      continue;
    }

    for (const reading of readings) {
      const attendant = attendantByKey(report.stationId, reading.slug);

      // Keyed by the person where there is one, and by station-and-printed-key where there is
      // not — `J_MWANGI` at two stations is two different people, and both are unclaimed.
      const key = attendant
        ? `attendant:${attendant.id}`
        : `unclaimed:${report.stationId}:${reading.slug}`;

      const accumulator = accumulators.get(key) ?? {
        stationId: report.stationId,
        stationName: report.station?.name ?? null,
        attendant: attendant ?? null,
        parsedSlug: reading.slug,
        label: null,
        points: [],
        shiftsNotComparable: 0,
        collected: 0,
      };

      accumulator.label = accumulator.label ?? reading.label;

      if (reading.variance === null) {
        // The person was on the report but a figure was missing. Counted, never treated as
        // zero: scoring an unread collected figure as nothing would invent a shortfall the
        // size of the whole day's takings.
        accumulator.shiftsNotComparable += 1;
      } else {
        accumulator.points.push({
          reportId: report.id,
          date: dayKey(effective),
          variance: reading.variance,
          provisional: reading.provisional,
        });
        accumulator.collected += reading.collected ?? 0;
      }

      accumulators.set(key, accumulator);
    }
  }

  const mapped: AttendantProfile[] = [];
  const unmapped: UnmappedAttendant[] = [];

  for (const accumulator of accumulators.values()) {
    // Oldest first, so the trend reads in the order the shifts were worked and ties on one day
    // keep the order they were uploaded in.
    const points = [...accumulator.points].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );

    const variance = points.reduce((sum, point) => sum + point.variance, 0);
    const shortfalls = points.filter((point) => point.variance > 0);
    const worstShiftPoint = shortfalls.reduce<AttendantVariancePoint | null>(
      (worst, point) => (worst === null || point.variance > worst.variance ? point : worst),
      null
    );
    const worstShift = worstShiftPoint?.variance ?? 0;

    const { attendant } = accumulator;

    // A name no one has claimed is not dropped. This is the case where a repeated shortfall
    // would otherwise leave no trace at all, so it is reported for the screen to offer a link.
    if (!attendant) {
      unmapped.push({
        stationId: accumulator.stationId,
        stationName: accumulator.stationName,
        slug: accumulator.parsedSlug,
        name: accumulator.label,
        shifts: points.length,
        variance,
      });
      continue;
    }

    const recentWindow = points.slice(-DRIFT_WINDOW);
    const earlierShifts = points.slice(0, Math.max(points.length - DRIFT_WINDOW, 0));
    const varianceThreshold = thresholdByStation.get(accumulator.stationId) ?? 0;

    mapped.push({
      attendantId: attendant.id,
      name: attendant.name,
      slug: attendant.slug,
      stationId: accumulator.stationId,
      stationName: accumulator.stationName,
      userId: attendant.userId,
      variance,
      worstShift,
      shifts: points.length,
      shiftsShort: shortfalls.length,
      shiftsNotComparable: accumulator.shiftsNotComparable,
      collected: accumulator.collected,
      baselineVariance: points.length > 0 ? median(points.map((point) => point.variance)) : null,
      recentVariance: recentWindow.length > 0 ? mean(recentWindow.map((point) => point.variance)) : null,
      provisional: points.some((point) => point.provisional),
      alert: decideAlert({
        attendance: { variance, worstShift, worstShiftPoint, shifts: points.length, shiftsShort: shortfalls.length, recentWindow, earlierShifts },
        varianceThreshold,
      }),
      trend: points,
    });
  }

  // Worst first: anything carrying an alert, then by the money that went missing. A person
  // *over* what they were due is not a loss and sorts below everyone who is short, however
  // large the surplus — the question this screen answers is where money is going.
  mapped.sort((a, b) => {
    const aAlerting = a.alert ? 1 : 0;
    const bAlerting = b.alert ? 1 : 0;
    if (aAlerting !== bAlerting) {
      return bAlerting - aAlerting;
    }
    if (a.variance !== b.variance) {
      return b.variance - a.variance;
    }
    return a.name.localeCompare(b.name);
  });

  unmapped.sort((a, b) => b.variance - a.variance);

  /*
   * Counted off the profiles that were actually built, rather than off the reports that
   * carried any attendant row at all.
   *
   * The difference is the whole reason this is derived here. A report whose only attendant
   * figures belong to a name nobody has claimed, or whose figures could not be read, fed no
   * profile and produced no comparison — counting it would make the totals block say "17
   * shifts compared" beside a list that accounts for 15, and the reader has no way to find the
   * missing two. Taken from `trend`, it can only ever be the number of shifts the profiles
   * below are built from.
   */
  const comparedReports = new Set<string>();
  for (const profile of mapped) {
    for (const point of profile.trend) {
      comparedReports.add(point.reportId);
    }
  }

  return {
    periodDays,
    generatedAt: new Date().toISOString(),
    stationId: options.stationId ?? null,
    attendants: mapped,
    unmapped,
    totals: {
      attendants: mapped.length,
      shiftsAnalysed: comparedReports.size,
      variance: mapped.reduce((sum, profile) => sum + profile.variance, 0),
      attendantsShort: mapped.filter((profile) => profile.variance > 0).length,
      attendantsAlerting: mapped.filter((profile) => profile.alert !== null).length,
      // Reported so the screen can say what "over the line" was judged against rather than
      // leaving the reader to guess at a threshold they cannot see.
      varianceThreshold: Math.max(0, ...stations.map((station) => station.varianceThreshold)),
    },
  };
}

/**
 * The attendant record behind one login, and the figures a manager would see for it.
 *
 * Reached through `Attendant.userId` — the only link between "who can sign in" and "whose name
 * is on the report", and deliberately a row somebody made rather than a name match. The
 * reasoning is the same as `linkAttendantAlias`'s: a fuzzy match that guessed wrong would move
 * one person's shortfall onto a colleague's record.
 *
 * ## Why the arithmetic is not re-derived here
 *
 * It calls `getAttendantProfiles` for the one station the record belongs to and picks the
 * profile out by id. Re-implementing the totals for a single person would be a second
 * implementation of the median baseline, the variance and the alias join, and the two would
 * drift — a person disputing a figure with their manager has to be looking at the same number
 * as the manager, and that is guaranteed by construction here rather than by two pieces of code
 * being careful in the same way.
 *
 * The cost is that the other profiles on that station are computed and discarded. The scan is
 * already bounded by `MAX_SCANNED_REPORTS`, and the alternative — a filter threaded through the
 * accumulator — would put "show me everybody" and "show me just this one" on two different code
 * paths, which is exactly the drift this avoids.
 *
 * ## Why nothing is checked against the caller's station assignments
 *
 * The record is the authorisation. An owner linking a login to a name has said those are the
 * same person, and the shifts under that name are that person's own work record whether or not
 * somebody also assigned them to the station. Filtering by assignment here would mean a
 * station's own attendant seeing "no record linked to your login" after an owner had just
 * linked one, which reads as the link having failed.
 *
 * Tenant scope is not passed and is not needed: the Prisma extension scopes `Attendant` and
 * `Station` on its own, so a record in another tenant is simply absent.
 */
export async function getMyAttendantProfile(
  userId: string,
  options: { periodDays?: number } = {}
): Promise<MyAttendantProfile> {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;

  const attendant = await prisma.attendant.findFirst({
    where: { userId },
    select: { id: true, stationId: true },
  });

  if (!attendant) {
    return {
      linked: false,
      profile: null,
      periodDays,
      generatedAt: new Date().toISOString(),
      varianceThreshold: 0,
    };
  }

  const profiles = await getAttendantProfiles({ periodDays, stationId: attendant.stationId });

  return {
    linked: true,
    // Null here means "linked, but no comparable shift in the window" — not unlinked. The two
    // are different screens: one asks a manager to make a link, the other says the link is fine
    // and there is simply nothing to show yet.
    profile: profiles.attendants.find((row) => row.attendantId === attendant.id) ?? null,
    periodDays,
    generatedAt: profiles.generatedAt,
    varianceThreshold: profiles.totals.varianceThreshold,
  };
}
