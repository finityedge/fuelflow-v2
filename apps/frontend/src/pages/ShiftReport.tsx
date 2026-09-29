import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExtractedField, ExtractedFieldGroup, ShiftReportDetail } from '@fuelflow/shared';
import { Layout } from '../components/Layout.js';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  ReportsIcon,
} from '../components/icons.js';
import { useAuthStore } from '../stores/authStore.js';
import { canCorrect } from '../lib/rbac.js';
import { correctField, getShiftReport, reparseShiftReport } from '../lib/shiftReports.js';
import { formatSignedTZS, formatTZS, formatReportDate } from '../lib/format.js';
import { varianceTone, type VarianceTone } from '../lib/variance.js';

const GROUP_ORDER: ExtractedFieldGroup[] = [
  'CASH_PAYMENTS',
  'CREDIT_SALES',
  'ATTENDANT_RECONCILIATION',
  'TANK_READINGS',
];

const GROUP_LABELS: Record<ExtractedFieldGroup, string> = {
  CASH_PAYMENTS: 'Cash & Payments',
  CREDIT_SALES: 'Credit Sales',
  ATTENDANT_RECONCILIATION: 'Attendant Reconciliation',
  TANK_READINGS: 'Tank Readings',
};

/** Tank and attendant fields read as a block per tank/attendant, not as a flat list. */
function groupHeading(field: ExtractedField): string | null {
  if (field.fieldName.startsWith('tank:')) {
    const tank = field.fieldName.split(':')[1];
    return `Tank ${tank}`;
  }
  if (field.fieldName.startsWith('attendant:')) {
    const parts = field.fieldName.split(':');
    if (parts.length >= 3) {
      return parts[1].replace(/_/g, ' ');
    }
  }
  return null;
}

type Tone = VarianceTone;

const TONE_STYLES: Record<Tone, { panel: string; label: string; text: string; headline: string }> = {
  balanced: {
    panel: 'bg-success-subtle border-success/30',
    label: 'text-success',
    text: 'text-success',
    headline: 'Everything is accounted for',
  },
  short: {
    panel: 'bg-error-subtle border-error/30',
    label: 'text-error',
    text: 'text-error',
    headline: 'Money is unaccounted for',
  },
  over: {
    panel: 'bg-warning-subtle border-warning/30',
    label: 'text-warning',
    text: 'text-warning',
    headline: 'More collected than sold',
  },
  unknown: {
    panel: 'bg-slate-100 border-border',
    label: 'text-muted',
    text: 'text-body',
    headline: 'Variance cannot be calculated',
  },
};

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
  const pollTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      return null;
    }
    const next = await getShiftReport(id);
    setDetail(next);
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

  const handleCorrect = useCallback(
    async (fieldId: string, value: string) => {
      if (!id) {
        return;
      }
      setSavingFieldId(fieldId);
      setSaveError(null);
      try {
        await correctField(id, fieldId, value);
        // Re-read rather than patch in place: the variance and the report's review state
        // are both derived from the fields, and the server is the one that derives them.
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
        <div className="mx-auto max-w-4xl">
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
        <div className="mx-auto max-w-4xl">
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
  const tone = varianceTone(summary.variance);
  const styles = TONE_STYLES[tone];
  const isParsing = report.status === 'PENDING';
  const isFailed = report.status === 'FAILED';
  const isComplete = !isParsing && !isFailed && needsReviewCount === 0;

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    fields: fields.filter((field) => field.group === group),
  })).filter((section) => section.fields.length > 0);

  return (
    <Layout>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <nav className="flex min-w-0 items-center gap-2 text-sm text-muted">
            <Link to="/" className="transition-colors hover:text-body">
              Dashboard
            </Link>
            <ChevronRightIcon className="h-4 w-4" />
            <span className="truncate">{formatReportDate(report.reportDate)}</span>
          </nav>
          <Link to="/shift-reports/recent" className="btn-secondary shrink-0">
            <ReportsIcon className="h-4 w-4" />
            All reports
          </Link>
        </div>

        {/* Header */}
        <div className="card p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-body">
                {formatReportDate(report.reportDate)}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {report.stationName ?? 'Station'}
                {report.pdfFileName ? ` · ${report.pdfFileName}` : ''}
              </p>
            </div>
            <StatusBadge status={report.status} needsReviewCount={needsReviewCount} />
          </div>

          {report.pdfFileUrl && (
            <a
              href={`/api/shift-reports/${report.id}/file`}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary mt-5"
            >
              <FileIcon className="h-4 w-4" />
              Open the original PDF
            </a>
          )}
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

        {/* The headline: is something wrong, and by how much. */}
        {!isParsing && !isFailed && (
          <div className={`card border p-6 sm:p-8 ${styles.panel}`}>
            <p className={`text-xs font-bold uppercase tracking-wider ${styles.label}`}>
              Variance
            </p>
            <p className={`mt-2 font-mono text-4xl font-bold tabular-nums sm:text-5xl ${styles.text}`}>
              {formatSignedTZS(summary.variance)}
            </p>
            <p className={`mt-2 text-sm font-semibold ${styles.label}`}>{styles.headline}</p>
            {summary.provisional && (
              <p className="mt-1 text-xs text-muted">
                Provisional — this figure will move once the highlighted fields below are corrected.
              </p>
            )}

            <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-black/5 pt-5 sm:grid-cols-2">
              <SummaryRow label="Pump totalizer sales" value={formatTZS(summary.pumpTotalizerSales)} />
              <SummaryRow label="Cash collected" value={formatTZS(summary.cash)} />
              <SummaryRow label="Mobile money" value={formatTZS(summary.mobileMoney)} />
              <SummaryRow label="Approved credit" value={formatTZS(summary.approvedCredit)} />
            </dl>
          </div>
        )}

        {isComplete && (
          <div className="flex items-center gap-3 rounded-xl bg-success-subtle p-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <CheckIcon className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-success">Reconciliation Complete</p>
              <p className="text-xs text-success/80">
                Every figure has been read or checked. Nothing here is waiting on you.
              </p>
            </div>
          </div>
        )}

        {needsReviewCount > 0 && !isParsing && !isFailed && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-warning-subtle p-4">
            <div className="flex items-center gap-3">
              <AlertIcon className="h-5 w-5 shrink-0 text-warning" />
              <p className="text-sm font-semibold text-warning">
                {needsReviewCount} field{needsReviewCount === 1 ? '' : 's'} need
                {needsReviewCount === 1 ? 's' : ''} your review
              </p>
            </div>
          </div>
        )}

        {grouped.map((section) => (
          <FieldGroup
            key={section.group}
            title={GROUP_LABELS[section.group]}
            fields={section.fields}
            mayCorrect={mayCorrect}
            editingFieldId={editingFieldId}
            savingFieldId={savingFieldId}
            onStartEdit={setEditingFieldId}
            onCancelEdit={() => setEditingFieldId(null)}
            onSave={handleCorrect}
          />
        ))}

        {!isParsing && !isFailed && fields.length === 0 && (
          <div className="card p-8 text-center">
            <p className="text-sm text-muted">
              No figures were read from this report. Check the PDF and try reading it again.
            </p>
          </div>
        )}
      </div>
    </Layout>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-mono text-sm font-semibold tabular-nums text-body">{value}</dd>
    </div>
  );
}

function StatusBadge({ status, needsReviewCount }: { status: string; needsReviewCount: number }) {
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

interface FieldGroupProps {
  title: string;
  fields: ExtractedField[];
  mayCorrect: boolean;
  editingFieldId: string | null;
  savingFieldId: string | null;
  onStartEdit: (fieldId: string) => void;
  onCancelEdit: () => void;
  onSave: (fieldId: string, value: string) => Promise<void>;
}

function FieldGroup({
  title,
  fields,
  mayCorrect,
  editingFieldId,
  savingFieldId,
  onStartEdit,
  onCancelEdit,
  onSave,
}: FieldGroupProps) {
  let lastHeading: string | null = null;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <h2 className="text-base font-bold text-body">{title}</h2>
        <span className="text-xs text-muted">
          {fields.length} field{fields.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="divide-y divide-border">
        {fields.map((field) => {
          const heading = groupHeading(field);
          const showHeading = heading !== null && heading !== lastHeading;
          lastHeading = heading ?? lastHeading;

          return (
            <div key={field.id}>
              {showHeading && (
                <p className="bg-slate-50 px-6 py-2 text-xs font-bold uppercase tracking-wider text-muted">
                  {heading}
                </p>
              )}
              <FieldRow
                field={field}
                mayCorrect={mayCorrect}
                isEditing={editingFieldId === field.id}
                isSaving={savingFieldId === field.id}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSave={onSave}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: ExtractedField;
  mayCorrect: boolean;
  isEditing: boolean;
  isSaving: boolean;
  onStartEdit: (fieldId: string) => void;
  onCancelEdit: () => void;
  onSave: (fieldId: string, value: string) => Promise<void>;
}

function FieldRow({
  field,
  mayCorrect,
  isEditing,
  isSaving,
  onStartEdit,
  onCancelEdit,
  onSave,
}: FieldRowProps) {
  const [draft, setDraft] = useState(field.parsedValue ?? '');

  useEffect(() => {
    setDraft(field.parsedValue ?? '');
  }, [field.parsedValue, isEditing]);

  const flag = field.needsReview;

  return (
    <div
      className={`px-6 py-4 transition-colors ${
        // A tinted row, not a small icon: on a phone in daylight a badge alone is easy to
        // miss, and this row is the thing the manager has to act on.
        flag ? 'bg-warning-subtle/70' : ''
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-body">{field.label}</p>
          {flag && (
            <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-warning px-2.5 py-0.5 text-xs font-bold text-white">
              <AlertIcon className="h-3 w-3" />
              Needs your review
            </p>
          )}
          {flag && field.reviewNote && (
            <p className="mt-1.5 text-xs text-warning">{field.reviewNote}</p>
          )}
          {field.correctedAt && !flag && (
            <p className="mt-1 text-xs text-muted">Corrected by you</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {isEditing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void onSave(field.id, draft);
              }}
            >
              <input
                autoFocus
                className="input w-40 py-2 text-right font-mono tabular-nums"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancelEdit();
                  }
                }}
                inputMode="decimal"
                aria-label={`Corrected value for ${field.label}`}
              />
              <button
                type="submit"
                className="btn-primary px-3 py-2"
                disabled={isSaving || draft.trim().length === 0}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn-ghost px-2 py-2" onClick={onCancelEdit} aria-label="Cancel">
                <CloseIcon className="h-4 w-4" />
              </button>
            </form>
          ) : (
            <>
              <span
                className={`font-mono text-base font-semibold tabular-nums ${
                  flag ? 'text-warning' : 'text-body'
                }`}
              >
                {field.amount !== null ? formatTZS(field.amount) : field.parsedValue ?? '—'}
              </span>
              {mayCorrect && (
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs"
                  onClick={() => onStartEdit(field.id)}
                >
                  Correct
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* What the parser actually saw. Shown whenever a human needs to judge the figure. */}
      {flag && field.regionText && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-muted hover:text-body">
            Show what was read from the PDF
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-200">
            {field.regionText}
          </pre>
        </details>
      )}
    </div>
  );
}
