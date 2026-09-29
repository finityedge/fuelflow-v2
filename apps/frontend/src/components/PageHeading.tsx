import type { ReactNode } from 'react';

/**
 * A page's own heading.
 *
 * Pages own their headings rather than borrowing the top bar for them, because the top bar
 * is 16px of chrome above the scroll and a page title belongs with the page. It also stops
 * the two from disagreeing, which they did: the review screen rendered "Shift report" in the
 * bar and "12 Mar 2026" as its heading, and both were on screen at once.
 */
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-body sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
