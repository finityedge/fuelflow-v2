import { Link } from 'react-router-dom';
import type { ShiftReportListItem } from '@fuelflow/shared';
import { ChevronRightIcon } from './icons.js';
import { ReportStatusPill } from './ReportStatusPill.js';
import { formatReportDate, formatSignedTZS, formatTimestamp } from '../lib/format.js';
import { VARIANCE_LABEL, VARIANCE_TEXT, varianceTone } from '../lib/variance.js';

/**
 * One report in the list.
 *
 * The row answers two separate questions and keeps them apart, because the mock this follows
 * ran them together:
 *
 *  - *Is anything waiting on me?* — the status pill, from `reportStatus.ts`.
 *  - *Does the money add up?* — the variance.
 *
 * A row can be "Nothing to review" and deeply short at the same time: every figure was read
 * cleanly, and the pumps still sold three million shillings more than anyone paid for. A
 * design that colours the variance by whether it looks like a profit would paint that green.
 * Here the figure takes its colour from `varianceTone`, whose signs this app defines, and it
 * arrives with the words that say which direction it went — so the number is readable
 * without relying on the colour at all.
 */

/** Why there is no variance to show. Never a bare dash, which reads as zero. */
function absenceReason(report: ShiftReportListItem): string {
  if (report.status === 'FAILED') {
    return report.failureReason ?? 'The PDF could not be read, so nothing was extracted from it.';
  }
  if (report.status === 'PENDING') {
    return 'The figures are still being read out of the PDF.';
  }
  return 'A figure this variance needs was never read, so it cannot be worked out yet.';
}

function VarianceCell({ report }: { report: ShiftReportListItem }) {
  const { variance, provisional } = report.summary;

  if (variance === null) {
    return (
      <div className="text-right sm:w-44 sm:shrink-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted sm:hidden">
          Variance
        </p>
        <p className="font-mono text-base font-bold tabular-nums text-muted">—</p>
        <p className="mt-0.5 text-xs text-muted">{absenceReason(report)}</p>
      </div>
    );
  }

  const tone = varianceTone(variance);

  return (
    <div className="text-right sm:w-44 sm:shrink-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted sm:hidden">Variance</p>
      <p className={`font-mono text-base font-bold tabular-nums ${VARIANCE_TEXT[tone]}`}>
        {formatSignedTZS(variance)}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {VARIANCE_LABEL[tone]}
        {/* A figure built from a field still awaiting review can move under the manager's
            feet. Saying so is the difference between a number and a promise. */}
        {provisional && ' · may still change'}
      </p>
    </div>
  );
}

/** The headings the variance column sits under, which the mobile label stands in for. */
export function ReportListHeadings() {
  return (
    <div className="hidden px-6 py-2 sm:flex sm:items-center sm:gap-4">
      <p className="flex-1 text-xs font-bold uppercase tracking-wider text-muted">Shift</p>
      <p className="w-44 shrink-0 text-right text-xs font-bold uppercase tracking-wider text-muted">
        Variance
      </p>
      <span className="w-5 shrink-0" aria-hidden="true" />
    </div>
  );
}

export function ReportListRow({
  report,
  showStation,
  fromQueue = false,
}: {
  report: ShiftReportListItem;
  /** Off when every row shares a station, which is most of the time. */
  showStation: boolean;
  /**
   * Whether the row was opened from the review queue.
   *
   * It changes nothing about the row and everything about the destination: the detail screen
   * reads `?from=queue` off the URL and offers "next in the queue" instead of a dead end. The
   * marker travels in the URL rather than in a store so that a link somebody bookmarked, or
   * pasted to a colleague, still means what it says.
   */
  fromQueue?: boolean;
}) {
  const meta = [
    report.fileName,
    showStation ? report.stationName ?? 'Station' : null,
    `uploaded ${formatTimestamp(report.uploadedAt)}`,
  ].filter(Boolean);

  return (
    <Link
      to={`/shift-reports/${report.id}${fromQueue ? '?from=queue' : ''}`}
      className="flex flex-col gap-3 px-6 py-4 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="truncate text-sm font-bold text-body">
            {formatReportDate(report.reportDate)}
          </p>
          <ReportStatusPill report={report} />
        </div>
        <p className="mt-1 truncate text-xs text-muted">{meta.join(' · ')}</p>
        {report.status === 'FAILED' && report.failureReason && (
          <p className="mt-1 text-xs text-error">{report.failureReason}</p>
        )}
      </div>

      <VarianceCell report={report} />

      <ChevronRightIcon className="hidden h-5 w-5 shrink-0 text-muted sm:block" />
    </Link>
  );
}
