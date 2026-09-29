/** @type {import('tailwindcss').Config} */
export default {
  // `relative: true` resolves these globs against this file instead of the process's
  // working directory, and that distinction is the whole point.
  //
  // The frontend is built from the repo root in Docker: `WORKDIR /app`, then
  // `pnpm exec vite build --config apps/frontend/vite.config.ts`. Tailwind does not read
  // Vite's `root`, so plain `./index.html` and `./src/**` resolved to `/app/index.html`
  // and `/app/src/**` — paths that do not exist. It scanned no files, found no classes,
  // and emitted preflight plus the component layer with no utilities at all: the
  // container served a fully unstyled app (6 kB of CSS) while a build run from
  // apps/frontend produced 28 kB and looked correct. Nothing in the build fails, so the
  // only way to notice was to look at what was actually served.
  content: {
    relative: true,
    files: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  },
  theme: {
    extend: {
      colors: {
        // `rgb(var(--x) / <alpha-value>)` rather than `var(--x)` so opacity modifiers
        // work: Tailwind substitutes <alpha-value>, so `bg-primary/10` becomes
        // `rgb(var(--color-primary) / 0.1)` and plain `bg-primary` becomes `... / 1`.
        // A bare `var(--x)` takes no alpha, so every `bg-*/10`, `border-*/30` and
        // `from-*/5` in the app compiled to nothing.
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        'primary-dark': 'rgb(var(--color-primary-dark) / <alpha-value>)',
        // The lighter blue the active sidebar link is set in. Same defect as `sidebar`
        // below: the variable exists, `text-primary-light` is used in Layout.tsx, and
        // without this key the class compiles to nothing — so the active item's label
        // took the inherited dark colour and disappeared into the dark rail.
        'primary-light': 'rgb(var(--color-primary-light) / <alpha-value>)',
        secondary: 'rgb(var(--color-secondary) / <alpha-value>)',
        background: 'rgb(var(--color-background) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        body: 'rgb(var(--color-body) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        error: 'rgb(var(--color-error) / <alpha-value>)',
        // The dark navigation rail. The variable and the `bg-sidebar` class both existed;
        // this mapping did not, so the sidebar had no background colour at all.
        sidebar: 'rgb(var(--color-sidebar) / <alpha-value>)',
        // The tinted panel backgrounds behind the status and variance states.
        'primary-subtle': 'rgb(var(--color-primary-subtle) / <alpha-value>)',
        'success-subtle': 'rgb(var(--color-success-subtle) / <alpha-value>)',
        'warning-subtle': 'rgb(var(--color-warning-subtle) / <alpha-value>)',
        'error-subtle': 'rgb(var(--color-error-subtle) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        xs: ['var(--text-xs)', { lineHeight: 'var(--leading-xs)' }],
        sm: ['var(--text-sm)', { lineHeight: 'var(--leading-sm)' }],
        base: ['var(--text-base)', { lineHeight: 'var(--leading-base)' }],
        lg: ['var(--text-lg)', { lineHeight: 'var(--leading-lg)' }],
        xl: ['var(--text-xl)', { lineHeight: 'var(--leading-xl)' }],
        '2xl': ['var(--text-2xl)', { lineHeight: 'var(--leading-2xl)' }],
        '3xl': ['var(--text-3xl)', { lineHeight: 'var(--leading-3xl)' }],
        '4xl': ['var(--text-4xl)', { lineHeight: 'var(--leading-4xl)' }],
        '5xl': ['var(--text-5xl)', { lineHeight: 'var(--leading-5xl)' }],
      },
      spacing: {
        18: '4.5rem',
        88: '22rem',
      },
      boxShadow: {
        'primary': '0 4px 14px 0 rgba(37, 99, 235, 0.25)',
        'primary-md': '0 6px 20px 0 rgba(37, 99, 235, 0.30)',
        'card': '0 1px 3px 0 rgba(15, 23, 42, 0.08), 0 1px 2px -1px rgba(15, 23, 42, 0.08)',
        'card-hover': '0 10px 25px -5px rgba(15, 23, 42, 0.10), 0 4px 10px -2px rgba(15, 23, 42, 0.05)',
      },
    },
  },
  plugins: [],
};
