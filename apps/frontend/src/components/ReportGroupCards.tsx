import type { ComponentType, ReactNode, SVGProps } from 'react';
import type { ExtractedField } from '@fuelflow/shared';
import { FieldValue, RowFlags, type CorrectionSession } from './FieldValue.js';
import { PlateIcon, TankIcon, UsersIcon, WalletIcon } from './icons.js';
import { formatNumber } from '../lib/format.js';
import {
  VARIANCE_PILL,
  VARIANCE_PILL_STYLE,
  VARIANCE_TEXT,
  varianceTone,
  type VarianceTone,
} from '../lib/variance.js';
import { attendantView, cashView, creditView, tankView, totalizerField } from '../lib/reportGroups.js';

/**
 * The four cards the shift is reviewed through.
 *
 * The design this follows shows one card per area of the report, each ending in a total.
 * That shape is right — a manager reconciles a shift area by area — but three things in it
 * are not, and each is corrected below rather than copied:
 *
 *  - Every figure in a card is written without the currency, and the card states its unit
 *    once, in the header. `TZS 1,248,000` four times down a column of a card that is a third
 *    of the screen wide is the same currency repeated until it stops carrying information,
 *    and it pushes the figures that matter into wrapping. The headline figure, where the
 *    currency genuinely matters, keeps it.
 *  - A derived figure is never editable. An attendant's shortfall, a tank's dip: these are
 *    subtractions of two figures that were read off the paper. Correcting the difference
 *    directly would leave the screen agreeing with itself and disagreeing with the report.
 *    The pencil sits on the figures that were actually read.
 *  - Nothing that was not read is shown as zero. An unread cash figure leaves the card's
 *    total as a dash with the reason, not as a total that is quietly short.
 */

// ---------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------

function GroupCard({
  icon: Icon,
  title,
  subtitle,
  unit,
  footer,
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  subtitle: string;
  /** Stated once rather than repeated on every figure. */
  unit: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card flex flex-col overflow-hidden">
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-body">{title}</h2>
          <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
        </div>
        <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {unit}
        </span>
      </header>

      <div className="flex-1 divide-y divide-border">{children}</div>

      {footer}
    </section>
  );
}

function CardTotal({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: string;
  note?: string;
}) {
  return (
    <div className="border-t border-border bg-slate-50 px-5 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-semibold text-body">{label}</p>
        <p className={`font-mono text-lg font-bold tabular-nums ${tone ?? 'text-body'}`}>{value}</p>
      </div>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Row({ children, flagged }: { children: ReactNode; flagged?: boolean }) {
  return <div className={`px-5 py-3.5 ${flagged ? 'bg-warning-subtle/60' : ''}`}>{children}</div>;
}

/** A line that separates figures the variance counts from figures it merely records. */
function SubHeading({ children }: { children: ReactNode }) {
  return (
    <p className="bg-slate-50/70 px-5 py-2 text-xs font-bold uppercase tracking-wider text-muted">
      {children}
    </p>
  );
}

/** A label and a figure on one line: the shape most of these rows take. */
function FigureRow({ label, field, session }: { label: string; field: ExtractedField | null; session: CorrectionSession }) {
  return (
    <Row flagged={field?.needsReview}>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-semibold text-body">{label}</p>
        <FieldValue field={field} session={session} format={formatNumber} />
      </div>
      <RowFlags fields={[field]} />
    </Row>
  );
}

// ---------------------------------------------------------------------------------------
// Cash and payments
// ---------------------------------------------------------------------------------------

export function CashPaymentsCard({
  fields,
  session,
}: {
  fields: ExtractedField[];
  session: CorrectionSession;
}) {
  const view = cashView(fields);
  const totalizer = totalizerField(fields);
  /** Deposits and manual entries: recorded on the report, but not subtracted in the variance. */
  const recorded = [...view.deposits, ...view.adjustments];

  return (
    <GroupCard icon={WalletIcon} title="Cash & payments" subtitle="Taken in during this shift" unit="TZS">
      <FigureRow label="Cash collected" field={view.cash} session={session} />

      {view.mobile.map((field) => (
        <FigureRow key={field.id} label={field.label} field={field} session={session} />
      ))}

      {recorded.length > 0 && <SubHeading>Also recorded — not subtracted above</SubHeading>}

      {recorded.map((field) => (
        <FigureRow key={field.id} label={field.label} field={field} session={session} />
      ))}

      <CardTotal
        label="Counted in the variance"
        value={view.countedTotal === null ? '—' : formatNumber(view.countedTotal)}
        note={
          view.countedIncomplete
            ? 'One of the figures above was never read, so this total is unknown — not low.'
            : view.adjustments.length > 0
              ? 'Cash and mobile money. The manual entries above are recorded for reference; the variance does not subtract them.'
              : 'Cash and mobile money — the two payment figures the variance subtracts.'
        }
      />

      {totalizer && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted">
          Pump totalizer sales ({formatNumber(totalizer.amount ?? null)}) is what the shift
          <em> sold</em>, not what it took in, so it is not counted here — it is the figure the
          variance subtracts these payments from.
        </p>
      )}
    </GroupCard>
  );
}

// ---------------------------------------------------------------------------------------
// Credit sales
// ---------------------------------------------------------------------------------------

export function CreditSalesCard({
  fields,
  session,
}: {
  fields: ExtractedField[];
  session: CorrectionSession;
}) {
  const view = creditView(fields);

  return (
    <GroupCard
      icon={PlateIcon}
      title="Credit sales"
      subtitle="Vehicles on credit, to be collected"
      unit="TZS"
      footer={
        <CardTotal
          label="Total credit sales"
          value={formatNumber(view.total)}
          note={
            view.unidentified > 0
              ? `${view.unidentified} of these could not be matched to a plate number. They are counted, and each one is flagged.`
              : 'Approved credit — the third figure the variance subtracts.'
          }
        />
      }
    >
      {view.rows.map((row) => (
        <Row key={row.key} flagged={row.field.needsReview}>
          <div className="flex items-center justify-between gap-4">
            <p
              className={`font-mono text-sm font-semibold ${
                row.identified ? 'text-body' : 'text-warning'
              }`}
            >
              {row.plate}
            </p>
            <FieldValue field={row.field} session={session} format={formatNumber} />
          </div>
          <RowFlags fields={[row.field]} />
        </Row>
      ))}
    </GroupCard>
  );
}

// ---------------------------------------------------------------------------------------
// Attendant reconciliation
// ---------------------------------------------------------------------------------------

/** The column headings the figures sit under, which the mobile labels stand in for. */
function AttendantColumnHeadings() {
  return (
    <div className="hidden px-5 py-2 sm:block">
      <div className="flex items-center gap-4">
        <p className="flex-1 text-xs font-bold uppercase tracking-wider text-muted">Attendant</p>
        <div className="grid w-[19rem] shrink-0 grid-cols-3 gap-3">
          <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">To collect</p>
          <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">Collected</p>
          <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">Difference</p>
        </div>
      </div>
    </div>
  );
}

/** A heading that only the stacked mobile layout needs. */
function MobileLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-wide text-muted sm:hidden">{children}</p>
  );
}

export function AttendantCard({
  fields,
  session,
}: {
  fields: ExtractedField[];
  session: CorrectionSession;
}) {
  const view = attendantView(fields);

  return (
    <GroupCard
      icon={UsersIcon}
      title="Attendant reconciliation"
      subtitle="Collected against what was expected"
      unit="TZS"
      footer={
        <div className="border-t border-border bg-slate-50">
          <div className="flex items-baseline justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-semibold text-body">Total to collect</p>
              {view.totalToCollect !== null && view.totalCollected !== null && (
                <p className="mt-0.5 text-xs text-muted">
                  {formatNumber(view.totalCollected)} was collected
                  {view.shortCount > 0
                    ? ` · ${view.shortCount} short`
                    : ''}
                  {view.overCount > 0 ? ` · ${view.overCount} over` : ''}
                </p>
              )}
            </div>
            <p className="font-mono text-lg font-bold tabular-nums text-body">
              {view.totalToCollect === null ? '—' : formatNumber(view.totalToCollect)}
            </p>
          </div>

          {/* These two totals are the sum of everybody's takings, so one attendant's shortfall
              and another's overpayment cancel in them exactly as they do in a month of
              variances. The rows above are where the direction is, and this says so rather
              than leaving the footer to imply the shift balanced. */}
          {view.shortCount > 0 && view.overCount > 0 && (
            <p className="px-5 pb-3 text-xs text-muted">
              Both directions are present, so these totals partly cancel — read the rows to see
              who is short.
            </p>
          )}
          {view.totalToCollect === null && (
            <p className="px-5 pb-3 text-xs text-muted">
              An attendant’s row could not be read in full, so this total is unknown — not low.
            </p>
          )}
        </div>
      }
    >
      <AttendantColumnHeadings />

      {view.rows.map((row) => {
        const tone = varianceTone(row.varianceAmount);
        return (
          <Row
            key={row.key}
            flagged={Boolean(row.unreadable) || Boolean(row.toCollect?.needsReview) || Boolean(row.collected?.needsReview)}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-bold text-primary">
                  {row.initials}
                </span>
                <p className="truncate text-sm font-semibold text-body">{row.name}</p>
              </div>

              <div className="grid grid-cols-3 gap-3 sm:w-[19rem] sm:shrink-0">
                <div className="text-right">
                  <MobileLabel>To collect</MobileLabel>
                  <FieldValue field={row.toCollect} session={session} format={formatNumber} size="sm" />
                </div>
                <div className="text-right">
                  <MobileLabel>Collected</MobileLabel>
                  <FieldValue field={row.collected} session={session} format={formatNumber} size="sm" />
                </div>
                <div className="text-right">
                  <MobileLabel>Difference</MobileLabel>
                  <p
                    className={`font-mono text-sm font-semibold tabular-nums ${VARIANCE_TEXT[tone]}`}
                  >
                    {row.varianceAmount === null ? '—' : formatNumber(row.varianceAmount)}
                  </p>
                  <span
                    className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${VARIANCE_PILL_STYLE[tone]}`}
                  >
                    {VARIANCE_PILL[tone]}
                  </span>
                </div>
              </div>
            </div>

            <RowFlags fields={[row.unreadable, row.toCollect, row.collected]} />

            {/* Spelled out because the two words mean opposite things to two readers: the
                figure is what the attendant owes against what they handed over. */}
            {tone === 'short' && row.varianceAmount !== null && (
              <p className="mt-2 text-xs text-muted">
                Handed over {formatNumber(row.varianceAmount)} less than expected.
              </p>
            )}
            {tone === 'over' && row.varianceAmount !== null && (
              <p className="mt-2 text-xs text-muted">
                Handed over {formatNumber(Math.abs(row.varianceAmount))} more than expected.
              </p>
            )}
          </Row>
        );
      })}
    </GroupCard>
  );
}

// ---------------------------------------------------------------------------------------
// Tank readings
// ---------------------------------------------------------------------------------------

/**
 * A dip is fuel the book says is there and the tank says is not. The words are the tank's,
 * not the reconciliation's: a tank holding more than its book is not good news either — it
 * means the book is wrong — so it carries the warning tone rather than the success one.
 */
const TANK_PILL: Record<VarianceTone, string> = {
  balanced: 'Balanced',
  short: 'Dip',
  over: 'Gain',
  unknown: 'Unread',
};

/** What the total means, which depends on which way the tanks moved. */
function tankTotalNote(view: ReturnType<typeof tankView>): string {
  if (view.totalDifference === null) {
    return 'A tank is missing a reading, so this total is unknown — not zero.';
  }
  if (view.bothDirections) {
    return `${view.losses} tank${view.losses === 1 ? '' : 's'} down and ${view.gains} holding more than the book. The litres above are those two directions cancelling, so they understate the movement — read the rows.`;
  }
  if (view.losses > 0) {
    return `Every tank moved the same way: ${view.losses} short of the book.`;
  }
  if (view.gains > 0) {
    return `${view.gains} tank${view.gains === 1 ? '' : 's'} holding more than the book. No tank lost fuel.`;
  }
  return 'Every tank matches its book stock.';
}

export function TankReadingsCard({
  fields,
  session,
}: {
  fields: ExtractedField[];
  session: CorrectionSession;
}) {
  const view = tankView(fields);

  return (
    <GroupCard
      icon={TankIcon}
      title="Tank readings"
      subtitle="Book stock against the closing dip (litres)"
      unit="Litres"
      footer={
        <CardTotal
          label="Total difference across tanks"
          value={view.totalDifference === null ? '—' : formatNumber(view.totalDifference)}
          note={tankTotalNote(view)}
        />
      }
    >
      <div className="hidden px-5 py-2 sm:block">
        <div className="flex items-center gap-4">
          <p className="flex-1 text-xs font-bold uppercase tracking-wider text-muted">Tank</p>
          <div className="grid w-[19rem] shrink-0 grid-cols-3 gap-3">
            <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">Book stock</p>
            <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">Closing dip</p>
            <p className="text-right text-xs font-bold uppercase tracking-wider text-muted">Difference</p>
          </div>
        </div>
      </div>

      {view.rows.map((row) => {
        const tone = varianceTone(row.difference);
        return (
          <Row
            key={row.key}
            flagged={Boolean(row.bookStock?.needsReview) || Boolean(row.closingDip?.needsReview)}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-body">Tank {row.tankId}</p>
                {row.differencePercent !== null && (
                  <p className="mt-0.5 text-xs text-muted">
                    {Math.abs(row.differencePercent).toFixed(1)}% of book stock
                  </p>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3 sm:w-[19rem] sm:shrink-0">
                <div className="text-right">
                  <MobileLabel>Book stock</MobileLabel>
                  <FieldValue field={row.bookStock} session={session} format={formatNumber} size="sm" />
                </div>
                <div className="text-right">
                  <MobileLabel>Closing dip</MobileLabel>
                  <FieldValue field={row.closingDip} session={session} format={formatNumber} size="sm" />
                </div>
                <div className="text-right">
                  <MobileLabel>Difference</MobileLabel>
                  <p className={`font-mono text-sm font-semibold tabular-nums ${VARIANCE_TEXT[tone]}`}>
                    {row.difference === null ? '—' : formatNumber(row.difference)}
                  </p>
                  <span
                    className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${VARIANCE_PILL_STYLE[tone]}`}
                  >
                    {TANK_PILL[tone]}
                  </span>
                </div>
              </div>
            </div>

            <RowFlags fields={[row.bookStock, row.closingDip]} />
          </Row>
        );
      })}
    </GroupCard>
  );
}
