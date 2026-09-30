import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSummary, StationSummary } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatCard } from '../components/StatCard.js';
import { ProgressRing } from '../components/ProgressRing.js';
import { VarianceTrendChart } from '../components/VarianceTrendChart.js';
import { AttentionList } from '../components/AttentionList.js';
import { RecentReportsTable } from '../components/RecentReportsTable.js';
import {
  AlertCircleIcon,
  BellIcon,
  BuildingIcon,
  ChartIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  FileIcon,
  ReportsIcon,
  ScaleIcon,
  UploadIcon,
} from '../components/icons.js';
import { useAuthStore } from '../stores/authStore.js';
import { canCorrect, canUpload } from '../lib/rbac.js';
import { getDashboard } from '../lib/dashboard.js';
import { listStations } from '../lib/stations.js';
import { formatLongDate, formatTZS, greetingFor, nameFor } from '../lib/format.js';

const PERIOD_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

function SkeletonCard() {
  return (
    <div className="card p-5">
      <div className="h-10 w-10 animate-pulse rounded-xl bg-slate-100" />
      <div className="mt-4 h-4 w-24 animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-7 w-32 animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-3 w-40 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

export function Home() {
  const user = useAuthStore((state) => state.user);

  const [stations, setStations] = useState<StationSummary[]>([]);
  /** Empty string means every station this user may see, which is also the right default. */
  const [stationId, setStationId] = useState('');
  const [periodDays, setPeriodDays] = useState<number>(30);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const uploadAllowed = user ? canUpload(user.role) : false;
  const correctAllowed = user ? canCorrect(user.role) : false;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations();
        if (!cancelled) {
          setStations(next);
        }
      } catch {
        // The dashboard still loads and still totals correctly for whatever the user may
        // see; only the station filter is missing, and it is hidden when there is nothing
        // to filter by. Better than replacing the whole page with an error about a control.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await getDashboard({ stationId: stationId || undefined, periodDays });
    setSummary(next);
  }, [stationId, periodDays]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The dashboard could not be loaded.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const attentionCount = summary ? summary.totals.needsReview + summary.totals.failed : 0;
  const periodLabel = `the last ${periodDays} days`;
  /** A reload that keeps the previous figures on screen rather than blanking the page. */
  const refreshing = loading && summary !== null;

  const heading = (
    <PageHeading
      title={`${greetingFor()}, ${nameFor(user?.email)}`}
      description={`${formatLongDate()}. ${
        summary
          ? `${summary.totals.reports} report${summary.totals.reports === 1 ? '' : 's'} over ${periodLabel}.`
          : `Your stations over ${periodLabel}.`
      }`}
      actions={
        <>
          {stations.length > 1 && (
            <div className="relative">
              <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <label htmlFor="dashboard-station" className="sr-only">
                Station
              </label>
              <select
                id="dashboard-station"
                className="input w-auto min-w-[12rem] py-2.5 pl-11 pr-8"
                value={stationId}
                onChange={(event) => setStationId(event.target.value)}
              >
                <option value="">All my stations</option>
                {stations.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            className="inline-flex rounded-xl border border-border bg-surface p-1"
            role="group"
            aria-label="Period"
          >
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                onClick={() => setPeriodDays(option.days)}
                aria-pressed={periodDays === option.days}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                  periodDays === option.days
                    ? 'bg-primary text-white'
                    : 'text-muted hover:text-body'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* The findings sheet is the dashboard written down — the same figures, one station,
              laid out to be printed. It sits here rather than in the sidebar because that is
              what it is: not a sixth place to go, but this page on paper. It carries the
              station the reader is already looking at, so it opens on their figures. */}
          {correctAllowed && (
            <Link
              to={stationId ? `/findings?stationId=${stationId}` : '/findings'}
              className="btn-secondary"
              title="A printable summary of this dashboard for one station"
            >
              <FileIcon className="h-4 w-4" />
              Findings sheet
            </Link>
          )}

          {/* A bell that points at the review queue. It carries no notification feed —
              there is none — so it says in words what the badge is counting, and appears
              only for people who can act on it. It opens the queue rather than the history
              list, because the count is work to do and the history list is not where you
              do it. */}
          {correctAllowed && attentionCount > 0 && (
            <Link
              to="/review"
              className="btn-secondary relative"
              title={`${attentionCount} report${attentionCount === 1 ? '' : 's'} need your attention`}
            >
              <BellIcon className="h-4 w-4" />
              <span className="sr-only">
                {attentionCount} report{attentionCount === 1 ? '' : 's'} need your attention
              </span>
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-error px-1 text-xs font-bold text-white">
                {attentionCount}
              </span>
            </Link>
          )}

          {uploadAllowed && (
            <Link to="/upload" className="btn-primary">
              <UploadIcon className="h-4 w-4" />
              Upload report
            </Link>
          )}
        </>
      }
    />
  );

  if (loading && !summary) {
    return (
      <Layout>
        <div className="mx-auto max-w-7xl">
          {heading}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-muted">Loading your stations…</p>
        </div>
      </Layout>
    );
  }

  if (error && !summary) {
    return (
      <Layout>
        <div className="mx-auto max-w-7xl">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertCircleIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Dashboard unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  if (!summary) {
    return null;
  }

  const { totals, variance } = summary;
  const nothingYet = totals.reports === 0;

  return (
    <Layout>
      <div className="mx-auto max-w-7xl space-y-6">
        {heading}

        {/* Switching period or station refetches, and the old figures stay put while it
            does. Without this the page would look settled on numbers that are about to be
            replaced, which is indistinguishable from the click having done nothing. */}
        {(refreshing || error) && (
          <div className="space-y-2">
            {refreshing && (
              <p
                role="status"
                className="flex items-center gap-2 text-sm font-medium text-primary"
              >
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Updating {periodLabel}…
              </p>
            )}

            {/* A failed refresh keeps the old figures rather than blanking the page, but
                says so — stale numbers presented as current are the worse failure. */}
            {error && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-body">
                <AlertCircleIcon className="h-4 w-4 shrink-0 text-warning" />
                <span>These figures may be out of date. {error}</span>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="font-semibold text-primary hover:text-primary-dark"
                >
                  Refresh
                </button>
              </div>
            )}
          </div>
        )}

        <div
          // Dimmed rather than hidden, and marked busy so a screen reader is told the
          // figures it is about to read are being replaced.
          aria-busy={refreshing}
          className={`space-y-6 transition-opacity duration-200 ${refreshing ? 'opacity-60' : 'opacity-100'}`}
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Money unaccounted for"
            value={formatTZS(variance.unaccounted)}
            valueClass={variance.unaccounted > 0 ? 'text-error' : 'text-success'}
            icon={ScaleIcon}
            iconClass={
              variance.unaccounted > 0
                ? 'bg-error-subtle text-error'
                : 'bg-success-subtle text-success'
            }
            hint={
              variance.computed === 0
                ? 'No shift in this period could be reconciled.'
                : `Across ${variance.computed} of ${totals.reports} shift${
                    totals.reports === 1 ? '' : 's'
                  }${
                    variance.overCollected > 0
                      ? ` · ${formatTZS(variance.overCollected)} over-collected`
                      : ''
                  }`
            }
          />

          <StatCard
            label="Reports needing review"
            value={String(totals.needsReview)}
            valueClass={totals.needsReview > 0 ? 'text-warning' : 'text-body'}
            icon={ReportsIcon}
            iconClass={
              totals.needsReview > 0
                ? 'bg-warning-subtle text-warning'
                : 'bg-slate-100 text-muted'
            }
            hint={
              totals.needsReview > 0
                ? `${totals.fieldsFlagged} field${
                    totals.fieldsFlagged === 1 ? '' : 's'
                  } waiting to be checked`
                : nothingYet
                  ? 'Nothing uploaded yet'
                  : 'Nothing is waiting on you'
            }
            to={correctAllowed ? '/review?tab=NEEDS_REVIEW' : undefined}
          />

          <StatCard
            label="Couldn’t be read"
            value={String(totals.failed)}
            valueClass={totals.failed > 0 ? 'text-error' : 'text-body'}
            icon={AlertCircleIcon}
            iconClass={totals.failed > 0 ? 'bg-error-subtle text-error' : 'bg-slate-100 text-muted'}
            hint={
              totals.failed > 0
                ? 'No figures were extracted — check the file'
                : 'Every upload was read'
            }
            to={correctAllowed ? '/review?tab=FAILED' : undefined}
          />

          <StatCard
            label="Read without a flag"
            value={`${totals.readCleanly} of ${totals.reports}`}
            icon={CheckCircleIcon}
            iconClass="bg-primary-subtle text-primary"
            visual={
              <ProgressRing value={totals.readCleanly} total={totals.reports} className="text-primary" />
            }
            // The one thing this number must not be read as. A shift can be read perfectly
            // and still be missing three million shillings, and that is what the variance
            // column is for.
            hint="Nothing was flagged — check the variance itself"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="card p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-body">
                  <ChartIcon className="h-4 w-4 text-primary" />
                  Variance trend
                </h2>
                <p className="mt-1 text-xs text-muted">
                  One point per reconciled shift, oldest first. Position is the order shifts
                  were reported in, not their calendar spacing.
                </p>
              </div>
            </div>

            {summary.trend.length > 0 ? (
              <>
                <VarianceTrendChart points={summary.trend} />
                {variance.notComputed > 0 && (
                  <p className="mt-3 text-xs text-muted">
                    {variance.notComputed} report
                    {variance.notComputed === 1 ? ' is' : 's are'} not plotted — a figure could
                    not be read, so no variance could be calculated for
                    {variance.notComputed === 1 ? ' it' : ' them'}.
                  </p>
                )}
              </>
            ) : (
              <div className="py-12 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary-subtle text-primary">
                  <ChartIcon className="h-6 w-6" />
                </div>
                <p className="text-sm font-semibold text-body">Nothing to plot yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
                  A shift appears here once its figures have been read and its variance
                  calculated.
                </p>
                {uploadAllowed && (
                  <Link to="/upload" className="btn-primary mt-4">
                    <UploadIcon className="h-4 w-4" />
                    Upload a shift report
                  </Link>
                )}
              </div>
            )}
          </div>

          <AttentionList summary={summary} />
        </div>

        <RecentReportsTable rows={summary.recent} />

        {nothingYet && (
          <div className="card flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
                <FileIcon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-body">
                  {stations.length === 0
                    ? 'No station is assigned to you yet'
                    : totals.outsidePeriod > 0
                      ? `${totals.outsidePeriod} report${
                          totals.outsidePeriod === 1 ? '' : 's'
                        } outside ${periodLabel}`
                      : `No shift reports in ${periodLabel}`}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {stations.length === 0
                    ? 'An owner has to assign you to a station before reports can be uploaded or shown.'
                    : totals.outsidePeriod > 0
                      ? // The period follows the date printed on each report, not the day it
                        // was uploaded, so a backlog of old shifts lands outside the window
                        // however recently it arrived. Saying so beats an empty screen.
                        `This view covers shifts dated in ${periodLabel}. Older reports are still saved — open the full list to see them.`
                      : 'Upload a Petronite shift report PDF and its figures will be read for you.'}
                </p>
              </div>
            </div>
            {stations.length > 0 &&
              (totals.outsidePeriod > 0 ? (
                <Link to="/shift-reports/recent" className="btn-secondary shrink-0">
                  See all reports
                  <ChevronRightIcon className="h-4 w-4" />
                </Link>
              ) : (
                uploadAllowed && (
                  <Link to="/upload" className="btn-primary shrink-0">
                    <UploadIcon className="h-4 w-4" />
                    Upload shift report
                  </Link>
                )
              ))}
          </div>
        )}
        </div>
      </div>
    </Layout>
  );
}
