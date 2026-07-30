/**
 * Dealership Admin Console — Team & Seats management.
 *
 * Accessible to:
 *   • Org admins (org_role === 'admin')
 *   • Master admin (isMasterAdmin) in any impersonation view
 *   • Users whose effectiveOrgRole === 'admin' (rooftop_admin preview)
 *
 * Shows seat capacity, invite link, email invite, and the active member table.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import {
  Users, Check, X, Trash2, UserPlus, Eye, EyeOff,
  Building2, AlertCircle, Loader2, RefreshCw, ChevronRight, ChevronDown,
  Crown, Plus, CreditCard, KeyRound, User, UserCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

// ── Types ─────────────────────────────────────────────────────────────────────

type TeamMember = {
  id: number;
  username: string;
  full_name: string;
  job_title: string;
  email: string;
  org_role: 'admin' | 'member';
  subscription_status?: string;
  subscription_tier?: string;
  created_at: string;
};

type SubAccountEntry = {
  id: number;
  username: string;
  full_name: string;
  job_title: string;
  org_role: string;
  subscription_status?: string;
  subscription_tier?: string;
  created_at: string;
};

type AccountEntry = {
  id: number;
  username: string;
  full_name: string;
  email: string;
  account_type: 'rooftop' | 'personal';
  is_master_admin?: boolean;
  created_at: string;
  // Rooftop-specific
  org_id?: number;
  org_name?: string;
  seat_limit?: number;
  seat_used?: number;
  sub_accounts?: SubAccountEntry[];
};

type OrgInfo = {
  id: number;
  name: string;
  plan_tier: string;
  max_seats: number;
  invite_code: string;
};

type TeamData = {
  org: OrgInfo;
  seat_used: number;
  max_seats: number;
  invite_link: string;
  members: TeamMember[];
  accounts?: AccountEntry[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLAN_LABELS: Record<string, string> = {
  rooftop_monthly:  'Rooftop Monthly',
  rooftop_annual:   'Rooftop Annual',
  rooftop_lifetime: 'Rooftop Lifetime',
};

function fmtDate(iso: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

// ── Add Seats Modal ───────────────────────────────────────────────────────────

type AddSeatsInterval = 'monthly' | 'annual' | 'lifetime';

function AddSeatsModal({ authFetch, currentMax, onClose }: {
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  currentMax: number;
  onClose: () => void;
}) {
  const PRESETS = [1, 5, 10];
  const [preset, setPreset]         = useState<number>(1);
  const [customVal, setCustomVal]   = useState('');
  const [useCustom, setUseCustom]   = useState(false);
  const [interval, setInterval_]    = useState<AddSeatsInterval>('monthly');
  const [loading, setLoading]       = useState(false);
  const [err, setErr]               = useState('');

  const seats = useCustom ? (parseInt(customVal) || 0) : preset;
  const isBundle5 = interval === 'lifetime' && seats === 5;

  const price = (() => {
    if (seats < 1) return { main: '—', note: '' };
    if (interval === 'monthly')  return { main: `$${seats * 39}/mo`,   note: `$39 × ${seats} seat${seats > 1 ? 's' : ''} · billed monthly` };
    if (interval === 'annual')   return { main: `$${(seats * 390).toLocaleString()}/yr`, note: `$390/seat/yr · $32.50/mo equivalent` };
    if (isBundle5)               return { main: '$4,495 one-time',       note: '5-seat lifetime bundle — save $480 vs individual' };
    return { main: `$${(seats * 995).toLocaleString()} one-time`, note: `$995/seat · pay once, never renews` };
  })();

  const handleUpgrade = async () => {
    if (seats < 1)   { setErr('Select at least 1 seat.'); return; }
    if (seats > 100) { setErr('Maximum 100 seats per order.'); return; }
    setErr(''); setLoading(true);
    try {
      const origin = window.location.origin;
      const base   = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res    = await authFetch('/api/team/add-seats-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seats, interval, origin, base_url: base }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create checkout session');
      window.location.href = data.url;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Plus className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-bold">Add More Seats</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Currently {currentMax} seats total</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">

          {/* Seat count */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Seats to Add</p>
            <div className="flex gap-2">
              {PRESETS.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setPreset(n); setUseCustom(false); }}
                  className={cn(
                    'flex-1 py-2.5 rounded-lg border text-sm font-bold transition-all',
                    !useCustom && preset === n
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                      : 'border-border hover:border-primary/50 hover:bg-muted/40',
                  )}
                >
                  +{n}
                </button>
              ))}
              <input
                type="number"
                min="1"
                max="100"
                placeholder="Custom"
                value={customVal}
                onFocus={() => setUseCustom(true)}
                onChange={(e) => { setCustomVal(e.target.value); setUseCustom(true); }}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2.5 text-sm font-bold text-center bg-background transition-all',
                  useCustom ? 'border-primary ring-1 ring-primary/30' : 'border-border hover:border-primary/50',
                )}
              />
            </div>
            {seats > 0 && (
              <p className="text-xs text-muted-foreground">
                New total: <strong className="text-foreground">{currentMax + seats} seats</strong>
              </p>
            )}
          </div>

          {/* Billing interval */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Billing Interval</p>
            <div className="flex rounded-xl border border-border bg-muted/40 p-1 gap-1">
              {(
                [
                  { key: 'monthly',  label: 'Monthly',  sub: '$39/seat' },
                  { key: 'annual',   label: 'Yearly',   sub: '$390/seat' },
                  { key: 'lifetime', label: 'Lifetime', sub: '$995/seat' },
                ] as { key: AddSeatsInterval; label: string; sub: string }[]
              ).map(({ key, label, sub }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setInterval_(key)}
                  className={cn(
                    'flex-1 flex flex-col items-center px-2 py-2 rounded-lg text-xs font-semibold transition-all',
                    interval === key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span>{label}</span>
                  <span className="text-[10px] font-normal mt-0.5 text-muted-foreground/70">{sub}</span>
                </button>
              ))}
            </div>

            {isBundle5 && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 font-semibold">
                🏆 5-Seat Lifetime Bundle — $4,495 (save $480 vs individual pricing)
              </div>
            )}
          </div>

          {/* Price breakdown */}
          <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {seats} seat{seats !== 1 ? 's' : ''} ×{' '}
                {interval === 'lifetime' ? (isBundle5 ? '$4,495 bundle' : '$995 one-time') : interval === 'annual' ? '$390/yr' : '$39/mo'}
              </span>
              <span className="text-sm font-bold text-primary">{price.main}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{price.note}</p>
          </div>

          {err && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{err}</p>
          )}

          <Button className="w-full gap-2 font-semibold" onClick={handleUpgrade} disabled={loading || seats < 1}>
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Redirecting to Stripe…</>
            ) : (
              <><CreditCard className="w-4 h-4" /> Upgrade &amp; Expand Team</>
            )}
          </Button>
          <p className="text-[11px] text-center text-muted-foreground -mt-3">
            Secured by Stripe · All seat purchases are final &amp; non-refundable
          </p>

        </div>
      </div>
    </div>
  );
}

// ── Admin Overview: Hierarchical Accounts View ────────────────────────────────

function AdminAccountsView({
  accounts,
  authFetch,
  onRefresh,
}: {
  accounts: AccountEntry[];
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onRefresh: () => void;
}) {
  // Accordion open/close per org
  const [expanded, setExpanded]     = useState<Record<number, boolean>>({});
  const toggle = (key: number) =>
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  // Remove confirmation
  const [confirmRemove, setConfirmRemove] = useState<{ id: number; username: string } | null>(null);
  const [removing, setRemoving]           = useState<number | null>(null);

  // Reset password
  const [resetTarget, setResetTarget] = useState<{ id: number; username: string } | null>(null);
  const [newPw, setNewPw]             = useState('');
  const [showPw, setShowPw]           = useState(false);
  const [resetting, setResetting]     = useState(false);
  const [pwErr, setPwErr]             = useState('');

  const handleRemove = async () => {
    if (!confirmRemove) return;
    const { id } = confirmRemove;
    setRemoving(id);
    setConfirmRemove(null);
    try {
      const res = await authFetch('/api/team/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: id }),
      });
      if (res.ok) onRefresh();
    } finally {
      setRemoving(null);
    }
  };

  const handleResetPw = async () => {
    if (!resetTarget) return;
    if (newPw.trim().length < 6) { setPwErr('Password must be at least 6 characters.'); return; }
    setPwErr('');
    setResetting(true);
    try {
      const res = await authFetch('/api/team/reset-member-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: resetTarget.id, new_password: newPw.trim() }),
      });
      if (res.ok) {
        setResetTarget(null);
        setNewPw('');
      } else {
        const d = await res.json().catch(() => ({})) as Record<string, string>;
        setPwErr(d.message || d.error || 'Reset failed.');
      }
    } finally {
      setResetting(false);
    }
  };

  const openReset = (sub: SubAccountEntry) => {
    setResetTarget({ id: sub.id, username: sub.username });
    setNewPw('');
    setPwErr('');
    setShowPw(false);
  };

  const rooftops = accounts.filter(a => a.account_type === 'rooftop');
  const personal = accounts.filter(a => a.account_type === 'personal');

  return (
    <>
      <div className="rounded-xl border overflow-hidden">

        {/* ─── Header ────────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">All Accounts</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {rooftops.length} rooftop{rooftops.length !== 1 ? 's' : ''}
            {personal.length > 0 && ` · ${personal.length} personal`}
          </span>
        </div>

        {/* ─── Rooftop accounts ──────────────────────────────────────────── */}
        {rooftops.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-amber-50/70 dark:bg-amber-950/20 border-b flex items-center gap-1.5">
              <Building2 className="w-3 h-3 text-amber-600 dark:text-amber-400" />
              <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                Rooftop Accounts
              </span>
            </div>

            <div className="divide-y">
              {rooftops.map(acct => {
                const expandKey = acct.org_id ?? acct.id;
                const isOpen    = expanded[expandKey] ?? false;
                const subs      = acct.sub_accounts ?? [];
                const subCount  = subs.length;

                return (
                  <div key={acct.id}>

                    {/* ── Rooftop Owner row ── */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggle(expandKey)}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggle(expandKey)}
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors select-none"
                      aria-expanded={isOpen}
                    >
                      {/* Org avatar */}
                      <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center flex-shrink-0">
                        <Building2 className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate">
                            {acct.full_name || acct.username}
                          </span>
                          {/* ROOFTOP OWNER badge */}
                          <span className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 flex-shrink-0 uppercase tracking-widest border border-amber-200 dark:border-amber-800/50">
                            <Building2 className="w-2.5 h-2.5" />
                            Rooftop Owner
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-muted-foreground">
                          <span>@{acct.username}</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span>{acct.org_name}</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span>{acct.seat_used ?? 1}/{acct.seat_limit ?? 10} seats</span>
                          <span className="text-muted-foreground/40">·</span>
                          <span>
                            {subCount === 0
                              ? 'No employees'
                              : `${subCount} employee${subCount !== 1 ? 's' : ''}`}
                          </span>
                        </div>
                      </div>

                      {/* Expand chevron */}
                      <div className={cn(
                        'flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-colors',
                        isOpen
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground/60 hover:text-muted-foreground',
                      )}>
                        <ChevronDown className={cn(
                          'w-4 h-4 transition-transform duration-200',
                          isOpen && 'rotate-180',
                        )} />
                      </div>
                    </div>

                    {/* ── Expanded sub-panel ── */}
                    {isOpen && (
                      <div className="border-t bg-muted/10">
                        {subCount === 0 ? (
                          <div className="flex items-center gap-2 px-10 py-4 text-xs text-muted-foreground/70 italic">
                            <Users className="w-3.5 h-3.5 flex-shrink-0" />
                            No employee accounts have been added to this rooftop yet.
                          </div>
                        ) : (
                          <>
                            {/* Column headers */}
                            <div className="hidden sm:grid grid-cols-[1fr_90px_110px_170px] gap-3 px-10 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider bg-muted/20 border-b border-muted/40">
                              <span>Employee</span>
                              <span>Status</span>
                              <span>Joined</span>
                              <span className="text-right">Actions</span>
                            </div>

                            {/* Rooftop Member rows */}
                            <div className="divide-y divide-muted/40">
                              {subs.map(sub => {
                                const isRemoving = removing === sub.id;
                                return (
                                  <div
                                    key={sub.id}
                                    className="grid grid-cols-1 sm:grid-cols-[1fr_90px_110px_170px] gap-2 sm:gap-3 px-10 py-2.5 items-center hover:bg-muted/20 transition-colors"
                                  >
                                    {/* Employee + ROOFTOP MEMBER badge */}
                                    <div className="flex items-center gap-2.5 min-w-0">
                                      <div className="w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold uppercase text-[10px] flex-shrink-0">
                                        {(sub.full_name || sub.username)[0]}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="text-sm font-medium truncate">
                                            {sub.full_name || sub.username}
                                          </span>
                                          <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex-shrink-0 uppercase tracking-widest border border-blue-100 dark:border-blue-800/40">
                                            <UserCheck className="w-2.5 h-2.5" />
                                            Rooftop Member
                                          </span>
                                        </div>
                                        <span className="text-[11px] text-muted-foreground font-mono truncate block">
                                          @{sub.username}
                                        </span>
                                      </div>
                                    </div>

                                    {/* Status */}
                                    <div className="hidden sm:block">
                                      {sub.subscription_status === 'active' ? (
                                        <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                                          <Check className="w-2.5 h-2.5" />Pro
                                        </span>
                                      ) : (
                                        <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                          Inactive
                                        </span>
                                      )}
                                    </div>

                                    {/* Joined */}
                                    <span className="text-[11px] text-muted-foreground hidden sm:block">
                                      {fmtDate(sub.created_at)}
                                    </span>

                                    {/* Actions */}
                                    <div className="hidden sm:flex items-center justify-end gap-1">
                                      <button
                                        onClick={() => openReset(sub)}
                                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded hover:bg-primary/10"
                                        title="Reset password"
                                      >
                                        <KeyRound className="w-3.5 h-3.5" />
                                        <span>Reset PW</span>
                                      </button>
                                      <button
                                        onClick={() => setConfirmRemove({ id: sub.id, username: sub.username })}
                                        disabled={isRemoving}
                                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded hover:bg-destructive/10 disabled:opacity-40"
                                        title="Remove from rooftop"
                                      >
                                        {isRemoving
                                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          : <Trash2 className="w-3.5 h-3.5" />}
                                        <span>{isRemoving ? 'Removing…' : 'Remove'}</span>
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ─── Personal accounts ─────────────────────────────────────────── */}
        {personal.length > 0 && (
          <>
            <div className={cn(
              'px-4 py-1.5 bg-muted/20 flex items-center gap-1.5',
              rooftops.length > 0 && 'border-t',
            )}>
              <User className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                Personal Accounts
              </span>
            </div>

            <div className="divide-y">
              {personal.map(acct => (
                <div
                  key={acct.id}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted/10 transition-colors"
                >
                  <div className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center font-bold uppercase text-sm flex-shrink-0',
                    acct.is_master_admin ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                  )}>
                    {(acct.full_name || acct.username)[0]}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">
                        {acct.full_name || acct.username}
                      </span>
                      {/* PERSONAL ACCOUNT badge */}
                      <span className={cn(
                        'inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full flex-shrink-0 uppercase tracking-widest border',
                        acct.is_master_admin
                          ? 'bg-primary/10 text-primary border-primary/20'
                          : 'bg-muted text-muted-foreground border-muted-foreground/20',
                      )}>
                        {acct.is_master_admin
                          ? <><Crown className="w-2.5 h-2.5" />Master Admin</>
                          : <><User className="w-2.5 h-2.5" />Personal Account</>
                        }
                      </span>
                    </div>
                    <span className="text-[11px] text-muted-foreground">@{acct.username}</span>
                  </div>

                  <span className="text-xs text-muted-foreground hidden sm:block flex-shrink-0">
                    {fmtDate(acct.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {accounts.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No accounts registered yet.</p>
          </div>
        )}
      </div>

      {/* ── Remove confirmation ──────────────────────────────────────────── */}
      <AlertDialog open={!!confirmRemove} onOpenChange={() => setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove @{confirmRemove?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will unlink the account from the rooftop and mark their subscription inactive.
              The username remains reserved — they cannot be re-added under that username.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Reset password dialog ────────────────────────────────────────── */}
      <Dialog
        open={!!resetTarget}
        onOpenChange={open => { if (!open) { setResetTarget(null); setNewPw(''); setPwErr(''); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password — @{resetTarget?.username}</DialogTitle>
            <DialogDescription>Enter a new password for this team member.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                placeholder="New password (min 6 characters)"
                value={newPw}
                onChange={e => { setNewPw(e.target.value); setPwErr(''); }}
                className="pr-10"
                disabled={resetting}
              />
              <button
                type="button"
                onClick={() => setShowPw(p => !p)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {pwErr && <p className="text-xs text-destructive">{pwErr}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setResetTarget(null); setNewPw(''); setPwErr(''); }}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button onClick={handleResetPw} disabled={resetting || newPw.trim().length < 6}>
              {resetting
                ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Resetting…</>
                : 'Reset Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Add Member Modal ──────────────────────────────────────────────────────────

const JOB_ROLES = [
  'BDC Agent',
  'Sales Rep',
  'Finance Manager',
  'Sales Manager',
  'Service Advisor',
  'Internet Coordinator',
  'Other',
] as const;

function AddMemberModal({
  authFetch, onClose, onCreated,
}: {
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onCreated: (member: TeamMember) => void;
}) {
  const [fullName,   setFullName]   = useState('');
  const [username,   setUsername]   = useState('');
  const [password,   setPassword]   = useState('');
  const [showPw,     setShowPw]     = useState(false);
  const [jobTitle,   setJobTitle]   = useState<string>(JOB_ROLES[0]);
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState('');
  const [fieldErr,   setFieldErr]   = useState<{ username?: string }>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setFieldErr({});

    if (!username.trim()) { setFieldErr({ username: 'Username is required.' }); return; }
    if (username.trim().length < 3) { setFieldErr({ username: 'Must be at least 3 characters.' }); return; }
    if (!password)        { setErr('Password is required.'); return; }
    if (password.length < 6) { setErr('Password must be at least 6 characters.'); return; }

    setSubmitting(true);
    try {
      const res  = await authFetch('/api/team/create-member', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username:   username.trim().toLowerCase(),
          password,
          full_name:  fullName.trim(),
          job_title:  jobTitle,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.error === 'username_taken') {
          setFieldErr({ username: 'That username is already taken.' });
        } else {
          setErr(json.message || json.error || 'Failed to create member.');
        }
        return;
      }
      onCreated(json.member as TeamMember);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-primary" />
            Add Team Member
          </DialogTitle>
          <DialogDescription>
            Create an account and assign it to an open seat. Hand the credentials
            directly to your rep — no invite email needed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-1">

          {/* Full Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Full Name</label>
            <Input
              placeholder="e.g. Jordan Smith"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Username */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Username <span className="text-destructive">*</span>
            </label>
            <Input
              placeholder="e.g. jsmith"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setFieldErr({}); }}
              disabled={submitting}
              className={cn(fieldErr.username && 'border-destructive focus-visible:ring-destructive')}
              autoComplete="off"
            />
            {fieldErr.username && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {fieldErr.username}
              </p>
            )}
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Temporary Password <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Input
                type={showPw ? 'text' : 'password'}
                placeholder="Min. 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="pr-9"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPw
                  ? <EyeOff className="w-4 h-4" />
                  : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Job Role */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Role</label>
            <select
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              {JOB_ROLES.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {err}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="gap-1.5">
              {submitting
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>
                : <><Check className="w-3.5 h-3.5" /> Create Account</>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Remove Member Confirmation Dialog ────────────────────────────────────────

function RemoveMemberDialog({
  username, open, removing, onConfirm, onCancel,
}: {
  username: string;
  open: boolean;
  removing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-destructive" />
            Remove from seat?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Are you sure you want to remove{' '}
                <span className="font-semibold text-foreground">{username || 'this user'}</span>{' '}
                from their assigned seat?
              </p>
              <p className="text-xs">
                Their Pro access will be revoked immediately and the licence slot will be freed.
                Account data (inventory, leads) is preserved — they can be re-added at any time.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={removing}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {removing ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Removing…
              </span>
            ) : 'Yes, remove seat'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Reset Password Modal ──────────────────────────────────────────────────────

function ResetPasswordModal({
  member, authFetch, onClose,
}: {
  member: TeamMember;
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  onClose: () => void;
}) {
  const [password,   setPassword]   = useState('');
  const [showPw,     setShowPw]     = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState('');
  const [done,       setDone]       = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!password)           { setErr('Password is required.'); return; }
    if (password.length < 6) { setErr('Password must be at least 6 characters.'); return; }
    setSubmitting(true);
    try {
      const res  = await authFetch('/api/team/reset-member-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: member.id, new_password: password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to reset password.');
      setDone(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" />
            Reset Password
          </DialogTitle>
          <DialogDescription>
            Set a new password for{' '}
            <span className="font-semibold text-foreground">
              {member.full_name || member.username}
            </span>{' '}
            (@{member.username}). Hand the new credentials directly to the rep.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="py-4 flex flex-col items-center gap-3 text-center">
            <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-semibold">Password updated successfully.</p>
            <p className="text-xs text-muted-foreground">
              The rep can now log in with the new password.
            </p>
            <Button className="w-full mt-1" onClick={onClose}>Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                New Password <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <Input
                  type={showPw ? 'text' : 'password'}
                  placeholder="Min. 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="pr-9"
                  autoComplete="new-password"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {err && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {err}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} className="gap-1.5">
                {submitting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                  : <><KeyRound className="w-3.5 h-3.5" /> Set Password</>}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const { user, authFetch, isMasterAdmin, effectiveIsMasterAdmin, effectiveOrgRole } = useAuth();

  const [data, setData]         = useState<TeamData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Add Member modal
  const [showAddMember, setShowAddMember] = useState(false);

  // Add Seats modal + Stripe return success/cancel banners
  const [showAddSeats, setShowAddSeats] = useState(false);
  const [seatSuccess, setSeatSuccess]   = useState(false);
  const [seatCanceled, setSeatCanceled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('seats_added') === '1') {
      setSeatSuccess(true);
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => setSeatSuccess(false), 8000);
    }
    if (params.get('seats_canceled') === '1') {
      setSeatCanceled(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Remove member confirmation
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [removing, setRemoving]           = useState<number | null>(null);

  // Reset password
  const [resetPasswordMember, setResetPasswordMember] = useState<TeamMember | null>(null);

  // ── Access check ──────────────────────────────────────────────────────────
  // Master admin always has access regardless of impersonation view.
  // Rooftop admin preview (effectiveOrgRole === 'admin') also gets access.
  const hasAccess = isMasterAdmin || effectiveOrgRole === 'admin';

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchTeam = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      const res = await authFetch('/api/team');
      if (res.status === 403) {
        setError('Access restricted to Dealership Admins.');
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load team data');
      setData(json as TeamData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authFetch]);

  useEffect(() => { fetchTeam(); }, [fetchTeam]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleRemove = async (memberId: number) => {
    setRemoving(memberId);
    setConfirmRemove(null);
    try {
      const res  = await authFetch('/api/team/remove-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: memberId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to remove member');
      // Optimistic update
      setData(prev => prev
        ? { ...prev, members: prev.members.filter(m => m.id !== memberId), seat_used: prev.seat_used - 1 }
        : prev
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to remove member.');
    } finally {
      setRemoving(null);
    }
  };

  // ── Guard: block non-admin, non-master users ──────────────────────────────
  // Evaluated after hook calls (rules of hooks require unconditional calls above).
  if (user && !hasAccess) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center space-y-3">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
          <Users className="w-6 h-6 text-muted-foreground" />
        </div>
        <h1 className="text-lg font-semibold">Team &amp; Seats</h1>
        <p className="text-sm text-muted-foreground">
          This page is only accessible to Dealership Admins on a Rooftop plan.
        </p>
        <a href="/pricing" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline underline-offset-2 mt-2">
          View plans <ChevronRight className="w-3.5 h-3.5" />
        </a>
      </div>
    );
  }

  // ── Loading / error ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-16 px-4 flex items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading team data…</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center space-y-3">
        <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => fetchTeam()}>Try again</Button>
      </div>
    );
  }

  if (!data) return null;

  const { org, seat_used, max_seats, invite_link, members } = data;
  const seatPct = Math.min(100, Math.round((seat_used / max_seats) * 100));
  const seatFull = seat_used >= max_seats;
  // effectiveIsMasterAdmin is false when master admin previews "Rooftop Admin" view,
  // so the full management UI (Add Member, Remove buttons) renders in that mode.
  const isDemoView = effectiveIsMasterAdmin && org.id === 0;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">

      {/* ── Master admin demo banner ─────────────────────────────────── */}
      {isDemoView && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
          <Crown className="w-4 h-4 flex-shrink-0" />
          <span>
            <strong>Master Admin view</strong> — showing all registered accounts as demo seats.
            Rooftop customers see only their own team members.
          </span>
        </div>
      )}

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-xl font-display font-bold tracking-tight">{org.name}</h1>
            <span className="text-[11px] font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded-full">
              {PLAN_LABELS[org.plan_tier] ?? org.plan_tier}
            </span>
          </div>
          <p className="text-sm text-muted-foreground pl-10">
            Dealership Admin Console
          </p>
        </div>
        <button
          onClick={() => fetchTeam(true)}
          disabled={refreshing}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError('')} className="ml-auto"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* ── Seat Usage Tracker ──────────────────────────────────────── */}

      {/* Stripe return: seats added successfully */}
      {seatSuccess && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-green-500/30 bg-green-500/8 text-green-700 dark:text-green-400">
          <Check className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm font-semibold">Seats added — your team capacity has been expanded!</span>
          <button onClick={() => setSeatSuccess(false)} className="ml-auto opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Stripe return: seat upgrade canceled */}
      {seatCanceled && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm font-semibold">Seat upgrade was not completed — your plan is unchanged. You can try again any time.</span>
          <button onClick={() => setSeatCanceled(false)} className="ml-auto opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!isDemoView && (
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Seat Usage</span>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn(
              'text-sm font-bold',
              seatFull ? 'text-destructive' : 'text-foreground',
            )}>
              {seat_used} of {max_seats} Seats Used
            </span>
            {!isDemoView && (
              <Button
                size="sm"
                onClick={() => setShowAddSeats(true)}
                className="gap-1.5 h-8 text-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                Add More Seats
              </Button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              seatFull ? 'bg-destructive' : seatPct >= 80 ? 'bg-amber-500' : 'bg-primary',
            )}
            style={{ width: `${seatPct}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{max_seats - seat_used} seat{max_seats - seat_used !== 1 ? 's' : ''} remaining</span>
          {seatFull ? (
            <span className="text-destructive font-medium flex items-center gap-1">
              All seats in use —{' '}
              {!isDemoView && (
                <button
                  onClick={() => setShowAddSeats(true)}
                  className="underline underline-offset-2 hover:text-destructive/80"
                >
                  add more seats
                </button>
              )}
              {isDemoView && 'add more or remove a member'}
            </span>
          ) : seatPct >= 80 ? (
            <span className="text-amber-500 font-medium">Running low — consider adding seats</span>
          ) : null}
        </div>
      </div>
      )}

      {/* ── Add Team Member ──────────────────────────────────────────── */}
      {!isDemoView && (
        <div className="rounded-xl border bg-card p-5 flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">Add a team member</p>
            <p className="text-xs text-muted-foreground">
              Create an account instantly — credentials are ready to hand off.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowAddMember(true)}
            disabled={seatFull}
            className="flex-shrink-0 gap-1.5"
            title={seatFull ? 'All seats in use — add more seats first' : ''}
          >
            <UserPlus className="w-3.5 h-3.5" />
            Add Member
          </Button>
        </div>
      )}

      {/* ── Active seats / account overview ─────────────────────────── */}
      {isDemoView && data?.accounts && (
        <AdminAccountsView
          accounts={data.accounts}
          authFetch={authFetch}
          onRefresh={() => fetchTeam(true)}
        />
      )}
      {!isDemoView && (
      <div className="rounded-xl border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Active Seats</h2>
          <span className="ml-auto text-xs text-muted-foreground">{members.length} member{members.length !== 1 ? 's' : ''}</span>
        </div>

        {members.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <Users className="w-7 h-7 text-muted-foreground/30 mx-auto" />
            <p className="text-sm text-muted-foreground">No team members yet.</p>
            <p className="text-xs text-muted-foreground/70">Use the Add Member button above to create accounts.</p>
          </div>
        ) : (
          <div className="divide-y">
            {/* Header row */}
            <div className="hidden sm:grid grid-cols-[1.5fr_1fr_90px_110px_160px] gap-3 px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide bg-muted/20">
              <span>Member</span>
              <span>Role</span>
              <span>Access</span>
              <span>Joined</span>
              <span className="text-right">Actions</span>
            </div>

            {members.map((m) => {
              const isCurrentUser = m.id === user?.id;
              const isRemoving    = removing === m.id;

              return (
                <div
                  key={m.id}
                  className="grid grid-cols-1 sm:grid-cols-[1.5fr_1fr_90px_110px_160px] gap-2 sm:gap-3 px-4 py-3 items-center hover:bg-muted/20 transition-colors"
                >
                  {/* Name + username + avatar */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold uppercase text-xs flex-shrink-0">
                      {(m.full_name || m.username)[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">
                          {m.full_name || m.username}
                        </span>
                        {isCurrentUser && (
                          <span className="text-[10px] font-semibold bg-muted text-muted-foreground px-1.5 py-0.5 rounded flex-shrink-0">You</span>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground truncate block">
                        @{m.username}
                      </span>
                    </div>
                  </div>

                  {/* Job title */}
                  <span className="text-xs text-muted-foreground truncate sm:block hidden">
                    {m.job_title || '—'}
                  </span>

                  {/* Org role + Pro badge */}
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className={cn(
                      'text-[11px] font-semibold px-2 py-0.5 rounded-full',
                      m.org_role === 'admin'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}>
                      {m.org_role === 'admin' ? 'Admin' : 'Member'}
                    </span>
                    {m.subscription_status === 'active' && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                        <Check className="w-2.5 h-2.5" />Pro
                      </span>
                    )}
                  </div>

                  {/* Joined */}
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {fmtDate(m.created_at)}
                  </span>

                  {/* Actions — disabled for self and in master admin demo view */}
                  <div className="flex items-center justify-end gap-1">
                    {isCurrentUser || isDemoView ? (
                      <span className="text-xs text-muted-foreground/50 italic">—</span>
                    ) : (
                      <>
                        <button
                          onClick={() => setResetPasswordMember(m)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded hover:bg-primary/10"
                          title="Reset password"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Reset PW</span>
                        </button>
                        <button
                          onClick={() => setConfirmRemove(m.id)}
                          disabled={isRemoving}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded hover:bg-destructive/10 disabled:opacity-40"
                          title="Remove from seat"
                        >
                          {isRemoving
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />}
                          <span className="hidden sm:inline">{isRemoving ? 'Removing…' : 'Remove'}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* ── Remove Member Confirmation Dialog ───────────────────────── */}
      <RemoveMemberDialog
        username={data?.members.find(m => m.id === confirmRemove)?.username ?? ''}
        open={confirmRemove !== null}
        removing={removing !== null}
        onConfirm={() => { if (confirmRemove !== null) handleRemove(confirmRemove); }}
        onCancel={() => setConfirmRemove(null)}
      />

      {/* ── Reset Password Modal ─────────────────────────────────────── */}
      {resetPasswordMember && (
        <ResetPasswordModal
          member={resetPasswordMember}
          authFetch={authFetch}
          onClose={() => setResetPasswordMember(null)}
        />
      )}

      {/* ── Add Member Modal ─────────────────────────────────────────── */}
      {showAddMember && (
        <AddMemberModal
          authFetch={authFetch}
          onClose={() => setShowAddMember(false)}
          onCreated={(member) => {
            setData(prev => prev
              ? { ...prev, members: [...prev.members, member], seat_used: prev.seat_used + 1 }
              : prev
            );
          }}
        />
      )}

      {/* ── Add Seats Modal ─────────────────────────────────────────── */}
      {showAddSeats && (
        <AddSeatsModal
          authFetch={authFetch}
          currentMax={max_seats}
          onClose={() => setShowAddSeats(false)}
        />
      )}

      {/* ── Footer note ──────────────────────────────────────────────── */}
      <p className="text-xs text-center text-muted-foreground leading-relaxed">
        {isDemoView
          ? 'Demo view — all registered accounts are shown. Real rooftop customers only see members within their own organization.'
          : 'Removing a seat immediately revokes the rep\'s Pro access and frees one licence slot. The rep\'s account data (inventory, leads) is preserved but they will be locked out until re-added or they subscribe independently.'}
      </p>
    </div>
  );
}
