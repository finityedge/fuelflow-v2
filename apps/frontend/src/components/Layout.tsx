import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthStore, selectIsAuthenticated } from '../stores/authStore.js';
import { logout } from '../lib/auth.js';
import { canUpload, canCorrect, isAttendant, roleLabel } from '../lib/rbac.js';
import { LogoLockup } from './Logo.js';
import {
  HomeIcon,
  ReportsIcon,
  CloudUploadIcon,
  LogoutIcon,
  MenuIcon,
  CloseIcon,
  AlertCircleIcon,
  TankIcon,
  UsersIcon,
  SettingsIcon,
} from './icons.js';
import type { AuthUser } from '../types/auth.js';

interface LayoutProps {
  children: React.ReactNode;
}

function getInitials(email: string): string {
  return email
    .split('@')[0]
    .split(/[._-]/)
    .map((part) => part[0]?.toUpperCase())
    .slice(0, 2)
    .join('');
}

/**
 * The sidebar's contents, shared by the fixed desktop column and the mobile drawer.
 *
 * Only the rows that lead somewhere are drawn, and Settings is the last one to have arrived:
 * a mock of this screen listed it from the start, and a nav item that opens a blank page is
 * worse than one that was never drawn, so it went in when the screen behind it existed.
 *
 * The queue sits directly under the dashboard because it is the only row here that is a task
 * rather than a place: the dashboard says how many reports are waiting, and this is the row
 * that goes and does them. Wet stock follows the queue rather than leading it — a leak is
 * found by reading shifts, and there is nothing to look at until those shifts have been read.
 * Attendants comes last for the same reason: it is the same reading of the same shifts, taken
 * one shift further, and it is the only row here whose subject is a person.
 *
 * Settings sits below all of them rather than among them, because it is not a view of the
 * shifts at all — it is the vocabulary those views are read against, and a manager arrives at
 * it once the figures have shown them something to fix.
 *
 * The findings sheet is not a row at all. It is reached from the dashboard, where the figures
 * it summarises already are — a nav entry would make it look like a sixth place to go rather
 * than what it is, which is the dashboard written down.
 *
 * For an attendant the first row is the only row, and it is not called Dashboard: `/` draws
 * their own record for them, so the row is named for what it opens. That is also why the
 * capability predicates above leave them with nothing — every other row here is a view of the
 * whole station's shifts, and the one screen that is theirs needed no permission to add.
 */
function SidebarBody({ user, onNavigate }: { user: AuthUser; onNavigate?: () => void }) {
  const location = useLocation();
  const uploadAllowed = canUpload(user.role);
  const correctAllowed = canCorrect(user.role);
  const attendant = isAttendant(user.role);

  const navItems = [
    { to: '/', icon: HomeIcon, label: attendant ? 'My shifts' : 'Dashboard', exact: true },
    ...(correctAllowed ? [{ to: '/review', icon: AlertCircleIcon, label: 'Review queue' }] : []),
    ...(correctAllowed ? [{ to: '/tanks', icon: TankIcon, label: 'Wet stock' }] : []),
    ...(correctAllowed ? [{ to: '/attendants', icon: UsersIcon, label: 'Attendants' }] : []),
    ...(correctAllowed
      ? [{ to: '/shift-reports/recent', icon: ReportsIcon, label: 'Shift reports' }]
      : []),
    ...(correctAllowed ? [{ to: '/settings', icon: SettingsIcon, label: 'Station settings' }] : []),
  ];

  const isActive = (to: string, exact?: boolean) =>
    exact ? location.pathname === to : location.pathname.startsWith(to);

  return (
    <>
      <div className="border-b border-slate-800/50 px-6 py-5">
        <LogoLockup tone="onDark" tagline />
      </div>

      <nav className="flex-1 overflow-y-auto p-4">
        <div className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(item.to, item.exact);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-primary/15 text-primary-light shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-white'
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-primary-light' : ''}`} />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* The one action this product exists for, given its own button rather than a third
            nav row: it is not a place to go, it is the thing to do. */}
        {uploadAllowed && (
          <Link to="/upload" onClick={onNavigate} className="btn-primary mt-6 w-full">
            <CloudUploadIcon className="h-4 w-4" />
            Upload shift report
          </Link>
        )}
      </nav>

      <div className="border-t border-slate-800/50 p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
            {getInitials(user.email)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{user.email.split('@')[0]}</p>
            <p className="truncate text-xs text-slate-400">{roleLabel(user.role)}</p>
          </div>
        </div>
        <button
          onClick={() => void logout()}
          className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-400 transition-all duration-200 hover:bg-slate-800/60 hover:text-white"
        >
          <LogoutIcon className="h-5 w-5" />
          Sign out
        </button>
      </div>
    </>
  );
}

export function Layout({ children }: LayoutProps) {
  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!isAuthenticated || !user) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* The chrome is hidden at the source rather than by a stylesheet reaching into it: a
          printed findings sheet is a document, and a document with a sidebar down one side of
          it is a screenshot. `print:hidden` is the whole of that rule. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-sidebar lg:flex print:hidden">
        <SidebarBody user={user} />
      </aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden print:hidden">
          <div
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="absolute bottom-0 left-0 top-0 flex w-72 flex-col bg-sidebar">
            <div className="flex h-16 shrink-0 items-center justify-end px-5">
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="text-slate-400 hover:text-white"
                aria-label="Close menu"
              >
                <CloseIcon className="h-6 w-6" />
              </button>
            </div>
            <SidebarBody user={user} onNavigate={() => setMobileMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex flex-1 flex-col lg:ml-64 print:ml-0">
        {/* Mobile chrome only — the menu button, and who you are signed in as. On desktop
            the sidebar column carries both, so this bar disappears entirely and the page
            heading sits at the top of the content where it belongs. */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur-xl sm:px-6 lg:hidden print:hidden">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="rounded-lg p-2 text-muted hover:bg-slate-100"
            aria-label="Open menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-2">
            <div className="flex flex-col items-end">
              <span className="text-sm font-semibold leading-tight text-body">
                {user.email.split('@')[0]}
              </span>
              <span className="text-xs text-muted">{roleLabel(user.role)}</span>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-subtle text-sm font-bold text-primary">
              {getInitials(user.email)}
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 print:p-0">{children}</main>
      </div>
    </div>
  );
}
