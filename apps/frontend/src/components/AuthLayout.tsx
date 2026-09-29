import { useState } from 'react';
import type { ComponentType, InputHTMLAttributes, ReactNode, SVGProps } from 'react';
import { Link } from 'react-router-dom';
import {
  ChartIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  ShieldCheckIcon,
  UsersIcon,
} from './icons.js';
import { LogoLockup } from './Logo.js';

/**
 * Cubic segments with horizontal handles, so the curve is smooth and never overshoots into a
 * wiggle between two points. Enough for a decorative line; a charting library would be weight
 * and a maintenance surface for a shape nobody reads.
 */
function smooth(points: Array<[number, number]>): string {
  return points
    .map(([x, y], index) => {
      if (index === 0) {
        return `M ${x} ${y}`;
      }
      const [prevX, prevY] = points[index - 1]!;
      const mid = (prevX + x) / 2;
      return `C ${mid} ${prevY} ${mid} ${y} ${x} ${y}`;
    })
    .join(' ');
}

const BRAND_CURVE: Array<[number, number]> = [
  [0, 150],
  [64, 124],
  [128, 131],
  [192, 106],
  [256, 114],
  [320, 90],
  [384, 97],
  [448, 72],
  [512, 55],
  [576, 60],
  [640, 38],
];

/**
 * The rising line on the brand panel.
 *
 * Drawn, not charted: there is no data behind it, no scale to read and no axis to label, so it
 * is `aria-hidden` and never announced as content. It is here to say what the product is about
 * before the reader has read a word.
 */
function BrandCurve() {
  const line = smooth(BRAND_CURVE);
  const area = `${line} L 640 200 L 0 200 Z`;

  return (
    <svg viewBox="0 0 640 200" width="640" height="200" className="mt-12 w-full" aria-hidden="true">
      <defs>
        <linearGradient id="brand-curve-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
        </linearGradient>
        <filter id="brand-curve-glow" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <g stroke="#1E293B" strokeWidth="1">
        {[40, 80, 120, 160].map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="640" y2={y} />
        ))}
        {[80, 160, 240, 320, 400, 480, 560].map((x) => (
          <line key={`v${x}`} x1={x} y1="0" x2={x} y2="200" />
        ))}
      </g>

      <path d={area} fill="url(#brand-curve-fill)" />
      <path
        d={line}
        fill="none"
        stroke="#3B82F6"
        strokeWidth="6"
        strokeLinecap="round"
        opacity="0.6"
        filter="url(#brand-curve-glow)"
      />
      <path
        d={line}
        fill="none"
        stroke="#60A5FA"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {BRAND_CURVE.map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r="4" fill="#3B82F6" stroke="#0F172A" strokeWidth="2" />
      ))}
    </svg>
  );
}

const BRAND_POINTS = [
  { icon: ShieldCheckIcon, lines: ['Accurate', 'Reconciliation'] },
  { icon: ClockIcon, lines: ['Real-time', 'Insights'] },
  { icon: ChartIcon, lines: ['Better', 'Decisions'] },
] as const;

function BrandPanel() {
  return (
    <aside className="hidden shrink-0 flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex lg:w-1/2 xl:p-14">
      <LogoLockup tone="onDark" tagline />

      <div className="max-w-xl">
        <h1 className="text-4xl font-bold leading-[1.15] tracking-tight text-white xl:text-5xl">
          Know exactly where every shilling went.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-slate-400 xl:text-lg">
          Reconcile your fuel sales, payments and stock with confidence.
        </p>
        <BrandCurve />
      </div>

      <ul className="flex items-start">
        {BRAND_POINTS.map((point, index) => (
          <li key={point.lines[0]} className="flex items-start">
            {index > 0 && <span aria-hidden="true" className="mx-6 h-9 w-px bg-slate-700/70" />}
            <div className="flex items-start gap-2.5">
              <point.icon className="h-5 w-5 shrink-0 text-primary-light" aria-hidden="true" />
              <p className="text-xs font-medium leading-snug text-slate-200">
                {point.lines.map((text) => (
                  <span key={text} className="block">
                    {text}
                  </span>
                ))}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * The shell both auth screens render inside: brand panel on the left, form on the right.
 *
 * Below `lg` the brand panel is dropped rather than stacked — it is 600px of decoration and
 * the person on a phone came here to sign in, so the form goes first and the lockup moves
 * above it.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface">
      <BrandPanel />
      <main className="flex w-full flex-1 items-center justify-center px-6 py-12 sm:px-10 lg:w-1/2 lg:px-16">
        <div className="w-full max-w-[26rem]">
          <div className="mb-10 lg:hidden">
            <LogoLockup tone="onLight" tagline />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

type AuthFieldProps = {
  id: string;
  /** The field's spoken name. The design leads with placeholders only, so this stays sr-only. */
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  trailing?: ReactNode;
  invalid?: boolean;
  hint?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>;

export function AuthField({
  id,
  label,
  icon: Icon,
  trailing,
  invalid = false,
  hint,
  ...input
}: AuthFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div
        className={`flex items-center rounded-xl border transition-colors duration-200 ${
          invalid
            ? 'border-error bg-error-subtle'
            : 'border-border bg-surface focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10'
        }`}
      >
        <Icon
          className={`ml-4 h-5 w-5 shrink-0 ${invalid ? 'text-error' : 'text-muted'}`}
          aria-hidden="true"
        />
        <input
          id={id}
          className="w-full bg-transparent py-3.5 pl-3 pr-3 text-sm text-body placeholder:text-muted focus:outline-none"
          {...input}
        />
        {trailing}
      </div>
      {hint}
    </div>
  );
}

export function AuthPasswordField({
  id,
  label,
  invalid,
  hint,
  ...input
}: Omit<AuthFieldProps, 'icon' | 'trailing'>) {
  const [visible, setVisible] = useState(false);

  return (
    <AuthField
      {...input}
      id={id}
      label={label}
      invalid={invalid}
      hint={hint}
      icon={LockIcon}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="mr-2 rounded-lg p-2 text-muted transition-colors hover:text-body focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          {visible ? (
            <EyeOffIcon className="h-5 w-5" aria-hidden="true" />
          ) : (
            <EyeIcon className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      }
    />
  );
}

export function AuthSubmit({
  isLoading,
  loadingLabel,
  children,
}: {
  isLoading: boolean;
  loadingLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={isLoading}
      aria-busy={isLoading}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3.5 text-sm font-semibold text-white shadow-primary transition-all duration-200 hover:bg-primary-dark hover:shadow-primary-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
    >
      {isLoading ? (
        <>
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
          />
          {loadingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-2 text-sm text-error">
      {message}
    </p>
  );
}

export function AuthDivider({ label = 'or' }: { label?: string }) {
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The secondary route out of the sign-in form: the one bordered, full-width action under the
 * divider. It is a link to the real registration page rather than the contact-us form in the
 * design, because this product has self-serve signup and no sales contact to route to.
 */
export function AuthAltAction({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-surface px-5 py-3.5 text-sm font-semibold text-primary transition-colors duration-200 hover:border-primary hover:bg-primary-subtle focus:outline-none focus:ring-2 focus:ring-primary/30"
    >
      <UsersIcon className="h-4 w-4" aria-hidden="true" />
      {children}
    </Link>
  );
}
