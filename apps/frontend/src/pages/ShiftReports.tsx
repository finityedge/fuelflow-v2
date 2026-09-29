import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ShiftReportListItem, Station } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { ReportFilterBar } from '../components/ReportFilterBar.js';
import { ReportListHeadings, ReportListRow } from '../components/ReportListRow.js';
import { AlertIcon, ChevronDownIcon, FileIcon, UploadIcon } from '../components/icons.js';
import { useAuthStore } from '../stores/authStore.js';
import { canUpload } from '../lib/rbac.js';
import { listShiftReports } from '../lib/shiftReports.js';
import { listStations } from '../lib/stations.js';
import {
  DATE_RANGE_FILTERS,
  STATUS_FILTERS,
  dateRangeBounds,
  type DateRangeFilter,
  type StatusFilter,
} from '../lib/reportFilters.js';

/**
 * How many rows arrive at a time.
 *
 * There is no upper bound on how many reports a station accumulates, so the list cannot
 * pretend it has them all. It says how many it is showing of how many matched, and the rest
 * arrive when asked for — which is the honest version of the "everything uploaded" this
 * screen used to claim while silently stopping at fifty.
 */
const PAGE_SIZE = 25;

export function ShiftReports() {
  const user = useAuthStore((state) => state.user);

  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [range, setRange] = useState<DateRangeFilter>('ALL');

  const [reports, setReports] = useState<ShiftReportListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Every load carries a ticket, and only the newest one is allowed to write.
   *
   * Three filters sit above this list and each of them fires a request; typing a date range
   * or switching station twice in a second would otherwise let an older reply land last and
   * paint rows that do not match the controls.
   */
  const requestRef = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const ticket = ++requestRef.current;

      if (offset === 0) {
        setLoading(true);
        setError(null);
        // A page that arrives after its filter has changed is dropped below without running
        // its `finally`, so the flag it set has to be cleared here instead — otherwise the
        // next "Load more" button is born disabled and says "Loading…" forever.
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }

      try {
        const page = await listShiftReports({
          stationId: stationId || undefined,
          status: status === 'ALL' ? undefined : status,
          ...dateRangeBounds(range),
          limit: PAGE_SIZE,
          offset,
        });

        if (ticket !== requestRef.current) {
          return;
        }

        // Appended, not replaced, for "load more": replacing would drop the rows already on
        // screen and make the button look like it had done nothing.
        setReports((previous) => (offset === 0 ? page.reports : [...previous, ...page.reports]));
        setTotal(page.total);
      } catch (err) {
        if (ticket !== requestRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Reports could not be loaded.');
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
    [stationId, status, range]
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  // The station list is for the filter, not for the rows, so it loads once and never blocks
  // the reports from appearing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations();
        if (!cancelled) {
          setStations(next);
        }
      } catch {
        // A filter that cannot be offered is not an error worth taking the screen down for;
        // the list still loads, just without the station dropdown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const uploadAllowed = user ? canUpload(user.role) : false;
  const isFiltered = stationId !== '' || status !== 'ALL' || range !== 'ALL';
  const hasMore = reports.length < total;

  const clearFilters = useCallback(() => {
    setStationId('');
    setStatus('ALL');
    setRange('ALL');
  }, []);

  const description = useMemo(() => {
    const parts = [
      stationId ? stations.find((station) => station.id === stationId)?.name : null,
      status === 'ALL' ? null : STATUS_FILTERS.find((option) => option.value === status)?.label,
      range === 'ALL' ? null : DATE_RANGE_FILTERS.find((option) => option.value === range)?.label,
    ].filter((part): part is string => Boolean(part));

    if (parts.length === 0) {
      return 'Every shift report uploaded for your stations, newest first.';
    }
    return `${parts.join(' · ')}, newest first.`;
  }, [stationId, stations, status, range]);

  /**
   * Whether to name the station on each row.
   *
   * Three identical station names down a column carry no information; two different ones
   * matter a great deal. So it is shown exactly when it discriminates: the person has more
   * than one station and has not already narrowed to one.
   */
  const showStation = stations.length > 1 && stationId === '';

  return (
    <Layout>
      <div className="mx-auto max-w-7xl">
        <PageHeading
          title="Shift reports"
          description={description}
          actions={
            // The sidebar carries the upload action on desktop, so this one exists for the
            // screens where the sidebar is behind a menu. Two primary buttons for one action
            // on one screen is a hierarchy with no top to it.
            uploadAllowed && (
              <Link to="/upload" className="btn-primary lg:hidden">
                <UploadIcon className="h-4 w-4" />
                Upload report
              </Link>
            )
          }
        />

        <ReportFilterBar
          stations={stations}
          stationId={stationId}
          status={status}
          range={range}
          onStationChange={setStationId}
          onStatusChange={setStatus}
          onRangeChange={setRange}
          onClear={clearFilters}
        />

        {loading && (
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading reports…</p>
          </div>
        )}

        {/* Only when there is nothing to show underneath it. A "load more" that fails must
            not replace the twenty-five rows already on screen with an apology — the rows are
            still true, and the failure belongs beside the button that caused it. */}
        {!loading && error && reports.length === 0 && (
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Reports unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load(0)}>
              Try again
            </button>
          </div>
        )}

        {/* The empty state replaces the list. It never sits beside rows: a screen that says
            "no reports match your filters" while seven reports are visible underneath is
            telling the manager two different things and leaving them to pick. */}
        {!loading && !error && reports.length === 0 && (
          <div className="card p-10 text-center">
            <div
              className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
                isFiltered ? 'bg-warning-subtle text-warning' : 'bg-primary-subtle text-primary'
              }`}
            >
              <FileIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">
              {isFiltered ? 'No reports match your filters' : 'No shift reports yet'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {isFiltered
                ? 'Nothing uploaded matches all of these at once. Widening the date range is usually what does it.'
                : 'Upload a shift report PDF and its figures will appear here, reconciled.'}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {isFiltered && (
                <button type="button" onClick={clearFilters} className="btn-secondary">
                  Clear filters
                </button>
              )}
              {uploadAllowed && !isFiltered && (
                <Link to="/upload" className="btn-primary">
                  <UploadIcon className="h-4 w-4" />
                  Upload report
                </Link>
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
                  <ReportListRow key={report.id} report={report} showStation={showStation} />
                ))}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Showing {reports.length} of {total} report{total === 1 ? '' : 's'}
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

            {/* A failure here belongs next to the button that caused it, not in place of the
                rows that are still correct. */}
            {error && (
              <p className="mt-3 text-sm text-error">
                {error} The reports already listed are unaffected.
              </p>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
