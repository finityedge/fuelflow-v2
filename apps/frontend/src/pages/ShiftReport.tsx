import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type {
  DashboardTrendPoint,
  ExtractedFieldGroup,
  ShiftReportDetail,
  ShiftReportListItem,
} from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import { PageHeading } from '../components/PageHeading.js';
import { VarianceHero } from '../components/VarianceHero.js';
import { VarianceTrendChart } from '../components/VarianceTrendChart.js';
import {
  AttendantCard,
  CashPaymentsCard,
  CreditSalesCard,
  TankReadingsCard,
} from '../components/ReportGroupCards.js';
import type { CorrectionSession } from '../components/FieldValue.js';
import {
  AlertIcon,
  BuildingIcon,
  ChartIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FileIcon,
  InfoIcon,
  ReportsIcon,
} from '../components/icons.js';
import { useAuthStore } from '../stores/authStore.js';
import { canCorrect } from '../lib/rbac.js';
import { correctField, getNextUnreviewed, getShiftReport, reparseShiftReport } from '../lib/shiftReports.js';
import { getDashboard } from '../lib/dashboard.js';
import { formatRelativeTime, formatReportDateLong } from '../lib/format.js';

/** How far back the trend beside the variance looks. Two months of shifts at one a day. */
const TREND_DAYS = 30;

/** Which card a flagged figure sits in, so the review notice can send someone to it. */
const CARD_FOR_GROUP: Record<ExtractedFieldGroup, { id: string; label: string }> = {
  CASH_PAYMENTS: { id: 'card-cash', label: 'Cash & payments' },
  CREDIT_SALES: { id: 'card-credit', label: 'Credit sales' },
  ATTENDANT_RECONCILIATION: { id: 'card-attendants', label: 'Attendant reconciliation' },
  TANK_READINGS: { id: 'card-tanks', label: 'Tank readings' },
};

function MetaChip({
  icon: Icon,
  children,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-muted"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </span>
  );
}

function StatusChip({ status, needsReviewCount }: { status: string; needsReviewCount: number }) {
  if (status === 'PENDING') {
    return <span className="badge bg-primary-subtle text-primary">Reading…</span>;
  }
  if (status === 'FAILED') {
    return <span className="badge bg-error-subtle text-error">Could not be read</span>;
  }
  if (needsReviewCount > 0) {
    return (
      <span className="badge bg-warning-subtle text-warning">
        {needsReviewCount} to review
      </span>
    );
  }
  return <span className="badge bg-success-subtle text-success">Reconciled</span>;
}

export function ShiftReport() {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);
  const mayCorrect = user ? canCorrect(user.role) : false;

  const [detail, setDetail] = useState<ShiftReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null);
  const [reparsing, setReparsing] = useState(false);

  /**
   * Whether this report was opened from the review queue.
   *
   * Read off the URL rather than kept in a store, so that opening the report from a bookmark,
   * a shared link or a fresh tab still offers the walk-through — and so that a report opened
   * from the history list stays a report rather than becoming a queue step.
   */
  const [searchParams] = useSearchParams();
  const fromQueue = searchParams.get('from') === 'queue';
  /** The next report still waiting, or null when this is the last one. */
  const [nextReport, setNextReport] = useState<ShiftReportListItem | null>(null);
  const [nextLoading, setNextLoading] = useState(false);
  /**
   * Whether the "what is next?" lookup itself failed.
   *
   * Kept apart from `nextReport === null` on purpose. "Nothing else is waiting" and "we could
   * not find out" are opposite things to tell somebody who is working through a backlog, and
   * one shared null would report the second as the first — telling a manager they are finished
   * on the strength of a failed request.
   */
  const [nextFailed, setNextFailed] = useState(false);

  /**
   * The station's other shifts, for the trend beside the variance. `null` means it has not
   * arrived yet; an empty array means the station has no other reconciled shifts in the
   * window. The two are different, and the card says so differently.
   */
  const [trend, setTrend] = useState<DashboardTrendPoint[] | null>(null);
  const [trendFailed, setTrendFailed] = useState(false);
  /** Bumped on every reload so the trend is refetched when a correction moves the figure. */
  const [version, setVersion] = useState(0);
  const pollTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      return null;
    }
    const next = await getShiftReport(id);
    setDetail(next);
    setVersion((current) => current + 1);
    return next;
  }, [id]);

  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        await load();
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : 'This report could not be loaded.'
          );
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
  }, [id, load]);

  // While the parse is still running the screen keeps itself up to date, so a manager who
  // arrives early does not have to know to refresh.
  useEffect(() => {
    if (detail?.report.status !== 'PENDING') {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }

    pollTimer.current = window.setTimeout(() => {
      void load().catch(() => {
        // Keep polling on a dropped connection; the next tick may well succeed.
      });
    }, 2000);

    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [detail, load]);

  const stationId = detail?.report.stationId;
  const reportStatus = detail?.report.status;

  /**
   * The trend is context, not the point of the screen.
   *
   * It is fetched separately and its failure is contained: the shift's own figures are
   * already on the page and are what someone came here for. A broken chart call must never
   * be able to take the variance down with it, so this deliberately does not touch
   * `loadError` or the loading state that guards the rest of the page.
   */
  useEffect(() => {
    if (!stationId || reportStatus === 'PENDING') {
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const summary = await getDashboard({ stationId, periodDays: TREND_DAYS });
        if (!cancelled) {
          setTrend(summary.trend);
          setTrendFailed(false);
        }
      } catch {
        if (!cancelled) {
          setTrend([]);
          setTrendFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stationId, reportStatus, version]);

  /**
   * Work out what comes next in the queue, and recompute it after every change to this report.
   *
   * `detail` is a dependency rather than `version` because a successful correction replaces the
   * whole detail object, and the queue genuinely moves when it does: fixing the last flagged
   * figure takes this report *out* of the queue, so "the oldest one still waiting" is a
   * different report than it was a moment ago. Recomputing here keeps the button honest instead
   * of offering to take the manager somewhere they have already been.
   */
  useEffect(() => {
    if (!fromQueue || !id || !detail) {
      return;
    }

    let cancelled = false;
    setNextLoading(true);
    setNextFailed(false);

    void (async () => {
      try {
        // Walk the same queue the link came from: a failed report steps to the next failed
        // one, everything else to the next awaiting review.
        const next = await getNextUnreviewed(
          id,
          detail.report.status === 'FAILED' ? 'FAILED' : 'NEEDS_REVIEW'
        );
        if (!cancelled) {
          setNextReport(next);
        }
      } catch {
        // Not being able to say what is next must not break the report in front of you — the
        // bar falls back to "back to the queue", which always works.
        if (!cancelled) {
          setNextReport(null);
          setNextFailed(true);
        }
      } finally {
        if (!cancelled) {
          setNextLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromQueue, id, detail]);

  const handleCorrect = useCallback(
    async (fieldId: string, value: string, note?: string) => {
      if (!id) {
        return;
      }
      setSavingFieldId(fieldId);
      setSaveError(null);
      try {
        await correctField(id, fieldId, value, note);
        // Re-read rather than patch in place: the variance, the per-row differences and the
        // report's review state are all derived from the fields, and the server derives them.
        await load();
        setEditingFieldId(null);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'That change could not be saved.');
      } finally {
        setSavingFieldId(null);
      }
    },
    [id, load]
  );

  const handleReparse = useCallback(async () => {
    if (!id) {
      return;
    }
    setReparsing(true);
    setSaveError(null);
    try {
      await reparseShiftReport(id);
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The report could not be re-parsed.');
    } finally {
      setReparsing(false);
    }
  }, [id, load]);

  if (loading) {
    return (
      <Layout>
        <div className="mx-auto max-w-7xl">
          <div className="card p-10 text-center">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted">Loading report…</p>
          </div>
        </div>
      </Layout>
    );
  }

  if (loadError || !detail) {
    return (
      <Layout>
        <div className="mx-auto max-w-7xl">
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle text-error">
              <AlertIcon className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-body">Report unavailable</h2>
            <p className="mt-2 text-muted">{loadError ?? 'This report could not be found.'}</p>
            <button type="button" className="btn-primary mt-5" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  const { report, fields, summary, needsReviewCount } = detail;
  const isParsing = report.status === 'PENDING';
  const isFailed = report.status === 'FAILED';
  const isComplete = !isParsing && !isFailed && needsReviewCount === 0;

  const session: CorrectionSession = {
    mayCorrect,
    editingFieldId,
    savingFieldId,
    start: setEditingFieldId,
    cancel: () => setEditingFieldId(null),
    save: handleCorrect,
  };

  const hasCredit = fields.some((field) => field.fieldName.startsWith('credit_sale:'));
  const hasAttendants = fields.some((field) => field.fieldName.startsWith('attendant:'));
  const hasTanks = fields.some((field) => field.fieldName.startsWith('tank:'));

  const firstFlagged = fields.find((field) => field.needsReview) ?? null;
  const target = firstFlagged ? CARD_FOR_GROUP[firstFlagged.group] : null;
  const isPlotted = trend?.some((point) => point.reportId === report.id) ?? false;

  const heading = (
    <PageHeading
      title="Shift report review"
      description={`${formatReportDateLong(report.reportDate)}. Check this shift's sales, payments and stock against the report.`}
      actions={
        <>
          <Link to="/shift-reports/recent" className="btn-secondary">
            <ReportsIcon className="h-4 w-4" />
            All reports
          </Link>
          {report.pdfFileUrl && (
            <a
              href={`/api/shift-reports/${report.id}/file`}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary"
            >
              <FileIcon className="h-4 w-4" />
              Original PDF
            </a>
          )}
        </>
      }
    />
  );

  return (
    <Layout>
      <div className="mx-auto max-w-7xl space-y-6">
        {heading}

        {/* Where the report came from, what it was called, and where it has got to. The file
            name is here rather than buried because it is how a manager recognises the upload
            they are looking at. */}
        <div className="flex flex-wrap items-center gap-2">
          <MetaChip icon={BuildingIcon}>{report.stationName ?? 'Station'}</MetaChip>
          <MetaChip icon={ClockIcon} title={report.uploadedAt}>
            Uploaded {formatRelativeTime(report.uploadedAt)}
          </MetaChip>
          {report.pdfFileName && <MetaChip icon={FileIcon}>{report.pdfFileName}</MetaChip>}
          <StatusChip status={report.status} needsReviewCount={needsReviewCount} />
        </div>

        {saveError && (
          <div className="flex items-start gap-3 rounded-xl bg-error-subtle p-4" aria-live="assertive">
            <AlertIcon className="h-5 w-5 shrink-0 text-error" />
            <p className="text-sm text-error">{saveError}</p>
          </div>
        )}

        {isParsing && (
          <div className="card p-8 text-center" aria-live="polite">
            <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="font-semibold text-body">Reading your report…</p>
            <p className="mt-1 text-sm text-muted">
              This page updates by itself as soon as the figures are ready.
            </p>
          </div>
        )}

        {/*
          The walk-through bar, shown only when this report was opened from the queue. It sits
          above everything else because its job is to answer "where am I and what is next?"
          before the reader gets absorbed in the figures.
        */}
        {fromQueue && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-white p-4">
            <Link
              to="/review"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              <ChevronRightIcon className="h-4 w-4 rotate-180" />
              Review queue
            </Link>

            {nextLoading ? (
              <span className="text-sm text-muted">Looking for the next one…</span>
            ) : nextFailed ? (
              <span className="text-sm text-muted">
                Couldn’t check what is waiting —{' '}
                <Link to="/review" className="font-semibold text-primary hover:underline">
                  back to the queue
                </Link>
              </span>
            ) : nextReport ? (
              <Link
                to={`/shift-reports/${nextReport.id}?from=queue`}
                // Primary only once this report is settled: while figures are still flagged,
                // the next thing to do is here, and a primary "skip" would pull the eye off it.
                className={isComplete ? 'btn-primary' : 'btn-secondary'}
              >
                Next: {formatReportDateLong(nextReport.reportDate)}
                <ChevronRightIcon className="h-4 w-4" />
              </Link>
            ) : (
              // The end of the queue. This is news, and it is good news, so it does not look
              // like an empty state.
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
                <CheckIcon className="h-4 w-4" />
                Nothing else is waiting
              </span>
            )}
          </div>
        )}

        {isFailed && (
          <div className="card border-error/30 p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-error-subtle text-error">
                <AlertIcon className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-body">This report could not be read</h2>
                <p className="mt-1 text-sm text-muted">
                  {report.failureReason ??
                    'The PDF did not match the expected shift report format.'}
                </p>
                <p className="mt-3 text-sm text-muted">
                  Nothing has been recorded from this file. Check that you uploaded the right PDF,
                  or try reading it again.
                </p>
                {mayCorrect && (
                  <button
                    type="button"
                    className="btn-primary mt-4"
                    disabled={reparsing}
                    onClick={() => void handleReparse()}
                  >
                    {reparsing ? 'Queueing…' : 'Try reading it again'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {!isParsing && !isFailed && (
          <>
            {needsReviewCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warning-subtle p-4">
                <div className="flex items-center gap-3">
                  <AlertIcon className="h-5 w-5 shrink-0 text-warning" />
                  <p className="text-sm font-semibold text-warning">
                    {needsReviewCount} figure{needsReviewCount === 1 ? '' : 's'} need
                    {needsReviewCount === 1 ? 's' : ''} your review before this shift is settled.
                  </p>
                </div>
                {target && (
                  <a
                    href={`#${target.id}`}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-warning underline decoration-warning/40 underline-offset-2 hover:decoration-warning"
                  >
                    Start with {target.label}
                    <ChevronRightIcon className="h-4 w-4" />
                  </a>
                )}
              </div>
            )}

            {isComplete && (
              <div className="flex items-center gap-3 rounded-xl bg-success-subtle p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
                  <CheckIcon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-success">Every figure has been checked</p>
                  <p className="text-xs text-success/80">
                    Nothing here is waiting on you. The variance above is the figure to act on.
                  </p>
                </div>
              </div>
            )}

            <div className="grid gap-6 xl:grid-cols-2">
              <VarianceHero summary={summary} />

              <section className="card flex flex-col p-5" aria-labelledby="trend-heading">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
                    <ChartIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 id="trend-heading" className="text-base font-bold text-body">
                      Variance trend
                    </h2>
                    <p className="mt-0.5 text-xs text-muted">
                      This station’s reconciled shifts over the last {TREND_DAYS} days, oldest
                      first.
                    </p>
                  </div>
                </div>

                <div className="mt-4 flex-1">
                  {trend === null ? (
                    <div className="flex h-full min-h-[12rem] items-center justify-center">
                      <span
                        role="status"
                        className="flex items-center gap-2 text-sm text-muted"
                      >
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        Loading recent shifts…
                      </span>
                    </div>
                  ) : trend.length === 0 ? (
                    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center">
                      <p className="text-sm font-semibold text-body">
                        {trendFailed ? 'The trend could not be loaded' : 'No other shifts to compare'}
                      </p>
                      <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
                        {trendFailed
                          ? 'The figures for this shift are unaffected — only the comparison is missing.'
                          : `This station has no reconciled shift dated in the last ${TREND_DAYS} days.`}
                      </p>
                    </div>
                  ) : (
                    <VarianceTrendChart points={trend} compact highlightId={report.id} />
                  )}
                </div>

                {/* Said plainly rather than left as an unexplained absence of the ring: a
                    reader who expects to find this shift on the chart needs to know why it
                    is not there. */}
                {trend !== null && trend.length > 0 && !isPlotted && (
                  <p className="mt-3 text-xs text-muted">
                    This shift is not plotted — it is either dated outside the last {TREND_DAYS}{' '}
                    days or its variance could not be worked out.
                  </p>
                )}
              </section>
            </div>

            {/* Two by two rather than four across: each of these is a small table with a
                correction control on most of its rows, and at a quarter of the screen width
                the figures wrap and the pencil lands somewhere unpredictable. */}
            <div className="grid gap-6 md:grid-cols-2">
              <div id="card-cash" className="scroll-mt-6">
                <CashPaymentsCard fields={fields} session={session} />
              </div>
              {hasCredit && (
                <div id="card-credit" className="scroll-mt-6">
                  <CreditSalesCard fields={fields} session={session} />
                </div>
              )}
              {hasAttendants && (
                <div id="card-attendants" className="scroll-mt-6">
                  <AttendantCard fields={fields} session={session} />
                </div>
              )}
              {hasTanks && (
                <div id="card-tanks" className="scroll-mt-6">
                  <TankReadingsCard fields={fields} session={session} />
                </div>
              )}
            </div>

            {fields.length === 0 && (
              <div className="card p-8 text-center">
                <p className="text-sm text-muted">
                  No figures were read from this report. Check the PDF and try reading it again.
                </p>
              </div>
            )}

            {fields.length > 0 && (!hasCredit || !hasAttendants || !hasTanks) && (
              <p className="flex items-start gap-2 text-xs text-muted">
                <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Only the sections this report contains are shown. A shift with no credit sales,
                  no attendants or no tank dip on the page it was printed from has nothing to
                  reconcile in that card.
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
