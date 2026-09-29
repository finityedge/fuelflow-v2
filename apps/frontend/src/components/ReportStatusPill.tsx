import type { ShiftReportListItem } from '@fuelflow/shared';
import { describeReportStatus, TONE_CLASSES } from '../lib/reportStatus.js';

/**
 * The one-line answer to "is anything wrong here?".
 *
 * `title` carries the long explanation, because the pill is read in a scanning list where
 * the detail would be noise — but the detail is what stops "Nothing to review" being read
 * as "this shift balances".
 */
export function ReportStatusPill({ report }: { report: ShiftReportListItem }) {
  const { label, tone, description } = describeReportStatus(report);

  return (
    <span
      className={`badge whitespace-nowrap ${TONE_CLASSES[tone]}`}
      title={description}
    >
      {label}
    </span>
  );
}
