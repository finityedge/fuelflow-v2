import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StationSummary, TankLeakageResponse, TankLeakageTank } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatCard } from '../components/StatCard.js';
import { TankTrendBars } from '../components/TankTrendBars.js';
import {
  AlertCircleIcon,
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  InfoIcon,
  RefreshIcon,
  TankIcon,
  TrendDownIcon,
} from '../components/icons.js';
import { getTankLeakage } from '../lib/tankLeakage.js';
import { listStations } from '../lib/stations.js';
import { formatLitres, formatNumber } from '../lib/format.js';

const PERIOD_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

/**
 * The review queue's counterpart for fuel rather than money.
 *
 * The dashboard answers "is the cash right?"; this answers "is the fuel still in the tank?".
 * They are different questions with different evidence, and a shift can balance perfectly in
 * shillings while a tank empties, because the litres were sold and the money banked. The only
 * trace is the tape against the book.
 *
 * Two things the screen has to get across, both of which the numbers alone do not say:
 *
 *   - which direction is bad. Book above dip means fuel the paperwork believes in and the tank
 *     does not contain, so a *positive* number is the bad one here, same as on the money side.
 *   - that a leak is a run, not a reading. A tank thirty litres down four shifts in a row is
 *     losing fuel at a rate that empties it in a season, and no one of those shifts is
 *     remarkable on its own. The alert says so in words.
 */
export function TankLeakage() {
  const [stations, setStations] = useState<StationSummary[]>([]);
  const [stationId, setStationId] = useState('');
  const [periodDays, setPeriodDays] = useState<number>(30);

  const [data, setData] = useState<TankLeakageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations();
        if (!cancelled) {
          setStations(next);
        }
      } catch {
        // The page still totals correctly across everything the user may see; only the
        // filter is missing, and it is hidden when there is nothing to filter by.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await getTankLeakage({ stationId: stationId || undefined, periodDays });
    setData(next);
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
          setError(err instanceof Error ? err.message : 'The tank figures could not be loaded.');
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

  /** A reload that keeps the old figures on screen rather than blanking the page. */
  const refreshing = loading && data !== null;
  const periodLabel = `the last ${periodDays} days`;
  const multiStation = stations.length > 1;

  const heading = (
    <PageHeading
      title="Wet stock"
      description={`What the tape found against what the paperwork says, over ${periodLabel}. A positive figure is fuel that was on paper and not in the tank.`}
      actions={
        <>
          {multiStation && (
            <div className="relative">
              <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <label htmlFor="leakage-station" className="sr-only">
                Station
              </label>
              <select
                id="leakage-station"
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
                  periodDays === option.days ? 'bg-primary text-white' : 'text-muted hover:text-body'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
            <RefreshIcon className="h-4 w-4" />
            Refresh
          </button>
        </>
      }
    />
  );

  if (loading && !data) {
    return (
      <Layout>
        <div className="mx-auto max-w-6xl">
          {heading}
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Comparing the tape against the book…</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error && !data) {
    return (
      <Layout>
        <div className="mx-auto max-w-6xl">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertCircleIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Tank figures unavailable</h2>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  if (!data) {
    return null;
  }

  const { totals, tanks, unmapped } = data;
  const netMissing = totals.varianceLitres;

  return (
    <Layout>
      <div className="mx-auto max-w-6xl space-y-6">
        {heading}

        {(refreshing || error) && (
          <div className="space-y-2">
            {refreshing && (
              <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                Updating {periodLabel}…
              </p>
            )}
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

        {/*
          The explainer is not optional furniture. "Wet stock" is trade language, and a station
          owner meeting it for the first time has no way to know from the numbers alone which
          direction is bad — the money screen's convention is the opposite of what most people
          guess for a dip reading.
        */}
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            Each shift, the report carries a <strong className="font-semibold text-body">book stock</strong> —
            what the station&rsquo;s paperwork says should be in the tank — and a{' '}
            <strong className="font-semibold text-body">closing dip</strong>, what the tape actually
            found. Where the book is higher, fuel has gone. Correcting a figure on a shift report
            moves these numbers: nothing here is a stored copy.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Missing from tanks"
            value={formatLitres(netMissing)}
            valueClass={netMissing > 0 ? 'text-error' : 'text-success'}
            icon={TankIcon}
            iconClass={netMissing > 0 ? 'bg-error-subtle text-error' : 'bg-success-subtle text-success'}
            hint={
              totals.tanks === 0
                ? 'No shift in this period carried a tank reading.'
                : `Net across ${totals.tanks} tank${totals.tanks === 1 ? '' : 's'}`
            }
          />

          <StatCard
            label="Tanks needing attention"
            value={String(totals.tanksAlerting)}
            valueClass={totals.tanksAlerting > 0 ? 'text-error' : 'text-body'}
            icon={AlertIcon}
            iconClass={
              totals.tanksAlerting > 0 ? 'bg-error-subtle text-error' : 'bg-slate-100 text-muted'
            }
            hint={
              totals.tanksAlerting > 0
                ? 'Short by more than their threshold'
                : 'Every tank is within its threshold'
            }
          />

          <StatCard
            label="Tanks running short"
            value={String(totals.tanksShort)}
            icon={TrendDownIcon}
            iconClass="bg-warning-subtle text-warning"
            hint="Net down over the period, however slightly"
          />

          <StatCard
            label="Shifts compared"
            value={String(totals.shiftsAnalysed)}
            icon={CheckCircleIcon}
            iconClass="bg-primary-subtle text-primary"
            hint={
              totals.shiftsAnalysed === 0
                ? 'No report carried a book-and-dip pair'
                : 'A shift is counted once, not once per tank'
            }
          />
        </div>

        {unmapped.length > 0 && (
          <div className="card border-warning/30 bg-warning-subtle p-5">
            <div className="flex items-start gap-3">
              <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div>
                <h2 className="text-sm font-bold text-body">
                  {unmapped.length === 1
                    ? 'One tank on these reports is not set up'
                    : `${unmapped.length} tanks on these reports are not set up`}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Their figures are real and are counted above. Until a tank is named on the
                  station&rsquo;s set-up it has no product, no capacity and no threshold, so it
                  cannot be alerted on — there is no line to hold it to.
                </p>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {unmapped.map((tank) => (
                    // The key goes with the link, so the set-up form opens on the exact
                    // spelling the reports are printing rather than on a name somebody has to
                    // guess at. Naming a tank is what turns these litres into an alert.
                    <li key={`${tank.stationId}:${tank.slug}`}>
                      <Link
                        to={`/settings?stationId=${encodeURIComponent(
                          tank.stationId
                        )}&newTank=${encodeURIComponent(tank.slug)}`}
                        className="block rounded-lg border border-warning/30 bg-surface px-3 py-1.5 text-xs text-body transition-colors hover:border-warning hover:bg-warning-subtle"
                        title={`Set up ${tank.slug} on ${tank.stationName ?? 'this station'}`}
                      >
                        <span className="font-mono font-semibold">{tank.slug}</span>
                        {tank.stationName ? ` · ${tank.stationName}` : ''}
                        {' · '}
                        {formatLitres(tank.varianceLitres)} over {tank.shifts} shift
                        {tank.shifts === 1 ? '' : 's'}
                        <span className="ml-2 font-semibold text-primary">Name it →</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {tanks.length === 0 ? (
          <div className="card p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <TankIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">No tank readings to compare</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {unmapped.length > 0
                ? 'The reports name tanks that are not set up yet, so nothing can be held to a threshold. Name them on the station and they appear here.'
                : `No shift report in ${periodLabel} carried a book figure and a dip for the same tank. Both are needed before a difference means anything.`}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Link to="/shift-reports/recent" className="btn-secondary">
                See all shift reports
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {tanks.map((tank) => (
              <TankCard key={tank.tankId ?? `${tank.stationId}:${tank.slug}`} tank={tank} showStation={multiStation && !stationId} />
            ))}
          </div>
        )}

        {totals.tanks > 0 && (
          <p className="text-xs text-muted">
            Thresholds are the station&rsquo;s own where one has been set, and otherwise half a
            percent of the tank&rsquo;s capacity — roughly where gauge error stops explaining a
            difference. A tank with neither a threshold nor a capacity is shown but never alerted
            on alone.
          </p>
        )}
      </div>
    </Layout>
  );
}

/** One tank, with its verdict, its numbers and its shift-by-shift shape. */
function TankCard({ tank, showStation }: { tank: TankLeakageTank; showStation: boolean }) {
  const short = tank.varianceLitres > 0;
  const alerted = tank.alert !== null;

  return (
    <div
      className={`card overflow-hidden ${alerted ? 'border-error/30' : ''}`}
      // Marked so a screen reader hears the tank and its verdict before being read the
      // figures — the numbers mean nothing until you know which tank and whether it is bad.
      aria-label={`${tank.name}${showStation && tank.stationName ? ` at ${tank.stationName}` : ''}: ${
        alerted ? 'needs attention' : short ? 'slightly short' : 'within threshold'
      }`}
    >
      {alerted && tank.alert && (
        <div className="flex items-start gap-3 border-b border-error/20 bg-error-subtle px-5 py-3">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-error" />
          <div>
            <p className="text-sm font-semibold text-body">{tank.alert.message}</p>
            <p className="mt-0.5 text-xs text-muted">
              {tank.alert.signal === 'single_shift'
                ? 'One shift is enough to act on.'
                : 'No single shift here would have been worth a second look.'}
              {tank.alert.reportId && (
                <>
                  {' '}
                  <Link
                    to={`/shift-reports/${tank.alert.reportId}`}
                    className="font-semibold text-primary hover:text-primary-dark"
                  >
                    Open that shift
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                alerted
                  ? 'bg-error-subtle text-error'
                  : short
                    ? 'bg-warning-subtle text-warning'
                    : 'bg-success-subtle text-success'
              }`}
            >
              <TankIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-body">{tank.name}</h2>
              <p className="text-xs text-muted">
                {showStation && tank.stationName ? `${tank.stationName} · ` : ''}
                {tank.product ? `${tank.product} · ` : ''}
                {tank.slug}
              </p>
            </div>
          </div>

          <div className="text-right">
            <p
              className={`font-mono text-2xl font-bold tracking-tight ${
                short ? 'text-error' : 'text-success'
              }`}
            >
              {formatLitres(tank.varianceLitres)}
            </p>
            <p className="text-xs text-muted">
              {short ? 'missing over the period' : 'more than the book, over the period'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <TankTrendBars points={tank.trend} />
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted">Shifts short</dt>
            <dd className="font-mono font-semibold text-body">
              {tank.shiftsShort} of {tank.shifts}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Worst single shift</dt>
            <dd className="font-mono font-semibold text-body">{formatLitres(tank.worstShiftLitres)}</dd>
          </div>
          <div>
            <dt className="text-muted">Alert threshold</dt>
            <dd className="font-mono font-semibold text-body">
              {tank.thresholdLitres === null ? 'none set' : formatLitres(tank.thresholdLitres)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Of capacity</dt>
            <dd className="font-mono font-semibold text-body">
              {tank.capacityPercent === null
                ? 'capacity unknown'
                : `${formatNumber(Math.abs(tank.capacityPercent))}%`}
            </dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {tank.shiftsNotComparable > 0 && (
            <span>
              {tank.shiftsNotComparable} shift
              {tank.shiftsNotComparable === 1 ? '' : 's'} could not be compared — a figure was
              missing, and a missing dip is not a full tank.
            </span>
          )}
          {tank.provisional && <span>A figure is still flagged, so this may move.</span>}
          {tank.thresholdLitres === null && (
            <span>
              No threshold and no capacity on this tank, so a shortfall of any size goes
              unremarked.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
