import { Link } from 'react-router-dom';
import type { DashboardReportRow } from '@fuelflow/shared';
import { ReportStatusPill } from './ReportStatusPill.js';
import { ChevronRightIcon } from './icons.js';
import { formatRelativeTime, formatReportDate, formatSignedTZS, formatTimestamp, formatTZS } from '../lib/format.js';
import { VARIANCE_TEXT, varianceTone } from '../lib/variance.js';

/**
 * The three figures a manager cross-checks, from one place of arithmetic so the desktop
 * table and the phone card list cannot disagree.
 *
 * "Accounted for" is `null` — not zero — when cash could not be read. A partial sum
 * printed as if it were the whole would make the shift look worse than it is, and the
 * variance beside it is `null` in exactly that case anyway.
 */
function figures(row: DashboardReportRow) {
  const accounted = row.summary.cash === null
    ? null
    : row.summary.cash + row.summary.mobileMoney + row.summary.approvedCredit;

  return {
    sales: formatTZS(row.summary.pumpTotalizerSales),
    accounted: formatTZS(accounted),
    variance: formatSignedTZS(row.summary.variance),
    varianceClass: VARIANCE_TEXT[varianceTone(row.summary.variance)],
  };
}

function labelFor(row: DashboardReportRow): string {
  return row.fileName ?? formatReportDate(row.reportDate);
}

/**
 * The period's reports, newest first.
 *
 * Two renders of one dataset rather than one table in a horizontal scroller: this table is
 * six money columns wide, and the people who use it are standing at a station holding a
 * phone. A table is the right element on a desk and the wrong one in a hand, so below `md`
 * each report becomes a card with its figures labelled.
 */
export function RecentReportsTable({ rows }: { rows: DashboardReportRow[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-base font-bold text-body">Recent shift reports</h2>
        <Link
          to="/shift-reports/recent"
          className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-primary-dark"
        >
          View all
          <ChevronRightIcon className="h-4 w-4" />
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted">
          Nothing uploaded in this period yet.
        </p>
      ) : (
        <>
          <table className="hidden w-full md:table">
            <caption className="sr-only">Shift reports in the last period, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <th scope="col" className="px-5 py-3">Report</th>
                <th scope="col" className="px-3 py-3">Station</th>
                <th scope="col" className="px-3 py-3">Status</th>
                <th scope="col" className="px-3 py-3 text-right">Total sales</th>
                <th scope="col" className="px-3 py-3 text-right">Accounted for</th>
                <th scope="col" className="px-5 py-3 text-right">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => {
                const f = figures(row);
                return (
                  <tr key={row.id} className="transition-colors hover:bg-slate-50">
                    <td className="px-5 py-3">
                      {/* The link is on the label, not the row: a `tr` cannot be a link, and
                          stretching an anchor over a table row breaks selection and the
                          accessibility tree. */}
                      <Link
                        to={`/shift-reports/${row.id}`}
                        className="text-sm font-semibold text-body hover:text-primary"
                      >
                        {labelFor(row)}
                      </Link>
                      <p className="text-xs text-muted" title={formatTimestamp(row.uploadedAt)}>
                        {formatReportDate(row.reportDate)} · {formatRelativeTime(row.uploadedAt)}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-sm text-muted">{row.stationName ?? '—'}</td>
                    <td className="px-3 py-3">
                      <ReportStatusPill report={row} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-sm text-body">{f.sales}</td>
                    <td className="px-3 py-3 text-right font-mono text-sm text-body">{f.accounted}</td>
                    <td className={`px-5 py-3 text-right font-mono text-sm font-semibold ${f.varianceClass}`}>
                      {f.variance}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="divide-y divide-border md:hidden">
            {rows.map((row) => {
              const f = figures(row);
              return (
                <li key={row.id}>
                  <Link to={`/shift-reports/${row.id}`} className="block px-5 py-4 active:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-semibold text-body">{labelFor(row)}</p>
                      <ReportStatusPill report={row} />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {formatReportDate(row.reportDate)} · {formatRelativeTime(row.uploadedAt)}
                    </p>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted">Total sales</dt>
                        <dd className="font-mono text-body">{f.sales}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Accounted for</dt>
                        <dd className="font-mono text-body">{f.accounted}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-muted">Variance</dt>
                        <dd className={`font-mono font-semibold ${f.varianceClass}`}>{f.variance}</dd>
                      </div>
                    </dl>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
