import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AttendantProfile,
  AttendantProfilesResponse,
  AttendantSummary,
  StationSummary,
  UnmappedAttendant,
} from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatCard } from '../components/StatCard.js';
import { VarianceBars } from '../components/VarianceBars.js';
import {
  AlertCircleIcon,
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  InfoIcon,
  RefreshIcon,
  ScaleIcon,
  TrendDownIcon,
  UsersIcon,
} from '../components/icons.js';
import { getAttendantProfiles } from '../lib/attendantProfiles.js';
import { getStationDetail, linkAttendantAlias, listStations } from '../lib/stations.js';
import { formatNumber, formatTZS } from '../lib/format.js';

const PERIOD_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

/**
 * Who is quietly short, and has it changed?
 *
 * The dashboard says a shift came up short. What it cannot say is that the *same person* came up
 * short by a small amount on eleven of their last fourteen shifts — each of those individually
 * inside the station's tolerance, and therefore indistinguishable from a busy day. The loss is
 * not in any one shift; it is in the aggregate, and this screen is the aggregate.
 *
 * Three things it has to get across, none of which the numbers say on their own:
 *
 *   - the sign. Positive is money that was due and not handed over, same as everywhere else.
 *   - that the person and the shift are different questions. The alert says which one it is.
 *   - the scale the variance happened at. TZS 5,000 is one thing on a person who handled
 *     50,000 and another on a person who handled five million, so the takings are shown beside
 *     every shortfall.
 */
export function AttendantProfiles() {
  const [stations, setStations] = useState<StationSummary[]>([]);
  const [stationId, setStationId] = useState('');
  const [periodDays, setPeriodDays] = useState<number>(30);

  const [data, setData] = useState<AttendantProfilesResponse | null>(null);
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
        // The screen still totals correctly across everything the user may see; only the
        // filter is missing, and it is hidden when there is nothing to filter by.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await getAttendantProfiles({ stationId: stationId || undefined, periodDays });
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
          setError(err instanceof Error ? err.message : 'The attendant figures could not be loaded.');
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
      title="Attendants"
      description={`What each person was due to hand over against what they did, over ${periodLabel}. A positive figure is money that was due and did not arrive.`}
      actions={
        <>
          {multiStation && (
            <div className="relative">
              <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <label htmlFor="profiles-station" className="sr-only">
                Station
              </label>
              <select
                id="profiles-station"
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
            <p className="text-sm text-muted">Reading every reconciliation in the period…</p>
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
            <h2 className="text-lg font-bold text-body">Attendant figures unavailable</h2>
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

  const { totals, attendants, unmapped } = data;
  const netMissing = totals.variance;

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
          The explainer is not optional furniture here either. This is the one screen in the
          product that names people, and a reader arriving at it for the first time needs to
          know that the arithmetic is the report's own two figures and not a judgement: the
          shortfall exists because expected minus collected is not zero, and correcting either
          figure on the shift moves it.
        */}
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            Each report prints, per attendant, what they were{' '}
            <strong className="font-semibold text-body">due to hand over</strong> and what they{' '}
            <strong className="font-semibold text-body">handed over</strong>. The difference is
            the figure below. Nothing here is stored — correcting either figure on a shift report
            moves it, and a shortfall of a few hundred shillings on one shift is what a run of
            them is built from.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Money unaccounted for"
            value={formatTZS(netMissing)}
            valueClass={netMissing > 0 ? 'text-error' : 'text-success'}
            icon={ScaleIcon}
            iconClass={netMissing > 0 ? 'bg-error-subtle text-error' : 'bg-success-subtle text-success'}
            hint={
              totals.attendants === 0
                ? 'No shift in this period carried an attendant reconciliation.'
                : `Net across ${totals.attendants} attendant${totals.attendants === 1 ? '' : 's'}`
            }
          />

          <StatCard
            label="Needing attention"
            value={String(totals.attendantsAlerting)}
            valueClass={totals.attendantsAlerting > 0 ? 'text-error' : 'text-body'}
            icon={AlertIcon}
            iconClass={
              totals.attendantsAlerting > 0 ? 'bg-error-subtle text-error' : 'bg-slate-100 text-muted'
            }
            hint={
              totals.attendantsAlerting > 0
                ? 'One big shift, or a pattern across many'
                : 'Nobody has a signal worth acting on'
            }
          />

          <StatCard
            label="Net short"
            value={String(totals.attendantsShort)}
            icon={TrendDownIcon}
            iconClass="bg-warning-subtle text-warning"
            hint="Handed over less than they were due, however little"
          />

          <StatCard
            label="Shifts compared"
            value={String(totals.shiftsAnalysed)}
            icon={CheckCircleIcon}
            iconClass="bg-primary-subtle text-primary"
            hint={
              totals.shiftsAnalysed === 0
                ? 'No report carried both figures for a named attendant'
                : 'A shift is counted once, not once per person'
            }
          />
        </div>

        {unmapped.length > 0 && (
          <UnmappedNames rows={unmapped} onLinked={() => void load()} />
        )}

        {attendants.length === 0 ? (
          <div className="card p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <UsersIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">No reconciliations to compare</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              {unmapped.length > 0
                ? 'The reports name attendants who are not set up on their station yet, so their figures have nobody to belong to. Join a name below and their history appears here.'
                : `No shift report in ${periodLabel} printed both a figure due and a figure handed over for a named attendant. Both are needed before a difference means anything.`}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Link to="/shift-reports/recent" className="btn-secondary">
                See all shift reports
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {attendants.map((profile) => (
              <AttendantCard
                key={profile.attendantId ?? `${profile.stationId}:${profile.slug}`}
                profile={profile}
                showStation={multiStation && !stationId}
              />
            ))}
          </div>
        )}

        {totals.attendants > 0 && (
          <p className="text-xs text-muted">
            A single shift is flagged at or over the station&rsquo;s own threshold —{' '}
            {formatTZS(totals.varianceThreshold)} here. The other two signals invent no threshold
            of their own, because &ldquo;most of their shifts were short&rdquo; and &ldquo;their
            last few were worse than their own normal&rdquo; are statements about one
            person&rsquo;s history and there is nothing station-wide to judge them against.
          </p>
        )}
      </div>
    </Layout>
  );
}

/**
 * The names nobody has claimed, with the way to claim one.
 *
 * Kept rather than dropped, and for a sharper reason than tanks: this is the case where a
 * repeated shortfall has nowhere to be recorded at all, so the money would otherwise leave the
 * product without a trace. The offer to join the name to a known attendant is the whole point —
 * and it is an offer a human accepts, never a similarity rule, because a guess that moved one
 * person's shortfall onto a colleague's record would be an accusation made by software.
 */
function UnmappedNames({ rows, onLinked }: { rows: UnmappedAttendant[]; onLinked: () => void }) {
  return (
    <div className="card border-warning/30 bg-warning-subtle p-5">
      <div className="flex items-start gap-3">
        <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-body">
            {rows.length === 1
              ? 'One name on these reports belongs to nobody yet'
              : `${rows.length} names on these reports belong to nobody yet`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Their figures are real and are counted nowhere above. A name no attendant record
            answers to has no one to accumulate against, so a small shortfall repeated every
            shift under it stays invisible. Join it to the person it names.
          </p>

          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <UnmappedRow key={`${row.stationId}:${row.slug}`} row={row} onLinked={onLinked} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** One stray name, and the inline form that joins it to somebody. */
function UnmappedRow({
  row,
  onLinked,
}: {
  row: UnmappedAttendant;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<AttendantSummary[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openForm() {
    setOpen(true);
    setError(null);
    if (candidates !== null) {
      return;
    }
    try {
      const detail = await getStationDetail(row.stationId);
      // Somebody in a different tenant's station is not reachable from here, and the list is
      // the station's own attendants, which is who a printed name on that station's reports
      // could possibly be.
      setCandidates(detail.attendants);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The station’s attendants could not be loaded.');
    }
  }

  async function join() {
    if (!chosen) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await linkAttendantAlias(row.stationId, chosen, { slug: row.slug });
      setOpen(false);
      onLinked();
    } catch (err) {
      // The server's own words, not a generic failure: it names the person a key already
      // belongs to, which is the only way the reader learns why this did nothing.
      setError(err instanceof Error ? err.message : 'That name could not be joined.');
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="rounded-xl border border-warning/30 bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-body">
            {row.name ?? row.slug}
            {row.name && <span className="ml-2 font-mono text-xs font-normal text-muted">{row.slug}</span>}
          </p>
          <p className="text-xs text-muted">
            {row.stationName ? `${row.stationName} · ` : ''}
            {formatTZS(row.variance)} over {row.shifts} shift{row.shifts === 1 ? '' : 's'}
          </p>
        </div>

        {!open && (
          <button
            type="button"
            className="btn-secondary py-1.5 text-xs"
            onClick={() => void openForm()}
          >
            Join to an attendant
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <label htmlFor={`join-${row.slug}`} className="sr-only">
            Attendant to join {row.name ?? row.slug} to
          </label>
          <select
            id={`join-${row.slug}`}
            className="input w-auto min-w-[12rem] py-2 text-sm"
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">
              {candidates === null ? 'Loading…' : 'Choose an attendant'}
            </option>
            {(candidates ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.isActive ? '' : ' (retired)'}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn-primary py-2 text-sm"
            disabled={!chosen || pending}
            onClick={() => void join()}
          >
            {pending ? 'Joining…' : 'Join'}
          </button>
          <button
            type="button"
            className="btn-secondary py-2 text-sm"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </button>

          {candidates !== null && candidates.length === 0 && (
            <p className="text-xs text-muted">
              This station has no attendants set up yet. Add {row.name ?? row.slug} on the
              station&rsquo;s set-up first.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-2 text-xs text-error">
          <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </li>
  );
}

/** One person, with their verdict, their figures and their shift-by-shift shape. */
function AttendantCard({
  profile,
  showStation,
}: {
  profile: AttendantProfile;
  showStation: boolean;
}) {
  const short = profile.variance > 0;
  const alerted = profile.alert !== null;

  // The share of what they were responsible for. `collected + variance` is what they were due,
  // which is the honest denominator: dividing by what they handed over makes a shortfall read
  // as a bigger share the more was missing.
  const due = profile.collected + profile.variance;
  const share = due > 0 ? (profile.variance / due) * 100 : null;

  return (
    <div
      className={`card overflow-hidden ${alerted ? 'border-error/30' : ''}`}
      // Marked so a screen reader hears the person and their verdict before being read the
      // figures — the numbers mean nothing until you know who and whether it is bad.
      aria-label={`${profile.name}${
        showStation && profile.stationName ? ` at ${profile.stationName}` : ''
      }: ${alerted ? 'needs attention' : short ? 'slightly short' : 'within threshold'}`}
    >
      {alerted && profile.alert && (
        <div className="flex items-start gap-3 border-b border-error/20 bg-error-subtle px-5 py-3">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-error" />
          <div>
            <p className="text-sm font-semibold text-body">{profile.alert.message}</p>
            <p className="mt-0.5 text-xs text-muted">
              {profile.alert.signal === 'single_shift'
                ? 'One shift is enough to act on.'
                : profile.alert.signal === 'recurring_shortfall'
                  ? 'No single shift here would have been worth a second look.'
                  : 'Nothing here is large — what changed is their own pattern.'}
              {profile.alert.reportId && (
                <>
                  {' '}
                  <Link
                    to={`/shift-reports/${profile.alert.reportId}`}
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
              <UsersIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-body">{profile.name}</h2>
              <p className="text-xs text-muted">
                {showStation && profile.stationName ? `${profile.stationName} · ` : ''}
                <span className="font-mono">{profile.slug}</span>
                {profile.userId ? ' · has a login' : ''}
              </p>
            </div>
          </div>

          <div className="text-right">
            <p
              className={`font-mono text-2xl font-bold tracking-tight ${
                short ? 'text-error' : 'text-success'
              }`}
            >
              {formatTZS(profile.variance)}
            </p>
            <p className="text-xs text-muted">
              {short ? 'unaccounted for over the period' : 'handed over more than was due'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <VarianceBars
            points={profile.trend}
            heading="Cash reconciliation"
            describe={(variance) =>
              variance === 0
                ? 'handed over exactly what was due'
                : variance > 0
                  ? `${formatTZS(variance)} short`
                  : `${formatTZS(-variance)} more than was due`
            }
            describeNet={(total) => `Net ${formatTZS(total)} unaccounted for`}
          />
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted">Shifts short</dt>
            <dd className="font-mono font-semibold text-body">
              {profile.shiftsShort} of {profile.shifts}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Worst single shift</dt>
            <dd className="font-mono font-semibold text-body">{formatTZS(profile.worstShift)}</dd>
          </div>
          <div>
            <dt className="text-muted">Typical shift</dt>
            <dd className="font-mono font-semibold text-body">
              {profile.baselineVariance === null ? '—' : formatTZS(profile.baselineVariance)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Of what they handled</dt>
            <dd className="font-mono font-semibold text-body">
              {share === null ? 'nothing collected' : `${formatNumber(Math.abs(share))}%`}
            </dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            {formatTZS(profile.collected)} collected over {profile.shifts} comparable shift
            {profile.shifts === 1 ? '' : 's'}.
          </span>
          {profile.shiftsNotComparable > 0 && (
            <span>
              {profile.shiftsNotComparable} shift
              {profile.shiftsNotComparable === 1 ? '' : 's'} could not be compared — a figure was
              missing, and a missing figure is not a zero.
            </span>
          )}
          {profile.provisional && <span>A figure is still flagged, so this may move.</span>}
        </div>
      </div>
    </div>
  );
}
