import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getMockAdminUsersPayload } from '@/lib/mock-admin-users';
import {
  Shield, Loader2, RefreshCw, Trash2, Check,
  UserCheck, UserX, StarOff, Star, AlertTriangle,
  KeyRound, Copy, Eye, EyeOff, Film, Save,
  Building2, ChevronDown, Users, User, Crown,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/* ── Types ──────────────────────────────────────────────────────── */

type AdminUser = {
  id: number;
  username: string;
  full_name: string;
  email: string;
  subscription_status: string;
  subscription_tier: string;
  is_admin: boolean;
  is_suspended: boolean;
  email_verified: boolean;
  created_at: string;
  recovery_id?: string;
  // Org hierarchy (populated via LEFT JOIN on organisations)
  org_id?: number | null;
  org_role?: string;          // 'admin' | 'member' | ''
  org_name?: string;
  org_max_seats?: number;
};

type RooftopGroup = { owner: AdminUser; members: AdminUser[] };

/* ── Status badge ───────────────────────────────────────────────── */

function StatusBadge({ u }: { u: AdminUser }) {
  if (u.is_admin) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
        <Shield className="w-2.5 h-2.5" /> Master Admin
      </span>
    );
  }
  if (u.is_suspended) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <AlertTriangle className="w-2.5 h-2.5" /> Suspended
      </span>
    );
  }
  if (u.subscription_status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <Star className="w-2.5 h-2.5" /> Pro
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
      Free Trial
    </span>
  );
}

/* ── Recovery ID cell ───────────────────────────────────────────── */

function RecoveryIdCell({ rid }: { rid?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied]     = useState(false);

  if (!rid) {
    return <span className="text-[10px] text-muted-foreground italic">None</span>;
  }

  const parts   = rid.split('-');
  const display = revealed || parts.length !== 4
    ? rid
    : `${parts[0]}-${parts[1]}-••••-••••`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground select-all">
        {display}
      </span>
      <button onClick={() => setRevealed(v => !v)} title={revealed ? 'Hide' : 'Reveal full ID'}
        className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
        {revealed ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
      <button onClick={copy} title="Copy Recovery ID"
        className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

/* ── Row action buttons (reused for every user row) ─────────────── */

type MutationLike<T = number> = { mutate: (id: T) => void; isPending: boolean };

function RowActions({
  u, busy,
  confirmDelete,   setConfirmDelete,
  confirmResetRid, setConfirmResetRid,
  togglePro, toggleSuspend, deleteUser, resetRecoveryId,
}: {
  u: AdminUser;
  busy: boolean;
  confirmDelete:       number | null;
  setConfirmDelete:    (id: number | null) => void;
  confirmResetRid:     number | null;
  setConfirmResetRid:  (id: number | null) => void;
  togglePro:       MutationLike;
  toggleSuspend:   MutationLike;
  deleteUser:      MutationLike;
  resetRecoveryId: MutationLike;
}) {
  if (u.is_admin) {
    return <span className="text-xs text-muted-foreground italic">Protected</span>;
  }

  /* Delete confirmation */
  if (confirmDelete === u.id) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-destructive font-semibold">Delete?</span>
        <button onClick={() => deleteUser.mutate(u.id)} disabled={deleteUser.isPending}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60 transition-colors">
          {deleteUser.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Confirm
        </button>
        <button onClick={() => setConfirmDelete(null)}
          className="px-2 py-1 rounded text-xs font-semibold bg-muted text-muted-foreground hover:bg-muted/70 transition-colors">
          Cancel
        </button>
      </div>
    );
  }

  /* Reset RID confirmation */
  if (confirmResetRid === u.id) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-amber-700 dark:text-amber-400 font-semibold">Reset RID?</span>
        <button onClick={() => resetRecoveryId.mutate(u.id)} disabled={resetRecoveryId.isPending}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60 transition-colors">
          {resetRecoveryId.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Confirm
        </button>
        <button onClick={() => setConfirmResetRid(null)}
          className="px-2 py-1 rounded text-xs font-semibold bg-muted text-muted-foreground hover:bg-muted/70 transition-colors">
          Cancel
        </button>
      </div>
    );
  }

  /* Normal actions */
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <button onClick={() => togglePro.mutate(u.id)} disabled={busy}
        title={u.subscription_status === 'active' ? 'Revoke Pro Access' : 'Grant Pro Access'}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50',
          u.subscription_status === 'active'
            ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-400'
            : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400',
        )}>
        {u.subscription_status === 'active'
          ? <><StarOff className="w-3 h-3" /> Revoke</>
          : <><Star    className="w-3 h-3" /> Grant Pro</>}
      </button>
      <button onClick={() => toggleSuspend.mutate(u.id)} disabled={busy}
        title={u.is_suspended ? 'Remove suspension' : 'Suspend account'}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-colors disabled:opacity-50',
          u.is_suspended
            ? 'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-400'
            : 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
        )}>
        {u.is_suspended
          ? <><UserCheck className="w-3 h-3" /> Unsuspend</>
          : <><UserX    className="w-3 h-3" /> Suspend</>}
      </button>
      <button onClick={() => setConfirmResetRid(u.id)} disabled={busy}
        title="Reset Recovery ID"
        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-400 transition-colors disabled:opacity-50">
        <KeyRound className="w-3 h-3" /> RID
      </button>
      <button onClick={() => setConfirmDelete(u.id)} disabled={busy}
        title="Delete account permanently"
        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 transition-colors disabled:opacity-50">
        <Trash2 className="w-3 h-3" /> Delete
      </button>
    </div>
  );
}

/* ── TikTok API credentials panel ───────────────────────────────── */

type TikTokConfigStatus = { configured: boolean; key_hint: string; source: string };

function TikTokConfigPanel({ authFetch }: { authFetch: ReturnType<typeof useAuth>['authFetch'] }) {
  const [ck,     setCk]     = useState('');
  const [cs,     setCs]     = useState('');
  const [showCs, setShowCs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState<{ ok: boolean; text: string } | null>(null);

  const { data: status, refetch: refetchStatus } = useQuery<TikTokConfigStatus>({
    queryKey: ['admin-tiktok-config'],
    queryFn:  async () => {
      const res = await authFetch('/api/admin/tiktok-config');
      if (!res.ok) throw new Error('Forbidden');
      return res.json();
    },
    staleTime: 0,
    gcTime:    0,
  });

  const save = async () => {
    if (!ck.trim() || !cs.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await authFetch('/api/admin/tiktok-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ client_key: ck.trim(), client_secret: cs.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Save failed');
      setMsg({ ok: true, text: `Saved — Key: ${d.key_hint} · Active immediately for all subscribers.` });
      setCk('');
      setCs('');
      await refetchStatus();
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#ff0050]/10 flex items-center justify-center flex-shrink-0">
            <Film className="w-4 h-4 text-[#ff0050]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">TikTok Integration</h2>
            <p className="text-xs text-muted-foreground">
              Global API credentials — active for all subscribers instantly on save
            </p>
          </div>
        </div>
        {status ? (
          <span className={cn(
            'text-[11px] font-semibold px-2.5 py-1 rounded-full border',
            status.configured
              ? 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800'
              : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800',
          )}>
            {status.configured
              ? `● Active · ${status.key_hint} · via ${status.source}`
              : '○ Not configured'}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">Loading…</span>
        )}
      </div>

      <div className="px-5 py-4 space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Client Key</label>
            <input
              type="text"
              value={ck}
              onChange={e => setCk(e.target.value)}
              placeholder={status?.configured ? '(leave blank to keep current)' : 'awma6z0gwjkfkeo2'}
              className="w-full px-3 py-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Client Secret</label>
            <div className="relative">
              <input
                type={showCs ? 'text' : 'password'}
                value={cs}
                onChange={e => setCs(e.target.value)}
                placeholder={status?.configured ? '(leave blank to keep current)' : '••••••••••••••••'}
                className="w-full px-3 py-2 pr-9 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowCs(v => !v)} tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                {showCs ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            Stored in the global database — no server restart required. Both fields must be filled to update.
          </p>
          <button onClick={save} disabled={saving || !ck.trim() || !cs.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Credentials
          </button>
        </div>
        {msg && (
          <div className={cn(
            'rounded-md px-3 py-2 text-xs flex items-start gap-1.5',
            msg.ok
              ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
              : 'bg-destructive/10 text-destructive',
          )}>
            {msg.ok
              ? <Check         className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
              : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />}
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function AdminPage() {
  const { authFetch, isMasterAdmin } = useAuth();
  const qc = useQueryClient();

  /* Accordion state: set of expanded owner user IDs */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  /* Inline confirmation state */
  const [confirmDelete,   setConfirmDelete]   = useState<number | null>(null);
  const [confirmResetRid, setConfirmResetRid] = useState<number | null>(null);
  const [resetRidResult,  setResetRidResult]  = useState<{ id: number; rid: string } | null>(null);

  /* Wrapper: also clears the "just-reset" display before opening a new RID confirm */
  const openResetRid = (id: number | null) => {
    if (id !== null) setResetRidResult(null);
    setConfirmResetRid(id);
  };

  /* ── Fetch all users (falls back to mock directory on static hosts) ── */
  const { data, isLoading, error, refetch, isFetching } = useQuery<{ users: AdminUser[] }>({
    queryKey: ['admin-users'],
    queryFn:  async () => {
      try {
        const res = await authFetch(`/api/admin/users?t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) {
          const payload = await res.json();
          if (Array.isArray(payload?.users) && payload.users.length > 0) {
            return payload;
          }
        }
      } catch {
        // API unreachable (Vercel static / client session) — use mock roster.
      }
      return getMockAdminUsersPayload() as { users: AdminUser[] };
    },
    enabled:   isMasterAdmin,
    staleTime: 0,
    gcTime:    0,
  });

  /* ── Mutations ── */
  const togglePro = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/admin/users/${id}/toggle-pro`, { method: 'PATCH' });
      if (!res.ok) throw new Error('Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const toggleSuspend = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/admin/users/${id}/toggle-suspend`, { method: 'PATCH' });
      if (!res.ok) throw new Error('Failed');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
    },
    onSuccess: () => {
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const resetRecoveryId = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/admin/users/${id}/recovery-id/reset`, { method: 'PATCH' });
      if (!res.ok) throw new Error('Failed');
      return res.json() as Promise<{ status: string; recovery_id: string }>;
    },
    onSuccess: (d, id) => {
      setConfirmResetRid(null);
      setResetRidResult({ id, rid: d.recovery_id });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setTimeout(() => setResetRidResult(r => (r?.id === id ? null : r)), 12_000);
    },
  });

  /* Guard */
  if (!isMasterAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive font-semibold">Access denied.</p>
      </div>
    );
  }

  /* ── Data prep ── */
  const users = data?.users ?? [];
  const busy  = togglePro.isPending || toggleSuspend.isPending ||
                deleteUser.isPending || resetRecoveryId.isPending;

  /* Separate into tiers */
  const masterAdmins    = users.filter(u =>  u.is_admin);
  const rooftopOwners   = users.filter(u => !u.is_admin && u.org_role === 'admin'  && u.org_id);
  const rooftopMembers  = users.filter(u => !u.is_admin && u.org_role === 'member' && u.org_id);
  const unaffiliated    = users.filter(u => !u.is_admin && !u.org_id);

  /* Build accordion groups: owner + their members */
  const rooftopGroups: RooftopGroup[] = rooftopOwners.map(owner => ({
    owner,
    members: rooftopMembers.filter(m => m.org_id === owner.org_id),
  }));

  /* Members with no matching owner row → show alongside personal */
  const matchedMemberIds = new Set(rooftopGroups.flatMap(g => g.members.map(m => m.id)));
  const orphanedMembers  = rooftopMembers.filter(m => !matchedMemberIds.has(m.id));
  const personalAccounts = [...unaffiliated, ...orphanedMembers];

  /* Stats */
  const totalPro  = users.filter(u => !u.is_admin && u.subscription_status === 'active').length;
  const totalSusp = users.filter(u => u.is_suspended).length;

  /* Shared action-props bundle passed to every RowActions */
  const actionProps = {
    busy,
    confirmDelete,   setConfirmDelete,
    confirmResetRid, setConfirmResetRid: openResetRid,
    togglePro, toggleSuspend, deleteUser, resetRecoveryId,
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold tracking-tight">Admin Console</h1>
            <p className="text-sm text-muted-foreground">User management — master admin only</p>
          </div>
          <span className="text-[10px] font-bold bg-red-500/15 text-red-500 border border-red-500/30 px-2 py-0.5 rounded-full ml-1">
            RESTRICTED
          </span>
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium border border-border hover:bg-muted transition-colors disabled:opacity-50">
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* ── TikTok panel ────────────────────────────────────────── */}
      <TikTokConfigPanel authFetch={authFetch} />

      {/* ── Stats ───────────────────────────────────────────────── */}
      {!isLoading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Accounts',  value: users.length,         color: 'text-foreground' },
            { label: 'Rooftop Orgs',    value: rooftopGroups.length, color: 'text-amber-600 dark:text-amber-400' },
            { label: 'Pro Subscribers', value: totalPro,             color: 'text-green-600 dark:text-green-400' },
            { label: 'Suspended',       value: totalSusp,            color: 'text-red-600 dark:text-red-400' },
          ].map(s => (
            <div key={s.label} className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={cn('text-2xl font-bold mt-0.5', s.color)}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Loading / error ──────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-7 h-7 animate-spin text-muted-foreground" />
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load users: {String(error)}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* ═══════════════════════════════════════════════════════════
              ROOFTOP ACCOUNTS — one accordion card per org
          ════════════════════════════════════════════════════════════ */}
          <div className="rounded-xl border overflow-hidden">

            {/* Section header */}
            <div className="px-4 py-2.5 bg-amber-50/70 dark:bg-amber-950/20 border-b flex items-center gap-2">
              <Building2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                Rooftop Accounts
              </span>
              <span className="ml-auto text-xs text-amber-600/70 dark:text-amber-400/60">
                {rooftopGroups.length} rooftop{rooftopGroups.length !== 1 ? 's' : ''}
                {' · '}
                {rooftopGroups.reduce((s, g) => s + g.members.length, 0)} member{rooftopGroups.reduce((s, g) => s + g.members.length, 0) !== 1 ? 's' : ''}
              </span>
            </div>

            {rooftopGroups.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                No rooftop accounts yet.
              </div>
            ) : (
              <div className="divide-y">
                {rooftopGroups.map(({ owner, members }) => {
                  const isOpen    = expanded.has(owner.id);
                  const seatUsed  = 1 + members.length;
                  const seatMax   = owner.org_max_seats ?? 10;
                  const justReset = resetRidResult?.id === owner.id;

                  return (
                    <div key={owner.id} className={cn(owner.is_suspended && 'bg-red-50/30 dark:bg-red-950/10')}>

                      {/* ── Rooftop Owner row ────────────────────────── */}
                      <div className="flex flex-col sm:flex-row sm:items-start gap-3 px-4 py-3">

                        {/* Clickable: icon + info + chevron (toggles accordion) */}
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleExpand(owner.id)}
                          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleExpand(owner.id)}
                          aria-expanded={isOpen}
                          className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer select-none"
                        >
                          {/* Building icon */}
                          <div className="w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Building2 className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-semibold truncate">
                                {owner.full_name || owner.username}
                              </span>
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 uppercase tracking-widest border border-amber-200 dark:border-amber-800/50 flex-shrink-0">
                                <Building2 className="w-2.5 h-2.5" /> Rooftop Account
                              </span>
                              <StatusBadge u={owner} />
                            </div>
                            <div className="flex items-center gap-x-2 text-[11px] text-muted-foreground flex-wrap mt-0.5">
                              <span>@{owner.username}</span>
                              {owner.org_name && (
                                <>
                                  <span className="text-muted-foreground/30">·</span>
                                  <span>{owner.org_name}</span>
                                </>
                              )}
                              <span className="text-muted-foreground/30">·</span>
                              <span>{seatUsed}/{seatMax} seats</span>
                              <span className="text-muted-foreground/30">·</span>
                              <span className="font-medium text-muted-foreground/80">
                                {members.length === 0
                                  ? 'No members'
                                  : `${members.length} member${members.length !== 1 ? 's' : ''}`}
                              </span>
                            </div>
                            {/* Recovery ID */}
                            <div className="flex items-center gap-1 mt-1">
                              <KeyRound className="w-2.5 h-2.5 text-muted-foreground/50" />
                              <RecoveryIdCell rid={justReset ? resetRidResult!.rid : owner.recovery_id} />
                            </div>
                          </div>

                          {/* Chevron */}
                          <ChevronDown className={cn(
                            'w-4 h-4 text-muted-foreground/60 flex-shrink-0 mt-1.5 transition-transform duration-200',
                            isOpen && 'rotate-180',
                          )} />
                        </div>

                        {/* Non-clickable: action buttons */}
                        <div className="sm:ml-0 ml-12 flex-shrink-0 sm:pt-1">
                          <RowActions u={owner} {...actionProps} />
                        </div>
                      </div>

                      {/* ── Expanded members panel ─────────────────── */}
                      {isOpen && (
                        <div className="border-t bg-muted/5">
                          {members.length === 0 ? (
                            <div className="flex items-center gap-2 px-14 py-3 text-xs text-muted-foreground/70 italic">
                              <Users className="w-3.5 h-3.5 flex-shrink-0" />
                              No members added to this rooftop yet.
                            </div>
                          ) : (
                            <div className="divide-y divide-muted/30">
                              {members.map(m => {
                                const mJustReset = resetRidResult?.id === m.id;
                                return (
                                  <div key={m.id}
                                    className={cn(
                                      'flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 px-4 py-2.5 pl-14',
                                      m.is_suspended && 'bg-red-50/30 dark:bg-red-950/10',
                                    )}
                                  >
                                    {/* Member info */}
                                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                                      <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold uppercase text-[10px] flex-shrink-0 mt-0.5">
                                        {(m.full_name || m.username)[0]}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="text-sm font-medium truncate">
                                            {m.full_name || m.username}
                                          </span>
                                          <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 uppercase tracking-widest border border-blue-100 dark:border-blue-800/40 flex-shrink-0">
                                            Member
                                          </span>
                                          <StatusBadge u={m} />
                                        </div>
                                        <div className="flex items-center gap-x-2 text-[11px] text-muted-foreground flex-wrap mt-0.5">
                                          <span>@{m.username}</span>
                                          {m.email && (
                                            <>
                                              <span className="text-muted-foreground/30">·</span>
                                              <span className="truncate">{m.email}</span>
                                            </>
                                          )}
                                          {!m.email_verified && m.email && (
                                            <span className="text-amber-600 font-medium text-[10px]">unverified</span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-1 mt-0.5">
                                          <KeyRound className="w-2.5 h-2.5 text-muted-foreground/50" />
                                          <RecoveryIdCell rid={mJustReset ? resetRidResult!.rid : m.recovery_id} />
                                        </div>
                                      </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex-shrink-0 sm:pt-0.5">
                                      <RowActions u={m} {...actionProps} />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}

                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ═══════════════════════════════════════════════════════════
              PERSONAL & MASTER ADMIN ACCOUNTS — flat list
          ════════════════════════════════════════════════════════════ */}
          {(personalAccounts.length > 0 || masterAdmins.length > 0) && (
            <div className="rounded-xl border overflow-hidden">

              {/* Section header */}
              <div className="px-4 py-2.5 bg-muted/30 border-b flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                  Personal &amp; Admin Accounts
                </span>
                <span className="ml-auto text-xs text-muted-foreground/60">
                  {personalAccounts.length + masterAdmins.length} account{personalAccounts.length + masterAdmins.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="divide-y">
                {[...masterAdmins, ...personalAccounts].map(u => {
                  const justReset = resetRidResult?.id === u.id;
                  return (
                    <div key={u.id}
                      className={cn(
                        'flex flex-col sm:flex-row sm:items-start gap-3 px-4 py-3',
                        u.is_suspended && 'bg-red-50/40 dark:bg-red-950/20',
                      )}
                    >
                      {/* Info */}
                      <div className="flex items-start gap-2.5 flex-1 min-w-0">
                        <div className={cn(
                          'w-8 h-8 rounded-full flex items-center justify-center font-bold uppercase text-sm flex-shrink-0 mt-0.5',
                          u.is_admin ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                        )}>
                          {(u.full_name || u.username)[0]}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium truncate">
                              {u.full_name || u.username}
                            </span>
                            {u.is_admin ? (
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-primary/10 text-primary uppercase tracking-widest border border-primary/20 flex-shrink-0">
                                <Crown className="w-2.5 h-2.5" /> Master Admin
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground uppercase tracking-widest border border-muted-foreground/20 flex-shrink-0">
                                <User className="w-2.5 h-2.5" /> Personal
                              </span>
                            )}
                            <StatusBadge u={u} />
                          </div>
                          <div className="flex items-center gap-x-2 text-[11px] text-muted-foreground flex-wrap mt-0.5">
                            <span>@{u.username}</span>
                            {u.email && (
                              <>
                                <span className="text-muted-foreground/30">·</span>
                                <span className="truncate">{u.email}</span>
                              </>
                            )}
                            {!u.email_verified && !u.is_admin && u.email && (
                              <span className="text-amber-600 font-medium text-[10px]">unverified</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <KeyRound className="w-2.5 h-2.5 text-muted-foreground/50" />
                            <RecoveryIdCell rid={justReset ? resetRidResult!.rid : u.recovery_id} />
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex-shrink-0 sm:pt-0.5">
                        <RowActions u={u} {...actionProps} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {users.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">No accounts found.</p>
          )}
        </>
      )}
    </div>
  );
}
