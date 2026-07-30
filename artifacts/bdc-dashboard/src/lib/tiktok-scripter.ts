/**
 * tiktok-scripter.ts — 1-click content generator for the TikTok Hub.
 *
 * Pure utility layer: reads a vehicle record straight from the local scraped
 * showroom inventory (marketplace_inventory via /api/v1/marketplace) and
 * string-templates a 15-second social script + a matching on-lot shot list.
 * No network calls — everything here is synchronous and side-effect free so
 * it can be unit tested and hot-reloaded instantly.
 */

export type ScriptTone = 'hype' | 'luxury' | 'deal';

/** Minimal vehicle shape the scripter needs — matches marketplace_inventory columns. */
export interface ScriptVehicle {
  vin: string;
  stock_number: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  price: number;
  mileage: number;
  exterior_color: string;
  image_url: string;
  last_seen: string;
}

export interface ToneOption {
  value: ScriptTone;
  emoji: string;
  label: string;
  description: string;
}

export const TONE_OPTIONS: ToneOption[] = [
  {
    value: 'hype',
    emoji: '🔥',
    label: 'Hype / High Energy',
    description: 'Fast hook, big energy, urgent CTA.',
  },
  {
    value: 'luxury',
    emoji: '💼',
    label: 'Professional / Luxury Review',
    description: 'Polished editorial tone for premium units.',
  },
  {
    value: 'deal',
    emoji: '📉',
    label: 'Deal of the Week / Aggressive Closer',
    description: 'Price-drop urgency for aged inventory.',
  },
];

export interface GeneratedScript {
  tone: ScriptTone;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
  /** Full formatted script with visual cues + transitions, ready to copy. */
  fullText: string;
}

export interface ShotListItem {
  id: number;
  label: string;
  seconds: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Approximate days on lot from last_seen (same convention as the Dashboard Hub). */
export function daysOnLot(lastSeen: string): number {
  if (!lastSeen) return 0;
  const t = new Date(lastSeen).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function fmtNum(n: number): string {
  return n > 0 ? n.toLocaleString('en-US') : '0';
}

export function vehicleTitle(v: ScriptVehicle): string {
  return [v.year || '', v.make, v.model, v.trim].filter(Boolean).join(' ').trim();
}

function hashKey(v: ScriptVehicle): string {
  return `${v.make}${v.model}`.replace(/[^A-Za-z0-9]/g, '') || 'CarTok';
}

// ── 1-click content generator ────────────────────────────────────────────

export function generateScript(v: ScriptVehicle, tone: ScriptTone): GeneratedScript {
  const title = vehicleTitle(v) || 'vehicle';
  const price = fmtNum(v.price);
  const miles = fmtNum(v.mileage);
  const color = v.exterior_color || 'a showroom-clean finish';
  const days  = daysOnLot(v.last_seen);
  const tag   = hashKey(v);
  const stock = (v.stock_number || 'TODAY').toUpperCase();

  if (tone === 'hype') {
    const hook = `Stop scrolling if you're looking for an immaculate ${title} under $${price}!`;
    const body = `Only ${miles} miles on this beast, wrapped in ${color} — this thing is CLEAN. 🔥`;
    const cta  = `Drop a 🔥 in the comments or DM us NOW — units like this don't last!`;
    const hashtags = ['#CarTok', '#CarsOfTikTok', `#${tag}`, '#DealAlert', '#CarDealer', '#ForSale', '#VroomVroom', '#CarSalesTok'];
    const fullText = [
      `🎬 HOOK (0-3s) — [Text Overlay: "STOP SCROLLING 🛑"]`,
      `"${hook}"`,
      ``,
      `⚡ TRANSITION — Whip-pan / zoom-punch cut to the grille`,
      ``,
      `🚗 BODY (3-10s) — [Camera: Slow walk-around pan]`,
      `"${body}"`,
      ``,
      `💥 TRANSITION — Snap-cut to interior / dashboard power-on`,
      ``,
      `📣 CTA (10-15s) — [Text Overlay: "DM US NOW"]`,
      `"${cta}"`,
      ``,
      `#️⃣ HASHTAGS`,
      hashtags.join(' '),
    ].join('\n');
    return { tone, hook, body, cta, hashtags, fullText };
  }

  if (tone === 'luxury') {
    const hook = `Introducing the ${title} — a statement in refinement, engineered for the discerning driver.`;
    const body = `Finished in ${color} with ${miles} miles of pristine ownership, this is $${price} well invested.`;
    const cta  = `Schedule your private test drive today — comment "TEST DRIVE" or send us a DM.`;
    const hashtags = ['#LuxuryCars', `#${tag}`, '#PremiumRide', '#CarReview', '#ExecutiveDrive', '#CarsOfTikTok', '#LuxuryLifestyle'];
    const fullText = [
      `🎬 OPEN (0-4s) — [Camera: Slow reveal, gimbal glide toward front fascia]`,
      `"${hook}"`,
      ``,
      `🎞️ TRANSITION — Smooth dissolve to cabin`,
      ``,
      `💼 BODY (4-11s) — [Camera: Interior detail shots, steady close-ups]`,
      `"${body}"`,
      ``,
      `🎞️ TRANSITION — Fade to exterior hero shot`,
      ``,
      `📣 CTA (11-15s) — [Text Overlay: lower-third with dealership name]`,
      `"${cta}"`,
      ``,
      `#️⃣ HASHTAGS`,
      hashtags.join(' '),
    ].join('\n');
    return { tone, hook, body, cta, hashtags, fullText };
  }

  // deal
  const hook = `This ${title} has been on the lot for ${days} day${days === 1 ? '' : 's'}, which means my manager is cutting prices today...`;
  const body = `Was $${price} — but with ${miles} miles and finished in ${color}, we need this GONE before month-end.`;
  const cta  = `Comment "SOLD" or DM the code ${stock} to lock in this price before someone else does.`;
  const hashtags = ['#DealOfTheWeek', '#PriceDrop', `#${tag}`, '#CarDeal', '#ActNow', '#CarSalesTok', '#CarsOfTikTok'];
  const fullText = [
    `🎬 HOOK (0-3s) — [Text Overlay: "PRICE CUT 📉"]`,
    `"${hook}"`,
    ``,
    `⚡ TRANSITION — Hard cut, price-tag graphic slams in`,
    ``,
    `📉 BODY (3-10s) — [Camera: Quick cuts — exterior, odometer, price sticker]`,
    `"${body}"`,
    ``,
    `💥 TRANSITION — Countdown-timer graphic overlay`,
    ``,
    `📣 CTA (10-15s) — [Text Overlay: "CODE ${stock}"]`,
    `"${cta}"`,
    ``,
    `#️⃣ HASHTAGS`,
    hashtags.join(' '),
  ].join('\n');
  return { tone, hook, body, cta, hashtags, fullText };
}

// ── Visual shot-list sequence builder ────────────────────────────────────

export function buildShotList(v: ScriptVehicle | null): ShotListItem[] {
  const finale = v ? `${vehicleTitle(v)} + price card overlay` : 'full vehicle + price card overlay';
  return [
    { id: 1, label: 'Aggressive front grille zoom', seconds: 3 },
    { id: 2, label: 'Clean panoramic wheel spin', seconds: 3 },
    { id: 3, label: 'Dashboard power-on sequence — lights, screen wake, gauge sweep', seconds: 4 },
    { id: 4, label: 'Driver POV interior pan across seats and console', seconds: 3 },
    { id: 5, label: 'Trunk / cargo space reveal', seconds: 2 },
    { id: 6, label: `Full exterior walk-around finale with ${finale}`, seconds: 3 },
  ];
}
