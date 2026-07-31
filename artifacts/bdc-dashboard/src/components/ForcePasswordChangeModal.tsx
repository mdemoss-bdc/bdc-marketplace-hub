import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Eye, EyeOff, KeyRound, Loader2, Lock } from 'lucide-react';

/**
 * Un-dismissible gate shown when an admin-assigned temporary password was used.
 * Blocks access to the desk until a new password is saved.
 */
export function ForcePasswordChangeModal() {
  const { forceChangePassword, user } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await forceChangePassword(password, confirm);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="force-pw-title"
        className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-300">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2 id="force-pw-title" className="text-lg font-semibold text-slate-100">
              Temporary Password Detected
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Please set a new password to continue
              {user?.username ? (
                <>
                  {' '}
                  as <span className="font-medium text-slate-200">{user.username}</span>
                </>
              ) : null}
              .
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              New Password
            </span>
            <div className="relative">
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="new-password"
                className="h-11 w-full rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 pr-10 text-sm text-slate-100 outline-none focus:border-amber-300/40 focus:ring-2 focus:ring-amber-400/30"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300"
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Confirm New Password
            </span>
            <input
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="h-11 w-full rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none focus:border-amber-300/40 focus:ring-2 focus:ring-amber-400/30"
            />
          </label>

          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-amber-400 text-sm font-bold text-amber-950 transition hover:bg-amber-300 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Set New Password & Continue
          </button>
        </form>
      </div>
    </div>
  );
}
