import { useState, FormEvent } from 'react';
import { Navigate, useNavigate, Link } from 'react-router-dom';
import { register } from '../lib/auth.js';
import { useAuthStore, selectIsAuthenticated } from '../stores/authStore.js';
import { BuildingIcon, CheckIcon, MailIcon } from '../components/icons.js';
import {
  AuthError,
  AuthField,
  AuthLayout,
  AuthPasswordField,
  AuthSubmit,
} from '../components/AuthLayout.js';

export function Register() {
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const [tenantName, setTenantName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (isHydrated && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      await register({ tenantName, ownerEmail, ownerPassword });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  }

  // The server enforces this too (`ownerPassword: z.string().min(8)`). Showing it here is not
  // a substitute for that — it is so the rule is visible while typing rather than only after
  // a rejected submit.
  const passwordChecks = [
    { label: 'At least 8 characters', met: ownerPassword.length >= 8 },
  ];

  return (
    <AuthLayout>
      <h1 className="text-3xl font-bold tracking-tight text-body">Create your account</h1>
      <p className="mt-2 text-sm text-muted">Set up FuelFlow for your fuel station</p>

      {error && <AuthError message={error} />}

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <AuthField
          id="tenantName"
          label="Station name"
          icon={BuildingIcon}
          type="text"
          autoComplete="organization"
          required
          placeholder="Acme Fuel Station"
          value={tenantName}
          onChange={(e) => setTenantName(e.target.value)}
        />

        <AuthField
          id="ownerEmail"
          label="Owner email"
          icon={MailIcon}
          type="email"
          autoComplete="email"
          required
          placeholder="owner@station.com"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
        />

        <AuthPasswordField
          id="ownerPassword"
          label="Password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="Password"
          value={ownerPassword}
          onChange={(e) => setOwnerPassword(e.target.value)}
          hint={
            <div className="mt-2 space-y-1">
              {passwordChecks.map((check) => (
                <div
                  key={check.label}
                  className={`flex items-center gap-2 text-xs ${
                    check.met ? 'text-success' : 'text-muted'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full ${
                      check.met ? 'bg-success text-white' : 'bg-slate-100'
                    }`}
                  >
                    {check.met && <CheckIcon className="h-2.5 w-2.5" aria-hidden="true" />}
                  </span>
                  {check.label}
                </div>
              ))}
            </div>
          }
        />

        <div className="pt-1">
          <AuthSubmit isLoading={isLoading} loadingLabel="Creating your account…">
            Create account
          </AuthSubmit>
        </div>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-primary hover:text-primary-dark">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
