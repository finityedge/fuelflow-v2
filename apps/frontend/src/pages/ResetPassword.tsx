import { useState, FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../lib/auth.js';
import { useAuthStore, selectIsAuthenticated } from '../stores/authStore.js';
import { AlertCircleIcon, CheckCircleIcon, LockIcon } from '../components/icons.js';
import {
  AuthAltAction,
  AuthError,
  AuthLayout,
  AuthPanel,
  AuthPasswordField,
  AuthSubmit,
  AuthTextLink,
} from '../components/AuthLayout.js';

/**
 * The page an emailed reset link lands on.
 *
 * The token arrives in the query string, which is the only place it can arrive: this is a link
 * out of an email client, and there is no session to carry it. That has a cost worth naming — the
 * URL ends up in the browser's history and in any proxy log in front of this app — and it is why
 * the token is single-use and expires within the hour. The alternative, an interstitial POST form
 * with the token in a hidden field, moves the token out of the address bar without stopping it
 * from being logged on the way in.
 *
 * Three states, and only the first is a form:
 *
 *  1. A token is present — ask for the new password.
 *  2. The change succeeded — say so, and point at sign-in.
 *  3. No token at all — a truncated link, or somebody who typed the path. The server can say
 *     nothing useful here, because no request has been made, so neither can this screen.
 *
 * A rejected token stays in state 1 with the server's own message under the field. That is
 * deliberate: the two refusals are different instructions — "not valid" sends somebody back to
 * the request form, "expired or already used" sends them to their inbox for a newer email — and
 * both are worth leaving the field in place for, since neither means the password was set.
 */
export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const isHydrated = useAuthStore((state) => state.isHydrated);

  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (isHydrated && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const tooShort = password.length > 0 && password.length < 8;
  const mismatched = confirmation.length > 0 && confirmation !== password;
  const canSubmit = password.length >= 8 && confirmation === password;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!canSubmit) {
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That password could not be set.');
    } finally {
      setIsLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout>
        <h1 className="text-3xl font-bold tracking-tight text-body">Reset link incomplete</h1>
        <AuthPanel tone="info" icon={AlertCircleIcon} title="This link is missing its token.">
          <p>
            That usually means the address was truncated — some email clients cut long links in
            half. Requesting a new one is quicker than trying to repair this one.
          </p>
        </AuthPanel>

        <div className="mt-8">
          <AuthAltAction to="/forgot-password">Request a new link</AuthAltAction>
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout>
        <h1 className="text-3xl font-bold tracking-tight text-body">Password changed</h1>
        <AuthPanel
          tone="success"
          icon={CheckCircleIcon}
          title="You can sign in with your new password."
        >
          {/* Not a throwaway line: a person who reset because they believed their password was
              stolen is owed the news that the other session is gone, and a person who reset with
              FuelFlow open on a second device is owed the explanation for why it stopped. */}
          <p>Anyone who was signed in to this account has been signed out.</p>
        </AuthPanel>

        <div className="mt-8">
          <AuthAltAction to="/login">Sign in</AuthAltAction>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-3xl font-bold tracking-tight text-body">Choose a new password</h1>
      <p className="mt-2 text-sm text-muted">
        Pick something you haven&rsquo;t used here before.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <AuthPasswordField
          id="password"
          label="New password"
          autoComplete="new-password"
          required
          autoFocus
          placeholder="New password"
          value={password}
          invalid={Boolean(error) || tooShort}
          onChange={(e) => setPassword(e.target.value)}
          hint={
            error ? (
              <AuthError message={error} />
            ) : tooShort ? (
              // The server's own rule is eight characters, and it is stated here rather than
              // discovered by being refused. A form that waits for a round trip to say the
              // password is too short spends the person's time to tell them something it already
              // knew.
              <p className="mt-2 text-xs text-muted">Use at least 8 characters.</p>
            ) : undefined
          }
        />

        <AuthPasswordField
          id="password-confirmation"
          label="Confirm new password"
          autoComplete="new-password"
          required
          placeholder="Confirm new password"
          value={confirmation}
          invalid={mismatched}
          onChange={(e) => setConfirmation(e.target.value)}
          hint={
            mismatched ? <p className="mt-2 text-xs text-error">Both passwords must match.</p> : undefined
          }
        />

        <div className="pt-1">
          <AuthSubmit isLoading={isLoading} loadingLabel="Saving…">
            Set new password
          </AuthSubmit>
        </div>
      </form>

      {/* The way out of a dead token. The field above stays put — a rejected link is not a
          reason to clear what somebody already typed — but the route to a working one is right
          here rather than behind the back button. */}
      <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted">
        <LockIcon className="h-4 w-4" aria-hidden="true" />
        <span>Link not working?</span>
        <AuthTextLink to="/forgot-password">Request a new one</AuthTextLink>
      </div>

      <p className="mt-4 text-center text-sm text-muted">
        <Link
          to="/login"
          className="rounded transition-colors hover:text-body focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
