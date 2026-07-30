import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  Gift, Copy, Check, Mail, MessageSquare,
  Users, DollarSign, TrendingUp, Receipt, BadgeCheck, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Referral = {
  id: number;
  referred_username: string;
  status: 'pending' | 'converted';
  credit_amount: number;
  created_at: string;
};

type BillingEvent = {
  event_type: string;
  stripe_invoice_id: string;
  amount_cents: number;
  credit_applied_cents: number;
  description: string;
  created_at: string;
};

type ReferralData = {
  referral_code: string;
  referral_link: string;
  account_credit: number;
  referrals: Referral[];
  billing_events: BillingEvent[];
};

export default function ReferralsPage() {
  const { authFetch } = useAuth();
  const [linkCopied, setLinkCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  const { data, isLoading } = useQuery<ReferralData>({
    queryKey: ['referrals'],
    queryFn: async () => {
      const res = await authFetch('/api/v1/referrals');
      if (!res.ok) throw new Error('Failed to load referral data');
      return res.json();
    },
  });

  const copyLink = useCallback(async () => {
    if (!data?.referral_link) return;
    await navigator.clipboard.writeText(data.referral_link);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2500);
  }, [data?.referral_link]);

  const copyCode = useCallback(async () => {
    if (!data?.referral_code) return;
    await navigator.clipboard.writeText(data.referral_code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2500);
  }, [data?.referral_code]);

  const totalCredit = data?.account_credit ?? 0;
  const activeCount    = data?.referrals.filter(r => r.status === 'pending').length   ?? 0;
  const convertedCount = data?.referrals.filter(r => r.status === 'converted').length ?? 0;

  const encodedLink = encodeURIComponent(data?.referral_link ?? '');
  const emailBody   = encodeURIComponent(
    `Hi!\n\nI use BDC Manager Desk to automate my BDC workflow at the dealership — it's been a huge time-saver.\n\nSign up using my referral link and get started with a free trial:\n${data?.referral_link ?? ''}`
  );
  const smsBody = encodeURIComponent(
    `Hey! Check out BDC Manager Desk — great tool for dealership BDC work. Sign up here: ${data?.referral_link ?? ''}`
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Gift className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Refer &amp; Earn</h1>
          <p className="text-sm text-muted-foreground">Earn $25 for every Pro subscriber you refer</p>
        </div>
      </div>

      {/* ── Stats Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: 'Total Credits Earned',
            value: `$${totalCredit.toFixed(2)}`,
            icon: DollarSign,
            color: 'text-green-600 dark:text-green-400',
          },
          {
            label: 'Active Referrals',
            value: activeCount,
            icon: Users,
            color: 'text-sky-600 dark:text-sky-400',
          },
          {
            label: 'Converted to Pro',
            value: convertedCount,
            icon: TrendingUp,
            color: 'text-primary',
          },
        ].map(s => (
          <div key={s.label} className="rounded-lg border bg-card px-4 py-4">
            <div className="flex items-center gap-1.5 mb-2">
              <s.icon className={cn('w-3.5 h-3.5', s.color)} />
              <p className="text-xs text-muted-foreground leading-none">{s.label}</p>
            </div>
            <p className={cn('text-2xl font-bold tabular-nums', s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* ── Referral Link Box ───────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Your Referral Link</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Share this link with other BDC agents — anyone who upgrades to Pro earns you $25
          </p>
        </div>

        {/* Link row */}
        <div className="flex gap-2">
          <div className="flex-1 min-w-0 bg-muted/50 border border-border rounded-md px-3 py-2 font-mono text-xs text-muted-foreground truncate select-all">
            {isLoading ? 'Loading…' : (data?.referral_link || '—')}
          </div>
          <Button
            size="sm"
            onClick={copyLink}
            disabled={!data?.referral_link}
            className="gap-1.5 flex-shrink-0"
          >
            {linkCopied
              ? <><Check className="w-3.5 h-3.5" />Copied!</>
              : <><Copy className="w-3.5 h-3.5" />Copy Link</>}
          </Button>
        </div>

        {/* Referral code chip */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Referral Code:</span>
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm tracking-[0.15em]">
              {data?.referral_code || '—'}
            </span>
            <button
              onClick={copyCode}
              disabled={!data?.referral_code}
              aria-label="Copy referral code"
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              {codeCopied
                ? <Check className="w-3.5 h-3.5 text-green-500" />
                : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Share buttons */}
        <div className="flex gap-2 flex-wrap pt-1">
          <a
            href={`mailto:?subject=Try%20BDC%20Manager%20Desk&body=${emailBody}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-400 transition-colors"
          >
            <Mail className="w-3.5 h-3.5" /> Email Invite
          </a>
          <a
            href={`sms:?body=${smsBody}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" /> SMS Invite
          </a>
        </div>
      </div>

      {/* ── How It Works ────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-base font-semibold mb-4">How It Works</h2>
        <div className="space-y-3">
          {[
            {
              step: '1',
              text: 'Share your unique referral link with another BDC agent or dealership manager',
            },
            {
              step: '2',
              text: 'They create an account using your link — the referral code is applied automatically',
            },
            {
              step: '3',
              text: 'Once they upgrade to BDC Manager Desk Pro, you earn a $25 billing credit',
            },
            {
              step: '4',
              text: 'The credit is applied directly to your Stripe account and reduces your next invoice',
            },
          ].map(({ step, text }) => (
            <div key={step} className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5">
                {step}
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Billing Activity ────────────────────────────────────────── */}
      <div className="rounded-lg border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
          <Receipt className="w-3.5 h-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Billing Activity</h2>
          <span className="ml-auto text-xs text-muted-foreground">Credit applied to renewal invoices</span>
        </div>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !data?.billing_events?.length ? (
          <div className="py-8 text-center">
            <Zap className="w-6 h-6 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No billing events yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              Credit activity will appear here once a referral converts to Pro.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {data.billing_events.map((ev, i) => {
              const creditDollars = ev.credit_applied_cents / 100;
              const isAward   = ev.event_type === 'credit.awarded'  || ev.event_type === 'credit.applied';
              const isCreated = ev.event_type === 'invoice.created';
              const isPaid    = ev.event_type === 'invoice.paid';

              return (
                <div key={i} className="flex items-start gap-3 px-4 py-3">
                  {/* Icon */}
                  <div className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5',
                    isAward   && 'bg-green-100 dark:bg-green-900/30',
                    isCreated && 'bg-sky-100 dark:bg-sky-900/30',
                    isPaid    && 'bg-primary/10',
                    !isAward && !isCreated && !isPaid && 'bg-muted',
                  )}>
                    {isAward   && <DollarSign   className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />}
                    {isCreated && <Receipt       className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />}
                    {isPaid    && <BadgeCheck    className="w-3.5 h-3.5 text-primary" />}
                    {!isAward && !isCreated && !isPaid && <Zap className="w-3.5 h-3.5 text-muted-foreground" />}
                  </div>

                  {/* Description */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium leading-snug">
                      {ev.description || ev.event_type}
                    </p>
                    {ev.stripe_invoice_id && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 font-mono truncate">
                        {ev.stripe_invoice_id}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {ev.created_at
                        ? new Date(ev.created_at).toLocaleString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            hour: 'numeric', minute: '2-digit',
                          })
                        : '—'}
                    </p>
                  </div>

                  {/* Credit amount badge */}
                  {creditDollars > 0 && (
                    <span className={cn(
                      'text-xs font-semibold font-mono flex-shrink-0 mt-0.5',
                      isAward ? 'text-green-600 dark:text-green-400' : 'text-primary',
                    )}>
                      −${creditDollars.toFixed(2)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Referral History ────────────────────────────────────────── */}
      <div className="rounded-lg border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Referral History</h2>
          {data?.referrals.length ? (
            <span className="text-xs text-muted-foreground">{data.referrals.length} total</span>
          ) : null}
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !data?.referrals.length ? (
          <div className="py-12 text-center">
            <Gift className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No referrals yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Share your link above to get started!</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Account
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Status
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">
                  Joined
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Credit
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.referrals.map(r => (
                <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                  {/* Account */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold uppercase text-[10px] flex-shrink-0">
                        {r.referred_username[0]}
                      </div>
                      <span className="font-medium">{r.referred_username}</span>
                    </div>
                  </td>
                  {/* Status */}
                  <td className="px-4 py-3">
                    {r.status === 'converted' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <TrendingUp className="w-2.5 h-2.5" />
                        Pro — Credit Earned
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                        <Users className="w-2.5 h-2.5" />
                        Trial Active
                      </span>
                    )}
                  </td>
                  {/* Joined date */}
                  <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                    {r.created_at
                      ? new Date(r.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  {/* Credit amount */}
                  <td className="px-4 py-3 text-right font-mono font-semibold text-sm">
                    {r.status === 'converted' ? (
                      <span className="text-green-600 dark:text-green-400">
                        ${r.credit_amount.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}
