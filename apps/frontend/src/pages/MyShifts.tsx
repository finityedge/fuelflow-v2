import { useCallback, useEffect, useState } from 'react';
import type { MyAttendantProfile } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatCard } from '../components/StatCard.js';
import { VarianceBars } from '../components/VarianceBars.js';
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckCircleIcon,
  InfoIcon,
  ScaleIcon,
  TrendDownIcon,
  UsersIcon,
} from '../components/icons.js';
import { useAuthStore } from '../stores/authStore.js';
import { getMyShifts } from '../lib/myShifts.js';
import {
  formatLongDate,
  formatReportDate,
  formatSignedTZS,
  formatTZS,
  greetingFor,
  nameFor,
} from '../lib/format.js';

const PERIOD_OPTIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

/**
 * The screen an attendant signs in to.
 *
 * ## Why this is what `/` draws for that role rather than a new nav row
 *
 * The dashboard answers "how much is the station short, and what is waiting to be reviewed",
 * which is a manager's work list: every figure on it is a total across colleagues, and there is
 * nothing on it an attendant can act on. The question an attendant actually arrives with — how
 * did my own shifts come out — had no screen at all, so the nav offered them one row and that
 * row was somebody else's job. `/` draws this for them instead of putting their own record one
 * click behind a row they would have to be told about. See `HomeRoute` in `AppRouter.tsx`.
 *
 * ## Why the figures agree with the manager's screen by construction
 *
 * Nothing here computes anything. The endpoint resolves the caller's own `Attendant` row and
 * takes the profile the profiling screen would show for that person, so a figure disputed with a
 * manager is the same number on both screens — not two implementations that happen to agree.
 * That is the whole reason this screen can exist without the arithmetic being duplicated.
 *
 * ## Why there is no link into the shift reports
 *
 * A report detail is the whole forecourt's shift: every colleague's attendant row, the tank
 * readings, the cash reconciliation. Sending somebody from their own page into that would hand
 * them the station's figures, which is exactly what their own row does not. So the list below is
 * a record to read, not a set of doors — the dates and their own variance, nothing behind them.
 *
 * ## Why the three signals are not here
 *
 * `single_shift`, `recurring_shortfall` and `worsening_drift` are the product's accusation
 * layer: they exist to tell a manager who to look at, and they are heuristics — a station with
 * no tolerance of its own has every short shift reported, and "most of their shifts were short"
 * is a majority test, not a finding. Showing one to the person it names would be an accusation
 * made by software with nobody in the loop, which is the thing `linkAttendantAlias` refuses to
 * do with a fuzzy name match for the same reason. So this page shows the person's own figures
 * and the station's published line, marks each shift against that line, and stops there. The
 * line itself is disclosed, because a shift marked "over the line" against a number the reader
 * cannot see would be worse than either extreme.
 */
export function MyShifts() {
  const user = useAuthStore((state) => state.user);

  const [periodDays, setPeriodDays] = useState<number>(30);
  const [data, setData] = useState<MyAttendantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await getMyShifts({ periodDays });
    setData(next);
  }, [periodDays]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Your shift figures could not be loaded.');
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

  const periodLabel = `the last ${periodDays} days`;
  const refreshing = loading && data !== null;

  const heading = (
    <PageHeading
      title={`${greetingFor()}, ${nameFor(user?.email)}`}
      description={`${formatLongDate()}. ${
        data?.profile
          ? `${data.profile.shifts} of your shift${
              data.profile.shifts === 1 ? '' : 's'
            } over ${periodLabel}.`
          : `Your own shifts over ${periodLabel}.`
      }`}
      actions={
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
      }
    />
  );

  if (loading && !data) {
    return (
      <Layout>
        <div className="mx-auto max-w-5xl">
          {heading}
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading your shifts…</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (error && !data) {
    return (
      <Layout>
        <div className="mx-auto max-w-5xl">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertCircleIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Your shifts could not be loaded</h2>
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

  /*
   * Three states, and they are genuinely different things. The first two look alike on a screen
   * that only had a null to go on: "nobody has linked your account" is a job for the person who
   * runs the station, while "nothing to compare in this window" is not a problem at all. Merging
   * them would tell somebody their account was broken when it was simply a quiet month.
   */
  if (!data.linked) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl space-y-6">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <UsersIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">No shift record is linked to this login</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
              Reports name the attendants who worked a shift by the name printed on them, and
              those names are set up per station — most attendants never sign in at all, and the
              ones a manager files reports for would be missing if a name required an account.
              Your account has to be joined to your name before this page can tell which figures
              are yours.
            </p>
            <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
              This does not mean your shifts are missing. They are on the reports under your
              name. Whoever runs the station can link the two in <strong>Station settings</strong>,
              on the attendant row for your name.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  const profile = data.profile;

  if (!profile || profile.shifts === 0) {
    return (
      <Layout>
        <div className="mx-auto max-w-3xl space-y-6">
          {heading}
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-subtle text-primary">
              <CalendarIcon className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-bold text-body">Nothing to compare in {periodLabel}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
              {profile && profile.shiftsNotComparable > 0
                ? `${profile.shiftsNotComparable} shift${
                    profile.shiftsNotComparable === 1 ? '' : 's'
                  } named you, but a figure was missing, so there was nothing to subtract. A shift is only counted once the report printed both what you were due to hand over and what you handed over.`
                : 'No report in this window printed both a figure due and a figure handed over for your name. Both are needed before a difference means anything.'}
            </p>
            {periodDays === 30 && (
              <button
                type="button"
                className="btn-secondary mt-5"
                onClick={() => setPeriodDays(90)}
              >
                Look back 90 days
              </button>
            )}
          </div>
        </div>
      </Layout>
    );
  }

  const threshold = data.varianceThreshold;
  /** A shift that has reached the line. The same test the manager's screen judges a single shift by. */
  const crossedLine = (variance: number) => variance > 0 && variance >= threshold;
  const worstCrossed = crossedLine(profile.worstShift);
  const newestFirst = [...profile.trend].reverse();

  return (
    <Layout>
      <div className="mx-auto max-w-5xl space-y-6">
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

        {/* The same explainer the manager's screen carries, in the second person. It is not
            furniture: the one thing a person reading their own shortfall needs to know is that
            it is subtraction, not a judgement — and that it moves when the shift is corrected. */}
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted">
          <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            Each report prints, per attendant, what you were{' '}
            <strong className="font-semibold text-body">due to hand over</strong> and what you{' '}
            <strong className="font-semibold text-body">handed over</strong>. The difference is
            the figure below. Nothing is stored — if either figure on the shift was read wrongly,
            correcting it moves your number.
          </p>
        </div>

        {profile.provisional && (
          <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-body">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>
              A figure on at least one of these shifts is still flagged for checking, so these
              totals may move. A flagged figure is one the reader was not sure of, not one that is
              wrong.
            </p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Money unaccounted for"
            value={formatTZS(profile.variance)}
            valueClass={profile.variance > 0 ? 'text-error' : 'text-success'}
            icon={ScaleIcon}
            iconClass={
              profile.variance > 0 ? 'bg-error-subtle text-error' : 'bg-success-subtle text-success'
            }
            hint={
              profile.variance > 0
                ? `Across ${profile.shifts} shift${profile.shifts === 1 ? '' : 's'}`
                : `Nothing is unaccounted for across ${profile.shifts} shift${
                    profile.shifts === 1 ? '' : 's'
                  }`
            }
          />

          <StatCard
            label="A typical shift"
            value={profile.baselineVariance === null ? '—' : formatTZS(profile.baselineVariance)}
            icon={TrendDownIcon}
            iconClass="bg-warning-subtle text-warning"
            hint="The middle shift of the ones compared — one big day does not move it"
          />

          <StatCard
            label="Your worst shift"
            value={formatTZS(profile.worstShift)}
            valueClass={worstCrossed ? 'text-error' : 'text-body'}
            icon={AlertCircleIcon}
            iconClass={worstCrossed ? 'bg-error-subtle text-error' : 'bg-slate-100 text-muted'}
            hint={
              profile.worstShift <= 0
                ? 'No shift left anything unaccounted for'
                : threshold > 0
                  ? worstCrossed
                    ? `At or over this station's ${formatTZS(threshold)} line for one shift`
                    : `Under this station's ${formatTZS(threshold)} line for one shift`
                  : 'This station has set no line of its own'
            }
          />

          <StatCard
            label="Shifts compared"
            value={String(profile.shifts)}
            icon={CheckCircleIcon}
            iconClass="bg-primary-subtle text-primary"
            hint={
              profile.shiftsNotComparable > 0
                ? `${profile.shiftsNotComparable} more named you but a figure was missing`
                : 'Every shift you appear on printed both figures'
            }
          />
        </div>

        <div className="card p-5">
          <h2 className="text-base font-bold text-body">Your shifts</h2>
          <p className="mt-1 text-xs text-muted">
            One bar per shift, oldest first. Above the line is money that was due and not handed
            over; below it is more handed over than was due.
          </p>

          <div className="mt-4">
            <VarianceBars
              points={profile.trend}
              heading="Your shifts"
              describe={(variance) =>
                variance === 0
                  ? 'balanced exactly'
                  : variance > 0
                    ? `${formatTZS(variance)} short`
                    : `${formatTZS(Math.abs(variance))} over`
              }
              describeNet={(total) =>
                total === 0
                  ? 'Every shift balanced exactly'
                  : total > 0
                    ? `${formatTZS(total)} short overall`
                    : `${formatTZS(Math.abs(total))} over overall`
              }
            />
          </div>

          <p className="mt-3 text-xs text-muted">
            {formatTZS(profile.collected)} handed over across these shifts.
            {profile.provisional && ' One of the contributing figures is still flagged.'}
          </p>
        </div>

        <div className="card overflow-hidden">
          {/*
            Newest first, although the strip above reads oldest first. The strip is for seeing a
            pattern, which reads left to right; this list is for finding a particular day, and the
            day somebody opens this page asking about is nearly always yesterday.
          */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-5 py-3 font-medium">
                  Shift
                </th>
                <th scope="col" className="px-3 py-3 text-right font-medium">
                  Left unaccounted for
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Against the line
                </th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((point) => (
                <tr key={point.reportId} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 text-body">{formatReportDate(point.date)}</td>
                  <td
                    className={`px-3 py-3 text-right font-mono font-semibold ${
                      point.variance > 0
                        ? 'text-error'
                        : point.variance < 0
                          ? 'text-success'
                          : 'text-muted'
                    }`}
                  >
                    {formatSignedTZS(point.variance)}
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${
                        crossedLine(point.variance)
                          ? 'bg-error-subtle text-error'
                          : point.variance > 0
                            ? 'bg-slate-100 text-muted'
                            : 'bg-success-subtle text-success'
                      }`}
                    >
                      {crossedLine(point.variance)
                        ? 'over the line'
                        : point.variance > 0
                          ? 'within the line'
                          : point.variance === 0
                            ? 'balanced'
                            : 'over'}
                    </span>
                    {point.provisional && (
                      <span
                        className="ml-2 text-xs text-muted"
                        title="A figure on this shift is still flagged for checking, so this may move."
                      >
                        still flagged
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted">
          These are your own figures — nobody else&rsquo;s are on this page.{' '}
          {threshold > 0
            ? `A shift is marked as over the line once it reaches this station's own ${formatTZS(
                threshold
              )}, the same figure a manager's screen is judged against.`
            : 'This station has set no line of its own, so every shift that does not balance exactly is marked.'}
        </p>
      </div>
    </Layout>
  );
}
