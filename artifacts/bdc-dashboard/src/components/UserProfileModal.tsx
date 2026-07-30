import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2, Eye, EyeOff, CheckCircle, XCircle,
  Mail, Phone, Lock, User as UserIcon, Calendar, Shield,
  Copy, Check, RefreshCw, AlertTriangle, KeyRound,
} from 'lucide-react';

// ── Local helpers ────────────────────────────────────────────────────────────

/** Parse JSON safely — HTML 404/500 pages must not throw Unexpected token. */
async function readApiJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const trimmed = text.trim();
  if (!trimmed) {
    if (!res.ok) throw new Error(`Request failed (${res.status}).`);
    return {};
  }
  const looksJson =
    ct.includes('application/json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');
  if (!looksJson) {
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 140);
    if (res.status === 404) {
      throw new Error('Profile update endpoint not found. Please refresh and try again.');
    }
    throw new Error(
      snippet
        ? `Server error (${res.status}): ${snippet}`
        : `Request failed (${res.status}).`,
    );
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON from server (${res.status}).`);
  }
}

function apiErrorMessage(data: Record<string, unknown>, fallback: string): string {
  const err = data.error ?? data.message;
  return typeof err === 'string' && err.trim() ? err : fallback;
}

function PasswordInput({
  id, value, onChange, placeholder = '••••••••', disabled = false,
}: {
  id?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="current-password"
        className="pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow(v => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={show ? 'Hide' : 'Show'}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function StatusMsg({ ok, msg }: { ok: boolean; msg: string }) {
  return (
    <div className={`flex items-start gap-2 p-2.5 rounded-md text-xs border ${
      ok
        ? 'bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400'
        : 'bg-destructive/10 border-destructive/20 text-destructive'
    }`}>
      {ok
        ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        : <XCircle    className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
      <span className="leading-snug">{msg}</span>
    </div>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0">
      <span className="w-28 text-xs text-muted-foreground flex-shrink-0 pt-0.5">{label}</span>
      <span className="text-sm font-medium break-all leading-snug">{value}</span>
    </div>
  );
}

/** Mask all segments except the first: REC-XXXX-••••-•••• */
function maskRecoveryId(rid: string, revealed: boolean): string {
  if (revealed) return rid;
  const parts = rid.split('-');
  if (parts.length !== 4) return rid;
  return `${parts[0]}-${parts[1]}-••••-••••`;
}

// ── Main component ───────────────────────────────────────────────────────────

interface UserProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UserProfileModal({ open, onOpenChange }: UserProfileModalProps) {
  const { user, authFetch, refreshUser, isSubscribed, isMasterAdmin } = useAuth();

  const [activeTab, setActiveTab] = useState('profile');

  // Phone
  const [phone, setPhone]             = useState('');
  const [loadingPhone, setLoadingPhone] = useState(false);
  const [savingPhone, setSavingPhone]   = useState(false);
  const [phoneStatus, setPhoneStatus]   = useState<'idle' | 'success' | 'error'>('idle');
  const [phoneMsg, setPhoneMsg]         = useState('');

  // Change password
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew]         = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwStatus, setPwStatus]   = useState<'idle' | 'success' | 'error'>('idle');
  const [pwMsg, setPwMsg]         = useState('');

  // Update email
  const [emailNew, setEmailNew]         = useState('');
  const [emailPw, setEmailPw]           = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailStatus, setEmailStatus]   = useState<'idle' | 'success' | 'error'>('idle');
  const [emailMsg, setEmailMsg]         = useState('');

  // Recovery ID
  const [ridRevealed, setRidRevealed]       = useState(false);
  const [ridCopied, setRidCopied]           = useState(false);
  const [ridRegenConfirm, setRidRegenConfirm] = useState(false);
  const [ridRegenLoading, setRidRegenLoading] = useState(false);
  const [ridRegenStatus, setRidRegenStatus]   = useState<'idle' | 'success' | 'error'>('idle');
  const [ridRegenMsg, setRidRegenMsg]         = useState('');

  // Load phone and ensure fresh user data (including recovery_id) when modal opens
  useEffect(() => {
    if (!open) return;
    setLoadingPhone(true);
    authFetch('/api/users/me')
      .then(async (r) => {
        const data = await readApiJson(r);
        const u = (data.user && typeof data.user === 'object')
          ? (data.user as Record<string, unknown>)
          : data;
        const nextPhone = String(u.phone ?? data.phone ?? '');
        setPhone(nextPhone);
      })
      .catch(() => {})
      .finally(() => setLoadingPhone(false));
    // Refresh user to pull latest recovery_id from the server
    refreshUser().catch(() => {});
  }, [open, authFetch, refreshUser]);

  // Reset all transient state when modal closes
  useEffect(() => {
    if (!open) {
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      setPwStatus('idle'); setPwMsg('');
      setEmailNew(''); setEmailPw('');
      setEmailStatus('idle'); setEmailMsg('');
      setPhoneStatus('idle'); setPhoneMsg('');
      setRidRevealed(false); setRidCopied(false);
      setRidRegenConfirm(false);
      setRidRegenStatus('idle'); setRidRegenMsg('');
      setActiveTab('profile');
    }
  }, [open]);

  const handleSavePhone = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPhone(true);
    setPhoneStatus('idle');
    try {
      const res = await authFetch('/api/users/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await readApiJson(res);
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Failed to save phone.'));
      setPhoneStatus('success');
      setPhoneMsg(String(data.message || 'Phone number saved.'));
    } catch (err: unknown) {
      setPhoneStatus('error');
      setPhoneMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSavingPhone(false);
    }
  }, [authFetch, phone]);

  const handleChangePassword = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setPwStatus('idle');
    setPwLoading(true);
    try {
      const res = await authFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: pwCurrent,
          new_password:     pwNew,
          confirm_password: pwConfirm,
        }),
      });
      const data = await readApiJson(res);
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Failed to update password.'));
      setPwStatus('success');
      setPwMsg('Password updated successfully.');
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
    } catch (err: unknown) {
      setPwStatus('error');
      setPwMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setPwLoading(false);
    }
  }, [authFetch, pwCurrent, pwNew, pwConfirm]);

  const handleUpdateEmail = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailStatus('idle');
    setEmailLoading(true);
    try {
      const res = await authFetch('/api/users/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_email:        emailNew.trim().toLowerCase(),
          current_password: emailPw,
        }),
      });
      const data = await readApiJson(res);
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Failed to update email.'));
      setEmailStatus('success');
      setEmailMsg(String(data.message || 'Email updated. Check both inboxes for confirmation.'));
      setEmailNew(''); setEmailPw('');
      await refreshUser();
    } catch (err: unknown) {
      setEmailStatus('error');
      setEmailMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setEmailLoading(false);
    }
  }, [authFetch, emailNew, emailPw, refreshUser]);

  const handleCopyRid = useCallback(async () => {
    const rid = user?.recovery_id;
    if (!rid) return;
    try {
      await navigator.clipboard.writeText(rid);
      setRidCopied(true);
      setTimeout(() => setRidCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }, [user?.recovery_id]);

  const handleRegenerateRid = useCallback(async () => {
    setRidRegenLoading(true);
    setRidRegenStatus('idle');
    try {
      const res = await authFetch('/api/user/recovery-id/regenerate', { method: 'POST' });
      const data = await readApiJson(res);
      if (!res.ok) throw new Error(apiErrorMessage(data, 'Failed to regenerate Recovery ID.'));
      setRidRegenConfirm(false);
      setRidRevealed(false);
      await refreshUser(); // pull the new recovery_id into context
      setRidRegenStatus('success');
      setRidRegenMsg('Recovery ID regenerated. Store your new ID in a safe place.');
    } catch (err: unknown) {
      setRidRegenStatus('error');
      setRidRegenMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRidRegenLoading(false);
    }
  }, [authFetch, refreshUser]);

  const roleLabel = isMasterAdmin ? 'Admin' : isSubscribed ? 'Pro' : 'Trial';
  const rolePillClass = isMasterAdmin
    ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
    : isSubscribed
    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';

  const formattedDate = (() => {
    const raw = user?.created_at;
    if (!raw) return '—';
    try {
      return new Date(raw).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      });
    } catch { return raw; }
  })();

  const rid = user?.recovery_id ?? '';
  const ridDisplay = rid ? maskRecoveryId(rid, ridRevealed) : '—';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] max-h-[90dvh] overflow-y-auto">

        {/* ── Header ── */}
        <DialogHeader className="pb-1">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold uppercase text-xl flex-shrink-0 select-none ring-2 ring-primary/20">
              {user?.username?.[0] ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg leading-tight">{user?.username ?? '—'}</DialogTitle>
              <DialogDescription asChild>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${rolePillClass}`}>
                    {isMasterAdmin && <Shield className="w-3 h-3" />}
                    {roleLabel}
                  </span>
                  {user?.email && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {user.email}
                    </span>
                  )}
                </div>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* ── Tabs ── */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
          <TabsList className="grid grid-cols-3 w-full h-9">
            <TabsTrigger value="profile" className="text-xs gap-1.5 h-full">
              <UserIcon className="w-3.5 h-3.5" />Profile
            </TabsTrigger>
            <TabsTrigger value="security" className="text-xs gap-1.5 h-full">
              <Lock className="w-3.5 h-3.5" />Security
            </TabsTrigger>
            <TabsTrigger value="account" className="text-xs gap-1.5 h-full">
              <Calendar className="w-3.5 h-3.5" />Account
            </TabsTrigger>
          </TabsList>

          {/* ── Profile & Contact ───────────────────────────────────── */}
          <TabsContent value="profile" className="space-y-5 pt-4">

            {/* Phone */}
            <form onSubmit={handleSavePhone} className="space-y-2.5">
              <Label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Phone className="w-3.5 h-3.5" />Phone Number
              </Label>
              {loadingPhone ? (
                <div className="flex items-center gap-2 py-1.5 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />Loading…
                </div>
              ) : (
                <Input
                  type="tel"
                  placeholder="+1 (304) 555-0100"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  autoComplete="tel"
                />
              )}
              {phoneStatus !== 'idle' && <StatusMsg ok={phoneStatus === 'success'} msg={phoneMsg} />}
              {!loadingPhone && (
                <Button type="submit" size="sm" disabled={savingPhone}>
                  {savingPhone
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Saving…</>
                    : 'Save Phone'}
                </Button>
              )}
            </form>

            <div className="border-t border-border" />

            {/* Email update */}
            <div className="space-y-3">
              <Label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Mail className="w-3.5 h-3.5" />Update Email Address
              </Label>

              {/* Current email read-only chip */}
              <div className="flex items-center gap-2 bg-muted/40 border border-border/60 rounded-md px-3 py-2 text-sm">
                <span className="flex-1 truncate text-muted-foreground text-xs">
                  {user?.email || 'No email on file'}
                </span>
                {user?.email_verified && (
                  <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                )}
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                A security alert with an emergency revert link will be sent to your current address.
              </p>

              <form onSubmit={handleUpdateEmail} className="space-y-2">
                <Input
                  type="email"
                  placeholder="new@dealership.com"
                  value={emailNew}
                  onChange={e => setEmailNew(e.target.value)}
                  autoComplete="email"
                />
                <PasswordInput
                  value={emailPw}
                  onChange={setEmailPw}
                  placeholder="Current password to confirm"
                />
                {emailStatus !== 'idle' && <StatusMsg ok={emailStatus === 'success'} msg={emailMsg} />}
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={emailLoading || !emailNew || !emailPw}
                >
                  {emailLoading
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Updating…</>
                    : 'Update Email'}
                </Button>
              </form>
            </div>
          </TabsContent>

          {/* ── Security (Change Password) ──────────────────────────── */}
          <TabsContent value="security" className="pt-4">
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="modal-pw-current" className="text-sm font-medium">Current Password</Label>
                  <PasswordInput
                    id="modal-pw-current"
                    value={pwCurrent}
                    onChange={setPwCurrent}
                    placeholder="Current password"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="modal-pw-new" className="text-sm font-medium">New Password</Label>
                  <PasswordInput
                    id="modal-pw-new"
                    value={pwNew}
                    onChange={setPwNew}
                    placeholder="New password (min. 6 characters)"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="modal-pw-confirm" className="text-sm font-medium">Confirm New Password</Label>
                  <PasswordInput
                    id="modal-pw-confirm"
                    value={pwConfirm}
                    onChange={setPwConfirm}
                    placeholder="Confirm new password"
                  />
                  {pwConfirm.length > 0 && pwNew !== pwConfirm && (
                    <p className="text-xs text-destructive flex items-center gap-1 mt-1">
                      <XCircle className="w-3 h-3" />Passwords do not match
                    </p>
                  )}
                </div>
              </div>
              {pwStatus !== 'idle' && <StatusMsg ok={pwStatus === 'success'} msg={pwMsg} />}
              <Button
                type="submit"
                className="w-full"
                disabled={pwLoading || !pwCurrent || !pwNew || !pwConfirm || pwNew !== pwConfirm}
              >
                {pwLoading
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Updating…</>
                  : 'Update Password'}
              </Button>
            </form>
          </TabsContent>

          {/* ── Account Details + Recovery ──────────────────────────── */}
          <TabsContent value="account" className="pt-4 space-y-5">

            {/* Read-only account info */}
            <div className="rounded-lg border border-border overflow-hidden text-sm">
              <ReadonlyRow label="Username" value={user?.username ?? '—'} />
              <ReadonlyRow
                label="Role"
                value={
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${rolePillClass}`}>
                    {isMasterAdmin && <Shield className="w-3 h-3" />}
                    {roleLabel}
                  </span>
                }
              />
              <ReadonlyRow
                label="Email"
                value={
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span>{user?.email || <span className="text-muted-foreground italic text-xs">None on file</span>}</span>
                    {user?.email_verified
                      ? <span className="text-[10px] text-green-600 dark:text-green-400 font-semibold">✓ Verified</span>
                      : user?.email
                      ? <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">Unverified</span>
                      : null}
                  </span>
                }
              />
              <ReadonlyRow label="User ID" value={`#${user?.id ?? '—'}`} />
              <ReadonlyRow label="Member Since" value={formattedDate} />
            </div>

            {/* ── Security & Account Recovery ─────────────────────── */}
            <div className="space-y-3">
              <Label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <KeyRound className="w-3.5 h-3.5" />Security &amp; Account Recovery
              </Label>

              {/* Recovery ID display box */}
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider font-semibold">
                  Your Recovery ID
                </p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm tracking-widest flex-1 select-all text-foreground">
                    {rid ? ridDisplay : <span className="text-muted-foreground italic text-xs">Generating…</span>}
                  </span>
                  <div className="flex items-center gap-1">
                    {/* Toggle reveal */}
                    <button
                      type="button"
                      onClick={() => setRidRevealed(v => !v)}
                      disabled={!rid}
                      title={ridRevealed ? 'Hide Recovery ID' : 'Reveal full Recovery ID'}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                    >
                      {ridRevealed
                        ? <EyeOff className="w-3.5 h-3.5" />
                        : <Eye    className="w-3.5 h-3.5" />}
                    </button>
                    {/* Copy */}
                    <button
                      type="button"
                      onClick={handleCopyRid}
                      disabled={!rid}
                      title="Copy Recovery ID to clipboard"
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                    >
                      {ridCopied
                        ? <Check className="w-3.5 h-3.5 text-green-500" />
                        : <Copy  className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                {ridCopied && (
                  <p className="text-[10px] text-green-600 dark:text-green-400 mt-1.5">
                    ✓ Copied to clipboard
                  </p>
                )}
              </div>

              {/* Regenerate control */}
              {!ridRegenConfirm ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => { setRidRegenConfirm(true); setRidRegenStatus('idle'); }}
                  disabled={!rid}
                  className="gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate ID
                </Button>
              ) : (
                <div className="rounded-md border border-amber-300/70 bg-amber-50/80 dark:bg-amber-950/20 dark:border-amber-700/40 p-3 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      <strong>Warning:</strong> Regenerating will permanently invalidate your current
                      Recovery ID. Make sure to save the new one immediately.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleRegenerateRid}
                      disabled={ridRegenLoading}
                      className="gap-1.5"
                    >
                      {ridRegenLoading
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Regenerating…</>
                        : 'Yes, Regenerate'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setRidRegenConfirm(false)}
                      disabled={ridRegenLoading}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {ridRegenStatus !== 'idle' && (
                <StatusMsg ok={ridRegenStatus === 'success'} msg={ridRegenMsg} />
              )}

              {/* ── Legal / Liability Disclaimer ── */}
              <div className="rounded-md border border-amber-300/60 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-700/40 p-3 flex gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  <strong>Important:</strong> Your Unique Recovery ID is required to verify account
                  ownership if you lose access to your primary email address. Please store it in a
                  secure location. BDC Manager Desk is not responsible for lost, stolen, or
                  compromised recovery IDs or lost accounts.
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
