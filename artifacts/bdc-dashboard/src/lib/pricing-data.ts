/**
 * Single source of truth for all pricing data.
 *
 * Both the public landing page and the in-app pricing page import from here.
 * To change a price, feature list, or plan key — edit this file only.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type BillingCycle = 'monthly' | 'annual' | 'lifetime';

export interface PricePoint {
  price: string;
  period: string;
  /** Short subtitle shown beneath the price on the landing page. */
  sub?: string;
}

export interface PlanCard {
  plan: string;     // matches backend BillingManager._PLANS key
  label: string;
  price: string;    // display price
  period: string;   // e.g. "/month" or "one-time"
  badge?: string;   // optional callout badge
  equiv?: string;   // e.g. "$124/mo equivalent"
  expansion?: string; // extra-seat expansion note (rooftop only)
  cta: string;
  highlight?: boolean;
}

// ── Billing cycle toggle tabs ─────────────────────────────────────────────────

export const CYCLE_TABS: { key: BillingCycle; label: string; sub?: string }[] = [
  { key: 'monthly',  label: 'Monthly' },
  { key: 'annual',   label: 'Yearly',  sub: '2 Months Free' },
  { key: 'lifetime', label: 'Lifetime' },
];

// ── Individual Pro Rep — price points (landing page) ─────────────────────────

export const IND_PRICE: Record<BillingCycle, PricePoint> = {
  monthly:  { price: '$149',   period: '/month' },
  annual:   { price: '$1,490', period: '/year',    sub: '$124/mo equivalent — 2 months free' },
  lifetime: { price: '$4,995', period: 'one-time', sub: 'Pay once, use forever' },
};

// ── Dealership Rooftop — price points (landing page) ─────────────────────────

export const ROOF_PRICE: Record<BillingCycle, PricePoint> = {
  monthly:  { price: '$495',    period: '/month',   sub: '+$39/mo per additional seat' },
  annual:   { price: '$4,950',  period: '/year',    sub: '+$390/yr per additional seat (saves $78)' },
  lifetime: { price: '$14,995', period: 'one-time', sub: '+$995 one-time per extra seat (or +$4,495 for 5-seat pack)' },
};

// ── Individual Pro Rep — full plan cards (pricing page) ──────────────────────

export const INDIVIDUAL_PLANS: Record<BillingCycle, PlanCard> = {
  monthly: {
    plan:   'pro_monthly',
    label:  'Pro Rep',
    price:  '$149',
    period: '/month',
    cta:    'Subscribe — $149/mo',
  },
  annual: {
    plan:      'pro_annual',
    label:     'Pro Rep',
    price:     '$1,490',
    period:    '/year',
    badge:     'GET 2 MONTHS FREE — BEST VALUE',
    equiv:     '$124/mo equivalent',
    cta:       'Subscribe — $1,490/yr',
    highlight: true,
  },
  lifetime: {
    plan:   'pro_lifetime',
    label:  'Pro Rep Lifetime Pass',
    price:  '$4,995',
    period: 'one-time',
    badge:  'PAY ONCE, USE FOREVER',
    cta:    'Get Lifetime Access — $4,995',
  },
};

// ── Dealership Rooftop — full plan cards (pricing page) ──────────────────────

export const ROOFTOP_PLANS: Record<BillingCycle, PlanCard> = {
  monthly: {
    plan:      'rooftop_monthly',
    label:     'Store License — Up to 10 Seats',
    price:     '$495',
    period:    '/month',
    expansion: '+$39/mo per additional seat',
    cta:       'Register Dealership — $495/mo',
  },
  annual: {
    plan:      'rooftop_annual',
    label:     'Store License — Up to 10 Seats',
    price:     '$4,950',
    period:    '/year',
    badge:     'GET 2 MONTHS FREE — BEST VALUE',
    equiv:     '$412/mo equivalent',
    expansion: '+$390/yr per additional seat (saves $78)',
    cta:       'Register Dealership — $4,950/yr',
    highlight: true,
  },
  lifetime: {
    plan:      'rooftop_lifetime',
    label:     'Store License — Up to 10 Seats',
    price:     '$14,995',
    period:    'one-time',
    badge:     'CAPEX STORE PASS — 10 SEATS',
    expansion: '+$995 one-time per seat · 5-seat pack $4,495',
    cta:       'Register Dealership — $14,995',
  },
};

// ── Free trial display constants ─────────────────────────────────────────────

export const FREE_TRIAL_PRICE   = '$0';
export const FREE_TRIAL_PERIOD  = '/ 5 days';
export const FREE_TRIAL_SUB     = 'Limited-access preview';

// ── Rooftop seat constants ────────────────────────────────────────────────────

/** Base seat count included in every Rooftop plan. */
export const ROOFTOP_BASE_SEATS = 10;

/** Per-extra-seat monthly price (display string). */
export const ROOFTOP_SEAT_MONTHLY_PRICE = '$39';

// ── Feature lists ─────────────────────────────────────────────────────────────

/** Short trial feature list shown on the public landing page. */
export const TRIAL_FEATURES = [
  '3 AI post generations / day',
  '3 wishlist entries / day',
  'Full inventory view (read-only)',
  'No credit card required',
];

/** Longer trial feature list shown on the in-app pricing page. */
export const FREE_TRIAL_FEATURES = [
  '3 AI post generations per day',
  '3 wishlist entries per day',
  'Read-only inventory browsing',
  'Marketplace Hub preview',
  'No credit card required',
];

/** Condensed Pro Rep feature list for the public landing page. */
export const PRO_FEATURES_LANDING = [
  'Unlimited AI post generations',
  'Full DMS / sitemap inventory sync',
  'Unlimited wishlist entries & alerts',
  'Customer Cards & Mail templates',
  'Personal daily posting queue',
  'Private lead & appointment pipeline',
  'Desk analytics & posting history',
];

/** Full Pro Rep feature list for the in-app pricing page. */
export const PRO_FEATURES = [
  'Unlimited AI vehicle post generation',
  'DMS / inventory sync',
  'Unlimited wishlist customer entries & alerts',
  'Personal daily posting queue',
  'Facebook & TikTok catalog feed URLs',
  'Direct mail follow-ups (customer cards)',
  '$25 referral billing credit per referred rep',
  'Private lead & appointment pipeline',
  'Desk analytics & posting history',
  'AI Support Assistant & diagnostics',
  'Email support',
];

/** Condensed Rooftop feature list for the public landing page. */
export const ROOFTOP_FEATURES_LANDING = [
  'Everything in Individual Pro Rep',
  'Executive Rooftop Dashboard',
  'Team Leaderboards & Seat Management',
  'Custom Dealership Logos on physical mail',
  'Priority Onboarding & Support',
  '⚡ Expandable Capacity: Add extra seats anytime at $39/mo, $390/yr, or $995 Lifetime per seat.',
];

/** Full Rooftop feature list for the in-app pricing page. */
export const ROOFTOP_EXTRAS = [
  'Everything in Individual Pro Rep',
  'Executive Rooftop Dashboard',
  'Team Leaderboards & Seat Management',
  'Custom Dealership Logos on physical mail',
  'Priority Onboarding & Support',
  'Shared dealership inventory workspace',
  'Centralized rooftop billing',
  '⚡ Expandable Capacity: Add extra seats anytime at $39/mo, $390/yr, or $995 Lifetime per seat.',
];
