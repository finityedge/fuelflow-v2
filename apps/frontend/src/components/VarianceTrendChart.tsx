import type { DashboardTrendPoint } from '@fuelflow/shared';
import { formatCompactNumber, formatSignedTZS, formatShortDate } from '../lib/format.js';
import {
  VARIANCE_DOT_FILL,
  VARIANCE_LABEL,
  varianceTone,
  type VarianceTone,
} from '../lib/variance.js';

const WIDTH = 760;
const HEIGHT = 260;
const PAD = { top: 18, right: 18, bottom: 38, left: 68 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

/** At most this many date labels, however many shifts are plotted. */
const MAX_X_LABELS = 7;

/**
 * A round number near `raw`, for gridlines a person can read.
 *
 * Without this the ticks land on whatever the data happens to span — `TZS 1.7M`,
 * `TZS 1.1M` — and the axis becomes a second puzzle to solve before reading the chart.
 */
function niceStep(raw: number): number {
  if (raw <= 0) {
    return 1;
  }
  const exponent = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

export function VarianceTrendChart({ points }: { points: DashboardTrendPoint[] }) {
  const values = points.map((point) => point.variance);
  const rawLo = Math.min(0, ...values);
  const rawHi = Math.max(0, ...values);

  // Every shift accounted for exactly: there is no span to scale to, so the axis is given
  // one rather than collapsing to a division by zero.
  const flat = rawLo === 0 && rawHi === 0;
  const step = flat ? 1 : niceStep((rawHi - rawLo) / 4);
  const lo = flat ? -1 : Math.floor(rawLo / step) * step;
  const hi = flat ? 1 : Math.ceil(rawHi / step) * step;

  const ticks: number[] = [];
  for (let tick = lo; tick <= hi + step / 1000; tick += step) {
    ticks.push(tick);
  }

  // x is the position in the sequence of shifts, not the calendar date. Shifts are
  // reported irregularly — three in one day, then nothing for a week — and spacing by date
  // would stack those three into one unreadable column and leave the rest of the plot
  // empty. The labels carry the dates so the gaps are still visible.
  const x = (index: number) =>
    points.length === 1
      ? PAD.left + PLOT_W / 2
      : PAD.left + (index / (points.length - 1)) * PLOT_W;
  const y = (value: number) => PAD.top + (1 - (value - lo) / (hi - lo)) * PLOT_H;

  const labelEvery = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point.variance)}`).join(' ');

  const range =
    points.length === 1
      ? `on ${formatShortDate(points[0]!.date)}`
      : `from ${formatShortDate(points[0]?.date)} to ${formatShortDate(points[points.length - 1]?.date)}`;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Variance for ${points.length} reconciled shift${points.length === 1 ? '' : 's'}, ${range}. Exact figures follow in a table.`}
      >
        {/* Gridlines and their labels. The unit is stated once, below, rather than on every
            tick — "TZS" seven times down the side is noise, not information. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="rgb(var(--color-border))"
              strokeWidth={tick === 0 ? 1.5 : 1}
              strokeDasharray={tick === 0 ? undefined : '3 4'}
            />
            <text
              x={PAD.left - 10}
              y={y(tick) + 4}
              textAnchor="end"
              fill="rgb(var(--color-muted))"
              fontSize={11}
            >
              {formatCompactNumber(tick)}
            </text>
          </g>
        ))}

        <text
          x={PAD.left - 10}
          y={PAD.top - 6}
          textAnchor="end"
          fill="rgb(var(--color-muted))"
          fontSize={11}
          fontWeight={600}
        >
          TZS
        </text>

        {points.length > 1 && (
          <path
            d={linePath}
            fill="none"
            stroke="rgb(var(--color-primary))"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {points.map((point, index) => {
          const tone: VarianceTone = varianceTone(point.variance);
          const cx = x(index);
          const cy = y(point.variance);
          return (
            <g key={point.reportId}>
              <circle
                cx={cx}
                cy={cy}
                r={point.provisional ? 5 : 4.5}
                fill={point.provisional ? 'rgb(var(--color-surface))' : VARIANCE_DOT_FILL[tone]}
                stroke={VARIANCE_DOT_FILL[tone]}
                strokeWidth={point.provisional ? 2.5 : 1.5}
              >
                <title>
                  {`${formatShortDate(point.date)} — ${formatSignedTZS(point.variance)}. ${VARIANCE_LABEL[tone]}.`}
                  {point.provisional ? ' A figure is still flagged, so this may change.' : ''}
                </title>
              </circle>

              {/* The last point is always labelled, whatever the thinning lands on: it is
                  the most recent shift and the one being read first. */}
              {(index % labelEvery === 0 || index === points.length - 1) && (
                <text
                  x={cx}
                  y={HEIGHT - PAD.bottom + 20}
                  textAnchor="middle"
                  fill="rgb(var(--color-muted))"
                  fontSize={11}
                >
                  {formatShortDate(point.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* The same data as text, for anyone who cannot use the plot — and the honest place to
          record that a hollow marker is not decoration. */}
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-error" />
          {VARIANCE_LABEL.short}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-warning" />
          {VARIANCE_LABEL.over}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-success" />
          {VARIANCE_LABEL.balanced}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-muted bg-surface" />
          Still flagged — the figure may move
        </span>
      </figcaption>

      <table className="sr-only">
        <caption>Variance per reconciled shift</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Variance</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.reportId}>
              <td>{formatShortDate(point.date)}</td>
              <td>{formatSignedTZS(point.variance)}</td>
              <td>{VARIANCE_LABEL[varianceTone(point.variance)]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
