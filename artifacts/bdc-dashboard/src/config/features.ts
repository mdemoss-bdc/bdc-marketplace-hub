/**
 * Central feature configuration for BDC Manager Desk.
 *
 * To add a new Pro feature: append an entry with `isPro: true, active: true`.
 * The Pricing page maps over this array automatically — no UI edits required.
 */

export interface FeatureConfig {
  id:            string;
  title:         string;
  description:   string;
  isPro:         boolean;
  isFreeTrial:   boolean;
  active:        boolean;
}

export const FEATURES: FeatureConfig[] = [
  {
    id:          'marketplace-hub',
    title:       'Marketplace Hub & Meta Commerce Manager CSV Export',
    description: 'Full Marketplace Hub access with automated Meta Commerce Manager CSV feed export for Facebook inventory sync.',
    isPro:       true,
    isFreeTrial: false,
    active:      true,
  },
  {
    id:          'ai-post-generation',
    title:       'Unlimited AI Vehicle Post Generation',
    description: 'Unlimited AI vehicle post generation & custom listing copy formatting for Facebook Marketplace.',
    isPro:       true,
    isFreeTrial: false,
    active:      true,
  },
  {
    id:          'wishlist-matching',
    title:       'Customer Wishlist Lead Matching & Inventory Alerts',
    description: 'Unlimited Customer Wishlist lead entries with real-time inventory matching, automated match alerts, red indicator badge & priority lead sorting.',
    isPro:       true,
    isFreeTrial: false,
    active:      true,
  },
  {
    id:          'multi-vehicle-preferences',
    title:       'Up to 3 Vehicle Preference Choices per Customer',
    description: 'Each wishlist entry supports up to 3 distinct vehicle choices (make, model, year, condition) — a match on any choice pins the lead to the top.',
    isPro:       true,
    isFreeTrial: false,
    active:      true,
  },
  {
    id:          'ai-support-assistant',
    title:       'AI Support Assistant & Live Catalog Diagnostics',
    description: 'Integrated AI Support Assistant with page-aware Quick Guides, a 9-check Meta feed Diagnostics Checker, and interactive AI chat.',
    isPro:       true,
    isFreeTrial: false,
    active:      true,
  },
  {
    id:          'free-trial',
    title:       'Free Tier: 3 AI Posts & 3 Wishlist Leads/Day for 5 Days',
    description: 'Try BDC Manager Desk free for 5 days — 3 AI-generated posts and 3 Wishlist customer entries per calendar day. No credit card required to start.',
    isPro:       false,
    isFreeTrial: true,
    active:      true,
  },
];

/** Active Pro features in display order. */
export const PRO_FEATURES    = FEATURES.filter(f => f.isPro && f.active);

/** Active free-trial terms entry. */
export const FREE_TRIAL_FEATURE = FEATURES.find(f => f.isFreeTrial && f.active) ?? null;
