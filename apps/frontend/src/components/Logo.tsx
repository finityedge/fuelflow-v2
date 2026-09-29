import type { SVGProps } from 'react';

/**
 * The FuelFlow mark: a droplet for the fuel, a leaf for what the reporting grows out of it.
 *
 * Two tones rather than one flat silhouette, because at 32px a single-colour shape reads as
 * a blob — the lighter lobe is what keeps the form legible when it is small.
 */
export function LogoMark({ className }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path
        d="M16 3.2c-4.8 5.8-8.4 9.7-8.4 14a8.4 8.4 0 0 0 16.8 0c0-4.3-3.6-8.2-8.4-14Z"
        fill="currentColor"
      />
      <path d="M16.7 12.6c.6 3.8-1 6.9-4.2 8.4-.9-3.5.7-6.9 4.2-8.4Z" fill="#34D399" />
      <path d="M17.5 12.6c3.5 1.5 5.1 4.9 4.2 8.4-3.2-1.5-4.8-4.6-4.2-8.4Z" fill="#10B981" />
    </svg>
  );
}

/**
 * Mark plus wordmark.
 *
 * `tone` names the surface the lockup is placed on, not a colour of its own. The auth screens
 * need both: the dark brand panel on the left, and — below `lg`, where that panel is hidden —
 * the light panel, so the brand is still the first thing on the page on a phone.
 */
export function LogoLockup({
  tone = 'onDark',
  tagline = false,
  className,
}: {
  tone?: 'onDark' | 'onLight';
  tagline?: boolean;
  className?: string;
}) {
  const onDark = tone === 'onDark';
  const accent = onDark ? 'text-primary-light' : 'text-primary';

  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      <LogoMark className={`h-9 w-9 shrink-0 ${accent}`} />
      <div className="min-w-0">
        <p
          className={`text-lg font-bold leading-tight tracking-tight ${
            onDark ? 'text-white' : 'text-body'
          }`}
        >
          Fuel<span className={accent}>Flow</span>
        </p>
        {tagline && (
          <p className={`text-xs leading-tight ${onDark ? 'text-slate-400' : 'text-muted'}`}>
            Fuel Station Reconciliation
          </p>
        )}
      </div>
    </div>
  );
}
