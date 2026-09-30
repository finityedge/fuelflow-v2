import type {
  AttendantProfilesResponse,
  FindingsMoney,
  FindingsSheet,
  FindingsShiftRow,
  TankLeakageResponse,
} from '@fuelflow/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { computeSummary } from '../parsing/petronite.js';
import type { SummaryInput } from '../parsing/types.js';
import { getDashboardSummary } from './dashboard.service.js';
import { getAttendantProfiles } from './attendantProfile.service.js';
import { getTankLeakage } from './tankLeakage.service.js';

/**
 * The findings sheet: the document the free audit hands over.
 *
 * ## Why this composes instead of computing
 *
 * Everything on this sheet is already on a screen — the money on the dashboard, the people on
 * the attendants screen, the fuel on the wet-stock screen. The sheet adds no arithmetic of its
 * own and deliberately calls those three services rather than re-deriving from the same tables.
 * The alternative was tried on paper and is worse: a second implementation of the variance is a
 * second answer, and the one document in this product that leaves the building must not be the
 * one that disagrees with the screen the owner was shown while it was being built.
 *
 * The one query that *is* new is the per-shift evidence table, because none of the three
 * services returns a plain list of every shift in the period — the dashboard's trend drops the
 * file names and its recent list stops at eight. It reads the same rows through the same
 * `computeSummary`, which is the arithmetic the dashboard section above is built from, so the
 * two halves of this document are consistent with each other by construction as well as by
 * test.
 *
 * ## One station, not the portfolio
 *
 * The other three endpoints all answer for every station the caller can see. This one takes a
 * required `stationId`, and that is the point of it: the document is about a place its owner
 * can walk into, and a headline reading "TZS 1.2m unaccounted for across your sites" is a
 * different, weaker sentence than one naming the forecourt it is going out of.
 */

/** The same cap as the dashboard's, for the same reason — see `dashboard.service.ts`. */
const MAX_SCANNED_REPORTS = 300;

const DEFAULT_PERIOD_DAYS = 30;

const TZS = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * `1250000` -> `TZS 1,250,000`.
 *
 * A second copy of the rule in `apps/frontend/src/lib/format.ts`, and the only duplication in
 * this file. It is here rather than shared because the headlines are written where the figures
 * are, which is what stops the sentence at the top of the sheet describing a different period
 * from the table underneath it — and that guarantee is worth more than the twelve lines it
 * costs. The options match the frontend's exactly, so a figure quoted in a headline and the
 * same figure in the table below render as the same string.
 */
function formatTZS(value: number): string {
  return `${value < 0 ? '-' : ''}TZS ${TZS.format(Math.abs(value))}`;
}

/** `1240` -> `1,240 L`. Whole litres, as the pumps and the tape both measure them. */
function formatLitres(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} L`;
}

/** `3, 'shift'` -> `3 shifts`. Every noun this is used with pluralises regularly. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function isOne(value: number): string {
  return value === 1 ? 'is' : 'are';
}

export interface FindingsOptions {
  /** Required, and already access-checked by the route. */
  stationId: string;
  periodDays?: number;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The sentences at the top of the sheet.
 *
 * Written here, from the same figures the document carries, so the prose cannot describe a
 * period the tables do not show. Every branch that has nothing to report says *why* it has
 * nothing to report — "no reports were uploaded" and "every shift balanced" are opposite
 * findings and a sheet that rendered both as a blank space would be lying by omission, which
 * is the one failure mode an audit document cannot have.
 *
 * Order is the order a reader needs it in: the money, then what is still unsettled about it,
 * then the two exceptions behind it, then the names nobody has claimed.
 */
function buildHeadlines(input: {
  periodDays: number;
  money: FindingsMoney;
  attendants: AttendantProfilesResponse;
  tanks: TankLeakageResponse;
}): string[] {
  const { periodDays, money, attendants, tanks } = input;
  const headlines: string[] = [];

  if (money.reports === 0) {
    headlines.push(
      `No shift reports were uploaded for this station in the last ${count(periodDays, 'day')}, so there was nothing to reconcile.`
    );
  } else if (money.shiftsCompared === 0) {
    headlines.push(
      `${count(money.reports, 'report')} were uploaded but none could be reconciled — the figures on them could not be read, so no money total is available.`
    );
  } else if (money.net > 0) {
    headlines.push(
      `${formatTZS(money.net)} is unaccounted for across ${count(money.shiftsCompared, 'reconciled shift')}: pump sales less the cash, mobile money and approved credit the reports account for.`
    );
  } else if (money.net < 0) {
    headlines.push(
      `The period is ${formatTZS(-money.net)} to the good: across ${count(money.shiftsCompared, 'reconciled shift')} more was collected than the pumps recorded.`
    );
  } else if (money.unaccounted > 0) {
    // The case the whole two-sided variance exists for. Netting these to zero and reporting
    // "no variance" would hide a short shift and an over-collected one of the same size, and
    // an over-collected shift is a figure somebody is still holding.
    headlines.push(
      `Net variance is zero over ${count(money.shiftsCompared, 'reconciled shift')}, but that is two figures cancelling: ${formatTZS(money.unaccounted)} came up short and ${formatTZS(money.overCollected)} came up over. Both are listed below.`
    );
  } else {
    headlines.push(
      `All ${count(money.shiftsCompared, 'reconciled shift')} in the period balanced exactly. No money is unaccounted for.`
    );
  }

  if (money.failedReports > 0) {
    headlines.push(
      `${count(money.failedReports, 'report')} could not be read at all and ${isOne(money.failedReports)} not in any figure above.`
    );
  }

  if (money.flaggedFields > 0) {
    headlines.push(
      `${count(money.flaggedFields, 'figure')} still ${money.flaggedFields === 1 ? 'has' : 'have'} to be checked by a person, so the totals above may move.`
    );
  }

  const people = attendants.totals;
  if (people.attendantsAlerting > 0) {
    headlines.push(
      `${count(people.attendantsAlerting, 'attendant')} ${isOne(people.attendantsAlerting)} carrying a pattern worth asking about, against ${formatTZS(people.variance)} net across every attendant on the station.`
    );
  } else if (people.attendantsShort > 0) {
    headlines.push(
      `${count(people.attendantsShort, 'attendant')} finished the period net short, though nobody is short often enough, or by enough, to raise a signal on their own.`
    );
  } else if (people.attendants === 0) {
    headlines.push('No attendant figures could be compared for this period.');
  } else {
    headlines.push('Every attendant finished the period net positive or exactly balanced.');
  }

  const fuel = tanks.totals;
  if (fuel.tanks === 0) {
    headlines.push('No tank readings could be compared for this period.');
  } else if (fuel.varianceLitres > 0) {
    const flagged =
      fuel.tanksAlerting > 0
        ? `${fuel.tanksAlerting} of ${count(fuel.tanks, 'tank')} ${isOne(fuel.tanksAlerting)} flagged for losing fuel`
        : `No tank is flagged on a single shift on its own`;
    headlines.push(
      `${flagged}, but the station is down ${formatLitres(fuel.varianceLitres)} against the book over ${count(fuel.shiftsAnalysed, 'shift')}: the tape against what the reports say was in the tank.`
    );
  } else {
    headlines.push(
      `Tank book and dip agree over ${count(fuel.shiftsAnalysed, 'shift')}, or the tanks came out ahead. No fuel is unaccounted for.`
    );
  }

  const strayNames = attendants.unmapped;
  const strayTanks = tanks.unmapped;
  if (strayNames.length > 0 || strayTanks.length > 0) {
    const parts: string[] = [];
    if (strayNames.length > 0) {
      parts.push(
        `${count(strayNames.length, 'name')} printed on the reports that no attendant record answers to (${strayNames
          .map((row) => row.name ?? row.slug)
          .join(', ')})`
      );
    }
    if (strayTanks.length > 0) {
      parts.push(
        `${count(strayTanks.length, 'tank key')} with no tank set up for ${strayTanks.length === 1 ? 'it' : 'them'} (${strayTanks
          .map((row) => row.slug)
          .join(', ')})`
      );
    }
    headlines.push(
      `There ${isOne(strayNames.length + strayTanks.length)} also ${parts.join(', and ')}. Their figures are kept apart and are not in the totals above.`
    );
  }

  return headlines;
}

export async function getFindingsSheet(options: FindingsOptions): Promise<FindingsSheet> {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
  const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const stationId = options.stationId;

  // Tenant-scoped by the Prisma extension, so a station in another tenant is simply absent —
  // the same reason the routes pair `hasStationAccess` with an existence check, kept here so
  // the service is safe to call without the route having done it.
  const station = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, name: true, location: true, varianceThreshold: true },
  });

  if (!station) {
    throw httpError(404, 'Station not found.');
  }

  /*
   * The three summaries, in one round trip each, all scoped to this one station.
   *
   * `restrictToStationIds` is left unset deliberately: `stationId` is required and already
   * access-checked, so narrowing further would be a second, weaker answer to a question the
   * route has settled. Passing the caller's station list here would also silently blank the
   * sheet for an owner who legitimately sees every station but is not *assigned* to this one.
   */
  const [dashboard, attendants, tanks, rows] = await Promise.all([
    getDashboardSummary({ periodDays, stationId }),
    getAttendantProfiles({ periodDays, stationId }),
    getTankLeakage({ periodDays, stationId }),
    loadShifts(stationId, since),
  ]);

  const money: FindingsMoney = {
    reports: dashboard.totals.reports,
    shiftsCompared: dashboard.variance.computed,
    unaccounted: dashboard.variance.unaccounted,
    overCollected: dashboard.variance.overCollected,
    net: dashboard.variance.net,
    largest: dashboard.variance.largest,
    flaggedFields: dashboard.totals.fieldsFlagged,
    failedReports: dashboard.totals.failed,
  };

  return {
    station: {
      id: station.id,
      name: station.name,
      location: station.location,
      varianceThreshold: station.varianceThreshold,
    },
    periodDays,
    from: dayKey(new Date(since)),
    to: dayKey(new Date()),
    generatedAt: new Date().toISOString(),
    headlines: buildHeadlines({ periodDays, money, attendants, tanks }),
    provisional:
      money.flaggedFields > 0 ||
      attendants.attendants.some((profile) => profile.provisional) ||
      tanks.tanks.some((tank) => tank.provisional),
    money,
    shifts: rows,
    attendants: attendants.attendants,
    tanks: tanks.tanks,
    totals: {
      attendants: attendants.totals,
      tanks: tanks.totals,
    },
    unattributed: {
      attendants: attendants.unmapped,
      tanks: tanks.unmapped,
    },
  };
}

/**
 * Every shift in the period, oldest first, with the figure the reader came for.
 *
 * Oldest first, unlike every screen in the product: a sheet is read as a narrative of the
 * month, and the shift at the top of the list is the one the period started with. The date
 * falls back to the upload day for a report whose own date was never read — the same fallback
 * and the same reason as the dashboard's, since a failed parse still happened on a day.
 *
 * `variance` is null rather than zero for a shift that could not be reconciled. Zero would
 * print as "this shift balanced", which is the one thing a failed parse does not mean.
 */
async function loadShifts(stationId: string, since: number): Promise<FindingsShiftRow[]> {
  const reports = await prisma.shiftReport.findMany({
    where: { stationId } satisfies Prisma.ShiftReportWhereInput,
    orderBy: { uploadedAt: 'desc' },
    take: MAX_SCANNED_REPORTS,
    select: {
      id: true,
      pdfFileName: true,
      reportDate: true,
      uploadedAt: true,
      status: true,
      extractedFields: { select: { fieldName: true, amount: true, needsReview: true } },
    },
  });

  const rows: FindingsShiftRow[] = [];

  for (const report of reports) {
    const effective = report.reportDate ?? report.uploadedAt;
    if (effective.getTime() < since) {
      continue;
    }

    const fields: SummaryInput[] = report.extractedFields;
    const summary = computeSummary(fields);

    rows.push({
      reportId: report.id,
      reportDate: report.reportDate ? dayKey(report.reportDate) : null,
      fileName: report.pdfFileName,
      status: report.status,
      variance: summary.variance,
      flaggedFields: fields.filter((field) => field.needsReview).length,
    });
  }

  return rows.reverse();
}
