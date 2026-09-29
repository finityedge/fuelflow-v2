/**
 * One place that decides what a report's status is called and what colour it gets.
 *
 * Statuses are shown in two places (the recent-uploads list and the reports list) and they
 * must not drift apart, so both read from here.
 *
 * The wording is deliberately narrower than it first looks. A mock of this screen labels a
 * finished report "Balanced", which reads as "the shift reconciles" — and that is a claim
 * this app cannot make from a status field. `PARSED` means every figure was read and no
 * field is waiting on a human; the pump totalizer can still be 3,000,000 TZS above what was
 * collected. Green here means "nothing is waiting on you", never "the money adds up", and
 * the variance on the report itself is the only thing that answers the second question.
 */

import type { ShiftReportListItem } from '@fuelflow/shared';

export type ReportStatusTone = 'primary' | 'warning' | 'success' | 'error';

export interface ReportStatus {
  /** The pill text. Short enough not to wrap in a narrow column. */
  label: string;
  tone: ReportStatusTone;
  /** Why it says that, in a sentence — for a `title` attribute or a screen reader. */
  description: string;
}

/** Written out in full because Tailwind only sees class names that appear literally. */
export const TONE_CLASSES: Record<ReportStatusTone, string> = {
  primary: 'bg-primary-subtle text-primary',
  warning: 'bg-warning-subtle text-warning',
  success: 'bg-success-subtle text-success',
  error: 'bg-error-subtle text-error',
};

export function describeReportStatus(
  report: Pick<ShiftReportListItem, 'status' | 'needsReviewCount' | 'failureReason'>
): ReportStatus {
  if (report.status === 'PENDING') {
    return {
      label: 'Reading…',
      tone: 'primary',
      description: 'We are still reading the figures out of this PDF.',
    };
  }

  if (report.status === 'FAILED') {
    return {
      label: 'Couldn’t be read',
      tone: 'error',
      description:
        report.failureReason ?? 'This PDF could not be read. Try uploading it again.',
    };
  }

  if (report.needsReviewCount > 0) {
    const count = report.needsReviewCount;
    return {
      label: `${count} to review`,
      tone: 'warning',
      description: `${count} figure${count === 1 ? '' : 's'} need a person to check ${
        count === 1 ? 'it' : 'them'
      } against the PDF.`,
    };
  }

  return {
    label: 'Nothing to review',
    tone: 'success',
    description:
      'Every figure was read without a flag. That is not the same as the shift balancing — check the variance on the report.',
  };
}
