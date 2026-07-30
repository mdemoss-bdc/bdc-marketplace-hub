import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const API_BASE = import.meta.env.BASE_URL + 'api';

type Status = 'loading' | 'success' | 'error';

export default function VerifyEmail() {
  const { refreshUser } = useAuth();
  const [status,  setStatus]  = useState<Status>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params     = new URLSearchParams(window.location.search);
    const verifyToken = params.get('token')?.trim();

    if (!verifyToken) {
      setStatus('error');
      setMessage('No verification token found in this link.');
      return;
    }

    fetch(`${API_BASE}/auth/verify-email?token=${encodeURIComponent(verifyToken)}`)
      .then(r => r.json())
      .then(async data => {
        if (data.status === 'ok') {
          // Refresh the auth context so the banner disappears immediately
          await refreshUser();
          setStatus('success');
          setMessage('Your email has been successfully verified!');
          // Hard-redirect so the app shell re-initialises with the updated user
          setTimeout(() => { window.location.href = '/marketplace-hub'; }, 2200);
        } else {
          setStatus('error');
          setMessage(data.error || 'Verification failed. The link may have expired.');
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('Network error. Please try again or request a new link.');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-dvh bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
            <p className="text-lg font-medium">Verifying your email…</p>
            <p className="text-sm text-muted-foreground">Just a moment.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle2 className="w-14 h-14 text-green-500 mx-auto" />
            <h1 className="text-2xl font-bold tracking-tight">Email Verified!</h1>
            <p className="text-muted-foreground">{message}</p>
            <p className="text-sm text-muted-foreground">
              Redirecting you to your Marketplace Hub…
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-14 h-14 text-destructive mx-auto" />
            <h1 className="text-2xl font-bold tracking-tight">Verification Failed</h1>
            <p className="text-muted-foreground">{message}</p>
            <div className="flex flex-col gap-2 mt-2">
              <a
                href="/marketplace-hub"
                className="inline-block rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                Go to Marketplace Hub
              </a>
              <p className="text-xs text-muted-foreground">
                You can request a new verification link from the banner inside the app.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
