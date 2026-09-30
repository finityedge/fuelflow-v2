import { formatShortDate } from '../lib/format.js';

/**
 * One shift's variance, whichever thing is being reconciled.
 *
 * Positive is the bad direction in both places this is used — litres the paperwork believes in
 * and the tank did not hold, money that was due and not handed over. Keeping one sign convention
 * across the two is what lets the strip below be one component rather than two that drift apart.
 */
export interface VarianceBarPoint {
  reportId: string;
  /** ISO day of the shift. */
  date: string;
  variance: number;
  /** A contributing figure is still flagged, so this bar may move. */
  provisional: boolean;
}

interface VarianceBarsProps {
  points: VarianceBarPoint[];
  /** What the strip plots, for the accessible name. "Book-versus-dip", "Cash reconciliation". */
  heading: string;
  /** One bar said in words. The tooltip and the accessible summary both read it. */
  describe: (variance: number) => string;
  /** What the whole strip nets to, said in words. */
  describeNet: (total: number) => string;
}

/**
 * A run of shifts, as bars, one per shift.
 *
 * Bars rather than a line, because the shape that matters is *which direction* each shift went
 * and how big it was, not the path between them. A repeated loss reads as a run of bars all on
 * the same side of the line, which is exactly the pattern a single total cannot show — and the
 * reason both alerts on both screens are about repetition rather than about any one shift.
 *
 * Bars grow up for a shortfall and down for a surplus, so the sign of the number is the side of
 * the line. The scale is shared across one strip and not across strips: two tanks of different
 * sizes losing the same litres are the same loss, and two attendants on very different takings
 * are not comparable either, so comparing the heights of two separate strips would suggest a
 * relationship that is not there.
 *
 * Nothing here knows whether the figure is litres or shillings. That is the whole of the
 * generalisation: the words are supplied by the caller, the geometry is not.
 */
export function VarianceBars({ points, heading, describe, describeNet }: VarianceBarsProps) {
  const HEIGHT = 72;
  const MID = HEIGHT / 2;
  const BAR_GAP = 2;

  const worst = Math.max(...points.map((point) => Math.abs(point.variance)), 1);
  // Bars are capped below half the canvas so the tallest one still has the zero line to sit
  // against, at both ends.
  const scale = (MID - 8) / worst;

  const width = Math.max(points.length * (6 + BAR_GAP), 40);
  const barWidth = width / points.length - BAR_GAP;

  const total = points.reduce((sum, point) => sum + point.variance, 0);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`${heading} for ${points.length} shift${
          points.length === 1 ? '' : 's'
        }, from ${formatShortDate(points[0]?.date)} to ${formatShortDate(
          points[points.length - 1]?.date
        )}. ${describeNet(total)}.`}
      >
        {/* The zero line: nothing unaccounted for on that shift. Bars above it are the bad side. */}
        <line
          x1={0}
          x2={width}
          y1={MID}
          y2={MID}
          stroke="rgb(var(--color-border))"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {points.map((point, index) => {
          const magnitude = Math.abs(point.variance) * scale;
          const isShort = point.variance > 0;
          const x = index * (barWidth + BAR_GAP);

          // A shift that balanced exactly still gets a visible tick, so the gap in a run of
          // bars is read as "nothing wrong" rather than as a missing reading.
          const height = Math.max(magnitude, point.variance === 0 ? 1.5 : 2);

          return (
            <rect
              key={point.reportId}
              x={x}
              y={isShort ? MID - height : MID}
              width={barWidth}
              height={height}
              rx={1}
              fill={
                point.variance === 0
                  ? 'rgb(var(--color-border))'
                  : isShort
                    ? 'rgb(var(--color-error))'
                    : 'rgb(var(--color-success))'
              }
              fillOpacity={point.provisional ? 0.35 : 1}
            >
              <title>
                {`${formatShortDate(point.date)} — ${describe(point.variance)}.`}
                {point.provisional ? ' A figure is still flagged, so this may change.' : ''}
              </title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}
