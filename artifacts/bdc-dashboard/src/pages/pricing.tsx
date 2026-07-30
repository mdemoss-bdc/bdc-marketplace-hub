/**
 * Pricing page — accessible to authenticated users who need to subscribe.
 *
 * Toggle:  Monthly | Annual (2 months free) | Lifetime Pass
 * Columns: Individual Pro Rep  ·  Dealership Rooftop (Up to 10 Seats)
 */

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  Check, Lock, Scale, ShieldAlert, AlertTriangle,
  X, ExternalLink, Zap, Building2, User2, Infinity, Crown, Minus, Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  type BillingCycle,
  type PlanCard,
  INDIVIDUAL_PLANS,
  ROOFTOP_PLANS,
  FREE_TRIAL_FEATURES,
  PRO_FEATURES,
  ROOFTOP_EXTRAS,
  FREE_TRIAL_PRICE,
  FREE_TRIAL_PERIOD,
  FREE_TRIAL_SUB,
  ROOFTOP_BASE_SEATS,
  ROOFTOP_SEAT_MONTHLY_PRICE,
} from '@/lib/pricing-data';

// ── Component ─────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const { authFetch, isEmailVerified, token, isSubscribed, isMasterAdmin, user } = useAuth();

  const [cycle, setCycle]       = useState<BillingCycle>('annual');
  const [loading, setLoading]   = useState<string | null>(null); // plan key being loaded
  const [error, setError]       = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [showTos, setShowTos]   = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [resendingSV, setResendingSV] = useState(false);
  const [resentSV, setResentSV]       = useState(false);
  const [pendingPlan, setPendingPlan] = useState('');
  // Extra seats above the base 10 included in the Rooftop plan.
  // Pre-populated from pending_extra_seats stored at registration so the first
  // Stripe charge reflects exactly what the admin selected on sign-up.
  const [extraSeats, setExtraSeats] = useState<number>(
    () => (user?.pending_extra_seats ?? 0)
  );

  const handleResendVerify = async () => {
    if (resendingSV || resentSV || !token) return;
    setResendingSV(true);
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      setResentSV(true);
      setTimeout(() => setResentSV(false), 60_000);
    } catch { /* best-effort */ }
    finally { setResendingSV(false); }
  };

  const handleSubscribe = async (plan: string) => {
    if (!tosAccepted) {
      setError('Please accept the Terms of Service before subscribing.');
      return;
    }
    setError('');
    if (!isEmailVerified) {
      setPendingPlan(plan);
      setShowVerifyModal(true);
      return;
    }
    setLoading(plan);
    try {
      const origin = window.location.origin;
      const base   = import.meta.env.BASE_URL.replace(/\/$/, '');
      const isRooftopPlan = plan.startsWith('rooftop_');
      const res    = await authFetch('/api/v1/billing/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          tos_accepted: true,
          success_url:  `${origin}${base}/marketplace-hub?subscribed=1`,
          cancel_url:   `${origin}${base}/pricing?canceled=1`,
          // Send the currently-shown extra seat count for rooftop plans so the
          // Stripe line item and the provisioned org seat_limit match.
          ...(isRooftopPlan && extraSeats > 0 ? { extra_seats: extraSeats } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start checkout');
      window.location.href = data.url;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setLoading(null);
    }
  };

  const indCard   = INDIVIDUAL_PLANS[cycle];
  const roofCard  = ROOFTOP_PLANS[cycle];

  return (
    <div className="max-w-5xl mx-auto py-10 px-4 space-y-8">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="text-center space-y-3">
        {user?.is_admin ? (
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-sm font-semibold px-3 py-1 rounded-full">
            <Crown className="w-3.5 h-3.5" />
            Master Admin — Lifetime Access Active
          </div>
        ) : (
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-semibold px-3 py-1 rounded-full">
            <Lock className="w-3.5 h-3.5" />
            Subscription Required
          </div>
        )}
        <h1 className="text-3xl sm:text-4xl font-display font-bold tracking-tight">
          BDC Manager Desk
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          {user?.is_admin
            ? 'You have permanent full-tier access. This page is shown for inspection only — all features are always unlocked.'
            : 'Flexible plans for individual reps and complete dealership rooftops.'}
        </p>
      </div>

      {/* ── Admin access notice (replaces CTA flow) ──────────────────────── */}
      {user?.is_admin && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-6 py-4 flex items-start gap-3 max-w-2xl mx-auto">
          <Crown className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-foreground">No subscription required</p>
            <p className="text-sm text-muted-foreground">
              All platform features — Marketplace Hub, Wishlist, Customer Cards &amp; Mail, Team &amp; Seats, and Analytics — are permanently unlocked for this account across every view, including impersonation previews.
            </p>
          </div>
        </div>
      )}

      {/* ── Billing cycle toggle ─────────────────────────────────────────── */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-xl border border-border bg-muted/40 p-1 gap-1">
          {(
            [
              { key: 'monthly',  label: 'Monthly' },
              { key: 'annual',   label: 'Yearly',  sub: '2 Months Free' },
              { key: 'lifetime', label: 'Lifetime Access' },
            ] as { key: BillingCycle; label: string; sub?: string }[]
          ).map(({ key, label, sub }) => (
            <button
              key={key}
              onClick={() => setCycle(key)}
              className={cn(
                'relative px-4 py-2 rounded-lg text-sm font-semibold transition-all',
                cycle === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
              {sub && (
                <span className={cn(
                  'ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                  cycle === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}>
                  {sub}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── ToS checkbox (shared across both cards) ──────────────────────── */}
      <div className="max-w-2xl mx-auto">
        <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-border bg-muted/40 px-4 py-3 hover:bg-muted/60 transition-colors">
          <input
            type="checkbox"
            checked={tosAccepted}
            onChange={(e) => { setTosAccepted(e.target.checked); setError(''); }}
            disabled={!!loading}
            className="mt-0.5 w-4 h-4 rounded border-border accent-primary flex-shrink-0 cursor-pointer"
          />
          <span className="text-xs text-muted-foreground leading-relaxed">
            I agree to the{' '}
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setShowTos(true); }}
              className="text-primary underline underline-offset-2 hover:text-primary/80 font-medium"
            >
              Terms of Service
            </button>
            . I understand all sales are final and non-refundable.
          </span>
        </label>
        {error && (
          <p className="mt-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {error}
          </p>
        )}
      </div>

      {/* ── Plan cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Free Trial card */}
        <FreePlanCard />

        {/* Individual Rep card */}
        <PlanCardUI
          card={indCard}
          icon={<User2 className="w-4 h-4 text-primary" />}
          seatLabel="1 Seat"
          features={PRO_FEATURES}
          cycleLabel={cycle}
          loading={loading === indCard.plan}
          disabled={!!loading || !tosAccepted}
          onSubscribe={() => handleSubscribe(indCard.plan)}
        />

        {/* Dealership Rooftop card */}
        <PlanCardUI
          card={roofCard}
          icon={<Building2 className="w-4 h-4 text-primary" />}
          seatLabel={extraSeats > 0 ? `${ROOFTOP_BASE_SEATS + extraSeats} Seats · Expandable` : `Store License · UP TO ${ROOFTOP_BASE_SEATS} SEATS`}
          features={ROOFTOP_EXTRAS}
          cycleLabel={cycle}
          loading={loading === roofCard.plan}
          disabled={!!loading || !tosAccepted}
          onSubscribe={() => handleSubscribe(roofCard.plan)}
        />
      </div>

      {/* ── Extra seats adjustment (shown when rooftop signup pre-selected extras) ── */}
      {extraSeats > 0 && (
        <div className="max-w-2xl mx-auto rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {extraSeats} additional seat{extraSeats !== 1 ? 's' : ''} selected at registration
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your Rooftop plan checkout will include {ROOFTOP_BASE_SEATS + extraSeats} total seats —{' '}
                {ROOFTOP_BASE_SEATS} base + {extraSeats} extra at {ROOFTOP_SEAT_MONTHLY_PRICE}/seat/mo. Adjust below if needed.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setExtraSeats(s => Math.max(0, s - 1))}
                disabled={extraSeats === 0}
                className="w-7 h-7 rounded-md border border-border bg-background flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="w-8 text-center text-sm font-bold tabular-nums">+{extraSeats}</span>
              <button
                type="button"
                onClick={() => setExtraSeats(s => s + 1)}
                className="w-7 h-7 rounded-md border border-border bg-background flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Legal fine-print ─────────────────────────────────────────────── */}
      <p className="text-xs text-center text-muted-foreground max-w-xl mx-auto leading-relaxed">
        By completing your purchase you authorise the charge shown above and acknowledge that
        all software sales, setup fees, and subscriptions are non-refundable. Service provided
        "As-Is" without guarantees of third-party platform availability.{' '}
        Payments processed securely by Stripe — your card details are never stored on our servers.
      </p>

      {/* ── Email Verification modal ─────────────────────────────────────── */}
      {showVerifyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setShowVerifyModal(false); }}
        >
          <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-sky-100 dark:bg-sky-900/40 flex items-center justify-center flex-shrink-0">
                  <ShieldAlert className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                </div>
                <h2 className="text-sm font-bold">Email Verification Required</h2>
              </div>
              <button onClick={() => setShowVerifyModal(false)} className="p-1.5 rounded-md text-muted-foreground hover:bg-muted" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Please verify your email address before upgrading. Check your inbox for the
                verification link sent at registration.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleResendVerify}
                  disabled={resendingSV || resentSV}
                  className="w-full rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white px-4 py-2.5 text-sm font-semibold transition-colors"
                >
                  {resentSV ? '✓ Email sent — check your inbox' : resendingSV ? 'Sending…' : 'Resend Verification Email'}
                </button>
                <button onClick={() => setShowVerifyModal(false)} className="w-full rounded-lg border border-border hover:bg-muted px-4 py-2.5 text-sm font-medium transition-colors">
                  Maybe Later
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Terms of Service modal ───────────────────────────────────────── */}
      {showTos && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setShowTos(false); }}
        >
          <div className="relative w-full max-w-[95vw] sm:max-w-2xl rounded-2xl border border-border bg-card shadow-2xl flex flex-col max-h-[85dvh]">
            <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-4 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Scale className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-bold">Terms of Service &amp; Refund Policy</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">BDC Manager Desk · Effective Jan 1, 2025</p>
                </div>
              </div>
              <button onClick={() => setShowTos(false)} className="p-1.5 rounded-md text-muted-foreground hover:bg-muted flex-shrink-0" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto px-6 py-5 space-y-5 flex-1 text-sm">
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive flex-shrink-0" />
                  <h3 className="font-bold text-destructive text-sm">No Refund Policy</h3>
                </div>
                <p className="text-sm font-semibold">All subscription purchases, renewals, and fees are strictly non-refundable.</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  This includes monthly charges, annual charges, lifetime pass purchases, and add-on fees.
                  By completing checkout you accept this policy. Your acceptance timestamp and IP address
                  are logged as evidence for potential chargeback disputes.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <h3 className="font-bold text-sm">Disclaimer of Warranties</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The Service is provided <strong>"AS-IS"</strong> without warranties of any kind,
                  express or implied. We do not warrant uninterrupted availability or accuracy of
                  any third-party data, including vehicle inventory.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-primary flex-shrink-0" />
                  <h3 className="font-bold text-sm">Limitation of Liability</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Maximum liability is capped at fees paid in the past 12 months. We are not liable
                  for indirect, incidental, or consequential damages.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <h3 className="font-bold text-sm">Independent Platform Disclaimer</h3>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  BDC Manager Desk is <strong>not affiliated with, endorsed by, or sponsored by
                  Meta Platforms, Inc.</strong> "Meta", "Facebook", and "Instagram" are trademarks
                  of Meta Platforms, Inc. We make no guarantees regarding third-party platform
                  availability, including Meta Commerce Manager.
                </p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between gap-3 rounded-b-2xl flex-shrink-0">
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline underline-offset-2">
                <ExternalLink className="w-3 h-3" /> View full Terms page
              </a>
              <button onClick={() => setShowTos(false)} className="rounded-md px-4 py-1.5 text-sm font-medium bg-muted hover:bg-muted/80 transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Free Trial card ───────────────────────────────────────────────────────────

function FreePlanCard() {
  return (
    <div className="rounded-2xl border border-border bg-card flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-5 border-b border-border">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center">
            <User2 className="w-4 h-4 text-muted-foreground" />
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Free Trial
          </span>
          <span className="ml-auto text-[11px] font-semibold border border-border rounded-full px-2 py-0.5 text-muted-foreground">
            1 Seat
          </span>
        </div>

        <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400">
          NO CREDIT CARD REQUIRED
        </div>

        <div className="flex items-end gap-1.5">
          <span className="text-4xl font-display font-bold tracking-tight">{FREE_TRIAL_PRICE}</span>
          <span className="text-muted-foreground pb-1 text-sm">{FREE_TRIAL_PERIOD}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{FREE_TRIAL_SUB}</p>
      </div>

      {/* Features */}
      <div className="px-6 py-5 flex-1">
        <ul className="space-y-2.5">
          {FREE_TRIAL_FEATURES.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full bg-muted flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-muted-foreground" />
              </span>
              {f}
            </li>
          ))}
        </ul>
      </div>

      {/* CTA */}
      <div className="px-6 pb-6">
        <a href="/register">
          <Button variant="outline" className="w-full font-semibold">
            Start Free Trial
          </Button>
        </a>
        <p className="text-[11px] text-center text-muted-foreground mt-2">
          5-day trial · No payment needed · Upgrade anytime
        </p>
      </div>
    </div>
  );
}

// ── Plan card sub-component ───────────────────────────────────────────────────

interface PlanCardUIProps {
  card: PlanCard;
  icon: React.ReactNode;
  seatLabel: string;
  features: string[];
  cycleLabel: BillingCycle;
  loading: boolean;
  disabled: boolean;
  onSubscribe: () => void;
}

function PlanCardUI({
  card, icon, seatLabel, features, cycleLabel, loading, disabled, onSubscribe,
}: PlanCardUIProps) {
  const isLifetime = cycleLabel === 'lifetime';

  return (
    <div className={cn(
      'rounded-2xl border bg-card flex flex-col overflow-hidden transition-shadow hover:shadow-md',
      card.highlight ? 'border-primary shadow-sm' : 'border-border',
    )}>
      {/* Card header */}
      <div className={cn(
        'px-6 pt-6 pb-5 border-b border-border',
        card.highlight ? 'bg-primary/5' : '',
      )}>
        {/* Plan type pill */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
            {icon}
          </div>
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {card.label}
          </span>
          <span className="ml-auto text-[11px] font-semibold border border-border rounded-full px-2 py-0.5 text-muted-foreground">
            {seatLabel}
          </span>
        </div>

        {/* Badge */}
        {card.badge && (
          <div className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3',
            isLifetime
              ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
              : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
          )}>
            {isLifetime ? <Infinity className="w-3 h-3" /> : <Crown className="w-3 h-3" />}
            {card.badge}
          </div>
        )}

        {/* Price */}
        <div className="flex items-end gap-1.5">
          <span className="text-4xl font-display font-bold tracking-tight">{card.price}</span>
          <span className="text-muted-foreground pb-1 text-sm">{card.period}</span>
        </div>
        {card.equiv && (
          <p className="text-xs text-muted-foreground mt-1">{card.equiv}</p>
        )}
        {card.expansion && (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-1">{card.expansion}</p>
        )}
      </div>

      {/* Feature list */}
      <div className="px-6 py-5 flex-1">
        <ul className="space-y-2.5">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-primary" />
              </span>
              {f}
            </li>
          ))}
        </ul>
      </div>

      {/* CTA */}
      <div className="px-6 pb-6">
        <Button
          className={cn('w-full font-semibold gap-2', isLifetime && 'bg-amber-600 hover:bg-amber-700 text-white')}
          variant={card.highlight && !isLifetime ? 'default' : isLifetime ? 'default' : 'outline'}
          onClick={onSubscribe}
          disabled={disabled || loading}
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Redirecting to Stripe…
            </span>
          ) : (
            <>
              {isLifetime && <Zap className="w-3.5 h-3.5" />}
              {card.cta}
            </>
          )}
        </Button>
        {isLifetime && (
          <p className="text-[11px] text-center text-muted-foreground mt-2">
            One-time charge · No recurring fees · Access never expires
          </p>
        )}
      </div>
    </div>
  );
}
