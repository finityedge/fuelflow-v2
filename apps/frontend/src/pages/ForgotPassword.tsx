import { useState, FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { requestPasswordReset } from '../lib/auth.js';
import { useAuthStore, selectIsAuthenticated } from '../stores/authStore.js';
import { MailIcon } from '../components/icons.js';
import {
  AuthAltAction,
  AuthError,
  AuthField,
  AuthLayout,
  AuthPanel,
  AuthSubmit,
  AuthTextLink,
} from '../components/AuthLayout.js';

/**
 * Asking for a reset link.
 *
 * The screen has two states and the second one is the interesting one. After a successful
 * request it does **not** say the email was sent, because the server did not tell it that — the
 * endpoint answers the same thing for an address with an account and one without, so that it
 * cannot be used to ask "does this person use FuelFlow?". A screen that promised "we've emailed
 * you" would put that answer back, and would be wrong for the address a stranger typed in.
 *
 * So the confirmation is conditional in its wording and unconditional in what it claims, which is
 * also what makes it readable to somebody who mistyped their address: if no account exists,
 * nothing is coming, and "if an account exists for that address" is a sentence they can act on.
 */
export function ForgotPassword() {
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState(false);

  // Somebody already signed in has no use for this, and the reset it would produce ends every
  // session they have — including the one they are using.
  if (isHydrated && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      await requestPasswordReset(email);
      setRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That request could not be sent.');
    } finally {
      setIsLoading(false);
    }
  }

  if (requested) {
    return (
      <AuthLayout>
        <h1 className="text-3xl font-bold tracking-tight text-body">Check your email</h1>
        <AuthPanel
          tone="info"
          icon={MailIcon}
          title="If an account exists for that address, a link is on its way."
        >
          <p>
            The link works once and expires within the hour. Opening it lets you choose a new
            password.
          </p>
          {/* The honest next step for the two people who land here: the one who mistyped, and
              the one whose mail server is slower than the screen is. A button rather than a link
              back to this same route — the route is already `/forgot-password`, and a link that
              navigates to where you are standing does nothing at all. */}
          <p>
            Nothing arrived? Check the spam folder, then{' '}
            <button
              type="button"
              onClick={() => setRequested(false)}
              className="rounded font-medium text-primary transition-colors hover:text-primary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              try again
            </button>
            .
          </p>
        </AuthPanel>

        <div className="mt-8">
          <AuthAltAction to="/login">Back to sign in</AuthAltAction>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-3xl font-bold tracking-tight text-body">Reset your password</h1>
      <p className="mt-2 text-sm text-muted">
        Enter the address you sign in with and we&rsquo;ll send you a link.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <AuthField
          id="email"
          label="Email address"
          icon={MailIcon}
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="juma@station.com"
          value={email}
          invalid={Boolean(error)}
          onChange={(e) => setEmail(e.target.value)}
          hint={error ? <AuthError message={error} /> : undefined}
        />

        <div className="pt-1">
          <AuthSubmit isLoading={isLoading} loadingLabel="Sending…">
            Send reset link
          </AuthSubmit>
        </div>
      </form>

      <div className="mt-6 text-center">
        <AuthTextLink to="/login">Back to sign in</AuthTextLink>
      </div>
    </AuthLayout>
  );
}
