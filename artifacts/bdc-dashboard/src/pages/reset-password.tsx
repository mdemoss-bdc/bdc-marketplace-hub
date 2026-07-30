import { useState } from 'react';
import { Link } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Car, Eye, EyeOff, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';

function PasswordInput({
  id, value, onChange, disabled = false, placeholder = '••••••••',
}: {
  id: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="pr-10 h-11"
        autoComplete="new-password"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(v => !v)}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

export default function ResetPassword() {
  // Read token and optional reverted flag from the URL query string
  const token = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('token') ?? ''
    : '';
  const reverted = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('reverted') === '1'
    : false;

  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');
  const [loading, setLoading]     = useState(false);
  const [done, setDone]           = useState(false);
  const [error, setError]         = useState('');

  const mismatch  = confirm.length > 0 && password !== confirm;
  const submitDisabled = loading || !password || !confirm || mismatch;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, new_password: password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  const Wordmark = (
    <div className="text-center space-y-2">
      <div className="flex items-center justify-center gap-2">
        <div className="w-10 h-10 rounded-md bg-primary flex items-center justify-center">
          <Car className="w-6 h-6 text-primary-foreground" />
        </div>
        <h1 className="text-2xl font-display font-bold tracking-tight">BDC Manager Desk</h1>
      </div>
    </div>
  );

  /* ── No token in URL ── */
  if (!token) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          {Wordmark}
          <Card>
            <CardContent className="pt-6 space-y-5">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-7 h-7 text-destructive" />
                </div>
                <div>
                  <p className="font-semibold text-base">Invalid reset link</p>
                  <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                    This link is missing a reset token. Please request a new password reset.
                  </p>
                </div>
              </div>
              <Link href="/forgot-password">
                <Button className="w-full h-11">Request New Link</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {Wordmark}

        {/* Security revert banner — shown when arriving via the emergency revocation link */}
        {reverted && (
          <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-sm text-amber-800 dark:text-amber-300">
                Email change reverted for security
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 leading-relaxed">
                Your email has been restored to its previous address and all active
                sessions have been terminated. Please set a new password now to fully
                secure your account.
              </p>
            </div>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{reverted ? 'Secure your account' : 'Set a new password'}</CardTitle>
            <CardDescription>
              {reverted
                ? 'Your email has been reverted. Set a new password to complete account recovery.'
                : 'Choose a strong password for your account.'}
            </CardDescription>
          </CardHeader>

          <CardContent>
            {done ? (
              /* ── Success ── */
              <div className="space-y-5">
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                    <CheckCircle className="w-7 h-7 text-green-500" />
                  </div>
                  <div>
                    <p className="font-semibold text-base">Password updated!</p>
                    <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                      Your password has been changed. You can now sign in with your new credentials.
                    </p>
                  </div>
                </div>
                <Link href="/login">
                  <Button className="w-full h-11">Sign In</Button>
                </Link>
              </div>
            ) : (
              /* ── Form ── */
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New Password</Label>
                  <PasswordInput
                    id="password" value={password} onChange={setPassword} disabled={loading}
                  />
                  <p className="text-xs text-muted-foreground">Minimum 6 characters.</p>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="confirm">Confirm New Password</Label>
                  <PasswordInput
                    id="confirm" value={confirm} onChange={setConfirm} disabled={loading}
                  />
                  {mismatch && (
                    <p className="text-xs text-destructive pt-0.5 flex items-center gap-1">
                      <span aria-hidden>⚠</span> Passwords do not match
                    </p>
                  )}
                </div>

                {error && (
                  <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full h-11" disabled={submitDisabled}>
                  {loading
                    ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Updating password…</>
                    : 'Update Password'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
