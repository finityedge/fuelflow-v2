import { Link } from 'react-router-dom';

interface StatCardProps {
  label: string;
  /** Pre-formatted. Money goes through `formatTZS`, which is why it is not a number here. */
  value: string;
  /** Colour for the value itself, when the number's meaning carries a tone. */
  valueClass?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind classes for the icon bubble, e.g. `bg-warning-subtle text-warning`. */
  iconClass: string;
  /** One line under the value. The place to put what the number does *not* say. */
  hint?: React.ReactNode;
  /** Optional right-hand visual — a ring, a sparkline. Must be `aria-hidden` if it repeats `value`. */
  visual?: React.ReactNode;
  /** When set the whole card becomes the link, so the target is the card's full hit area. */
  to?: string;
}

/**
 * One figure on the dashboard.
 *
 * The value is `font-mono` on purpose: a column of these cards is read by comparing digits,
 * and proportional numerals do not line up.
 */
export function StatCard({
  label,
  value,
  valueClass,
  icon: Icon,
  iconClass,
  hint,
  visual,
  to,
}: StatCardProps) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        {visual}
      </div>
      <p className="mt-4 text-sm font-medium text-muted">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold tracking-tight ${valueClass ?? 'text-body'}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className="card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {inner}
      </Link>
    );
  }

  return <div className="card p-5">{inner}</div>;
}
