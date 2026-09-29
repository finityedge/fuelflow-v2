import type {
  DashboardReportRow,
  DashboardSummary,
  DashboardTotals,
  DashboardTrendPoint,
  DashboardVarianceTotals,
  ShiftReportListItem,
} from '@fuelflow/shared';
import { prisma } from '../prisma/client.js';
import { computeSummary } from '../parsing/petronite.js';
import type { SummaryInput } from '../parsing/types.js';

/**
 * How many recent reports the period is drawn from.
 *
 * The period filter itself runs in memory, because "this report belongs to the last 30
 * days" means its *report* date, and a report uploaded today can carry a date from last
 * month. Prisma cannot express "reportDate, or uploadedAt when reportDate is null" as a
 * single indexable predicate, so the window is applied after loading. The cap keeps that
 * bounded: a station producing more than 300 shift reports in a month is not a case this
 * app has to answer for, and silently reading the newest 300 is better than reading an
 * unbounded table on every dashboard load.
 */
const MAX_SCANNED_REPORTS = 300;

/** Recent rows shown in the table under the chart. */
const RECENT_LIMIT = 8;

const DEFAULT_PERIOD_DAYS = 30;

export interface DashboardOptions {
  periodDays?: number;
  /** One station, already access-checked by the route. */
  stationId?: string;
  /**
   * The stations this user may see at all. `undefined` means every station in the tenant
   * (an owner); an empty array means none, and must yield an empty dashboard rather than
   * an unrestricted one — `in: []` matches nothing, which is the correct answer here.
   */
  restrictToStationIds?: string[];
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getDashboardSummary(options: DashboardOptions = {}): Promise<DashboardSummary> {
  const periodDays = options.periodDays ?? DEFAULT_PERIOD_DAYS;
  const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;

  const stationFilter = options.stationId
    ? { stationId: options.stationId }
    : options.restrictToStationIds
      ? { stationId: { in: options.restrictToStationIds } }
      : {};

  const reports = await prisma.shiftReport.findMany({
    where: stationFilter,
    orderBy: { uploadedAt: 'desc' },
    take: MAX_SCANNED_REPORTS,
    select: {
      id: true,
      stationId: true,
      pdfFileName: true,
      reportDate: true,
      status: true,
      uploadedAt: true,
      failureReason: true,
      station: { select: { name: true } },
      // Only the three columns the reconciliation arithmetic reads. The review screen
      // needs the labels and region text; a dashboard total does not.
      extractedFields: {
        select: { fieldName: true, amount: true, needsReview: true },
      },
    },
  });

  const totals: DashboardTotals = {
    reports: 0,
    readCleanly: 0,
    needsReview: 0,
    failed: 0,
    pending: 0,
    fieldsFlagged: 0,
    outsidePeriod: 0,
  };

  const variance: DashboardVarianceTotals = {
    unaccounted: 0,
    overCollected: 0,
    net: 0,
    computed: 0,
    notComputed: 0,
    largest: null,
  };

  const trend: DashboardTrendPoint[] = [];
  /** Upload timestamps, kept alongside the points so same-day shifts sort chronologically. */
  const trendOrder: string[] = [];
  const rows: DashboardReportRow[] = [];

  for (const report of reports) {
    // The report's own date is what the shift belongs to; the upload date is a fallback
    // for a report whose date was never read, and the only date a failed parse has.
    const effective = report.reportDate ?? report.uploadedAt;
    if (effective.getTime() < since) {
      totals.outsidePeriod += 1;
      continue;
    }

    const fields: SummaryInput[] = report.extractedFields;
    const summary = computeSummary(fields);
    const flagged = fields.filter((field) => field.needsReview).length;

    totals.reports += 1;
    totals.fieldsFlagged += flagged;
    if (report.status === 'FAILED') {
      totals.failed += 1;
    } else if (report.status === 'PENDING') {
      totals.pending += 1;
    } else if (flagged > 0) {
      totals.needsReview += 1;
    } else {
      totals.readCleanly += 1;
    }

    if (summary.variance === null) {
      variance.notComputed += 1;
    } else {
      variance.computed += 1;
      // Kept apart on purpose. A short shift and an over-collected shift of equal size
      // sum to zero, and reporting that as "no variance" would hide both.
      if (summary.variance > 0) {
        variance.unaccounted += summary.variance;
      } else if (summary.variance < 0) {
        variance.overCollected += -summary.variance;
      }

      const point: DashboardTrendPoint = {
        reportId: report.id,
        date: dayKey(effective),
        variance: summary.variance,
        status: report.status,
        provisional: summary.provisional,
      };
      trend.push(point);
      trendOrder.push(report.uploadedAt.toISOString());

      const magnitude = Math.abs(summary.variance);
      if (magnitude > Math.abs(variance.largest?.variance ?? 0)) {
        variance.largest = {
          reportId: report.id,
          reportDate: report.reportDate ? dayKey(report.reportDate) : null,
          fileName: report.pdfFileName,
          variance: summary.variance,
        };
      }
    }

    if (rows.length < RECENT_LIMIT) {
      const listItem: ShiftReportListItem = {
        id: report.id,
        stationId: report.stationId,
        stationName: report.station?.name ?? null,
        fileName: report.pdfFileName,
        reportDate: report.reportDate ? dayKey(report.reportDate) : null,
        status: report.status,
        uploadedAt: report.uploadedAt.toISOString(),
        failureReason: report.failureReason,
        needsReviewCount: flagged,
      };
      rows.push({ ...listItem, summary });
    }
  }

  variance.net = variance.unaccounted - variance.overCollected;

  // Oldest first, and only reconciled shifts: a failed parse has no variance to plot, and
  // drawing it at zero would read as "this shift balanced". Two shifts on one day keep
  // their upload order, so the line follows the order they were actually reported in.
  const orderedTrend = trend
    .map((point, index) => ({ point, uploadedAt: trendOrder[index]! }))
    .sort((a, b) =>
      a.point.date === b.point.date
        ? a.uploadedAt < b.uploadedAt
          ? -1
          : a.uploadedAt > b.uploadedAt
            ? 1
            : 0
        : a.point.date < b.point.date
          ? -1
          : 1
    )
    .map((entry) => entry.point);

  return {
    periodDays,
    generatedAt: new Date().toISOString(),
    totals,
    variance,
    trend: orderedTrend,
    recent: rows,
  };
}
