import { useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { Eye, EyeOff, Loader2, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/BrandLogo';

const FIELD =
  'h-11 w-full rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 outline-none transition-colors ' +
  'focus:border-amber-300/40 focus:ring-2 focus:ring-amber-400/30';

const FIELD_ERROR =
  'h-11 w-full rounded-lg border border-red-400/50 bg-slate-950/70 px-3 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 outline-none transition-colors ' +
  'focus:border-red-300/60 focus:ring-2 focus:ring-red-400/25';

type Mode = 'signin' | 'signup';

type FieldErrors = {
  fullName?: string;
  email?: string;
  username?: string;
  password?: string;
  confirmPassword?: string;
};

function PreviewBanner() {
  const [, setLocation] = useLocation();
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-xs font-semibold text-amber-950 shadow-md">
      <span>Master Admin Preview — Login Screen</span>
      <button
        type="button"
        onClick={() => setLocation('/dashboard')}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-amber-950/15 px-2.5 py-1 font-bold transition-colors hover:bg-amber-950/25"
      >
        <ArrowLeft className="h-3 w-3" />
        Return to App
      </button>
    </div>
  );
}

export default function LoginPage() {
  const { login, register } = useAuth();
  const [, setLocation] = useLocation();
  const isPreview = new URLSearchParams(window.location.search).get('preview') === 'true';

  const [mode, setMode] = useState<Mode>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loading, setLoading] = useState(false);

  const clearFieldError = (key: keyof FieldErrors) => {
    setFieldErrors((f) => {
      if (!f[key]) return f;
      const next = { ...f };
      delete next[key];
      return next;
    });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setSuccess('');
    setFieldErrors({});
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const validateSignIn = () => {
    const next: FieldErrors = {};
    if (!username.trim()) next.username = 'Username is required.';
    if (!password) next.password = 'Password is required.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const validateSignUp = () => {
    const next: FieldErrors = {};
    if (!email.trim()) next.email = 'Email address is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      next.email = 'Enter a valid email address.';
    }
    if (!username.trim()) next.username = 'Username is required.';
    else if (username.trim().length < 3) next.username = 'Username must be at least 3 characters.';
    if (!password) next.password = 'Password is required.';
    else if (password.length < 6) next.password = 'Password must be at least 6 characters.';
    if (!confirmPassword) next.confirmPassword = 'Confirm your password.';
    else if (password !== confirmPassword) next.confirmPassword = 'Passwords do not match.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (mode === 'signin') {
      if (!validateSignIn()) {
        setError('Enter both username and password to continue.');
        return;
      }
      setLoading(true);
      try {
        await login(username.trim(), password);
        setLocation('/dashboard');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!validateSignUp()) {
      setError('Please fix the highlighted fields to create your account.');
      return;
    }

    setLoading(true);
    try {
      await register(
        username.trim(),
        password,
        email.trim(),
        true,
        '',
        '',
        '',
        'individual',
        '',
        0,
        'monthly',
        fullName.trim() || undefined,
      );
      setSuccess('Account created — welcome aboard.');
      setLocation('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        'relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-950 px-4 py-10',
        isPreview && 'pt-16',
      )}
    >
      {isPreview && <PreviewBanner />}

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,0.09),transparent_55%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(51,65,85,0.5),transparent_50%)]"
      />

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center sm:h-20 sm:w-20">
            <BrandLogo className="h-16 w-16 drop-shadow-[0_0_24px_rgba(251,191,36,0.25)] sm:h-20 sm:w-20" />
          </div>
          <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent">
            BDC Manager Desk
          </h1>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Sales Command Center
          </p>
          <p className="mt-3 text-sm text-slate-400">
            {mode === 'signin'
              ? 'Sign in with your username and password to open the dashboard.'
              : 'Create a free account to get started with the desk.'}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] backdrop-blur-xl"
          noValidate
        >
          {mode === 'signup' && (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor="signup-fullname"
                  className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
                >
                  Full Name <span className="normal-case tracking-normal text-slate-600">(optional)</span>
                </label>
                <input
                  id="signup-fullname"
                  type="text"
                  autoComplete="name"
                  placeholder="Your name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={loading}
                  className={FIELD}
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="signup-email"
                  className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
                >
                  Email Address
                </label>
                <input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@dealership.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    clearFieldError('email');
                  }}
                  disabled={loading}
                  className={fieldErrors.email ? FIELD_ERROR : FIELD}
                  aria-invalid={Boolean(fieldErrors.email)}
                />
                {fieldErrors.email && (
                  <p className="text-[11px] text-red-300">{fieldErrors.email}</p>
                )}
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="login-username"
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
            >
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              placeholder="Enter username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearFieldError('username');
              }}
              disabled={loading}
              className={fieldErrors.username ? FIELD_ERROR : FIELD}
              aria-invalid={Boolean(fieldErrors.username)}
            />
            {fieldErrors.username && (
              <p className="text-[11px] text-red-300">{fieldErrors.username}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                placeholder={mode === 'signup' ? 'Create a password' : 'Enter password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearFieldError('password');
                }}
                disabled={loading}
                className={cn(fieldErrors.password ? FIELD_ERROR : FIELD, 'pr-11')}
                aria-invalid={Boolean(fieldErrors.password)}
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                disabled={loading}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-200 disabled:opacity-40"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {fieldErrors.password && (
              <p className="text-[11px] text-red-300">{fieldErrors.password}</p>
            )}
          </div>

          {mode === 'signup' && (
            <div className="space-y-1.5">
              <label
                htmlFor="signup-confirm"
                className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400"
              >
                Confirm Password
              </label>
              <input
                id="signup-confirm"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="Re-enter password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  clearFieldError('confirmPassword');
                }}
                disabled={loading}
                className={fieldErrors.confirmPassword ? FIELD_ERROR : FIELD}
                aria-invalid={Boolean(fieldErrors.confirmPassword)}
              />
              {fieldErrors.confirmPassword && (
                <p className="text-[11px] text-red-300">{fieldErrors.confirmPassword}</p>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
            >
              {error}
            </div>
          )}

          {success && (
            <div
              role="status"
              className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"
            >
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={cn(
              'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg',
              'bg-gradient-to-b from-amber-300 to-amber-500',
              'text-sm font-semibold uppercase tracking-[0.12em] text-slate-950',
              'shadow-[0_0_20px_-6px_rgba(251,191,36,0.55)]',
              'transition-all hover:from-amber-200 hover:to-amber-400',
              'disabled:pointer-events-none disabled:opacity-60',
            )}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading
              ? mode === 'signup'
                ? 'Creating account…'
                : 'Signing in…'
              : mode === 'signup'
                ? 'Create Account'
                : 'Sign In'}
          </button>

          <p className="pt-1 text-center text-sm text-slate-400">
            {mode === 'signin' ? (
              <>
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => switchMode('signup')}
                  className="font-semibold text-amber-300 transition-colors hover:text-amber-200 disabled:opacity-50"
                >
                  Sign Up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => switchMode('signin')}
                  className="font-semibold text-amber-300 transition-colors hover:text-amber-200 disabled:opacity-50"
                >
                  Sign In
                </button>
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
