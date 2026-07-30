import { useState, useCallback } from 'react';
import { Mail, X, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

export function EmailVerificationBanner() {
  const { user, token, isEmailVerified } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sending,   setSending]   = useState(false);
  const [sent,      setSent]      = useState(false);
  const [error,     setError]     = useState('');

  const handleResend = useCallback(async () => {
    if (sending || sent || !token) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSent(true);
        // Reset after 60 s so the user can resend again if needed
        setTimeout(() => setSent(false), 60_000);
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Failed to resend. Try again shortly.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }, [sending, sent, token]);

  // Only show for authenticated, unverified users
  if (!user || isEmailVerified || dismissed) return null;

  // ── Success state: green confirmation block ───────────────────────────────
  if (sent) {
    return (
      <div className="flex items-start gap-3 px-4 py-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800/50 rounded-lg text-sm mb-5">
        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-green-900 dark:text-green-200 font-semibold leading-snug">
            Verification email sent!
          </p>
          <p className="text-green-700 dark:text-green-300 text-xs mt-0.5">
            Check your inbox and spam folder. Click the link in the email to activate your account.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-green-500 dark:text-green-400 hover:opacity-70 transition-opacity flex-shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // ── Pending verification state ────────────────────────────────────────────
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800/50 rounded-lg text-sm mb-5">
      <Mail className="w-4 h-4 text-sky-600 dark:text-sky-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        {/* Clicking the message text also triggers resend */}
        <button
          onClick={handleResend}
          disabled={sending}
          className="text-sky-900 dark:text-sky-200 leading-snug text-left w-full disabled:opacity-60 hover:opacity-80 transition-opacity"
        >
          Please check your inbox to verify your email address
          {user.email ? <span className="font-medium"> ({user.email})</span> : null}.
        </button>
        <p className="mt-1 text-xs">
          <button
            onClick={handleResend}
            disabled={sending}
            className="text-sky-600 dark:text-sky-400 font-semibold underline underline-offset-2 hover:opacity-80 disabled:opacity-50 transition-opacity"
          >
            {sending ? 'Sending…' : 'Resend verification link'}
          </button>
        </p>
        {error && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-sky-500 dark:text-sky-400 hover:opacity-70 transition-opacity flex-shrink-0 mt-0.5"
        aria-label="Dismiss verification banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
