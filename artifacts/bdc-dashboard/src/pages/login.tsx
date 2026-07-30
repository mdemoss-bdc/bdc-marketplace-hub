import { useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { Car, Eye, EyeOff, Loader2, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

const FIELD =
  'h-11 w-full rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 outline-none transition-colors ' +
  'focus:border-amber-300/40 focus:ring-2 focus:ring-amber-400/30';

const FIELD_ERROR =
  'h-11 w-full rounded-lg border border-red-400/50 bg-slate-950/70 px-3 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 outline-none transition-colors ' +
  'focus:border-red-300/60 focus:ring-2 focus:ring-red-400/25';

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
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const isPreview = new URLSearchParams(window.location.search).get('preview') === 'true';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const next: { username?: string; password?: string } = {};
    if (!username.trim()) next.username = 'Username is required.';
    if (!password) next.password = 'Password is required.';
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!validate()) {
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
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-b from-amber-300 to-amber-600 shadow-[0_0_20px_-4px_rgba(251,191,36,0.55)]">
            <Car className="h-6 w-6 text-slate-950" />
          </div>
          <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent">
            BDC Manager Desk
          </h1>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Sales Command Center
          </p>
          <p className="mt-3 text-sm text-slate-400">
            Sign in with your username and password to open the dashboard.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] backdrop-blur-xl"
          noValidate
        >
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
                if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined }));
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
                autoComplete="current-password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
                }}
                disabled={loading}
                required
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

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
            >
              {error}
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
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
