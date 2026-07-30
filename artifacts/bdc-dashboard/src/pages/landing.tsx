/**
 * Public landing page — rendered at `/` for unauthenticated visitors.
 *
 * Purpose: Stripe business-verification compliance.  A Stripe reviewer hitting
 * the public app origin must immediately see what the product is,
 * who it is for, what it costs, and how to reach support.
 *
 * Layout order (top → bottom):
 *   1. Sticky nav
 *   2. Hero — headline + description
 *   3. Billing interval toggle
 *   4. 3-column pricing grid  ← ABOVE the sign-in / sign-up CTAs
 *   5. CTA buttons (Start Free Trial | Sign In)
 *   6. Feature grid
 *   7. For-whom section
 *   8. Footer
 */

import { useState } from 'react';
import {
  Car, Check, Zap, BarChart3, Mail, Heart, Store,
  Shield, Clock, ChevronRight, Building2, Crown, Infinity as InfinityIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocation } from 'wouter';
import {
  type BillingCycle,
  CYCLE_TABS,
  IND_PRICE,
  ROOF_PRICE,
  TRIAL_FEATURES,
  PRO_FEATURES_LANDING,
  ROOFTOP_FEATURES_LANDING,
  FREE_TRIAL_PRICE,
  FREE_TRIAL_PERIOD,
  FREE_TRIAL_SUB,
  ROOFTOP_BASE_SEATS,
  ROOFTOP_SEAT_MONTHLY_PRICE,
} from '@/lib/pricing-data';

// ── Billing cycle ─────────────────────────────────────────────────────────────

type Cycle = BillingCycle;

// ── Feature grid data ─────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Zap,
    title: 'AI Post Generation',
    desc: 'One-click Facebook Marketplace copy for any vehicle in your inventory — price, features, hashtags, and photos, all auto-generated.',
  },
  {
    icon: Store,
    title: 'Marketplace Hub',
    desc: 'Sync live inventory from your DMS or public sitemap.  Filter, search, and queue vehicles for daily posting with a single click.',
  },
  {
    icon: Heart,
    title: 'Wishlist Matching',
    desc: 'Log buyer preferences and get instant alerts when a matching vehicle hits your inventory so your BDC team never misses a lead.',
  },
  {
    icon: Mail,
    title: 'Customer Mail',
    desc: 'Generate personalised follow-up postcards and email templates for every active lead — templated, proofed, and ready to send.',
  },
  {
    icon: BarChart3,
    title: 'Desk Analytics',
    desc: 'Track daily posting volume, lead pipeline activity, appointment set rates, and AI usage across your entire BDC team.',
  },
  {
    icon: Shield,
    title: 'Private Per-Rep Accounts',
    desc: 'Each BDC rep gets an isolated account with their own inventory view, posting queue, and lead list — nothing shared by accident.',
  },
  {
    icon: Building2,
    title: 'Dealership Rooftop',
    desc: 'Executive dashboards, store leaderboards, and seat management for multi-rep stores — one rooftop subscription covers your entire BDC team.',
  },
];

// ── Page component ────────────────────────────────────────────────────────────

export default function LandingPage() {
  const [, navigate]   = useLocation();
  const [cycle, setCycle] = useState<Cycle>('monthly');

  const goToLogin    = () => navigate('/login');

  /** Navigate to /register with the selected billing cycle pre-filled. */
  const goToRegisterPro      = () => navigate(`/register?plan=pro_${cycle}`);
  const goToRegisterRooftop  = () => navigate(`/register?accountType=rooftop&plan=rooftop_${cycle}`);

  const indPx  = IND_PRICE[cycle];
  const roofPx = ROOF_PRICE[cycle];

  return (
    <div className="min-h-dvh bg-transparent text-foreground flex flex-col">

      {/* ── Top nav ────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/50 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
              <Car className="w-4.5 h-4.5 text-primary-foreground" />
            </div>
            <span className="font-display font-bold text-base tracking-tight leading-none">
              BDC Manager Desk
            </span>
          </a>

          <nav className="hidden sm:flex items-center gap-6">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Features</a>
            <a href="#pricing"  className="text-sm text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
            <a href="/terms"    className="text-sm text-muted-foreground hover:text-foreground transition-colors">Terms</a>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={goToLogin}
              className="text-sm font-semibold text-primary hover:underline underline-offset-2 transition-colors"
            >
              Sign In
            </button>
            <Button size="sm" onClick={goToRegisterPro} className="gap-1.5">
              Start Free Trial <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero + Pricing ─────────────────────────────────────────────────── */}
      <section
        id="pricing"
        className="flex-shrink-0 pt-16 pb-0 sm:pt-24 px-4 relative"
        style={{
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,0,0,0.40) 0%, rgba(0,0,0,0.65) 100%), url(/audi-bg.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundAttachment: 'fixed',
        }}
      >
        <div className="max-w-6xl mx-auto">

          {/* Hero headline */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-semibold mb-5 border border-primary/30">
              <Clock className="w-3 h-3" /> 5-day free trial — no credit card required
            </div>

            <h1 className="text-4xl sm:text-5xl font-display font-bold tracking-tight leading-tight mb-4 text-white drop-shadow-lg">
              The Sales Command Post
              <br />
              <span className="text-primary">for Car Dealerships</span>
            </h1>

            <p className="text-lg text-white/75 leading-relaxed max-w-2xl mx-auto drop-shadow">
              BDC Manager Desk automates Facebook Marketplace posting, tracks buyer wishlists,
              manages your lead pipeline, and gives every BDC rep their own isolated workspace —
              so your team spends time selling, not copy-pasting.
            </p>
          </div>

          {/* ── Billing interval toggle ────────────────────────────────────── */}
          <div className="flex justify-center mb-6">
            <div className="inline-flex rounded-xl border border-border bg-muted/40 p-1 gap-1">
              {CYCLE_TABS.map(({ key, label, sub }) => (
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

          {/* ── 3-column pricing grid ──────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">

            {/* Free Trial */}
            <div className="rounded-2xl border border-border bg-card flex flex-col overflow-hidden">
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                  Free Trial
                </p>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400">
                  NO CREDIT CARD REQUIRED
                </div>
                <div className="flex items-end gap-1.5">
                  <span className="text-4xl font-display font-bold tracking-tight">{FREE_TRIAL_PRICE}</span>
                  <span className="text-muted-foreground pb-1 text-sm">{FREE_TRIAL_PERIOD}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{FREE_TRIAL_SUB}</p>
              </div>
              <div className="px-6 py-4 flex-1">
                <ul className="space-y-2">
                  {TRIAL_FEATURES.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Check className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="px-6 pb-6">
                <Button variant="outline" className="w-full font-semibold" onClick={goToRegisterPro}>
                  Start Free Trial
                </Button>
              </div>
            </div>

            {/* Individual Pro Rep */}
            <div className="rounded-2xl border-2 border-primary bg-card flex flex-col overflow-hidden relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                <span className="bg-primary text-primary-foreground text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full whitespace-nowrap">
                  Most Popular
                </span>
              </div>
              <div className="px-6 pt-6 pb-4 border-b border-border bg-primary/5">
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                  Individual Pro Rep
                </p>
                {cycle === 'annual' && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    <Crown className="w-3 h-3" /> GET 2 MONTHS FREE
                  </div>
                )}
                {cycle === 'lifetime' && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    <InfinityIcon className="w-3 h-3" /> PAY ONCE · USE FOREVER
                  </div>
                )}
                <div className="flex items-end gap-1.5">
                  <span className="text-4xl font-display font-bold tracking-tight">{indPx.price}</span>
                  <span className="text-muted-foreground pb-1 text-sm">{indPx.period}</span>
                </div>
                {indPx.sub && <p className="text-xs text-muted-foreground mt-1">{indPx.sub}</p>}
              </div>
              <div className="px-6 py-4 flex-1">
                <ul className="space-y-2">
                  {PRO_FEATURES_LANDING.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="px-6 pb-6">
                <Button className="w-full font-semibold gap-1.5" onClick={goToRegisterPro}>
                  Start Free Trial <ChevronRight className="w-3.5 h-3.5" />
                </Button>
                <p className="text-[11px] text-center text-muted-foreground mt-2">
                  5-day trial included · Cancel anytime
                </p>
              </div>
            </div>

            {/* Dealership Rooftop */}
            <div className="rounded-2xl border border-border bg-card flex flex-col overflow-hidden">
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                  Store License · Up to 10 Seats
                </p>
                {cycle === 'annual' && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    <Crown className="w-3 h-3" /> GET 2 MONTHS FREE
                  </div>
                )}
                {cycle === 'lifetime' && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full mb-3 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                    <InfinityIcon className="w-3 h-3" /> CAPEX PASS · 10 SEATS
                  </div>
                )}
                <div className="flex items-end gap-1.5">
                  <span className="text-4xl font-display font-bold tracking-tight">{roofPx.price}</span>
                  <span className="text-muted-foreground pb-1 text-sm">{roofPx.period}</span>
                </div>
                {roofPx.sub && <p className="text-xs text-muted-foreground mt-1">{roofPx.sub}</p>}
              </div>
              <div className="px-6 py-4 flex-1">
                <ul className="space-y-2">
                  {ROOFTOP_FEATURES_LANDING.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="px-6 pb-6">
                <Button variant="outline" className="w-full font-semibold" onClick={goToRegisterRooftop}>
                  Register Dealership
                </Button>
                <p className="text-[11px] text-center text-muted-foreground mt-2">
                  Up to {ROOFTOP_BASE_SEATS} seats · Expand at +{ROOFTOP_SEAT_MONTHLY_PRICE}/mo/seat
                </p>
              </div>
            </div>
          </div>

          {/* ── CTA buttons — below pricing grid ──────────────────────────── */}
          <div className="text-center pb-16 sm:pb-24 border-b border-border/50">
            <div className="flex flex-col sm:flex-row gap-3 justify-center mb-3">
              <Button size="lg" onClick={goToRegisterPro} className="gap-2 text-base px-8">
                Start Free Trial <ChevronRight className="w-4 h-4" />
              </Button>
              <Button size="lg" variant="outline" onClick={goToLogin} className="text-base px-8">
                Sign In to Your Account
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              5-day free trial · Plans for Individual Reps ({IND_PRICE.monthly.price}/mo) and Dealership Stores ({ROOF_PRICE.monthly.price}/mo)
            </p>
            <p className="text-xs text-muted-foreground mt-1.5">
              Payments processed securely by{' '}
              <a href="https://stripe.com" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                Stripe
              </a>
              . Your card details are never stored on our servers.
            </p>
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────────────────── */}
      <section id="features" className="py-16 sm:py-24 px-4 bg-black/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-display font-bold tracking-tight mb-3">
              Everything your BDC needs in one place
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              Purpose-built for automotive dealership Business Development Centers —
              not a generic CRM bolted on to a spreadsheet.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map(f => (
              <div
                key={f.title}
                className="rounded-xl border bg-card p-6 space-y-3 hover:shadow-md transition-shadow"
              >
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <f.icon className="w-4.5 h-4.5 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── For whom ───────────────────────────────────────────────────────── */}
      <section className="py-16 px-4 bg-black/40 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto text-center space-y-4">
          <h2 className="text-xl sm:text-2xl font-display font-bold tracking-tight">
            Built for automotive BDC teams
          </h2>
          <p className="text-muted-foreground text-sm sm:text-base leading-relaxed">
            BDC Manager Desk is a Software-as-a-Service (SaaS) platform designed exclusively for
            Business Development Center (BDC) agents and managers at automotive dealerships.
            The subscription grants access to AI-powered content generation tools, inventory
            management features, and lead-tracking capabilities for use in day-to-day dealership
            BDC operations.
          </p>
          <div className="flex flex-wrap justify-center gap-x-8 gap-y-2 text-sm text-muted-foreground pt-2">
            <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-primary" /> BDC Agents</span>
            <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-primary" /> BDC Managers</span>
            <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-primary" /> Automotive Dealerships</span>
            <span className="flex items-center gap-1"><Check className="w-3.5 h-3.5 text-primary" /> Independent Dealers</span>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/10 bg-black/60 backdrop-blur-md mt-auto">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center">
                <Car className="w-3.5 h-3.5 text-primary-foreground" />
              </div>
              <span className="font-display font-bold text-sm">BDC Manager Desk</span>
            </div>

            <nav className="flex flex-wrap justify-center items-center gap-x-6 gap-y-1">
              <a href="/terms"   className="text-xs text-muted-foreground hover:text-foreground transition-colors">Terms of Service</a>
              <a href="/privacy" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Privacy Policy</a>
              <a href="mailto:support.bdcmanager@gmail.com" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                Support: support.bdcmanager@gmail.com
              </a>
            </nav>

            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} BDC Manager Desk
            </p>
          </div>
        </div>
      </footer>

    </div>
  );
}
