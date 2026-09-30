import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FindingsSheet as FindingsSheetData, StationSummary } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { useAuthStore } from '../stores/authStore.js';
import {
  AlertCircleIcon,
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  InfoIcon,
  PrinterIcon,
  RefreshIcon,
  TankIcon,
  UsersIcon,
} from '../components/icons.js';
import { getFindingsSheet } from '../lib/findings.js';
import { listStations } from '../lib/stations.js';
import {
  formatLitres,
  formatNumber,
  formatReportDate,
  formatTimestamp,
  formatTZS,
} from '../lib/format.js';

const PERIOD_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

/**
 * The findings sheet — the free audit, written down.
 *
 * This is the only screen in the product whose output is meant to leave it. Everything else is
 * a console an operator reads and acts on; this is a document that gets printed and put on a
 * station owner's desk, and the design follows from that in three ways:
 *
 *   - nothing on it is interactive except the controls, which are hidden when it prints;
 *   - every figure is already decided by the server. This page does no arithmetic at all. It
 *     renders what `GET /api/findings` returned, including the sentences at the top, because
 *     the one way a document like this can do real damage is by disagreeing with the screen it
 *     was built from — and that cannot happen if the client never computes anything.
 *   - it says when it is not finished. A report can be corrected and the figures move, so if
 *     any reading under this period is still flagged the sheet says so at the top rather than
 *     silently being one revision out of date on the day it is handed over.
 */
export function FindingsSheet() {
  const user = useAuthStore((state) => state.user);
  const [searchParams] = useSearchParams();

  const [stations, setStations] = useState<StationSummary[]>([]);
  const [stationId, setStationId] = useState('');
  const [periodDays, setPeriodDays] = useState<number>(30);

  const [data, setData] = useState<FindingsSheetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Arriving from the dashboard carries the station the reader was already looking at, so
    // the sheet opens on the figures they clicked rather than on whichever station happens to
    // be first. It is only a starting value — the dropdown below overrules it.
    const requested = searchParams.get('stationId');

    let cancelled = false;
    void (async () => {
      try {
        const next = await listStations();
        if (cancelled) {
          return;
        }
        setStations(next);
        // The sheet is about one station and the endpoint requires one, so the screen has to
        // pick before it can show anything. The first station is the honest default: the
        // alternative is a blank page with a dropdown, which reads as a failure.
        setStationId((current) => {
          if (current) {
            return current;
          }
          return requested && next.some((station) => station.id === requested)
            ? requested
            : (next[0]?.id ?? '');
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The station list could not be loaded.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `searchParams` is stable between renders for a given location, so this runs on mount —
    // it re-runs only if the URL itself changes, which is when the parameter actually means
    // something new. It is a starting value, not a binding: nothing writes it back.
  }, [searchParams]);

  const load = useCallback(async () => {
    const next = await getFindingsSheet({ stationId, periodDays });
    setData(next);
  }, [stationId, periodDays]);

  useEffect(() => {
    if (!stationId) {
      return;
    }
    let cancelled = false;

    /*
     * The previous sheet is cleared before the next one is fetched, which is the opposite of
     * what the other screens in this app do — they deliberately keep the old figures on screen
     * behind a dimmed banner so a slow load does not blank the page.
     *
     * Here that would be a hazard rather than a mercy. This is the one page whose contents get
     * printed, and a stale sheet under a newly-chosen station name is a document attributing
     * one forecourt's shortfalls to another. The blank is brief and the spinner says what is
     * happening; a wrong sheet on somebody's desk is not recoverable.
     */
    setData(null);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'The findings sheet could not be assembled.');
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
  }, [stationId, load]);

  const heading = (
    <PageHeading
      title="Findings sheet"
      description="A one-station summary of what the reports show, ready to print and hand over."
      actions={
        <>
          <div className="relative">
            <BuildingIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <label htmlFor="findings-station" className="sr-only">
              Station
            </label>
            <select
              id="findings-station"
              className="input w-auto min-w-[13rem] py-2.5 pl-11 pr-8"
              value={stationId}
              onChange={(event) => setStationId(event.target.value)}
            >
              {stations.length === 0 && <option value="">No stations</option>}
              {stations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name}
                </option>
              ))}
            </select>
          </div>

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

          <button
            type="button"
            className="btn-secondary"
            onClick={() => void load()}
            disabled={loading || !stationId}
          >
            <RefreshIcon className="h-4 w-4" />
            Refresh
          </button>

          <button
            type="button"
            className="btn-primary"
            onClick={() => window.print()}
            disabled={!data}
          >
            <PrinterIcon className="h-4 w-4" />
            Print or save as PDF
          </button>
        </>
      }
    />
  );

  const body = useMemo(() => {
    if (loading && !data) {
      return (
        <div className="card p-10 text-center">
          <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted">Reconciling every shift in the period…</p>
        </div>
      );
    }

    if (error && !data) {
      return (
        <div className="card p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
            <AlertCircleIcon className="h-7 w-7" />
          </div>
          <h2 className="text-lg font-bold text-body">The sheet could not be assembled</h2>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button type="button" className="btn-primary mt-5" onClick={() => void load()}>
            Try again
          </button>
        </div>
      );
    }

    if (!data) {
      return (
        <div className="card p-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
            <InfoIcon className="h-7 w-7" />
          </div>
          <h2 className="text-lg font-bold text-body">No station to report on</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            A findings sheet is about one forecourt. There is no station on this account yet, so
            there is nothing to assemble.
          </p>
        </div>
      );
    }

    return <Sheet document={data} preparedBy={user?.email ?? null} />;
  }, [loading, error, data, load, user]);

  return (
    <Layout>
      <div className="print-sheet mx-auto max-w-4xl space-y-6">
        <div className="no-print">{heading}</div>

        {body}
      </div>
    </Layout>
  );
}

/**
 * The document itself.
 *
 * Nothing in here is interactive and nothing in here computes. Where a figure has a qualifier —
 * a null variance, an unclaimed name, a flagged reading — the qualifier is printed rather than
 * the figure being quietly left out, because a reader holding the paper has no other way to ask.
 */
function Sheet({ document: sheet, preparedBy }: { document: FindingsSheetData; preparedBy: string | null }) {
  const { money, shifts } = sheet;
  const shortAttendants = sheet.attendants.filter((profile) => profile.variance > 0);
  const flaggedTanks = sheet.tanks.filter(
    (tank) => tank.alert !== null || tank.varianceLitres !== 0
  );
  const hasUnattributed =
    sheet.unattributed.attendants.length > 0 || sheet.unattributed.tanks.length > 0;

  return (
    <>
      <article className="card overflow-hidden">
        <div className="border-b border-border bg-primary-subtle px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            FuelFlow · reconciliation audit
          </p>
          <h2 className="mt-1 text-2xl font-bold text-body">{sheet.station.name}</h2>
          <p className="mt-0.5 text-sm text-muted">
            {sheet.station.location ? `${sheet.station.location} · ` : ''}
            {formatReportDate(sheet.from)} to {formatReportDate(sheet.to)} ({sheet.periodDays} days)
          </p>
          <p className="mt-2 text-xs text-muted">
            Generated {formatTimestamp(sheet.generatedAt)}
            {preparedBy ? ` by ${preparedBy}` : ''}
          </p>
        </div>

        {sheet.provisional && (
          <div className="flex items-start gap-3 border-b border-warning/30 bg-warning-subtle px-6 py-3">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-body">
              <strong className="font-semibold">Provisional.</strong> At least one figure in this
              period is still flagged for a human to check. Correcting it will move the totals on
              this page, so read the flagged shifts before acting on them.
            </p>
          </div>
        )}

        <ol className="divide-y divide-border">
          {sheet.headlines.map((headline) => (
            <li key={headline} className="flex items-start gap-3 px-6 py-4">
              <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-sm leading-relaxed text-body">{headline}</p>
            </li>
          ))}
        </ol>
      </article>

      <section className="card overflow-hidden">
        <h2 className="border-b border-border px-6 py-4 text-base font-bold text-body">
          The money
        </h2>
        <dl className="grid gap-x-8 gap-y-3 px-6 py-5 sm:grid-cols-2">
          <Figure label="Shift reports uploaded" value={formatNumber(money.reports)} hint="In the period, however each one ended up." />
          <Figure
            label="Reconciled shifts"
            value={formatNumber(money.shiftsCompared)}
            hint="Both sides of the subtraction were readable, so a variance exists."
          />
          <Figure
            label="Unaccounted for"
            value={formatTZS(money.unaccounted)}
            tone={money.unaccounted > 0 ? 'bad' : 'neutral'}
            hint="Sum of the shifts that came up short."
          />
          <Figure
            label="Over-collected"
            value={formatTZS(money.overCollected)}
            tone={money.overCollected > 0 ? 'warn' : 'neutral'}
            hint="Sum of the shifts that came up over. Kept apart from the shortfall — netting the two would hide both."
          />
          <Figure
            label="Net over the period"
            value={formatTZS(money.net)}
            tone={money.net > 0 ? 'bad' : money.net < 0 ? 'good' : 'neutral'}
            hint="Short shifts less over-collected shifts."
          />
          <Figure
            label="Figures still to check"
            value={formatNumber(money.flaggedFields)}
            tone={money.flaggedFields > 0 ? 'warn' : 'neutral'}
            hint="Read but not yet confirmed by a person."
          />
          <Figure
            label="Reports that could not be read"
            value={formatNumber(money.failedReports)}
            tone={money.failedReports > 0 ? 'warn' : 'neutral'}
            hint="Not in any figure above. A failed parse is not a balanced shift."
          />

          {money.largest && (
            <Figure
              label="Worst single shift"
              value={formatTZS(money.largest.variance)}
              tone={money.largest.variance > 0 ? 'bad' : 'good'}
              hint={`${money.largest.fileName ?? 'Untitled report'}${
                money.largest.reportDate ? ` · ${formatReportDate(money.largest.reportDate)}` : ''
              }`}
            />
          )}
        </dl>
      </section>

      <section className="card overflow-hidden">
        <h2 className="border-b border-border px-6 py-4 text-base font-bold text-body">
          Exceptions
        </h2>

        <div className="space-y-5 px-6 py-5">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-body">
              <UsersIcon className="h-4 w-4 text-muted" />
              Attendants
            </h3>

            {sheet.attendants.length === 0 && sheet.unattributed.attendants.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No shift in this period printed both a figure due and a figure handed over, so no
                attendant could be compared.
              </p>
            ) : sheet.attendants.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Every attendant figure in the period belongs to a name nobody has claimed — see
                below.
              </p>
            ) : sheet.totals.attendants.attendantsAlerting === 0 && shortAttendants.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Nobody is short. {formatNumber(sheet.totals.attendants.attendants)} attendant
                {sheet.totals.attendants.attendants === 1 ? '' : 's'} compared over{' '}
                {formatNumber(sheet.totals.attendants.shiftsAnalysed)} shifts, all net positive or
                exactly balanced.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {sheet.attendants
                  .filter((profile) => profile.alert !== null || profile.variance > 0)
                  .map((profile) => (
                    <li
                      key={profile.attendantId ?? `${profile.stationId}:${profile.slug}`}
                      className="flex items-start justify-between gap-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-body">{profile.name}</p>
                        <p className="text-xs text-muted">
                          {profile.shiftsShort} of {profile.shifts} shifts short
                          {profile.provisional ? ' · a figure is still flagged' : ''}
                        </p>
                        {profile.alert && (
                          <p className="mt-1 text-xs text-body">{profile.alert.message}</p>
                        )}
                      </div>
                      <p className="shrink-0 font-mono text-sm font-bold text-error">
                        {formatTZS(profile.variance)}
                      </p>
                    </li>
                  ))}
              </ul>
            )}

            {sheet.attendants.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Across every attendant compared: {formatTZS(sheet.totals.attendants.variance)} net.
                A single shift is flagged at or over the station&rsquo;s own threshold of{' '}
                {formatTZS(sheet.station.varianceThreshold)}.
              </p>
            )}
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="flex items-center gap-2 text-sm font-bold text-body">
              <TankIcon className="h-4 w-4 text-muted" />
              Tanks
            </h3>

            {sheet.tanks.length === 0 && sheet.unattributed.tanks.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                No report in this period carried both a book figure and a dip for the same tank, so
                nothing could be compared.
              </p>
            ) : sheet.tanks.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Every tank reading in the period is keyed to a tank nobody has set up — see below.
              </p>
            ) : flaggedTanks.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Book and dip agree on every tank, or the tanks came out ahead. Nothing is
                unaccounted for.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {flaggedTanks.map((tank) => (
                  <li
                    key={`${tank.stationId}:${tank.slug}`}
                    className="flex items-start justify-between gap-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-body">
                        {tank.name}
                        {tank.product && (
                          <span className="ml-2 text-xs font-normal text-muted">{tank.product}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        {tank.shifts} shift{tank.shifts === 1 ? '' : 's'} compared
                        {tank.thresholdLitres !== null
                          ? ` · flagged at ${formatLitres(tank.thresholdLitres)} on one shift`
                          : ' · no threshold set, so only a run of shortfalls can alert'}
                        {tank.provisional ? ' · a reading is still flagged' : ''}
                      </p>
                      {tank.alert && <p className="mt-1 text-xs text-body">{tank.alert.message}</p>}
                    </div>
                    <p
                      className={`shrink-0 font-mono text-sm font-bold ${
                        tank.varianceLitres > 0 ? 'text-error' : 'text-success'
                      }`}
                    >
                      {formatLitres(tank.varianceLitres)}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {sheet.tanks.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Across every tank compared: {formatLitres(sheet.totals.tanks.varianceLitres)} net
                against the book over {formatNumber(sheet.totals.tanks.shiftsAnalysed)} shifts.
              </p>
            )}
          </div>
        </div>
      </section>

      {hasUnattributed && (
        <section className="card overflow-hidden border-warning/30">
          <h2 className="border-b border-border px-6 py-4 text-base font-bold text-body">
            Not attributed to anybody
          </h2>
          <div className="space-y-3 px-6 py-5 text-sm">
            <p className="text-muted">
              These figures are real and are counted in no total on this sheet. They are kept
              apart rather than guessed at, because moving a shortfall onto the wrong record is
              worse than leaving it unattributed.
            </p>

            {sheet.unattributed.attendants.length > 0 && (
              <div>
                <p className="font-semibold text-body">Names on the reports</p>
                <ul className="mt-1 space-y-1">
                  {sheet.unattributed.attendants.map((row) => (
                    <li key={`${row.stationId}:${row.slug}`} className="flex justify-between gap-4">
                      <span className="text-muted">
                        {row.name ?? row.slug}
                        <span className="ml-2 font-mono text-xs">{row.slug}</span> over {row.shifts}{' '}
                        shift{row.shifts === 1 ? '' : 's'}
                      </span>
                      <span className="shrink-0 font-mono font-semibold text-body">
                        {formatTZS(row.variance)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sheet.unattributed.tanks.length > 0 && (
              <div>
                <p className="font-semibold text-body">Tank keys with no tank set up</p>
                <ul className="mt-1 space-y-1">
                  {sheet.unattributed.tanks.map((row) => (
                    <li key={`${row.stationId}:${row.slug}`} className="flex justify-between gap-4">
                      <span className="text-muted">
                        <span className="font-mono text-xs">{row.slug}</span> over {row.shifts} shift
                        {row.shifts === 1 ? '' : 's'}
                      </span>
                      <span className="shrink-0 font-mono font-semibold text-body">
                        {formatLitres(row.varianceLitres)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="border-b border-border px-6 py-4 text-base font-bold text-body">
          Every shift in the period
        </h2>

        {shifts.length === 0 ? (
          <p className="px-6 py-5 text-sm text-muted">
            No shift reports were uploaded for this station in the period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="px-6 py-2.5 font-semibold">
                    Shift
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Report
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                    Flagged
                  </th>
                  <th scope="col" className="px-6 py-2.5 text-right font-semibold">
                    Variance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shifts.map((row) => (
                  <tr key={row.reportId}>
                    <td className="whitespace-nowrap px-6 py-2.5 text-body">
                      {row.reportDate ? (
                        formatReportDate(row.reportDate)
                      ) : (
                        <span className="text-muted">Date not read</span>
                      )}
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-2.5 text-muted" title={row.fileName ?? undefined}>
                      {row.fileName ?? 'Untitled report'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <ShiftStatus status={row.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted">
                      {row.flaggedFields > 0 ? row.flaggedFields : '—'}
                    </td>
                    <td className="whitespace-nowrap px-6 py-2.5 text-right font-mono font-semibold">
                      {row.variance === null ? (
                        <span className="font-sans font-normal text-muted">Not reconciled</span>
                      ) : (
                        <span className={row.variance > 0 ? 'text-error' : row.variance < 0 ? 'text-success' : 'text-body'}>
                          {formatTZS(row.variance)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <td colSpan={4} className="px-6 py-2.5 text-xs text-muted">
                    Net over {formatNumber(money.shiftsCompared)} reconciled shift
                    {money.shiftsCompared === 1 ? '' : 's'}
                  </td>
                  <td className="px-6 py-2.5 text-right font-mono text-sm font-bold text-body">
                    {formatTZS(money.net)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <footer className="space-y-2 text-xs text-muted">
        <p>
          Variance is pump totalizer sales less the cash, mobile money and approved credit the
          report accounts for. A positive figure is money that was due and did not arrive; a
          negative one is money collected beyond what the pumps recorded.
        </p>
        <p>
          Nothing on this sheet is stored. Every figure is re-derived from the readings on the
          shift reports each time it is opened, so a corrected report moves the total immediately
          and the corrected figure is what appears here.
        </p>
        <p>
          Shift dates are the dates on the reports. A report whose date could not be read is filed
          under its upload day, and a report that could not be read at all is listed with no
          variance rather than a variance of zero.
        </p>
      </footer>
    </>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'bad'
      ? 'text-error'
      : tone === 'good'
        ? 'text-success'
        : tone === 'warn'
          ? 'text-warning'
          : 'text-body';

  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 font-mono text-lg font-bold ${toneClass}`}>{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Plain words rather than a coloured pill — a pill is a screen affordance and prints as a blob. */
function ShiftStatus({ status }: { status: FindingsSheetData['shifts'][number]['status'] }) {
  const label =
    status === 'PARSED'
      ? 'Read'
      : status === 'NEEDS_REVIEW'
        ? 'Needs review'
        : status === 'FAILED'
          ? 'Could not be read'
          : 'Waiting';

  const tone =
    status === 'FAILED'
      ? 'text-error'
      : status === 'NEEDS_REVIEW'
        ? 'text-warning'
        : status === 'PENDING'
          ? 'text-muted'
          : 'text-success';

  return <span className={`text-xs font-semibold ${tone}`}>{label}</span>;
}
