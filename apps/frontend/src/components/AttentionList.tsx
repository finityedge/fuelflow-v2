import { Link } from 'react-router-dom';
import type { DashboardSummary } from '@fuelflow/shared';
import { AlertCircleIcon, CheckCircleIcon, ChevronRightIcon, FileIcon, ReportsIcon } from './icons.js';
import { formatReportDate, formatSignedTZS } from '../lib/format.js';

type Tone = 'error' | 'warning' | 'primary';

interface AttentionItem {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  to: string;
  tone: Tone;
}

const TONE: Record<Tone, { bar: string; bubble: string }> = {
  error: { bar: 'bg-error', bubble: 'bg-error-subtle text-error' },
  warning: { bar: 'bg-warning', bubble: 'bg-warning-subtle text-warning' },
  primary: { bar: 'bg-primary', bubble: 'bg-primary-subtle text-primary' },
};

/**
 * What needs a person, derived only from states the system actually has.
 *
 * A design of this panel listed "Tank 2 variance trending up" and "2 attendants flagged
 * this week". Neither is computable: the app extracts tank dips and per-attendant rows
 * from a single report, but has no across-time tank analysis and no per-attendant scoring,
 * so both would have been invented numbers presented with the same authority as the real
 * ones. Every item here traces to a field on the summary.
 */
function buildItems(summary: DashboardSummary): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (summary.totals.failed > 0) {
    items.push({
      key: 'failed',
      icon: AlertCircleIcon,
      title: `${summary.totals.failed} report${summary.totals.failed === 1 ? '' : 's'} couldn’t be read`,
      description: 'No figures were extracted. Check the file and upload it again.',
      to: '/shift-reports/recent',
      tone: 'error',
    });
  }

  if (summary.totals.needsReview > 0) {
    const fields = summary.totals.fieldsFlagged;
    items.push({
      key: 'review',
      icon: ReportsIcon,
      title: `${summary.totals.needsReview} report${summary.totals.needsReview === 1 ? '' : 's'} need review`,
      description: `${fields} field${fields === 1 ? '' : 's'} waiting for someone to check.`,
      to: '/shift-reports/recent',
      tone: 'warning',
    });
  }

  const largest = summary.variance.largest;
  if (largest && largest.variance !== 0) {
    items.push({
      key: 'largest',
      icon: FileIcon,
      // The word "largest" is doing real work: this is the worst shift in the period, not
      // a total, and a manager should not read it as one.
      title: `Largest single variance ${formatSignedTZS(largest.variance)}`,
      description:
        (largest.reportDate ? formatReportDate(largest.reportDate) : largest.fileName ?? 'One shift') +
        (largest.variance > 0 ? ' — money is unaccounted for.' : ' — more was collected than sold.'),
      to: `/shift-reports/${largest.reportId}`,
      tone: largest.variance > 0 ? 'error' : 'warning',
    });
  }

  if (summary.totals.pending > 0) {
    items.push({
      key: 'pending',
      icon: FileIcon,
      title: `${summary.totals.pending} report${summary.totals.pending === 1 ? '' : 's'} still being read`,
      description: 'Parsing runs in the background. Nothing to do yet.',
      to: '/shift-reports/recent',
      tone: 'primary',
    });
  }

  return items;
}

export function AttentionList({ summary }: { summary: DashboardSummary }) {
  const items = buildItems(summary);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4">
        <h2 className="text-base font-bold text-body">Needs your attention</h2>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-success-subtle text-success">
            <CheckCircleIcon className="h-6 w-6" />
          </div>
          <p className="text-sm font-semibold text-body">
            {summary.totals.reports === 0 ? 'No reports yet' : 'Nothing needs your attention'}
          </p>
          <p className="mt-1 text-xs text-muted">
            {summary.totals.reports === 0
              ? 'Upload a shift report and its figures will be read for you.'
              : `All ${summary.totals.reports} reports in this period have been checked.`}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const Icon = item.icon;
            const tone = TONE[item.tone];
            return (
              <li key={item.key}>
                <Link
                  to={item.to}
                  className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-slate-50"
                >
                  {/* The colour bar carries the urgency, so the row does not have to rely on
                      the reader noticing a tinted icon. */}
                  <span className={`h-9 w-1 shrink-0 rounded-full ${tone.bar}`} aria-hidden="true" />
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone.bubble}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-body">{item.title}</p>
                    <p className="truncate text-xs text-muted">{item.description}</p>
                  </div>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
