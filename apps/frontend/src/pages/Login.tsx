import { useState, FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { login } from '../lib/auth.js';
import { useAuthStore, selectIsAuthenticated } from '../stores/authStore.js';
import { MailIcon } from '../components/icons.js';
import {
  AuthAltAction,
  AuthDivider,
  AuthError,
  AuthField,
  AuthLayout,
  AuthPasswordField,
  AuthSubmit,
} from '../components/AuthLayout.js';

export function Login() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetNoteOpen, setResetNoteOpen] = useState(false);

  if (isHydrated && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      await login({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  }

  // A rejected sign-in is one fact about the pair, not about the address: both fields are
  // marked so the correction is not aimed at whichever one happens to be highlighted.
  const credentialsRejected = Boolean(error);

  return (
    <AuthLayout>
      <h1 className="text-3xl font-bold tracking-tight text-body">Welcome back</h1>
      <p className="mt-2 text-sm text-muted">Sign in to your station dashboard</p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <AuthField
          id="email"
          label="Email address"
          icon={MailIcon}
          type="email"
          autoComplete="email"
          required
          placeholder="juma@station.com"
          value={email}
          invalid={credentialsRejected}
          onChange={(e) => setEmail(e.target.value)}
          hint={error ? <AuthError message={error} /> : undefined}
        />

        <div>
          <AuthPasswordField
            id="password"
            label="Password"
            autoComplete="current-password"
            required
            placeholder="Password"
            value={password}
            invalid={credentialsRejected}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="mt-2 text-right">
            <button
              type="button"
              onClick={() => setResetNoteOpen((open) => !open)}
              aria-expanded={resetNoteOpen}
              className="rounded text-sm text-muted transition-colors hover:text-body focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              Forgot password?
            </button>
          </div>
          {resetNoteOpen && (
            // The design has this link; the product has no reset flow behind it. Saying so is
            // the point — a link that quietly does nothing reads as a broken app.
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Password reset isn&rsquo;t available in this version of FuelFlow.
            </p>
          )}
        </div>

        <div className="pt-1">
          <AuthSubmit isLoading={isLoading} loadingLabel="Signing in…">
            Sign In
          </AuthSubmit>
        </div>
      </form>

      <div className="mt-6">
        <AuthDivider />
      </div>

      <div className="mt-6">
        <AuthAltAction to="/register">Create your account</AuthAltAction>
      </div>
    </AuthLayout>
  );
}
