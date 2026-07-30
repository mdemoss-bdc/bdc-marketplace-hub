import { useState } from 'react';
import { Link } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Car, Loader2, CheckCircle, ArrowLeft, Mail } from 'lucide-react';

export default function ForgotPassword() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">

        {/* Wordmark */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            <div className="w-10 h-10 rounded-md bg-primary flex items-center justify-center">
              <Car className="w-6 h-6 text-primary-foreground" />
            </div>
            <h1 className="text-2xl font-display font-bold tracking-tight">BDC Manager Desk</h1>
          </div>
          <p className="text-sm text-muted-foreground">Sales Command Center</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              Enter the email address linked to your account and we'll send you a reset link.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {sent ? (
              /* ── Success state ── */
              <div className="space-y-5">
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                    <CheckCircle className="w-7 h-7 text-green-500" />
                  </div>
                  <div>
                    <p className="font-semibold text-base">Check your inbox</p>
                    <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                      If <strong className="text-foreground">{email}</strong> is registered,
                      you'll receive a password reset link within a minute.
                      Check your spam folder if it doesn't arrive.
                    </p>
                  </div>
                </div>
                <Link href="/login">
                  <Button variant="outline" className="w-full gap-2">
                    <ArrowLeft className="w-4 h-4" />Back to Sign In
                  </Button>
                </Link>
              </div>
            ) : (
              /* ── Form state ── */
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email" className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                    Email Address
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="name@dealership.com"
                    value={email}
                    onChange={e => { setEmail(e.target.value); setError(''); }}
                    required
                    disabled={loading}
                    autoComplete="email"
                    className="h-11"
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                    {error}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full h-11"
                  disabled={loading || !email.trim()}
                >
                  {loading
                    ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Sending…</>
                    : 'Send Reset Link'}
                </Button>

                <div className="text-center pt-1">
                  <Link href="/login">
                    <button type="button" className="text-sm text-muted-foreground hover:text-primary transition-colors">
                      ← Back to Sign In
                    </button>
                  </Link>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
