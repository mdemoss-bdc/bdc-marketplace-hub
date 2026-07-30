import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import VideoUploadDropzone from '@/components/VideoUploadDropzone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Sparkles, Link2, Loader2, Copy, CheckCheck,
  ArrowRight, Zap, X, Lock, Calendar, Clock, Terminal,
  Car, BellOff, RefreshCw, TrendingUp,
} from 'lucide-react';

interface ParsedListing {
  price: string;
  miles: string;
  retail_price?: string;
  doc_fee?: string;
  savings?: string;
  title: string;
  description: string;
  features: string[];
  hashtags: string;
  vehicle_summary: string;
  _usage?: { used: number; limit: number; remaining: number };
}

// ── Quota constants ───────────────────────────────────────────────────────────
const DAILY_LIMIT    = 3;
const TRIAL_DAYS     = 5;
const LIFETIME_LIMIT = 15;          // 3 posts × 5 days
const TRIAL_MS       = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// ── localStorage keys ─────────────────────────────────────────────────────────
const LS_DATE        = 'bdc_fg_date';
const LS_USED        = 'bdc_fg_used';
const LS_TRIAL_START = 'bdc_fg_trial_start';
const LS_TOTAL       = 'bdc_fg_total';          // lifetime generations

// ── Storage helpers ───────────────────────────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readDailyUsage(): number {
  try {
    const storedDate = localStorage.getItem(LS_DATE);
    const storedUsed = parseInt(localStorage.getItem(LS_USED) || '0', 10);
    if (storedDate === getTodayKey()) return isNaN(storedUsed) ? 0 : storedUsed;
    // New day — reset daily counter (lifetime stays)
    localStorage.setItem(LS_DATE, getTodayKey());
    localStorage.setItem(LS_USED, '0');
    return 0;
  } catch {
    return 0;
  }
}

function incrementDailyUsage(): number {
  try {
    const current = readDailyUsage();
    const next = Math.min(current + 1, DAILY_LIMIT);
    localStorage.setItem(LS_DATE, getTodayKey());
    localStorage.setItem(LS_USED, String(next));
    return next;
  } catch {
    return 1;
  }
}

function readLifetimeTotal(): number {
  try {
    const raw = parseInt(localStorage.getItem(LS_TOTAL) || '0', 10);
    return isNaN(raw) ? 0 : raw;
  } catch {
    return 0;
  }
}

function incrementLifetimeTotal(): number {
  try {
    const next = readLifetimeTotal() + 1;
    localStorage.setItem(LS_TOTAL, String(next));
    return next;
  } catch {
    return 1;
  }
}

function getTrialStart(): number | null {
  try {
    const raw = localStorage.getItem(LS_TRIAL_START);
    if (!raw) return null;
    const ts = parseInt(raw, 10);
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

function initTrialStart(): number {
  try {
    const existing = getTrialStart();
    if (existing !== null) return existing;
    const now = Date.now();
    localStorage.setItem(LS_TRIAL_START, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

function getTrialInfo(trialStart: number | null, lifetimeTotal: number): {
  dayNum: number;
  expired: boolean;
  hoursRemaining: number;
} {
  if (trialStart === null) {
    return { dayNum: 1, expired: false, hoursRemaining: TRIAL_DAYS * 24 };
  }
  const elapsed         = Date.now() - trialStart;
  const dayNum          = Math.floor(elapsed / 86_400_000) + 1;
  const timeExpired     = elapsed >= TRIAL_MS;
  const lifetimeExpired = lifetimeTotal >= LIFETIME_LIMIT;
  const hoursRemaining  = Math.max(0, Math.ceil((TRIAL_MS - elapsed) / 3_600_000));
  return { dayNum, expired: timeExpired || lifetimeExpired, hoursRemaining };
}

// ── Upgrade features list ─────────────────────────────────────────────────────
const UPGRADE_FEATURES = [
  'Unlimited AI-generated posts, every day',
  'Full inventory sync — every vehicle, automatically',
  'Bulk scheduling & Facebook feed integration',
  'Lead pipeline, appointments & BDC analytics',
];

// ── Upgrade modal reason type ─────────────────────────────────────────────────
type UpgradeReason = 'daily' | 'trial' | 'general';

export default function FreeGenerator() {
  const [result, setResult]   = useState<ParsedListing | null>(null);
  const [url, setUrl]         = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const [price, setPrice]             = useState('');
  const [retailPrice, setRetailPrice] = useState('');
  const [docFee, setDocFee]           = useState('');
  const [savings, setSavings]         = useState('');
  const [miles, setMiles]             = useState('');
  const [title, setTitle]             = useState('');
  const [description, setDescription] = useState('');
  const [hashtags, setHashtags]       = useState('');
  const [features, setFeatures]       = useState<string[]>([]);
  const [copied, setCopied]           = useState(false);
  const [videoFile, setVideoFile]     = useState<File | null>(null);

  // ── Usage / trial ─────────────────────────────────────────────────────────
  const [dailyUsed,     setDailyUsed]     = useState(0);
  const [lifetimeTotal, setLifetimeTotal] = useState(0);
  const [trialStart,    setTrialStart]    = useState<number | null>(null);

  // ── Upgrade modal ─────────────────────────────────────────────────────────
  const [upgradeReason, setUpgradeReason] = useState<UpgradeReason | null>(null);
  const showUpgradeModal = upgradeReason !== null;

  const { isSubscribed, user, token } = useAuth();
  const isAdmin = Boolean(user?.is_admin);

  // ── Derived ───────────────────────────────────────────────────────────────
  const trial          = getTrialInfo(trialStart, lifetimeTotal);
  const dailyRemaining = Math.max(0, DAILY_LIMIT - dailyUsed);
  const isDailyLimitHit = !isAdmin && dailyRemaining <= 0;
  const isTrialExpired  = !isAdmin && trial.expired;
  const isLocked        = isTrialExpired || isDailyLimitHit;
  const trialStarted    = trialStart !== null;
  const detectedCondition = /\bnew\b/i.test(title) ? 'New' : 'Used';

  const _fmt = (n: string) =>
    n ? `$${Number(n.replace(/\D/g, '')).toLocaleString()}` : '';

  const formattedPost = [
    title, '',
    price       ? `💲 Internet Price: ${_fmt(price)}`    : '',
    retailPrice ? `🏷️ Retail Price: ${_fmt(retailPrice)}` : '',
    savings     ? `💰 Money Saved: ${_fmt(savings)}`     : '',
    docFee      ? `📄 Doc Fee: ${_fmt(docFee)}`          : '',
    miles       ? `🚗 Mileage: ${Number(miles.replace(/\D/g, '')).toLocaleString()} miles` : '',
    videoFile   ? `📹 Video: ${videoFile.name}`          : '',
    '', description, '', hashtags,
  ].filter(l => l !== undefined && l !== '').join('\n').trim();

  // ── Hydrate from localStorage ─────────────────────────────────────────────
  useEffect(() => {
    setDailyUsed(readDailyUsage());
    setLifetimeTotal(readLifetimeTotal());
    setTrialStart(getTrialStart());
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleDevReset() {
    try {
      localStorage.removeItem(LS_TRIAL_START);
      localStorage.removeItem(LS_DATE);
      localStorage.removeItem(LS_USED);
      localStorage.removeItem(LS_TOTAL);
    } catch { /* ignore */ }
    setTrialStart(null);
    setDailyUsed(0);
    setLifetimeTotal(0);
    setUpgradeReason(null);
  }

  function openUpgrade(reason: UpgradeReason) {
    setUpgradeReason(reason);
  }

  async function handleGenerate() {
    if (!isAdmin) {
      if (isTrialExpired)  { openUpgrade('trial'); return; }
      if (isDailyLimitHit) { openUpgrade('daily'); return; }
    }
    const trimmed = url.trim();
    if (!trimmed) { setError('Please paste a vehicle URL first.'); return; }
    try { new URL(trimmed); } catch {
      setError("That doesn't look like a valid URL. It should start with http:// or https://");
      return;
    }
    setError('');
    setLoading(true);
    // Clear previous result before new generation
    setResult(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/v1/free-tool/parse', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (res.status === 429 && data.error === 'rate_limit') {
        const used = data.used ?? DAILY_LIMIT;
        setDailyUsed(used);
        openUpgrade('daily');
        return;
      }
      if (!res.ok || data.error) throw new Error(data.error || 'Server error');
      const d: ParsedListing = data;
      setResult(d);
      setPrice(String(d.price || ''));
      setRetailPrice(String(d.retail_price || ''));
      setDocFee(String(d.doc_fee || ''));
      setSavings(String(d.savings || ''));
      setMiles(String(d.miles || ''));
      setTitle(d.title || '');
      setDescription(d.description || '');
      setHashtags(d.hashtags || '');
      setFeatures(d.features || []);
      // Record usage
      const ts = initTrialStart();
      setTrialStart(ts);
      const newDaily    = incrementDailyUsage();
      const newLifetime = incrementLifetimeTotal();
      setDailyUsed(newDaily);
      setLifetimeTotal(newLifetime);
      // If they just hit a limit, show the modal after generation
      if (!isAdmin && newDaily >= DAILY_LIMIT) {
        // They used their last post — modal shown on next attempt, not now
      }
    } catch (e: unknown) {
      setError((e as Error).message || 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(formattedPost).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  function reset() {
    setResult(null); setUrl(''); setError('');
    setPrice(''); setRetailPrice(''); setDocFee(''); setSavings('');
    setMiles(''); setTitle(''); setDescription('');
    setHashtags(''); setFeatures([]); setCopied(false); setVideoFile(null);
  }

  // ── Upgrade modal copy ────────────────────────────────────────────────────
  const modalCopy = upgradeReason === 'daily'
    ? {
        icon:    <Clock className="w-8 h-8 text-amber-500" />,
        iconBg:  'bg-amber-500/10',
        title:   'Daily Free Limit Reached!',
        body:    `You've used your ${DAILY_LIMIT} free posts for today. Upgrade to Pro for unlimited daily AI listings, automatic inventory sync, and full Marketplace automation.`,
        note:    'Resets at midnight',
        cta:     'Upgrade to Pro — $75/mo',
        dismiss: "I'll come back tomorrow",
      }
    : upgradeReason === 'trial'
    ? {
        icon:    <Lock className="w-8 h-8 text-destructive" />,
        iconBg:  'bg-destructive/10',
        title:   'Your Free Preview Has Ended',
        body:    `You've reached the end of your ${TRIAL_DAYS}-day free trial (${LIFETIME_LIMIT} total posts). Upgrade to Pro for unlimited daily AI listings, automatic inventory sync, and full Marketplace automation.`,
        note:    null,
        cta:     'Upgrade to Pro — $75/mo',
        dismiss: null,
      }
    : {
        icon:    <Zap className="w-8 h-8 text-primary" />,
        iconBg:  'bg-primary/10',
        title:   'Upgrade to Marketplace Hub Pro',
        body:    'Manage and sync unlimited dealership inventory with automated AI post generation every day.',
        note:    null,
        cta:     'Upgrade to Pro — $75/mo',
        dismiss: 'Maybe later',
      };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">

      {/* ── Unified upgrade modal ──────────────────────────────────────────── */}
      {showUpgradeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl p-7 space-y-5">
            {modalCopy.dismiss && (
              <button
                onClick={() => setUpgradeReason(null)}
                className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            <div className="flex flex-col items-center text-center space-y-4 pt-1">
              <div className={`w-16 h-16 rounded-full flex items-center justify-center ${modalCopy.iconBg}`}>
                {modalCopy.icon}
              </div>
              <h2 className="text-xl font-bold tracking-tight">{modalCopy.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm">
                {modalCopy.body}
              </p>
            </div>

            {/* Progress bar — daily or trial */}
            {upgradeReason === 'daily' && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Daily posts used</span>
                  <span className="font-semibold text-foreground">{DAILY_LIMIT}/{DAILY_LIMIT}</span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full w-full bg-amber-500 rounded-full" />
                </div>
                <p className="text-xs text-muted-foreground text-right">{modalCopy.note}</p>
              </div>
            )}
            {upgradeReason === 'trial' && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Free trial</span>
                  <span className="font-semibold text-destructive">
                    {LIFETIME_LIMIT}/{LIFETIME_LIMIT} posts used
                  </span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: TRIAL_DAYS }).map((_, i) => (
                    <div key={i} className="flex-1 h-2 rounded-full bg-destructive" />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-right">{TRIAL_DAYS} of {TRIAL_DAYS} days used</p>
              </div>
            )}

            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {UPGRADE_FEATURES.map(f => (
                <li key={f} className="flex items-center gap-2">
                  <div className="w-4 h-4 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-2.5 h-2.5 text-primary" />
                  </div>
                  {f}
                </li>
              ))}
            </ul>

            <div className="space-y-2 pt-1">
              <a
                href="/pricing"
                className="flex items-center justify-center gap-2 w-full h-12 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 transition-opacity"
              >
                <Zap className="w-4 h-4" />
                {modalCopy.cta}
              </a>
              {modalCopy.dismiss && (
                <button
                  onClick={() => setUpgradeReason(null)}
                  className="w-full h-9 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted transition-colors"
                >
                  {modalCopy.dismiss}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Free AI Post Generator</h1>
          <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30 border text-[10px] font-bold px-2">
            FREE
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Paste any vehicle listing URL and get a Facebook Marketplace post in seconds — no account needed.
        </p>
      </div>

      {/* ── Admin mode banner ──────────────────────────────────────────────── */}
      {isAdmin && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-violet-500 flex-shrink-0" />
            <div>
              <p className="text-xs font-semibold text-violet-600 dark:text-violet-400">
                Admin Mode — All limits bypassed
              </p>
              <p className="text-[10px] text-muted-foreground">
                Daily caps, trial timers, and paywalls are disabled for your account
              </p>
            </div>
          </div>
          <button
            onClick={handleDevReset}
            className="flex-shrink-0 flex items-center gap-1.5 text-[11px] font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 border border-violet-400/40 hover:border-violet-500/60 rounded-md px-2.5 py-1 transition-colors"
          >
            <Terminal className="w-3 h-3" />
            Reset Trial Counter
          </button>
        </div>
      )}

      {/* ── Quota progress cards (non-admin) ──────────────────────────────── */}
      {!isAdmin && (
        <div className="grid grid-cols-2 gap-3">

          {/* Daily Limit card */}
          <div className={`rounded-xl border px-4 py-3 space-y-2 ${
            isDailyLimitHit
              ? 'border-amber-500/30 bg-amber-500/8'
              : 'border-border bg-card'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Clock className={`w-3.5 h-3.5 flex-shrink-0 ${isDailyLimitHit ? 'text-amber-500' : 'text-muted-foreground'}`} />
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Daily Limit</p>
              </div>
              {isDailyLimitHit && (
                <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400">Resets midnight</span>
              )}
            </div>
            <div className="flex items-end gap-1.5">
              <span className={`text-2xl font-bold leading-none ${isDailyLimitHit ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
                {dailyUsed}
              </span>
              <span className="text-sm text-muted-foreground mb-0.5">/ {DAILY_LIMIT} posts today</span>
            </div>
            <div className="flex gap-1">
              {Array.from({ length: DAILY_LIMIT }).map((_, i) => (
                <div
                  key={i}
                  className={`flex-1 h-1.5 rounded-full transition-colors ${
                    i < dailyUsed
                      ? isDailyLimitHit ? 'bg-amber-500' : 'bg-primary'
                      : 'bg-muted-foreground/20'
                  }`}
                />
              ))}
            </div>
            <p className={`text-xs font-semibold ${isDailyLimitHit ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}>
              {isDailyLimitHit
                ? 'Daily cap reached'
                : `${dailyRemaining} Post${dailyRemaining !== 1 ? 's' : ''} Available Today`}
            </p>
          </div>

          {/* Trial Progress card */}
          <div className={`rounded-xl border px-4 py-3 space-y-2 ${
            isTrialExpired
              ? 'border-destructive/25 bg-destructive/8'
              : trial.dayNum >= 4
              ? 'border-amber-500/25 bg-amber-500/8'
              : trialStarted
              ? 'border-border bg-card'
              : 'border-dashed border-border bg-muted/30'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Calendar className={`w-3.5 h-3.5 flex-shrink-0 ${
                  isTrialExpired ? 'text-destructive' : trial.dayNum >= 4 ? 'text-amber-500' : 'text-muted-foreground'
                }`} />
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Trial Progress</p>
              </div>
              {isTrialExpired && (
                <span className="text-[10px] font-bold text-destructive">Expired</span>
              )}
            </div>
            {trialStarted ? (
              <>
                <div className="flex items-end gap-1.5">
                  <span className={`text-2xl font-bold leading-none ${
                    isTrialExpired ? 'text-destructive' : trial.dayNum >= 4 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
                  }`}>
                    Day {Math.min(trial.dayNum, TRIAL_DAYS)}
                  </span>
                  <span className="text-sm text-muted-foreground mb-0.5">of {TRIAL_DAYS}</span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: TRIAL_DAYS }).map((_, i) => (
                    <div key={i} className={`flex-1 h-1.5 rounded-full transition-colors ${
                      i < Math.min(trial.dayNum, TRIAL_DAYS)
                        ? isTrialExpired ? 'bg-destructive'
                        : trial.dayNum >= TRIAL_DAYS ? 'bg-destructive'
                        : trial.dayNum >= 4 ? 'bg-amber-500'
                        : 'bg-primary'
                        : 'bg-muted-foreground/20'
                    }`} />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{lifetimeTotal}</span> / {LIFETIME_LIMIT} total posts used
                </p>
              </>
            ) : (
              <>
                <div className="flex items-end gap-1.5">
                  <span className="text-2xl font-bold leading-none text-muted-foreground/40">—</span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: TRIAL_DAYS }).map((_, i) => (
                    <div key={i} className="flex-1 h-1.5 rounded-full bg-muted-foreground/15" />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Starts on first generation</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Expired / locked notice ────────────────────────────────────────── */}
      {!isAdmin && isLocked && (
        <div
          className="rounded-xl border px-4 py-3 flex items-center justify-between gap-3 cursor-pointer"
          style={{
            background:   isTrialExpired ? 'hsl(var(--destructive) / 0.08)' : 'hsl(40 96% 60% / 0.08)',
            borderColor:  isTrialExpired ? 'hsl(var(--destructive) / 0.25)' : 'hsl(40 96% 60% / 0.3)',
          }}
          onClick={() => isTrialExpired ? openUpgrade('trial') : openUpgrade('daily')}
        >
          <p className={`text-sm font-medium ${isTrialExpired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
            {isTrialExpired
              ? `Your ${TRIAL_DAYS}-day free preview has ended.`
              : `You've used all ${DAILY_LIMIT} free posts for today. Come back tomorrow!`}
          </p>
          <a
            href="/pricing"
            className="flex-shrink-0 flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline underline-offset-2"
            onClick={e => e.stopPropagation()}
          >
            <Zap className="w-3.5 h-3.5" />Upgrade
          </a>
        </div>
      )}

      {/* ── URL Input card ────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        {/* Card header */}
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Link2 className="w-4 h-4 text-muted-foreground" />
            Vehicle Listing URL
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openUpgrade('general')}
            className="gap-1.5 text-muted-foreground border-muted-foreground/30 text-xs"
          >
            <Lock className="w-3 h-3" />
            <RefreshCw className="w-3 h-3" />
            Sync All Inventory
          </Button>
        </div>

        {/* URL + Generate */}
        <div className="flex gap-2">
          <Input
            type="url"
            placeholder="https://www.mosescars.com/used-..."
            value={url}
            onChange={e => { setUrl(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && !loading && !isLocked && handleGenerate()}
            className="flex-1 h-11"
            disabled={loading || isLocked}
          />
          <Button
            onClick={handleGenerate}
            disabled={loading || !url.trim() || isLocked}
            className="h-11 px-5 gap-2 whitespace-nowrap"
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" />Generating…</>
              : isTrialExpired
              ? <><Lock className="w-4 h-4" />Trial Ended</>
              : isDailyLimitHit
              ? <><Lock className="w-4 h-4" />Come Back Tomorrow</>
              : result
              ? <><Sparkles className="w-4 h-4" />Generate Next →</>
              : <><Sparkles className="w-4 h-4" />Generate Listing</>}
          </Button>
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {/* Remaining posts inline badge — shown before first generation or between vehicles */}
        {!isAdmin && !isLocked && (
          <div className="flex items-center justify-between pt-1">
            {!trialStarted ? (
              <button
                type="button"
                className="text-xs text-primary hover:underline underline-offset-2 truncate max-w-[60%]"
                onClick={() => setUrl('https://www.mosescars.com/used-St+Albans-2022-Honda-Accord-Sport-2.0T-1HGCV2F36NA807141')}
              >
                Try an example: 2022 Honda Accord Sport — Moses Cars
              </button>
            ) : (
              <button
                type="button"
                className="text-xs text-primary hover:underline underline-offset-2 truncate max-w-[60%]"
                onClick={() => setUrl('https://www.mosescars.com/used-St+Albans-2022-Honda-Accord-Sport-2.0T-1HGCV2F36NA807141')}
              >
                Try an example: 2022 Honda Accord Sport — Moses Cars
              </button>
            )}
            <div className="flex items-center gap-2 flex-shrink-0 text-muted-foreground">
              <div className="flex gap-0.5">
                {Array.from({ length: DAILY_LIMIT }).map((_, i) => (
                  <div key={i} className={`w-2 h-2 rounded-full ${
                    i < dailyUsed ? 'bg-primary' : 'bg-muted-foreground/25'
                  }`} />
                ))}
              </div>
              <span className="text-xs font-medium whitespace-nowrap">
                {dailyRemaining} Post{dailyRemaining !== 1 ? 's' : ''} Available Today
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Result card ───────────────────────────────────────────────────── */}
      {result && (
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">

          {/* Table-style column header strip */}
          <div className="border-b border-border bg-muted/40 px-4 py-2 grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vehicle</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-12 text-center">Cond.</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-20 text-center">Miles</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-20 text-center">Price</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-24 text-center">Feed Status</span>
            <span className="w-8" />
          </div>

          {/* Vehicle data row */}
          <div className="px-4 py-3 grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-3 border-b border-border">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-14 h-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                <Car className="w-6 h-6 text-muted-foreground/30" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-sm leading-tight truncate">{title}</div>
                {result.vehicle_summary && result.vehicle_summary !== title && (
                  <div className="text-xs text-muted-foreground truncate mt-0.5">{result.vehicle_summary}</div>
                )}
              </div>
            </div>
            <div className="w-12 flex justify-center">
              <Badge className={detectedCondition === 'New'
                ? 'bg-blue-600 text-white border-0 text-[10px] px-2 py-0.5'
                : 'bg-amber-500 text-white border-0 text-[10px] px-2 py-0.5'}>
                {detectedCondition}
              </Badge>
            </div>
            <div className="w-20 text-center text-xs text-muted-foreground whitespace-nowrap">
              {miles ? `${Number(miles.replace(/\D/g, '')).toLocaleString()} mi` : '—'}
            </div>
            <div className="w-20 text-center font-bold text-primary whitespace-nowrap text-sm">
              {price ? _fmt(price) : '—'}
            </div>
            <div className="w-24 flex justify-center">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
                <BellOff className="w-2.5 h-2.5" />Preview Only
              </span>
            </div>
            <div className="w-8 flex justify-end">
              <button
                onClick={reset}
                className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Clear and start over"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* AI Generated Copy panel */}
          <div className="px-5 py-5 bg-muted/30 space-y-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" />
              AI Generated Listing Copy
            </p>
            <div className="grid sm:grid-cols-3 gap-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Listing Title</p>
                <p className="text-sm font-bold leading-snug">{title}</p>
                {(price || retailPrice || savings || docFee) && (
                  <div className="mt-3 space-y-0.5">
                    {price       && <p className="text-xs font-mono text-foreground/80">💲 {_fmt(price)}</p>}
                    {retailPrice && <p className="text-xs font-mono text-muted-foreground line-through">🏷️ {_fmt(retailPrice)}</p>}
                    {savings     && <p className="text-xs font-mono text-green-600 dark:text-green-400">💰 Save {_fmt(savings)}</p>}
                    {docFee      && <p className="text-xs font-mono text-muted-foreground">📄 Doc: {_fmt(docFee)}</p>}
                  </div>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Key Features</p>
                {features.length > 0 ? (
                  <ul className="space-y-0.5">
                    {features.map((f, i) => (
                      <li key={i} className="text-xs text-foreground/90">• {f}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground italic">No features extracted</p>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Description</p>
                  <p className="text-xs text-foreground/80 leading-relaxed line-clamp-6">{description}</p>
                </div>
                {hashtags && (
                  <p className="text-xs text-primary/80 font-medium leading-relaxed">{hashtags}</p>
                )}
                <Button size="sm" className="gap-2 w-full" onClick={handleCopy}>
                  {copied
                    ? <><CheckCheck className="w-3.5 h-3.5" />Copied!</>
                    : <><Copy className="w-3.5 h-3.5" />Copy Full Post</>}
                </Button>
              </div>
            </div>

            <VideoUploadDropzone
              isPro={isSubscribed}
              videoFile={videoFile}
              onFileChange={setVideoFile}
            />
          </div>

          {/* Footer actions */}
          <div className="px-4 py-3 border-t border-border bg-card flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={reset} className="gap-1.5 h-8">
              ← Start Over
            </Button>
            {!isAdmin && dailyRemaining > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setResult(null); setUrl(''); }}
                className="gap-1.5 h-8"
              >
                <TrendingUp className="w-3.5 h-3.5" />
                Generate Another ({dailyRemaining} left today)
              </Button>
            ) : !isAdmin ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openUpgrade('daily')}
                className="gap-1.5 h-8 text-muted-foreground"
              >
                <Lock className="w-3.5 h-3.5" />
                Daily Limit Reached
              </Button>
            ) : null}
            <div className="flex-1" />
            {!isAdmin && (
              <p className="text-xs text-muted-foreground hidden sm:block">
                {dailyRemaining > 0
                  ? `${dailyRemaining} post${dailyRemaining !== 1 ? 's' : ''} remaining today`
                  : 'Daily limit reached — resets at midnight'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Upgrade CTA banner ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 flex gap-4 items-start">
        <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Zap className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold leading-snug">
            Tired of posting manually one by one?
          </p>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Sync your <strong>entire inventory automatically</strong> with BDC Manager Desk Pro.
            AI posts for every vehicle, bulk scheduling, and Facebook feed integration — all in one place.
          </p>
          <a
            href="/pricing"
            className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-primary hover:underline underline-offset-2"
          >
            Get BDC Manager Desk Pro — $75/mo
            <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
