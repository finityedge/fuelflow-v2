import type { TankLeakagePoint } from '@fuelflow/shared';
import { VarianceBars } from './VarianceBars.js';
import { formatNumber } from '../lib/format.js';

/**
 * One tank's book-versus-dip figure, shift by shift.
 *
 * The geometry and the sign convention live in `VarianceBars`; all this adds is the words for a
 * fuel figure. It is kept as its own component rather than having every caller pass words at the
 * tank screen's call site, because there is exactly one way to say a litres figure here and it
 * should not be re-typed wherever a tank is drawn.
 */
export function TankTrendBars({ points }: { points: TankLeakagePoint[] }) {
  return (
    <VarianceBars
      points={points.map((point) => ({
        reportId: point.reportId,
        date: point.date,
        variance: point.varianceLitres,
        provisional: point.provisional,
      }))}
      heading="Book-versus-dip"
      describe={(variance) =>
        variance === 0
          ? 'book and dip agreed'
          : variance > 0
            ? `${formatNumber(variance)} litres missing`
            : `${formatNumber(-variance)} litres more than the book`
      }
      describeNet={(total) => `Net ${formatNumber(total)} litres missing`}
    />
  );
}
