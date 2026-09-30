import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ShiftReportListItem, StationSummary } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { ReportListHeadings, ReportListRow } from '../components/ReportListRow.js';
import { AlertIcon, CheckCircleIcon, ChevronDownIcon, RefreshIcon } from '../components/icons.js';
import { listShiftReports } from '../lib/shiftReports.js';
import { listStations } from '../lib/stations.js';

/**
 * What the queue can be pointed at.
 *
 * Only the two states that are asking a person to do something. `PENDING` is excluded because
 * a machine is already on it — showing it here would put a row in front of a manager whose
 * only possible action is to wait. `PARSED` is excluded because it is done.
 */
type QueueState = 'NEEDS_REVIEW' | 'FAILED';

const TABS: ReadonlyArray<{ value: QueueState; label: string; blurb: string }> = [
  {
    value: 'NEEDS_REVIEW',
    label: 'Needs review',
    blurb: 'Figures the parser was unsure of. Open one, check it against the paper report, and correct what is wrong.',
  },
  {
    value: 'FAILED',
    label: 'Couldn’t be read',
    blurb: 'Reports that could not be read at all. Usually the wrong file, or a scan — check the reason on the row.',
  },
];

const PAGE_SIZE = 25;

/**
 * The review queue.
 *
 * This screen exists because the history list answers the wrong question. History is ordered
 * newest-first, which is right for "what happened?" and exactly backwards for "what should I
 * do next?" — the report that has been sitting unreviewed for three weeks appears at the
 * bottom of the page, behind everything uploaded since. So the queue inverts the order, takes
 * only the states that need a person, and drops the station and date filters that made the
 * history screen a place to browse rather than a place to work.
 *
 * Rows link into the report with `?from=queue`, which is what puts the "next" button on the
 * detail screen. The walk-through is deliberately not a wizard that swallows the list: a
 * manager can leave the queue at any point and the URL still means something.
 */
export function Queue() {
  /**
   * The tab to open on, from `?tab=`. The dashboard's two attention tiles link here with the
   * tab already chosen, so "3 couldn't be read" lands on the three unreadable files rather
   * than on a list that does not contain them.
   *
   * Read once as the initial value rather than kept in sync with the URL afterwards: after
   * that the tabs are the control, and pushing every switch into history would mean the back
   * button walked a user through their own tab clicks instead of out of the queue.
   */
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<QueueState>(
    searchParams.get('tab') === 'FAILED' ? 'FAILED' : 'NEEDS_REVIEW'
  );
  const [reports, setReports] = useState<ShiftReportListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Station names for the rows, so a queue spanning sites says which site each row is from. */
  const [stations, setStations] = useState<StationSummary[]>([]);

  /** Only the newest load may write, so switching tabs twice cannot paint a stale list. */
  const requestRef = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const ticket = ++requestRef.current;

      if (offset === 0) {
        setLoading(true);
        setError(null);
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const page = await listShiftReports({
          status: state,
          // The whole point of the screen: longest-waiting first.
          order: 'oldest',
          limit: PAGE_SIZE,
          offset,
        });

        if (ticket !== requestRef.current) {
          return;
        }

        setReports((previous) => (offset === 0 ? page.reports : [...previous, ...page.reports]));
        setTotal(page.total);
      } catch (err) {
        if (ticket !== requestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : 'The queue could not be loaded.');
        if (offset === 0) {
          setReports([]);
          setTotal(0);
        }
      } finally {
        if (ticket === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [state]
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations();
        if (!cancelled) {
          setStations(next);
        }
      } catch {
        // The station dropdown is not worth taking the queue down for; the rows still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const active = TABS.find((tab) => tab.value === state)!;
  const hasMore = reports.length < total;
  const showStation = stations.length > 1;

  return (
    <Layout>
      <div className="mx-auto max-w-5xl">
        <PageHeading
          title="Review queue"
          description={active.blurb}
          actions={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void load(0)}
              disabled={loading}
            >
              <RefreshIcon className="h-4 w-4" />
              Refresh
            </button>
          }
        />

        {/* Two tabs, not a filter bar. A queue has one mode at a time, and the counts on the
            tabs are the whole reason to open this screen rather than the history list. */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setState(tab.value)}
              className={
                tab.value === state
                  ? 'rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white'
                  : 'rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-muted transition-colors hover:bg-slate-200 hover:text-body'
              }
              aria-pressed={tab.value === state}
            >
              {tab.label}
              {tab.value === state && !loading ? ` (${total})` : ''}
            </button>
          ))}

          {reports.length > 0 && (
            <p className="ml-auto text-sm text-muted">
              Oldest first — the shift that has been waiting longest is at the top.
            </p>
          )}
        </div>

        {loading && (
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading the queue…</p>
          </div>
        )}

        {!loading && error && reports.length === 0 && (
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Queue unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load(0)}>
              Try again
            </button>
          </div>
        )}

        {/*
          The empty state is the reward, and it says so. "No reports" on a queue and "no
          reports" on a history list are opposite pieces of news, and rendering both as the
          same grey box throws away the one moment the screen has to tell somebody they are
          done.
        */}
        {!loading && !error && reports.length === 0 && (
          <div className="card p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success-subtle text-success">
              <CheckCircleIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">
              {state === 'NEEDS_REVIEW' ? 'Nothing needs your review' : 'Nothing failed to read'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {state === 'NEEDS_REVIEW'
                ? 'Every report that has been read has had its uncertain figures checked. New uploads appear here when they need a person.'
                : 'Every uploaded PDF has been readable so far. If one fails, the reason and the row will appear here.'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Link to="/shift-reports/recent" className="btn-secondary">
                See all shift reports
              </Link>
              {state === 'NEEDS_REVIEW' && (
                <button type="button" className="btn-ghost" onClick={() => setState('FAILED')}>
                  Check for unreadable files
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && reports.length > 0 && (
          <>
            <div className="card overflow-hidden">
              <ReportListHeadings />
              <div className="divide-y divide-border border-t border-border">
                {reports.map((report) => (
                  <ReportListRow
                    key={report.id}
                    report={report}
                    showStation={showStation}
                    fromQueue
                  />
                ))}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Showing {reports.length} of {total} waiting
              </p>
              {hasMore && (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={loadingMore}
                  onClick={() => void load(reports.length)}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                  {!loadingMore && <ChevronDownIcon className="h-4 w-4" />}
                </button>
              )}
            </div>

            {error && (
              <p className="mt-3 text-sm text-error">
                {error} The rows already listed are unaffected.
              </p>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
