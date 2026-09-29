import type { ComponentType, SVGProps } from 'react';
import type { ReconciliationSummary } from '@fuelflow/shared';
import { AlertIcon, CheckCircleIcon, InfoIcon, ScaleIcon } from './icons.js';
import { formatTZS } from '../lib/format.js';
import {
  VARIANCE_LABEL,
  VARIANCE_PANEL,
  VARIANCE_TEXT,
  varianceTone,
  type VarianceTone,
} from '../lib/variance.js';

/**
 * The one number this screen exists for.
 *
 * Two things here are deliberate and were both got wrong by the design this is built from:
 *
 *  - The figure is shown unsigned, with the direction said in words underneath. `TZS -12,450`
 *    in a red panel marked "needs attention" is a contradiction: in this product a negative
 *    variance is money *over*-collected, and the reader has to know that before they can read
 *    a sign. Saying "Money unaccounted for — TZS 12,450" cannot be misread.
 *  - The arithmetic is shown rather than summarised. A manager who is going to argue with
 *    this number, or go and dig out the paper report, needs to see which four figures
 *    produced it, not be told to trust it.
 */

const TONE_ICON: Record<VarianceTone, ComponentType<SVGProps<SVGSVGElement>>> = {
  short: AlertIcon,
  over: ScaleIcon,
  balanced: CheckCircleIcon,
  unknown: InfoIcon,
};

function explanation(tone: VarianceTone, magnitude: string): string {
  switch (tone) {
    case 'short':
      return `The pumps sold ${magnitude} more than every payment on this report accounts for. Nothing on the report says where that money went.`;
    case 'over':
      return `${magnitude} more has been recorded as collected than the pumps sold. Nothing appears to be missing — a figure on the report is most likely written down wrongly.`;
    case 'balanced':
      return 'Every shilling the pumps sold is accounted for by a payment recorded on this report.';
    case 'unknown':
      return 'A variance needs both pump totalizer sales and cash collected. At least one of them could not be read, so the difference cannot be worked out.';
  }
}

export function VarianceHero({ summary }: { summary: ReconciliationSummary }) {
  const tone = varianceTone(summary.variance);
  const Icon = TONE_ICON[tone];
  const magnitude = summary.variance === null ? '—' : formatTZS(Math.abs(summary.variance));

  const rows: { sign: string; label: string; value: number | null }[] = [
    { sign: '', label: 'Pump totalizer sales', value: summary.pumpTotalizerSales },
    { sign: '−', label: 'Cash collected', value: summary.cash },
    { sign: '−', label: 'Mobile money', value: summary.mobileMoney },
    { sign: '−', label: 'Approved credit', value: summary.approvedCredit },
  ];

  return (
    <section className={`card border p-6 sm:p-8 ${VARIANCE_PANEL[tone]}`} aria-labelledby="variance-heading">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/70 ${VARIANCE_TEXT[tone]}`}
        >
          <Icon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <h2
            id="variance-heading"
            className={`text-xs font-bold uppercase tracking-wider ${VARIANCE_TEXT[tone]}`}
          >
            Variance — {VARIANCE_LABEL[tone]}
          </h2>

          <p
            className={`mt-2 font-mono text-4xl font-bold tabular-nums sm:text-5xl ${VARIANCE_TEXT[tone]}`}
          >
            {magnitude}
          </p>

          <p className="mt-3 max-w-2xl text-sm text-body">{explanation(tone, magnitude)}</p>

          {summary.provisional && (
            <p className="mt-2 text-xs text-muted">
              Provisional — one of the figures below is still flagged, so this will move when it
              is checked.
            </p>
          )}

          <dl className="mt-6 border-t border-black/5 pt-5">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-4 py-1"
              >
                <dt className="flex items-baseline gap-2 text-sm text-muted">
                  <span className="w-3 shrink-0 font-mono text-right">{row.sign}</span>
                  {row.label}
                </dt>
                <dd className="font-mono text-sm font-semibold tabular-nums text-body">
                  {formatTZS(row.value)}
                </dd>
              </div>
            ))}

            <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-black/10 pt-2">
              <dt className="flex items-baseline gap-2 text-sm font-semibold text-body">
                <span className="w-3 shrink-0 font-mono text-right">=</span>
                Variance
              </dt>
              <dd className={`font-mono text-sm font-bold tabular-nums ${VARIANCE_TEXT[tone]}`}>
                {magnitude}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
