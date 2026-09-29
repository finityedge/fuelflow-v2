/**
 * What a variance means, in one place.
 *
 * Two screens show variances — the review screen for one shift, the dashboard for a month
 * of them — and the entire value of the number depends on both reading its sign the same
 * way. It lives here so they cannot drift apart.
 *
 * The convention is the app's own and it is not the obvious one:
 *
 *   positive  the pumps sold more than every form of payment accounts for. Money left and
 *             nobody recorded receiving it. This is the problem the product exists to find.
 *   negative  more was recorded as collected than was sold. Nothing is missing; a figure
 *             was written down wrongly. A bookkeeping error, not a loss.
 *   zero      the two sides agree.
 *
 * Colouring by sign alone — positive as the good, green one — inverts all of that.
 */

export type VarianceTone = 'balanced' | 'short' | 'over' | 'unknown';

export function varianceTone(variance: number | null | undefined): VarianceTone {
  if (variance === null || variance === undefined || Number.isNaN(variance)) {
    return 'unknown';
  }
  if (variance === 0) {
    return 'balanced';
  }
  return variance > 0 ? 'short' : 'over';
}

/**
 * Written out as literals rather than composed, because Tailwind only emits classes it can
 * see in the source. `` `text-${tone}` `` compiles to nothing at all.
 */
export const VARIANCE_TEXT: Record<VarianceTone, string> = {
  balanced: 'text-success',
  short: 'text-error',
  over: 'text-warning',
  unknown: 'text-muted',
};

export const VARIANCE_PANEL: Record<VarianceTone, string> = {
  balanced: 'bg-success-subtle border-success/30',
  short: 'bg-error-subtle border-error/30',
  over: 'bg-warning-subtle border-warning/30',
  unknown: 'bg-slate-100 border-border',
};

/** The dot colour on the trend chart. Same meaning, chart-weight colour. */
export const VARIANCE_DOT_FILL: Record<VarianceTone, string> = {
  balanced: 'rgb(var(--color-success))',
  short: 'rgb(var(--color-error))',
  over: 'rgb(var(--color-warning))',
  unknown: 'rgb(var(--color-muted))',
};

/** A short phrase for a legend or a tooltip. Never the word "balanced" for a non-zero shift. */
export const VARIANCE_LABEL: Record<VarianceTone, string> = {
  balanced: 'Accounted for exactly',
  short: 'Money unaccounted for',
  over: 'More collected than sold',
  unknown: 'Variance cannot be calculated',
};
