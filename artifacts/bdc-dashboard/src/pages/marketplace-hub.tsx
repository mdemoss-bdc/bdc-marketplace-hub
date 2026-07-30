import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RefreshCw,
  Search,
  Car,
  Loader2,
  Bot,
  Copy,
  CheckCheck,
  X,
  Tag,
  Gauge,
  Palette,
  TrendingUp,
  ShoppingBag,
  Store,
  CalendarClock,
  CheckCircle2,
  Clock3,
  MinusCircle,
  RotateCcw,
  ListOrdered,
  LayoutGrid,
  Sparkles,
  Rss,
  BellOff,
  Radio,
  Video,
  BookOpen,
  ExternalLink,
  Link2,
  Settings,
  ChevronDown,
  ChevronUp,
  Save,
  Check,
  AlertTriangle,
  PauseCircle,
  PlayCircle,
  Ban,
  Plus,
  Trash2,
} from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import VideoUploadDropzone from '@/components/VideoUploadDropzone';

const API_BASE = '/api';

// ─── Types ───────────────────────────────────────────────────────────────────

type PostedStatus = 'not_posted' | 'posted';

interface Vehicle {
  id: number;
  vin: string;
  stock_number: string;
  condition: 'New' | 'Used';
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  price: number;
  retail_price: number;
  doc_fee: number;
  savings: number;
  exterior_color: string;
  interior_color: string;
  image_url: string;
  location: string;
  dealership_group?: string;
  status: 'ACTIVE' | 'SOLD';
  posted_status: PostedStatus;
  last_seen: string;
}

interface GeneratedPost {
  title: string;
  features: string[];
  description: string;
  hashtags: string;
}

interface Counts {
  ACTIVE: number;
  SOLD: number;
  total: number;
  posted: number;
}

interface QueueItem {
  id: number;
  queue_date: string;
  vin: string;
  stock_number: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  scheduled_time: string;
  status: 'Pending' | 'Posted' | 'Skipped';
  posted_at: string | null;
}

interface QueueStats {
  Pending: number;
  Posted: number;
  Skipped: number;
  total: number;
  date: string;
}

type ActiveTab = 'publisher' | 'inventory' | 'queue';

// ─── Publisher (marketplace_queue) types ─────────────────────────────────────
// Backed by /api/marketplace/* — open on the local engine, no token required.

type PublisherStatus = 'scheduled' | 'posted' | 'failed' | 'paused';

interface PublisherItem {
  id: number;
  vin: string;
  stock_number: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  price: number;
  status: PublisherStatus;
  scheduled_time: string | null;
  posted_at: string | null;
  ai_description: string;
  error_message: string;
  vehicle_title: string;
  scheduled_local: string | null;
  posted_local: string | null;
  in_window: boolean | null;
  minutes_until_post: number | null;
  overdue: boolean;
}

interface PublisherQuota {
  posts_today: number;
  daily_cap: number;
  remaining: number;
  cap_reached: boolean;
  label: string;
  window: string;
}

interface PublisherQueue {
  items: PublisherItem[];
  total: number;
  counts: Record<PublisherStatus, number>;
  quota: PublisherQuota;
}

const AUTO_PUBLISH_KEY = 'marketplace_auto_publish';
const SETTINGS_CACHE_KEY = 'marketplace_scraper_settings';

interface InventoryLocationConfig {
  location_name: string;
  inventory_url_new: string;
  inventory_url_used: string;
  csv_enabled: boolean;
  csv_url: string;
}

type SettingsCache = Record<string, unknown>;

function emptyLocationRow(): InventoryLocationConfig {
  return {
    location_name: '',
    inventory_url_new: '',
    inventory_url_used: '',
    csv_enabled: false,
    csv_url: '',
  };
}

function normalizeLocationConfigs(raw: unknown): InventoryLocationConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => {
      const enabledRaw = item.csv_enabled ?? item.csvEnabled ?? false;
      const csv_enabled = typeof enabledRaw === 'string'
        ? ['1', 'true', 'yes', 'on'].includes(enabledRaw.trim().toLowerCase())
        : Boolean(enabledRaw);
      return {
        location_name: String(item.location_name ?? item.name ?? item.location ?? '').trim(),
        inventory_url_new: String(item.inventory_url_new ?? item.new_url ?? item.newUrl ?? '').trim(),
        inventory_url_used: String(item.inventory_url_used ?? item.used_url ?? item.usedUrl ?? '').trim(),
        csv_enabled,
        csv_url: String(item.csv_url ?? item.csvUrl ?? item.csv_feed_url ?? '').trim(),
      };
    })
    .filter(row =>
      row.location_name
      || row.inventory_url_new
      || row.inventory_url_used
      || row.csv_url
      || row.csv_enabled
    );
}

/** Last-saved scraper/Meta settings, so the form survives reloads and outages. */
function readCachedSettings(): SettingsCache | null {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as SettingsCache : null;
  } catch {
    return null;
  }
}

function writeCachedSettings(values: SettingsCache) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(values));
  } catch {
    /* quota or private mode — the server save still carries the values */
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n ? `$${n.toLocaleString()}` : '—';
}
function fmtMiles(n: number) {
  if (!n || n < 10) return n <= 0 ? '—' : `${n} mi`;
  return `${n.toLocaleString()} mi`;
}
function relTime(iso: string) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtTime(t: string) {
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}
function fmtDate(d: string) {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ─── Posting Status Badge ─────────────────────────────────────────────────────

function PostingBadge({ status, orphaned = false }: { status: PostedStatus; orphaned?: boolean }) {
  if (status === 'posted' && orphaned) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400 whitespace-nowrap" title="This vehicle was removed from your inventory feed but is still marked as posted. Remove it from the feed to clear the listing.">
        <AlertTriangle className="w-2.5 h-2.5" />Still in Feed
      </span>
    );
  }
  if (status === 'posted') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
        <Radio className="w-2.5 h-2.5" />In Feed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
      <BellOff className="w-2.5 h-2.5" />Not Posted
    </span>
  );
}

// ─── AI Post Panel (expanded table row) ──────────────────────────────────────

function AiPostPanel({ post, onCopy, copyDone, videoFile, onVideoChange }: {
  post: GeneratedPost;
  onCopy: () => void;
  copyDone: boolean;
  videoFile: File | null;
  onVideoChange: (f: File | null) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-3 gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Listing Title</p>
          <p className="text-sm font-bold leading-snug">{post.title}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Key Features</p>
          <ul className="space-y-0.5">
            {post.features.map((f, i) => (
              <li key={i} className="text-xs text-foreground/90">• {f}</li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Description</p>
            <p className="text-xs text-foreground/80 leading-relaxed line-clamp-5">{post.description}</p>
          </div>
          <p className="text-xs text-primary/80 font-medium">{post.hashtags}</p>
          <Button size="sm" className="gap-2 w-full" onClick={onCopy}>
            {copyDone
              ? <><CheckCheck className="w-3.5 h-3.5" />Copied!</>
              : <><Copy className="w-3.5 h-3.5" />Copy Full Post</>}
          </Button>
        </div>
      </div>
      {/* Walkaround video — all marketplace users are Pro-subscribed */}
      <div className="border-t border-border/60 pt-4">
        <VideoUploadDropzone isPro videoFile={videoFile} onFileChange={onVideoChange} compact />
      </div>
    </div>
  );
}

// ─── Queue Status Badge ───────────────────────────────────────────────────────

function QueueStatusBadge({ status }: { status: QueueItem['status'] }) {
  if (status === 'Posted')
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 border border-green-500/30 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:text-green-400"><CheckCircle2 className="w-3 h-3" />Posted</span>;
  if (status === 'Skipped')
    return <span className="inline-flex items-center gap-1 rounded-full bg-muted border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground"><MinusCircle className="w-3 h-3" />Skipped</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 border border-blue-500/30 px-2.5 py-0.5 text-xs font-semibold text-sky-300 dark:text-blue-400"><Clock3 className="w-3 h-3" />Pending</span>;
}

// ─── Publisher: status badge ──────────────────────────────────────────────────

function PublisherBadge({ status }: { status: PublisherStatus }) {
  const map: Record<PublisherStatus, { cls: string; icon: typeof Clock3; label: string }> = {
    scheduled: {
      cls: 'border-amber-300/40 bg-amber-400/15 text-amber-200',
      icon: Clock3,
      label: 'Scheduled',
    },
    posted: {
      cls: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
      icon: CheckCircle2,
      label: 'Posted',
    },
    paused: {
      cls: 'border-slate-600 bg-slate-800/70 text-slate-300',
      icon: PauseCircle,
      label: 'Paused',
    },
    failed: {
      cls: 'border-red-400/40 bg-red-500/15 text-red-200',
      icon: AlertTriangle,
      label: 'Failed',
    },
  };
  const { cls, icon: Icon, label } = map[status];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
      cls,
    )}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// ─── Publisher: quota bar ─────────────────────────────────────────────────────

function QuotaBar({ quota }: { quota: PublisherQuota }) {
  const pct = quota.daily_cap > 0
    ? Math.min(100, Math.round((quota.posts_today / quota.daily_cap) * 100))
    : 0;
  const tone =
    quota.cap_reached ? 'from-red-400 to-red-600'
      : pct >= 70     ? 'from-amber-300 to-amber-500'
      :                 'from-emerald-300 to-emerald-500';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur-md">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Daily Quota Usage
          </p>
          <p className="mt-1 font-display text-2xl font-bold tabular-nums tracking-tight text-slate-100">
            {quota.posts_today}
            <span className="text-slate-500">/{quota.daily_cap}</span>
            <span className="ml-2 text-xs font-medium text-slate-400">Posts Used Today</span>
          </p>
        </div>
        <span className={cn(
          'rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
          quota.cap_reached
            ? 'border-red-400/40 bg-red-500/15 text-red-200'
            : 'border-slate-700 bg-slate-950/60 text-slate-400',
        )}>
          {quota.cap_reached ? 'Cap Reached' : `${quota.remaining} Left`}
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-950/80 ring-1 ring-inset ring-white/[0.06]">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-500', tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Posting window {quota.window} · auto-publish pauses outside these hours
      </p>
    </div>
  );
}

// ─── Publisher: metric tile ───────────────────────────────────────────────────

function PublisherStat({
  label, value, sub, icon: Icon, tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Clock3;
  tone?: 'amber' | 'emerald';
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <Icon className={cn(
          'h-3.5 w-3.5',
          tone === 'amber' ? 'text-amber-300' : tone === 'emerald' ? 'text-emerald-300' : 'text-slate-500',
        )} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      </div>
      <p className={cn(
        'mt-1.5 font-display text-2xl font-bold tabular-nums tracking-tight',
        tone === 'amber' ? 'text-amber-100' : tone === 'emerald' ? 'text-emerald-200' : 'text-slate-100',
      )}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

// ─── Publisher View — Facebook Marketplace Publishing Command Center ──────────

function PublisherView() {
  const [queue, setQueue] = useState<PublisherQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const [autoPublish, setAutoPublish] = useState(
    () => localStorage.getItem(AUTO_PUBLISH_KEY) !== 'off',
  );

  // Copy drawer
  const [copyItem, setCopyItem] = useState<PublisherItem | null>(null);
  const [copyText, setCopyText] = useState('');
  const [copyLoading, setCopyLoading] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copySource, setCopySource] = useState('');
  const [clipDone, setClipDone] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');

  const fetchQueue = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/marketplace/queue`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load publisher queue');
      setQueue(data as PublisherQueue);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load publisher queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchQueue(); }, [fetchQueue]);

  // Keep the quota gauge and countdowns fresh
  useEffect(() => {
    const id = window.setInterval(() => void fetchQueue(true), 30_000);
    return () => window.clearInterval(id);
  }, [fetchQueue]);

  const toggleAutoPublish = (on: boolean) => {
    setAutoPublish(on);
    localStorage.setItem(AUTO_PUBLISH_KEY, on ? 'on' : 'off');
  };

  const nextSlot = useMemo(() => {
    if (!queue) return null;
    const upcoming = queue.items
      .filter(i => i.status === 'scheduled' && i.scheduled_time)
      .sort((a, b) => (a.scheduled_time || '').localeCompare(b.scheduled_time || ''));
    return upcoming[0] || null;
  }, [queue]);

  const openCopyDrawer = async (item: PublisherItem) => {
    setCopyItem(item);
    setCopyText(item.ai_description || '');
    setCopyError('');
    setCopySource('');
    setClipDone(false);
    setPublishMsg('');
    setCopyLoading(true);
    try {
      const res = await fetch(`${API_BASE}/marketplace/generate-copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: item.vin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Copy generation failed');
      setCopyText(data.ai_description || '');
      setCopySource(data.source || '');
    } catch (e: unknown) {
      setCopyError(e instanceof Error ? e.message : 'Copy generation failed');
    } finally {
      setCopyLoading(false);
    }
  };

  const handleClipboard = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setClipDone(true);
      toast({
        title: 'Marketplace Copy Copied!',
        description: 'Paste it into your Facebook Marketplace listing.',
        className: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
      });
      window.setTimeout(() => setClipDone(false), 2200);
    } catch {
      setCopyError('Clipboard copy failed — select the text manually.');
    }
  };

  /** Save the edited copy back to the queue row, optionally publishing now. */
  const submitSchedule = async (publishNow: boolean) => {
    if (!copyItem) return;
    setPublishing(true);
    setPublishMsg('');
    try {
      const res = await fetch(`${API_BASE}/marketplace/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vin: copyItem.vin,
          ai_description: copyText,
          publish_now: publishNow,
          ...(publishNow ? {} : { scheduled_time: copyItem.scheduled_time || undefined }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || (res.status === 429 ? 'Daily cap reached' : 'Request failed'));
      }
      setPublishMsg(publishNow ? 'Published to Marketplace queue.' : 'Copy saved to schedule.');
      await fetchQueue(true);
      window.setTimeout(() => { setCopyItem(null); setPublishMsg(''); }, 1400);
    } catch (e: unknown) {
      setCopyError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setPublishing(false);
    }
  };

  const handlePauseResume = async (item: PublisherItem) => {
    setBusyId(item.id);
    const next: PublisherStatus = item.status === 'paused' ? 'scheduled' : 'paused';
    try {
      const res = await fetch(`${API_BASE}/marketplace/queue/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, status: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Status update failed');
      }
      await fetchQueue(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Status update failed');
    } finally {
      setBusyId(null);
    }
  };

  const quota = queue?.quota;
  const counts = queue?.counts;

  return (
    <div className="space-y-5">
      {/* Header + auto-publish toggle */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 backdrop-blur-md">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Radio className="h-5 w-5 text-amber-300" />
              <h2 className="font-display text-lg font-bold text-slate-100">
                Marketplace Publishing Command Center
              </h2>
            </div>
            <p className="max-w-xl text-sm text-slate-400">
              Up to <span className="font-semibold text-slate-200">{quota?.daily_cap ?? 10} listings</span> per day,
              posted between <span className="font-semibold text-slate-200">8:00 AM – 9:00 PM</span>.
              Review AI copy before anything goes live.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetchQueue()}
              className="h-8 gap-1.5 border-slate-700/60 bg-white/[0.03] text-slate-300 hover:border-amber-300/30 hover:text-amber-100"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            <div className="flex items-center gap-2.5 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <div className="text-right">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Auto-Publish
                </p>
                <p className={cn(
                  'text-[11px] font-semibold',
                  autoPublish ? 'text-emerald-300' : 'text-slate-400',
                )}>
                  {autoPublish ? 'Schedule Active' : 'Paused'}
                </p>
              </div>
              <Switch
                checked={autoPublish}
                onCheckedChange={toggleAutoPublish}
                aria-label="Toggle auto-publish schedule"
              />
            </div>
          </div>
        </div>

        {!autoPublish && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            <BellOff className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              Auto-publish is paused. Scheduled listings stay queued until you re-enable it
              or publish them manually.
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Quota bar + counters */}
      {quota && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <QuotaBar quota={quota} />
          </div>
          <PublisherStat
            label="Active Queue"
            value={String(counts?.scheduled ?? 0)}
            sub={`${counts?.paused ?? 0} paused · ${counts?.failed ?? 0} failed`}
            icon={Clock3}
            tone="amber"
          />
          <PublisherStat
            label="Published Today"
            value={String(quota.posts_today)}
            sub={nextSlot
              ? `Next slot ${nextSlot.scheduled_local}`
              : 'No upcoming slots'}
            icon={CheckCircle2}
            tone="emerald"
          />
        </div>
      )}

      {/* Queue cards */}
      {loading && !queue ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
        </div>
      ) : !queue || queue.items.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 px-6 py-16 text-center backdrop-blur-md">
          <ShoppingBag className="mx-auto h-8 w-8 text-slate-600" />
          <p className="mt-3 text-sm text-slate-400">
            Nothing queued yet. Schedule a vehicle from the Inventory tab.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {queue.items.map(item => (
            <article
              key={item.id}
              className={cn(
                'overflow-hidden rounded-xl border bg-slate-900/80 backdrop-blur-md transition-colors',
                item.status === 'failed'
                  ? 'border-red-500/40'
                  : item.overdue
                    ? 'border-amber-400/40'
                    : 'border-slate-800',
              )}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 px-4 py-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-100">
                    {item.vehicle_title || item.vin}
                  </h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                    <span className="font-mono text-slate-400">{item.vin}</span>
                    {item.stock_number && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span>Stock #{item.stock_number}</span>
                      </>
                    )}
                    {item.price > 0 && (
                      <>
                        <span className="text-slate-700">·</span>
                        <span className="font-semibold text-amber-200/90">
                          ${item.price.toLocaleString()}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <PublisherBadge status={item.status} />
              </div>

              <div className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  {item.status === 'posted' ? (
                    <span className="text-emerald-300/90">
                      Posted {item.posted_local}
                    </span>
                  ) : item.scheduled_local ? (
                    <span className={cn(item.overdue ? 'text-amber-200' : 'text-slate-400')}>
                      {item.overdue ? 'Overdue since' : 'Scheduled'} {item.scheduled_local}
                      {item.minutes_until_post !== null && !item.overdue && (
                        <span className="ml-1 text-slate-500">
                          (in {Math.round(item.minutes_until_post)}m)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-500">No slot assigned</span>
                  )}
                  {item.in_window === false && (
                    <span className="text-red-300/90">Outside posting window</span>
                  )}
                </div>

                {item.error_message && (
                  <p className="rounded-md border border-red-400/25 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-200">
                    {item.error_message}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 pt-0.5">
                  <Button
                    size="sm"
                    onClick={() => void openCopyDrawer(item)}
                    className="h-8 gap-1.5 border-0 bg-amber-400/90 px-3 text-xs font-semibold text-slate-950 hover:bg-amber-300"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Generate Marketplace Copy
                  </Button>
                  {item.status !== 'posted' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === item.id}
                      onClick={() => void handlePauseResume(item)}
                      className="h-8 gap-1.5 border-slate-700/60 bg-white/[0.03] px-3 text-xs text-slate-200 hover:border-amber-300/30 hover:text-amber-100"
                    >
                      {busyId === item.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : item.status === 'paused'
                          ? <PlayCircle className="h-3.5 w-3.5" />
                          : <PauseCircle className="h-3.5 w-3.5" />}
                      {item.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ── Marketplace copy drawer ─────────────────────────────────────── */}
      <Sheet open={!!copyItem} onOpenChange={open => { if (!open) setCopyItem(null); }}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-slate-800 bg-slate-950 text-slate-100 sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle className="text-slate-100">
              Marketplace Copy — {copyItem?.vehicle_title || copyItem?.vin}
            </SheetTitle>
            <SheetDescription className="text-slate-400">
              Review and edit before publishing. Specs, VIN, and BDC contact steps are
              generated from live inventory.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            {copyItem && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-[11px] text-slate-400">
                <span className="font-mono text-slate-200">{copyItem.vin}</span>
                {copyItem.stock_number && <span>· Stock #{copyItem.stock_number}</span>}
                {copyItem.price > 0 && (
                  <span className="font-semibold text-amber-200/90">
                    · ${copyItem.price.toLocaleString()}
                  </span>
                )}
                {copySource && (
                  <span className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 uppercase tracking-wider text-slate-500">
                    {copySource === 'openai' ? 'AI polished' : 'Template'}
                  </span>
                )}
              </div>
            )}

            {copyLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating listing copy…
              </div>
            ) : (
              <>
                <Textarea
                  value={copyText}
                  onChange={e => setCopyText(e.target.value)}
                  rows={18}
                  className="resize-none border-slate-700/60 bg-slate-900/80 font-mono text-[12px] leading-relaxed text-slate-100 focus-visible:ring-amber-300/40"
                />
                <p className="text-[11px] tabular-nums text-slate-500">
                  {copyText.length} characters
                </p>
              </>
            )}

            {copyError && (
              <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {copyError}
              </div>
            )}
            {publishMsg && (
              <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-200">
                {publishMsg}
              </div>
            )}

            <div className="flex flex-col gap-2 pb-6">
              <Button
                onClick={() => void submitSchedule(true)}
                disabled={!copyText || copyLoading || publishing || quota?.cap_reached}
                className="h-10 gap-2 border-0 bg-emerald-500 font-semibold text-white hover:bg-emerald-400 disabled:opacity-50"
              >
                {publishing
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Radio className="h-4 w-4" />}
                {quota?.cap_reached ? 'Daily Cap Reached' : 'Publish Now'}
              </Button>
              <Button
                variant="outline"
                onClick={() => void submitSchedule(false)}
                disabled={!copyText || copyLoading || publishing}
                className="h-10 gap-2 border-slate-700/60 bg-white/[0.03] text-slate-200 hover:border-amber-300/30 hover:text-amber-100"
              >
                <CalendarClock className="h-4 w-4" />
                Save to Schedule
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleClipboard()}
                disabled={!copyText || copyLoading}
                className={cn(
                  'h-10 gap-2 border-slate-700/60 bg-white/[0.03]',
                  clipDone ? 'border-emerald-400/40 text-emerald-300' : 'text-slate-200 hover:border-amber-300/30 hover:text-amber-100',
                )}
              >
                {clipDone
                  ? <><CheckCheck className="h-4 w-4" /> Copied!</>
                  : <><Copy className="h-4 w-4" /> Copy to Clipboard</>}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Queue View ───────────────────────────────────────────────────────────────

function QueueView({ token }: { token: string }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<QueueStats>({ Pending: 0, Posted: 0, Skipped: 0, total: 0, date: '' });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [genMsg, setGenMsg] = useState('');

  const today = new Date().toISOString().slice(0, 10);

  const fetchQueue = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/marketplace/queue`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setQueue(data.queue ?? []);
      setStats(data.stats ?? { Pending: 0, Posted: 0, Skipped: 0, total: 0, date: today });
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  const handleGenerate = async (force = false) => {
    setGenerating(true); setGenMsg('');
    try {
      const res = await fetch(`${API_BASE}/v1/marketplace/queue/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data.skipped) {
        setGenMsg(`Queue already exists (${data.total_existing} items). Use Regenerate to replace it.`);
      } else {
        setGenMsg(`Scheduled ${data.generated} posts for today.`);
        await fetchQueue(true);
      }
    } catch { setGenMsg('Failed to generate queue.'); }
    finally { setGenerating(false); setTimeout(() => setGenMsg(''), 5000); }
  };

  const handleUpdateStatus = async (item: QueueItem, status: QueueItem['status']) => {
    setUpdatingId(item.id);
    try {
      await fetch(`${API_BASE}/v1/marketplace/queue/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: item.id, status }),
      });
      await fetchQueue(true);
    } catch { console.error('update failed'); }
    finally { setUpdatingId(null); }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md p-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <CalendarClock className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-bold">Posting Queue & Schedule</h2>
            </div>
            <p className="text-sm text-muted-foreground max-w-lg">
              Up to <span className="font-semibold text-foreground">10 vehicles</span> are scheduled each day
              between <span className="font-semibold text-foreground">8:00 AM – 9:00 PM</span>.
              Each vehicle rotates through the full inventory cycle before repeating.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {genMsg && <span className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-md max-w-[280px]">{genMsg}</span>}
            {queue.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => handleGenerate(true)} disabled={generating} className="gap-2">
                {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                Regenerate
              </Button>
            )}
            <Button size="sm" onClick={() => handleGenerate(false)} disabled={generating || queue.length > 0} className="gap-2">
              {generating ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Generating…</>
                : <><Sparkles className="w-3.5 h-3.5" />Generate Today's Queue</>}
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          {[
            { label: 'Total Scheduled', value: stats.total, color: 'text-foreground' },
            { label: 'Pending', value: stats.Pending, color: 'text-blue-600' },
            { label: 'Posted', value: stats.Posted, color: 'text-green-600' },
            { label: 'Skipped', value: stats.Skipped, color: 'text-muted-foreground' },
          ].map(s => (
            <div key={s.label} className="flex items-center gap-3 rounded-lg bg-muted/60 border border-border px-4 py-2.5 min-w-[100px]">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{s.label}</p>
                <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
              </div>
            </div>
          ))}
          <div className="ml-auto flex items-center self-center">
            <span className="text-xs text-muted-foreground font-medium">{fmtDate(today)}</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : queue.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center rounded-xl border border-dashed border-border">
          <CalendarClock className="w-12 h-12 text-muted-foreground/30" />
          <div>
            <p className="font-semibold text-muted-foreground">No posts scheduled for today</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Click "Generate Today's Queue" to schedule up to 10 vehicles.</p>
          </div>
          <Button size="sm" onClick={() => handleGenerate(false)} disabled={generating} className="gap-2">
            <Sparkles className="w-3.5 h-3.5" />Generate Today's Queue
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground w-24">Time</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vehicle</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground w-24">Stock #</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground w-28">VIN (last 8)</th>
                <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground w-28">Status</th>
                <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {queue.map((item) => {
                const isUpdating = updatingId === item.id;
                const isPast = item.scheduled_time < new Date().toTimeString().slice(0, 5);
                return (
                  <tr key={item.id} className={`transition-colors hover:bg-muted/30 ${item.status === 'Posted' ? 'opacity-70' : ''}`}>
                    <td className="px-4 py-3.5">
                      <span className={`font-mono text-sm font-semibold ${isPast && item.status === 'Pending' ? 'text-amber-600' : 'text-foreground'}`}>
                        {fmtTime(item.scheduled_time)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="font-medium">{item.year} {item.make} {item.model}</span>
                      {item.trim && <span className="ml-1.5 text-muted-foreground text-xs">{item.trim}</span>}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-muted-foreground">{(item.stock_number && item.stock_number !== 'N/A') ? item.stock_number : '—'}</td>
                    <td className="px-4 py-3.5 font-mono text-xs text-muted-foreground">{item.vin.slice(-8)}</td>
                    <td className="px-4 py-3.5"><QueueStatusBadge status={item.status} /></td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {isUpdating ? (
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        ) : item.status === 'Pending' ? (
                          <>
                            <Button size="sm" variant="outline"
                              className="h-7 px-2.5 text-xs gap-1 text-green-700 border-green-500/40 hover:bg-green-500/10"
                              onClick={() => handleUpdateStatus(item, 'Posted')}>
                              <CheckCircle2 className="w-3 h-3" />Mark Posted
                            </Button>
                            <Button size="sm" variant="ghost"
                              className="h-7 px-2.5 text-xs gap-1 text-muted-foreground"
                              onClick={() => handleUpdateStatus(item, 'Skipped')}>
                              <MinusCircle className="w-3 h-3" />Skip
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost"
                            className="h-7 px-2.5 text-xs gap-1 text-muted-foreground"
                            onClick={() => handleUpdateStatus(item, 'Pending')}>
                            <RotateCcw className="w-3 h-3" />Reset
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>{/* end overflow-x-auto */}
          <div className="px-4 py-3 border-t border-border bg-muted/20 text-xs text-muted-foreground">
            Posting window: 8:00 AM – 9:00 PM · Max 10 posts/day · Rotates through full inventory cycle before repeating
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inventory View ───────────────────────────────────────────────────────────

import { TrialBanner } from '@/components/TrialBanner';

/** Host → default dealership branding when Settings name/city are blank. */
function dealerBrandingFromUrl(inventoryUrl: string, dealerName = '') {
  let host = '';
  try {
    host = new URL(inventoryUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch { /* ignore */ }
  const registrable = host.split('.').slice(-2).join('.');
  if (registrable === 'universityfordwv.com' || host.includes('universityford')) {
    return {
      name: dealerName.trim() || 'University Ford',
      location: 'St. Albans / WV',
    };
  }
  if (registrable === 'mosescars.com' || host.includes('mosescars')) {
    return {
      name: dealerName.trim() || 'Moses Auto Group',
      location: 'Huntington, WV',
    };
  }
  return {
    name: dealerName.trim() || 'Our Dealership',
    location: '',
  };
}

function InventoryView({ token, dealerName = '', inventoryUrl = '', feedUserId = '', commerceCatalogId = '', onOpenMetaGuide }: {
  token: string;
  dealerName?: string;
  inventoryUrl?: string;
  feedUserId?: string;
  commerceCatalogId?: string;
  onOpenMetaGuide: () => void;
}) {
  const { authFetch } = useAuth();
  const queryClient = useQueryClient();

  // Read ?filter=posted from the URL so the dashboard card navigates here pre-filtered
  const search = useSearch();
  const urlFilter = new URLSearchParams(search).get('filter');
  const initialPostedFilter = urlFilter === 'posted' ? 'posted' : '';

  // Inventory data
  const [inventory, setInventory] = useState<Vehicle[]>([]);
  const [makes, setMakes] = useState<string[]>([]);
  const [counts, setCounts] = useState<Counts>({ ACTIVE: 0, SOLD: 0, total: 0, posted: 0 });
  const [lastSync, setLastSync] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [cancellingSync, setCancellingSync] = useState(false);
  const [syncSessionId, setSyncSessionId] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [syncPhase, setSyncPhase] = useState('');
  const [syncProgress, setSyncProgress] = useState({ synced: 0, total: 0, enriched: 0 });
  const [syncReason, setSyncReason] = useState('');
  // After Cancel Sync, ignore late status polls that would flip syncing back on.
  const userCancelledRef = useRef(false);

  // Filters
  const [filterCondition, setFilterCondition] = useState('');
  const [filterMake, setFilterMake] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterMinPrice, setFilterMinPrice] = useState('');
  const [filterMaxPrice, setFilterMaxPrice] = useState('');
  const [filterMinYear, setFilterMinYear] = useState('');
  const [filterMaxYear, setFilterMaxYear] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterPosted, setFilterPosted] = useState(initialPostedFilter);
  const [sortBy, setSortBy] = useState('');

  // Available filter options (populated from API)
  const [years, setYears] = useState<number[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);

  // Selection
  const [selectedVins, setSelectedVins] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);
  const [postMsg, setPostMsg] = useState('');

  // AI post generation / FB Post drawer
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerCopy, setDrawerCopy] = useState('');
  const [drawerTitle, setDrawerTitle] = useState('');
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [drawerSource, setDrawerSource] = useState('');
  const [drawerClipDone, setDrawerClipDone] = useState(false);
  // Legacy inline-expand state (kept for any cached posts; FB Post now uses the drawer)
  const [generatingVin, setGeneratingVin] = useState<string | null>(null);
  const [expandedVin, setExpandedVin] = useState<string | null>(null);
  const [posts, setPosts] = useState<Record<string, GeneratedPost>>({});
  // Trial-limit upgrade modal
  const [upgradeModal, setUpgradeModal] = useState<string | null>(null);
  const [copyDoneVin, setCopyDoneVin] = useState<string | null>(null);
  const [postingVins, setPostingVins] = useState<Set<string>>(new Set());
  const [videoFiles, setVideoFiles] = useState<Record<string, File | null>>({});


  const fetchInventory = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    const p = new URLSearchParams();
    // Location / make / model are filtered client-side for instant cascade.
    if (filterCondition) p.set('condition', filterCondition);
    if (filterMinPrice) p.set('min_price', filterMinPrice);
    if (filterMaxPrice) p.set('max_price', filterMaxPrice);
    if (filterMinYear) p.set('min_year', filterMinYear);
    if (filterMaxYear) p.set('max_year', filterMaxYear);
    if (filterPosted) p.set('posted_status', filterPosted);
    try {
      const res = await fetch(`${API_BASE}/marketplace/inventory?${p}`);
      const data = await res.json();
      setInventory(data.inventory ?? []);
      setMakes(data.makes ?? []);
      setModels(data.models ?? []);
      setYears(data.years ?? []);
      setLocations(data.locations ?? []);
      setCounts(data.counts ?? { ACTIVE: 0, SOLD: 0, total: 0, posted: 0 });
      setLastSync(data.last_sync ?? '');
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [filterCondition, filterMinPrice, filterMaxPrice, filterMinYear, filterMaxYear, filterPosted]);

  useEffect(() => { fetchInventory(); }, [fetchInventory]);

  // Fetch the last sync reason on mount so the empty-state message is
  // meaningful even when no sync was triggered in this session.
  useEffect(() => {
    fetch(`${API_BASE}/sync/status`)
      .then(r => r.json())
      .then(d => {
        if (d.reason) setSyncReason(d.reason);
        if (d.session_id) setSyncSessionId(d.session_id);
        // A sync already running (e.g. started before this mount) keeps the
        // button in its spinner state and resumes progress polling.
        if (d.syncing) {
          if (userCancelledRef.current) return;
          setSyncing(true);
          setSyncPhase(d.phase || 'fetching');
          setCancellingSync(d.cancel_status === 'cancelling' || d.phase === 'cancelling');
          setSyncMsg(
            d.cancel_status === 'cancelling' || d.phase === 'cancelling'
              ? 'Cancelling sync…'
              : 'Syncing inventory…',
          );
          void pollSyncStatus();
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear selection when inventory changes
  useEffect(() => { setSelectedVins(new Set()); }, [inventory]);

  /** Poll scrape progress until the engine reports done, then reload state. */
  const pollSyncStatus = useCallback(async () => {
    if (userCancelledRef.current) return;
    try {
      const res  = await fetch(`${API_BASE}/sync/status`);
      const data = await res.json();
      if (userCancelledRef.current) return;
      setSyncPhase(data.phase ?? '');
      setSyncProgress({ synced: data.synced ?? 0, total: data.total ?? 0, enriched: data.enriched ?? 0 });
      if (data.session_id) setSyncSessionId(data.session_id);
      if (data.cancel_status === 'cancelling' || data.phase === 'cancelling') {
        setCancellingSync(true);
        setSyncMsg('Cancelling sync…');
      }

      if (data.done || !data.syncing) {
        setSyncing(false);
        setCancellingSync(false);
        userCancelledRef.current = false;
        if (data.reason) setSyncReason(data.reason);
        // Pull the freshly scraped rows and refresh the rest of the dashboard.
        await fetchInventory(true);
        queryClient.invalidateQueries();
        setLastSync(data.last_sync || new Date().toISOString());

        const found = data.synced || data.vehicle_count || 0;
        // Only treat an explicit user-cancel reason as "stopped by user".
        // Terminal cancel_status alone can be leftover from errors/prior runs.
        const wasCancelled = data.reason === 'cancelled';
        if (data.error && !wasCancelled) {
          setSyncMsg(`Sync failed: ${data.error}`);
        } else {
          setSyncMsg(
            wasCancelled
              ? `Sync stopped by user. Partial inventory saved${found ? ` (${found.toLocaleString()} vehicles).` : '.'}`
              : found > 0
                ? `Sync complete. ${found.toLocaleString()} vehicles loaded.`
                : 'Sync complete. No vehicles were found at that URL.',
          );
        }
        setTimeout(() => { setSyncMsg(''); setSyncPhase(''); setSyncSessionId(''); }, 8000);
      } else {
        setTimeout(() => { void pollSyncStatus(); }, 1500);
      }
    } catch {
      if (userCancelledRef.current) return;
      setSyncing(false); setCancellingSync(false); setSyncPhase('');
      setSyncMsg('Lost contact with the scraper engine.');
      setTimeout(() => setSyncMsg(''), 5000);
    }
  }, [fetchInventory, queryClient]);

  const handleSync = async () => {
    userCancelledRef.current = false;
    setSyncing(true); setCancellingSync(false); setSyncPhase('starting');
    setSyncMsg('Syncing inventory…');
    setSyncProgress({ synced: 0, total: 0, enriched: 0 });
    setSyncSessionId('');

    // Token-free trigger — the engine resolves the account and scrapes the
    // configured Used/New inventory URLs.
    try {
      const startRes  = await fetch(`${API_BASE}/sync`, { method: 'POST' });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        setSyncing(false); setSyncPhase('');
        setSyncMsg(startData.error || 'Could not start the scraper.');
        setTimeout(() => setSyncMsg(''), 6000);
        return;
      }
      if (startData.session_id) setSyncSessionId(startData.session_id);
    } catch {
      setSyncing(false); setSyncPhase('');
      setSyncMsg('Could not reach the scraper engine.');
      setTimeout(() => setSyncMsg(''), 6000);
      return;
    }

    setTimeout(pollSyncStatus, 800);
  };

  const handleCancelSync = () => {
    if (!syncing && !cancellingSync) return;
    // Instant UI feedback — do not wait for the worker to finish the current page.
    userCancelledRef.current = true;
    setCancellingSync(true);
    setSyncing(false);
    setSyncPhase('cancelling');
    setSyncMsg('Cancelling sync…');

    const body = syncSessionId ? { session_id: syncSessionId } : {};
    void fetch(`${API_BASE}/scrape/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 404) {
          setSyncMsg(data.error || 'Could not cancel the sync.');
        }
        // Reload whatever the worker committed before abort.
        await fetchInventory(true);
        queryClient.invalidateQueries();
        setSyncMsg('Sync stopped by user. Partial inventory saved.');
        setTimeout(() => {
          setSyncMsg('');
          setSyncPhase('');
          setCancellingSync(false);
          setSyncSessionId('');
        }, 8000);
      })
      .catch(() => {
        setSyncMsg('Cancel requested — scraper may still be winding down.');
        setTimeout(() => {
          setSyncMsg('');
          setCancellingSync(false);
        }, 6000);
      });
  };

  // ── Posting actions ───────────────────────────────────────────────

  const handlePostVehicles = useCallback(async (vins: string[], action: 'post' | 'unpost') => {
    if (!vins.length) return;
    setPostingVins(prev => { const s = new Set(prev); vins.forEach(v => s.add(v)); return s; });
    if (vins.length > 1 || selectedVins.size > 1) setPosting(true);
    setPostMsg('');
    try {
      const res = await authFetch(`${API_BASE}/v1/marketplace/posting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vins, action }),
      });
      const data = await res.json();
      if (res.ok) {
        const label = action === 'post' ? 'Added to feed' : 'Removed from feed';
        setPostMsg(`${label}: ${data.updated} vehicle${data.updated !== 1 ? 's' : ''}.`);
        setSelectedVins(new Set());
        await fetchInventory(true);
        // Keep dashboard "Posted to Facebook" count in sync without waiting for the 15s poll
        queryClient.invalidateQueries({ queryKey: ['desk-analytics'] });
      } else {
        setPostMsg(data.error || 'Action failed.');
      }
    } catch { setPostMsg('Network error — please retry.'); }
    finally {
      setPostingVins(prev => { const s = new Set(prev); vins.forEach(v => s.delete(v)); return s; });
      setPosting(false);
      setTimeout(() => setPostMsg(''), 5000);
    }
  }, [authFetch, fetchInventory, selectedVins.size]);

  // Client-side sort (applied after server-side filters)
  const sortedInventory = useMemo(() => {
    if (!sortBy) return inventory;
    return [...inventory].sort((a, b) => {
      switch (sortBy) {
        case 'price_asc':    return (a.price || 0) - (b.price || 0);
        case 'price_desc':   return (b.price || 0) - (a.price || 0);
        case 'mileage_asc':  return (a.mileage || 0) - (b.mileage || 0);
        case 'mileage_desc': return (b.mileage || 0) - (a.mileage || 0);
        case 'year_desc':    return (b.year || 0) - (a.year || 0);
        case 'year_asc':     return (a.year || 0) - (b.year || 0);
        default: return 0;
      }
    });
  }, [inventory, sortBy]);

  // Unique rooftops from the live inventory pool (New + Used). Prefer values
  // present on vehicle rows; fall back to the API distinct list.
  const locationOptions = useMemo(() => {
    const fromRows = inventory.map(v => v.location).filter(Boolean) as string[];
    return Array.from(new Set([...fromRows, ...locations])).sort();
  }, [inventory, locations]);

  // Makes available at the selected rooftop (and current condition pool).
  const makeOptions = useMemo(() => {
    const pool = inventory.filter(v =>
      (!filterLocation || v.location === filterLocation)
      && (!filterCondition || v.condition === filterCondition),
    );
    return Array.from(new Set(pool.map(v => v.make).filter(Boolean))).sort();
  }, [inventory, filterLocation, filterCondition]);

  // Models for the selected make + rooftop.
  const modelOptions = useMemo(() => {
    if (!filterMake) return [];
    const pool = inventory.filter(v =>
      v.make === filterMake
      && (!filterLocation || v.location === filterLocation)
      && (!filterCondition || v.condition === filterCondition),
    );
    return Array.from(new Set(pool.map(v => v.model).filter(Boolean))).sort();
  }, [inventory, filterMake, filterLocation, filterCondition]);

  // Instant client-side cascade: location → make → model → text search.
  const filteredInventory = useMemo(() => {
    const term = filterSearch.trim().toLowerCase();
    return sortedInventory.filter(v => {
      if (filterLocation && v.location !== filterLocation) return false;
      if (filterMake && v.make !== filterMake) return false;
      if (filterModel && v.model !== filterModel) return false;
      if (!term) return true;
      return [v.make, v.model, v.trim, v.vin, v.stock_number, v.location, String(v.year ?? '')]
        .some(f => (f ?? '').toString().toLowerCase().includes(term));
    });
  }, [sortedInventory, filterSearch, filterLocation, filterMake, filterModel]);

  // ── Selection helpers ─────────────────────────────────────────────

  const activeVehicles = useMemo(() => filteredInventory.filter(v => v.status === 'ACTIVE'), [filteredInventory]);
  const allSelected = activeVehicles.length > 0 && activeVehicles.every(v => selectedVins.has(v.vin));
  const someSelected = selectedVins.size > 0;

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedVins(new Set());
    } else {
      setSelectedVins(new Set(activeVehicles.map(v => v.vin)));
    }
  }, [allSelected, activeVehicles]);

  const toggleVin = useCallback((vin: string, checked: boolean) => {
    setSelectedVins(prev => {
      const s = new Set(prev);
      if (checked) s.add(vin); else s.delete(vin);
      return s;
    });
  }, []);

  // ── FB Post drawer ────────────────────────────────────────────────

  /** Local fallback listing text so the drawer is always usable for copy/paste. */
  const buildLocalListingCopy = useCallback((v: Vehicle) => {
    const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
    const brand = dealerBrandingFromUrl(inventoryUrl, dealerName);
    const atDealer = brand.location
      ? `${brand.name} in ${brand.location}`
      : brand.name;
    return [
      `${title} | ${fmt(v.price)}`,
      '',
      `- Condition: ${v.condition || 'Used'}`,
      `- Mileage: ${fmtMiles(v.mileage)}`,
      `- Price: ${fmt(v.price)}`,
      v.exterior_color ? `- Exterior: ${v.exterior_color}` : null,
      v.interior_color ? `- Interior: ${v.interior_color}` : null,
      v.stock_number ? `- Stock #: ${v.stock_number}` : null,
      `- VIN: ${v.vin}`,
      '',
      `This ${String(v.condition || 'used').toLowerCase()} ${title} is on the lot now at ${atDealer}. ` +
      'Fully inspected and ready to drive home. Financing available for all credit tiers — ' +
      'we will appraise your trade while you are here.',
      '',
      'HOW TO CLAIM THIS VEHICLE:',
      '1. Message us here on Marketplace with your name and best callback number.',
      '2. Or text/call our BDC team to schedule a same-day test drive.',
      '3. Serious inquiries get a response within 15 minutes during business hours.',
    ].filter(Boolean).join('\n');
  }, [dealerName, inventoryUrl]);

  const openFbPostDrawer = useCallback(async (vehicle: Vehicle) => {
    // Open immediately — never gated on Meta catalog IDs, auth, or prior generation.
    setSelectedVehicle(vehicle);
    setIsDrawerOpen(true);
    setDrawerError('');
    setDrawerClipDone(false);
    setDrawerSource('');
    setDrawerTitle([vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' '));
    setDrawerCopy(buildLocalListingCopy(vehicle));
    setDrawerLoading(true);
    setGeneratingVin(vehicle.vin);

    try {
      // Token-free Marketplace copy endpoint — works for manual copy/paste without
      // Meta credentials or a session.
      const res = await fetch(`${API_BASE}/marketplace/generate-copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: vehicle.vin }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ai_description) {
        setDrawerCopy(String(data.ai_description));
        setDrawerTitle(data.title || [
          vehicle.year, vehicle.make, vehicle.model, vehicle.trim,
        ].filter(Boolean).join(' '));
        setDrawerSource(data.source || '');
        // Keep a GeneratedPost cache so any legacy expand UI stays warm.
        setPosts(prev => ({
          ...prev,
          [vehicle.vin]: {
            title: data.title || '',
            features: [],
            description: String(data.ai_description),
            hashtags: '',
          },
        }));
      } else if (data.error) {
        setDrawerError(String(data.error));
      }
    } catch {
      setDrawerError('Could not reach the copy engine — using the local draft below.');
    } finally {
      setDrawerLoading(false);
      setGeneratingVin(null);
    }
  }, [buildLocalListingCopy]);

  const handleDrawerClipboard = async () => {
    if (!drawerCopy) return;
    try {
      await navigator.clipboard.writeText(drawerCopy);
      setDrawerClipDone(true);
      toast({
        title: 'Marketplace Copy Copied!',
        description: 'Paste it into your Facebook Marketplace listing.',
        className: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
      });
      window.setTimeout(() => setDrawerClipDone(false), 2200);
    } catch {
      setDrawerError('Clipboard copy failed — select the text manually.');
    }
  };

  const handleCopy = async (v: Vehicle) => {
    const post = posts[v.vin]; if (!post) return;
    const vf = videoFiles[v.vin] ?? null;
    const text = [post.title, '', post.features.join('\n'), '', post.description, '',
      `💰 Price: ${fmt(v.price)}`, `🚘 ${v.year} ${v.make} ${v.model} ${v.trim}`,
      `📍 ${dealerName || 'Our Dealership'}`, '📞 Call or DM to schedule your test drive!',
      '', post.hashtags,
      ...(vf ? ['', `📹 Video: ${vf.name} (attach when uploading to Facebook Marketplace)`] : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyDoneVin(v.vin); setTimeout(() => setCopyDoneVin(null), 2500);
    } catch { alert('Copy failed — please select and copy manually.'); }
  };

  const clearFilters = () => {
    setFilterCondition(''); setFilterMake(''); setFilterModel(''); setFilterLocation('');
    setFilterMinPrice(''); setFilterMaxPrice('');
    setFilterMinYear('');  setFilterMaxYear('');
    setFilterSearch('');   setFilterPosted('');
    setSortBy('');
  };
  const hasFilters = filterCondition || filterMake || filterModel || filterLocation || filterMinPrice
    || filterMaxPrice || filterMinYear || filterMaxYear || filterSearch || filterPosted
    || sortBy;

  const onLocationChange = (v: string) => {
    const next = v === 'all' ? '' : v;
    setFilterLocation(next);
    // Switching rooftops invalidates make/model cascade.
    setFilterMake('');
    setFilterModel('');
  };
  const onMakeChange = (v: string) => {
    const next = v === 'all' ? '' : v;
    setFilterMake(next);
    setFilterModel('');
  };

  return (
    <div className="space-y-5">
      <TrialBanner />
      {/* Sync bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            {syncMsg && (
              <span className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
                cancellingSync || syncPhase === 'cancelling'
                  ? 'border border-amber-400/40 bg-amber-500/15 text-amber-100'
                  : syncing
                    ? 'border border-amber-300/30 bg-amber-400/10 text-amber-200'
                    : syncMsg.startsWith('Scraped')
                      ? 'border border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                      : syncMsg.startsWith('Sync stopped')
                        ? 'border border-amber-400/35 bg-amber-500/10 text-amber-200'
                        : 'border border-slate-700 bg-slate-900/80 text-slate-300',
              )}>
                {syncing || cancellingSync
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : syncMsg.startsWith('Scraped')
                    ? <Check className="h-3 w-3" />
                    : syncMsg.startsWith('Sync stopped')
                      ? <Ban className="h-3 w-3" />
                      : null}
                {syncMsg}
              </span>
            )}
            {!syncing && (
              <span className="text-xs text-muted-foreground">
                Last sync: <span className="font-medium">{relTime(lastSync)}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onOpenMetaGuide}
              className="gap-2 text-sky-300 border-sky-400/25 hover:bg-sky-400/10 hover:border-blue-300 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              <BookOpen className="w-3.5 h-3.5" />
              Meta Setup Guide
            </Button>
            {(syncing || cancellingSync) && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelSync}
                disabled={cancellingSync}
                className="gap-2 border-rose-400/40 text-rose-200 hover:bg-rose-500/15 hover:text-rose-100 hover:border-rose-300/50 disabled:opacity-70"
              >
                {cancellingSync
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Cancelling…</>
                  : <><Ban className="w-3.5 h-3.5" />Cancel Sync</>}
              </Button>
            )}
            <Button size="sm" onClick={handleSync} disabled={syncing || cancellingSync} className="gap-2">
              {syncing
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Syncing…</>
                : <><RefreshCw className="w-3.5 h-3.5" />Sync All Inventory</>}
            </Button>
          </div>
        </div>

        {/* Progress bar — shown while a sync is in flight */}
        {syncing && (
          <div className="rounded-lg border border-slate-800/60 bg-slate-900/80 backdrop-blur-md px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium">
                {(cancellingSync || syncPhase === 'cancelling') && 'Cancelling sync — saving vehicles scraped so far…'}
                {!cancellingSync && syncPhase !== 'cancelling' && syncPhase === 'discovering' && 'Phase 1 — Fetching sitemap…'}
                {!cancellingSync && syncPhase !== 'cancelling' && syncPhase === 'enriching'   && `Phase 2 — Enriching vehicle details…`}
                {!cancellingSync && syncPhase !== 'cancelling' && syncPhase === 'starting'    && 'Starting full inventory crawl…'}
                {!cancellingSync && syncPhase !== 'cancelling' && !['discovering','enriching','starting','cancelling'].includes(syncPhase) && 'Syncing…'}
              </span>
              <span>
                {syncPhase === 'enriching' && syncProgress.total > 0
                  ? `${syncProgress.enriched.toLocaleString()} / ${syncProgress.synced.toLocaleString()} enriched`
                  : syncProgress.synced > 0
                    ? `${syncProgress.synced.toLocaleString()} vehicles found`
                    : ''}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
              {syncPhase === 'enriching' && syncProgress.synced > 0 ? (
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${Math.round((syncProgress.enriched / syncProgress.synced) * 100)}%` }}
                />
              ) : (
                /* indeterminate pulse while discovering */
                <div className="h-full bg-primary/60 rounded-full animate-pulse w-1/2" />
              )}
            </div>
            {syncPhase === 'enriching' && syncProgress.total > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {syncProgress.synced.toLocaleString()} vehicles discovered from {dealerName || 'your inventory source'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { icon: ShoppingBag, label: 'Total Listings', value: inventory.length, cls: 'text-primary', bg: 'bg-primary/10' },
          { icon: TrendingUp, label: 'Active', value: counts.ACTIVE, cls: 'text-green-600', bg: 'bg-green-500/10' },
          { icon: Tag, label: 'SOLD', value: counts.SOLD, cls: 'text-destructive', bg: 'bg-destructive/10' },
          { icon: Radio, label: 'In Meta Feed', value: counts.posted, cls: 'text-emerald-600', bg: 'bg-emerald-500/10', clickable: true },
        ].map(s => {
          const isActive = s.clickable && filterPosted === 'posted';
          return (
            <div
              key={s.label}
              onClick={s.clickable ? () => setFilterPosted(filterPosted === 'posted' ? '' : 'posted') : undefined}
              className={`rounded-lg border border-slate-800/60 bg-slate-900/80 backdrop-blur-md p-4 flex items-center gap-3 ${
                s.clickable
                  ? 'cursor-pointer hover:shadow-md transition-all ' + (isActive ? 'border-emerald-400 ring-1 ring-emerald-300/60' : 'border-border hover:border-emerald-300')
                  : 'border-border'
              }`}
            >
              <div className={`w-9 h-9 rounded-full ${s.bg} flex items-center justify-center flex-shrink-0`}>
                <s.icon className={`w-4 h-4 ${s.cls}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className={`text-2xl font-bold ${s.cls}`}>{s.value}</p>
              </div>
              {s.clickable && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors ${
                  isActive
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {isActive ? 'FILTERED' : 'FILTER'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg border border-slate-800/60 bg-slate-900/80 backdrop-blur-md">
        {/* Select-all checkbox */}
        <div className="flex items-center gap-2 pr-3 border-r border-border">
          <Checkbox
            checked={allSelected}
            onCheckedChange={toggleSelectAll}
            id="select-all"
            className="w-4 h-4"
          />
          <label htmlFor="select-all" className="text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
            {allSelected ? 'Deselect all' : 'Select all'}
          </label>
        </div>

        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input className="pl-9 h-9 text-sm" placeholder="Search make, model, VIN…"
            value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} />
        </div>
        <Select value={filterCondition || 'all'} onValueChange={(v) => {
          setFilterCondition(v === 'all' ? '' : v);
          setFilterMake('');
          setFilterModel('');
        }}>
          <SelectTrigger className="h-9 w-[130px] text-sm"><SelectValue placeholder="All Conditions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Conditions</SelectItem>
            <SelectItem value="New">New</SelectItem>
            <SelectItem value="Used">Used</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterLocation || 'all'} onValueChange={onLocationChange}>
          <SelectTrigger className="h-9 w-[200px] text-sm"><SelectValue placeholder="Location / Rooftop" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locations</SelectItem>
            {(locationOptions.length ? locationOptions : locations).map(l => (
              <SelectItem key={l} value={l}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterMake || 'all'} onValueChange={onMakeChange}>
          <SelectTrigger className="h-9 w-[130px] text-sm"><SelectValue placeholder="All Makes" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Makes</SelectItem>
            {(makeOptions.length ? makeOptions : makes).map(m => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filterModel || 'all'}
          onValueChange={(v) => setFilterModel(v === 'all' ? '' : v)}
          disabled={!filterMake}
        >
          <SelectTrigger className="h-9 w-[150px] text-sm"><SelectValue placeholder="All Models" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Models</SelectItem>
            {(modelOptions.length ? modelOptions : models).map(m => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterPosted || 'all'} onValueChange={(v) => setFilterPosted(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-9 w-[130px] text-sm"><SelectValue placeholder="All Statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="posted">In Feed</SelectItem>
            <SelectItem value="not_posted">Not Posted</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy || 'default'} onValueChange={(v) => setSortBy(v === 'default' ? '' : v)}>
          <SelectTrigger className="h-9 w-[170px] text-sm"><SelectValue placeholder="Sort By" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default Sort</SelectItem>
            <SelectItem value="price_asc">Price: Low to High</SelectItem>
            <SelectItem value="price_desc">Price: High to Low</SelectItem>
            <SelectItem value="mileage_asc">Mileage: Low to High</SelectItem>
            <SelectItem value="mileage_desc">Mileage: High to Low</SelectItem>
            <SelectItem value="year_desc">Year: Newest First</SelectItem>
            <SelectItem value="year_asc">Year: Oldest First</SelectItem>
          </SelectContent>
        </Select>
        {/* Year range */}
        <div className="flex items-center gap-1.5">
          <Select value={filterMinYear || 'any'} onValueChange={(v) => setFilterMinYear(v === 'any' ? '' : v)}>
            <SelectTrigger className="h-9 w-[90px] text-sm"><SelectValue placeholder="Min Yr" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Min Yr</SelectItem>
              {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs">–</span>
          <Select value={filterMaxYear || 'any'} onValueChange={(v) => setFilterMaxYear(v === 'any' ? '' : v)}>
            <SelectTrigger className="h-9 w-[90px] text-sm"><SelectValue placeholder="Max Yr" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Max Yr</SelectItem>
              {[...years].reverse().map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Price range */}
        <div className="flex items-center gap-1.5">
          <Input type="number" placeholder="Min $" className="h-9 w-[80px] text-sm"
            value={filterMinPrice} onChange={(e) => setFilterMinPrice(e.target.value)} />
          <span className="text-muted-foreground text-xs">–</span>
          <Input type="number" placeholder="Max $" className="h-9 w-[80px] text-sm"
            value={filterMaxPrice} onChange={(e) => setFilterMaxPrice(e.target.value)} />
        </div>
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={clearFilters} className="h-9 gap-1.5 text-muted-foreground">
            <X className="w-3.5 h-3.5" />Clear
          </Button>
        )}
      </div>

      {/* Batch action bar — appears when ≥1 vehicle selected */}
      {someSelected && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            {selectedVins.size} vehicle{selectedVins.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {postMsg && (
              <span className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-md w-full sm:w-auto">{postMsg}</span>
            )}
            <Button size="sm"
              className="h-9 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white border-0"
              disabled={posting}
              onClick={() => handlePostVehicles([...selectedVins], 'post')}>
              {posting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rss className="w-3.5 h-3.5" />}
              Add {selectedVins.size} to Feed
            </Button>
            <Button size="sm" variant="outline"
              className="h-9 gap-2 text-muted-foreground"
              disabled={posting}
              onClick={() => handlePostVehicles([...selectedVins], 'unpost')}>
              {posting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />}
              Remove from Feed
            </Button>
            <Button size="sm" variant="ghost"
              className="h-9 gap-1 text-muted-foreground"
              onClick={() => setSelectedVins(new Set())}>
              <X className="w-3.5 h-3.5" />Clear
            </Button>
          </div>
        </div>
      )}

      {/* Inventory table */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : filteredInventory.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <Store className="w-12 h-12 text-muted-foreground/30" />
          <div>
            <p className="font-semibold text-muted-foreground">No inventory found</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {hasFilters ? 'Try clearing your filters' : 'Click "Sync Inventory" to fetch your latest inventory'}
            </p>
            {!hasFilters && syncReason && syncReason !== 'ok' && (
              (syncReason === 'js_render_empty' || syncReason === 'parse_empty') ? (
                <div className="mt-4 max-w-md mx-auto rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-400/10 dark:bg-amber-950/40 p-4 text-left">
                  <div className="flex gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-amber-200">
                        {syncReason === 'js_render_empty'
                          ? 'No inventory found — standard and JavaScript rendering both returned 0 vehicles.'
                          : 'No inventory found — your URL may require JavaScript rendering.'}
                      </p>
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {syncReason === 'js_render_empty'
                          ? 'The page was fetched twice: once as static HTML and once with a headless browser to execute JavaScript. Both attempts returned no vehicles. The site may use bot-protection, require login, or the URL may be pointing to the wrong page.'
                          : 'This server first tries to read static HTML, then automatically retries with a headless browser. If both return nothing, the URL is likely incorrect or the site requires login.'}
                      </p>
                      <div className="text-xs text-amber-700 dark:text-amber-400 space-y-1">
                        <p className="font-semibold">Supported platforms:</p>
                        <ul className="list-disc list-inside space-y-0.5 ml-1">
                          <li>
                            <a href="https://www.dealeron.com" target="_blank" rel="noopener noreferrer"
                               className="underline underline-offset-2 hover:text-amber-100 dark:hover:text-amber-200 inline-flex items-center gap-0.5">
                              DealerOn <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                            {' '}— REST API bypass (no JS needed)
                          </li>
                          <li>
                            <a href="https://www.dealer.com" target="_blank" rel="noopener noreferrer"
                               className="underline underline-offset-2 hover:text-amber-100 dark:hover:text-amber-200 inline-flex items-center gap-0.5">
                              Dealer.com <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          </li>
                          <li>
                            <a href="https://www.sincro.com" target="_blank" rel="noopener noreferrer"
                               className="underline underline-offset-2 hover:text-amber-100 dark:hover:text-amber-200 inline-flex items-center gap-0.5">
                              Sincro <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          </li>
                        </ul>
                      </div>
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        <a href="/settings" className="underline underline-offset-2 hover:text-amber-100 dark:hover:text-amber-200 font-medium">
                          Check your inventory URL in Settings
                        </a>
                        {' '}and make sure it points to the public-facing search results page (not a login-gated admin URL). You can also ask your website provider for a direct sitemap or data-feed export link.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-amber-600 dark:text-amber-500 mt-2 max-w-sm mx-auto">
                  {syncReason === 'no_urls_configured'
                    ? 'No inventory URL is configured — add your dealership URL in Settings to see live listings.'
                    : syncReason === 'demo'
                    ? 'Showing demo data — configure your inventory URL in Settings for live listings.'
                    : null}
                </p>
              )
            )}
          </div>
          {!hasFilters && (
            <Button size="sm" onClick={handleSync} disabled={syncing} className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" />Sync Now
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[960px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="w-10 px-3 py-3 text-left">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleSelectAll}
                      className="w-4 h-4"
                    />
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">Stock #</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">VIN</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vehicle</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cond.</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Miles</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Color</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Price</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Feed</th>
                  <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredInventory.flatMap(v => {
                  const isSold      = v.status === 'SOLD';
                  const isPosted    = v.posted_status === 'posted';
                  const isOrphaned  = isSold && isPosted;   // removed from feed but still marked posted
                  const isPosting   = postingVins.has(v.vin);
                  const isGenerating = generatingVin === v.vin;
                  const isExpanded  = expandedVin === v.vin;
                  const post        = posts[v.vin] ?? null;
                  const copyDone    = copyDoneVin === v.vin;
                  const isSelected  = selectedVins.has(v.vin);

                  const mainRow = (
                    <tr
                      key={v.vin}
                      className={`transition-colors hover:bg-muted/20 ${isSold && !isOrphaned ? 'opacity-60' : ''} ${isOrphaned ? 'bg-amber-50/40' : ''} ${isSelected ? 'bg-primary/5' : ''} ${isExpanded ? 'bg-muted/30' : ''}`}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-3">
                        {!isSold && (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(c) => toggleVin(v.vin, Boolean(c))}
                            className="w-4 h-4"
                          />
                        )}
                      </td>

                      {/* Stock # */}
                      <td className="px-3 py-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {(v.stock_number && v.stock_number !== 'N/A') ? `#${v.stock_number}` : '—'}
                      </td>

                      {/* VIN */}
                      <td className="px-3 py-3 font-mono text-xs text-muted-foreground whitespace-nowrap tracking-wide">
                        {v.vin && v.vin.length === 17 ? v.vin : v.vin && v.vin.length > 0 ? <span className="text-muted-foreground/50 italic">—</span> : '—'}
                      </td>

                      {/* Vehicle */}
                      <td className="px-3 py-3">
                        <div className="font-semibold text-sm leading-tight">
                          {v.year} {v.make} {v.model}
                        </div>
                        {v.trim && (
                          <div className="text-xs text-muted-foreground mt-0.5">{v.trim}</div>
                        )}
                        {v.location && (
                          <div className="text-[10px] text-slate-500 mt-0.5">{v.location}</div>
                        )}
                      </td>

                      {/* Condition */}
                      <td className="px-3 py-3">
                        <Badge className={v.condition === 'New'
                          ? 'bg-blue-600 text-white border-0 text-[10px] px-2 py-0.5'
                          : 'bg-amber-500 text-white border-0 text-[10px] px-2 py-0.5'}>
                          {v.condition}
                        </Badge>
                      </td>

                      {/* Miles */}
                      <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtMiles(v.mileage)}
                      </td>

                      {/* Color */}
                      <td className="px-3 py-3 text-xs text-muted-foreground">
                        {v.exterior_color || '—'}
                      </td>

                      {/* Price */}
                      <td className="px-3 py-3 font-bold text-primary whitespace-nowrap">
                        {fmt(v.price)}
                      </td>

                      {/* Status */}
                      <td className="px-3 py-3">
                        {isSold ? (
                          <span className="inline-flex items-center rounded-full bg-destructive/10 border border-destructive/30 px-2 py-0.5 text-[10px] font-semibold text-destructive whitespace-nowrap">
                            SOLD
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-green-500/10 border border-green-500/30 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:text-green-400 whitespace-nowrap">
                            ACTIVE
                          </span>
                        )}
                      </td>

                      {/* Feed */}
                      <td className="px-3 py-3">
                        <PostingBadge status={v.posted_status} orphaned={isOrphaned} />
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {isSold ? (
                            <>
                              {isOrphaned && (
                                isPosting ? (
                                  <Button size="sm" variant="outline" disabled className="h-7 px-2 gap-1">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="outline"
                                    onClick={() => handlePostVehicles([v.vin], 'unpost')}
                                    className="h-7 px-2.5 text-xs gap-1 text-amber-700 border-amber-400/50 hover:bg-amber-500/10 hover:border-amber-500/60 dark:text-amber-400 whitespace-nowrap">
                                    <BellOff className="w-3 h-3" />Remove from Feed
                                  </Button>
                                )
                              )}
                              {!isOrphaned && (
                                <span className="text-xs text-destructive font-medium whitespace-nowrap">
                                  Delete social posts
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              {/* Feed toggle — independent of FB Post / Meta catalog credentials */}
                              {isPosting ? (
                                <Button size="sm" variant="outline" disabled className="h-7 px-2 gap-1">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                </Button>
                              ) : isPosted ? (
                                <Button size="sm" variant="outline"
                                  onClick={() => handlePostVehicles([v.vin], 'unpost')}
                                  className="h-7 px-2.5 text-xs gap-1 text-destructive border-destructive/40 hover:bg-destructive/10 hover:border-destructive/60 whitespace-nowrap">
                                  <BellOff className="w-3 h-3" />Remove from Feed
                                </Button>
                              ) : (
                                <Button size="sm"
                                  onClick={() => handlePostVehicles([v.vin], 'post')}
                                  className="h-7 px-2 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white border-0 whitespace-nowrap">
                                  <Rss className="w-3 h-3" />Add
                                </Button>
                              )}
                            </>
                          )}
                          {/* FB Post — always openable for manual copy/paste; never gated on Meta IDs */}
                          <Button
                            size="sm"
                            type="button"
                            onClick={() => void openFbPostDrawer(v)}
                            className="h-7 px-2.5 text-xs gap-1 whitespace-nowrap border-0 bg-amber-400/90 font-semibold text-slate-950 hover:bg-amber-300"
                          >
                            {isGenerating
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Bot className="w-3 h-3" />}
                            FB Post
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );

                  if (isExpanded && post) {
                    return [
                      mainRow,
                      <tr key={`${v.vin}-post`} className="bg-muted/30">
                        <td colSpan={10} className="px-5 py-4 border-b border-border">
                          <AiPostPanel
                            post={post}
                            onCopy={() => handleCopy(v)}
                            copyDone={copyDone}
                            videoFile={videoFiles[v.vin] ?? null}
                            onVideoChange={(file) => setVideoFiles(prev => ({ ...prev, [v.vin]: file }))}
                          />
                        </td>
                      </tr>,
                    ];
                  }
                  return [mainRow];
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-border bg-muted/20 text-xs text-muted-foreground">
            {sortedInventory.length} vehicle{sortedInventory.length !== 1 ? 's' : ''} · {counts.posted} in Meta feed
            {someSelected && ` · ${selectedVins.size} selected`}
            {hasFilters && ' · filtered'}
          </div>
        </div>
      )}

      {/* ── FB Post / Marketplace Copy drawer ───────────────────────────── */}
      <Sheet
        open={isDrawerOpen}
        onOpenChange={open => {
          setIsDrawerOpen(open);
          if (!open) setSelectedVehicle(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-slate-800 bg-slate-950 text-slate-100 sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle className="text-slate-100">
              Marketplace Copy — {drawerTitle || selectedVehicle?.vin}
            </SheetTitle>
            <SheetDescription className="text-slate-400">
              Review and edit before posting to Facebook Marketplace. Specs are
              pulled from the selected inventory row — no Meta catalog credentials required.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            {selectedVehicle && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-3 text-[11px] text-slate-400">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold text-slate-100">
                    {selectedVehicle.year} {selectedVehicle.make} {selectedVehicle.model}
                    {selectedVehicle.trim ? ` ${selectedVehicle.trim}` : ''}
                  </span>
                  <span className="font-mono text-slate-300">{selectedVehicle.vin}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                  <span>Price: <span className="font-semibold text-amber-200/90">{fmt(selectedVehicle.price)}</span></span>
                  <span>Miles: <span className="text-slate-200">{fmtMiles(selectedVehicle.mileage)}</span></span>
                  <span>Color: <span className="text-slate-200">{selectedVehicle.exterior_color || '—'}</span></span>
                  <span>Cond: <span className="text-slate-200">{selectedVehicle.condition || '—'}</span></span>
                  {selectedVehicle.stock_number && (
                    <span>Stock #: <span className="text-slate-200">{selectedVehicle.stock_number}</span></span>
                  )}
                  {selectedVehicle.interior_color && (
                    <span>Interior: <span className="text-slate-200">{selectedVehicle.interior_color}</span></span>
                  )}
                </div>
                {drawerSource && (
                  <span className="mt-2 inline-block rounded border border-slate-700 px-1.5 py-0.5 uppercase tracking-wider text-slate-500">
                    {drawerSource === 'openai' ? 'AI polished' : 'Template'}
                  </span>
                )}
              </div>
            )}

            {drawerLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating Marketplace listing copy…
              </div>
            ) : (
              <>
                <Textarea
                  value={drawerCopy}
                  onChange={e => setDrawerCopy(e.target.value)}
                  rows={18}
                  className="resize-none border-slate-700/60 bg-slate-900/80 font-mono text-[12px] leading-relaxed text-slate-100 focus-visible:ring-amber-300/40"
                />
                <p className="text-[11px] tabular-nums text-slate-500">
                  {drawerCopy.length} characters
                </p>
              </>
            )}

            {drawerError && (
              <div className="rounded-lg border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                {drawerError}
              </div>
            )}

            <div className="flex flex-col gap-2 pb-6">
              <Button
                onClick={() => void handleDrawerClipboard()}
                disabled={!drawerCopy || drawerLoading}
                className={cn(
                  'h-10 gap-2 border-0 font-semibold',
                  drawerClipDone
                    ? 'bg-emerald-500 text-white hover:bg-emerald-400'
                    : 'bg-amber-400/90 text-slate-950 hover:bg-amber-300',
                )}
              >
                {drawerClipDone
                  ? <><CheckCheck className="h-4 w-4" /> Copied!</>
                  : <><Copy className="h-4 w-4" /> Copy to Clipboard</>}
              </Button>
              <Button
                variant="outline"
                onClick={() => { setIsDrawerOpen(false); setSelectedVehicle(null); }}
                className="h-10 border-slate-700/60 bg-white/[0.03] text-slate-200 hover:border-amber-300/30 hover:text-amber-100"
              >
                Close
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Trial Upgrade Modal ──────────────────────────────────────────── */}
      {upgradeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setUpgradeModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md shadow-2xl p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-bold tracking-tight">Trial Limit Reached!</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{upgradeModal}</p>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="/pricing"
                className="w-full inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors"
                onClick={() => setUpgradeModal(null)}
              >
                Upgrade to Pro — $75/mo
              </a>
              <button
                onClick={() => setUpgradeModal(null)}
                className="w-full rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MarketplaceHub() {
  const { token } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>('publisher');

  // Meta Setup Guide modal — lifted here so both the header button (inside
  // InventoryView) and the scraper-form shortcut button can open it without
  // DOM hacks, and so the modal renders at the page root regardless of which
  // tab is active.
  const [showMetaGuide, setShowMetaGuide] = useState(false);
  const [feedCopied,    setFeedCopied]    = useState(false);

  // ── Scraper setup state ───────────────────────────────────────────────
  const [scraperOpen,    setScraperOpen]    = useState(false);
  const [locationConfigs, setLocationConfigs] = useState<InventoryLocationConfig[]>([emptyLocationRow()]);
  const [scraperSpId,    setScraperSpId]    = useState('');
  const [syncFreq,       setSyncFreq]       = useState('daily');
  const [dealerName,     setDealerName]     = useState('');
  const [scraperSaving,  setScraperSaving]  = useState(false);
  const [scraperSaveMsg, setScraperSaveMsg] = useState('');
  // Secondary, non-blocking detail shown under the success badge
  const [scraperSaveNote, setScraperSaveNote] = useState('');

  // ── Meta / Facebook Marketplace setup state ───────────────────────────
  const [fbBusinessId,      setFbBusinessId]      = useState('');
  const [commerceCatalogId, setCommerceCatalogId] = useState('');
  const [metaPixelId,       setMetaPixelId]       = useState('');
  // feedUserId: DB user_id — used as catalog URL fallback when no Commerce Catalog ID is set
  const [feedUserId,        setFeedUserId]        = useState('');
  // settingsLoaded: true once the initial GET /settings response arrives
  const [settingsLoaded,    setSettingsLoaded]    = useState(false);

  const primaryUsedUrl = locationConfigs[0]?.inventory_url_used?.trim() || '';
  const primaryNewUrl = locationConfigs[0]?.inventory_url_new?.trim() || '';
  const hasAnyInventoryUrl = locationConfigs.some(
    loc => loc.inventory_url_used.trim() || loc.inventory_url_new.trim(),
  );
  const locationSummary = locationConfigs
    .map(loc => loc.location_name.trim())
    .filter(Boolean)
    .join(' · ');

  const [csvSyncingIdx, setCsvSyncingIdx] = useState<number | null>(null);
  const [csvSyncMsg, setCsvSyncMsg] = useState('');

  const updateLocationConfig = useCallback((
    index: number,
    field: keyof InventoryLocationConfig,
    value: string | boolean,
  ) => {
    setLocationConfigs(prev => prev.map((row, i) => (
      i === index ? { ...row, [field]: value } : row
    )));
  }, []);

  const addLocationConfig = useCallback(() => {
    setLocationConfigs(prev => [...prev, emptyLocationRow()]);
  }, []);

  const removeLocationConfig = useCallback((index: number) => {
    setLocationConfigs(prev => {
      if (prev.length <= 1) return [emptyLocationRow()];
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleCsvSyncNow = useCallback(async (index: number) => {
    const loc = locationConfigs[index];
    if (!loc) return;
    const csvUrl = loc.csv_url.trim();
    if (!csvUrl) {
      setCsvSyncMsg('Enter a CSV File URL first.');
      setTimeout(() => setCsvSyncMsg(''), 4000);
      return;
    }
    setCsvSyncingIdx(index);
    setCsvSyncMsg('');
    try {
      const res = await fetch(`${API_BASE}/marketplace/csv-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_name: loc.location_name.trim() || `Location ${index + 1}`,
          csv_url: csvUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status === 'error') {
        setCsvSyncMsg(data.error || data.message || 'CSV sync failed.');
      } else {
        setCsvSyncMsg(data.message || `Synced ${data.synced ?? 0} vehicle(s).`);
      }
    } catch {
      setCsvSyncMsg('CSV sync failed — is the engine running?');
    } finally {
      setCsvSyncingIdx(null);
      setTimeout(() => setCsvSyncMsg(''), 6000);
    }
  }, [locationConfigs]);

  useEffect(() => {
    // Hydrate from the local cache first so the form is never blank while the
    // network request is in flight (and stays usable if the engine is down).
    const cached = readCachedSettings();
    const apply = (d: SettingsCache, { allowEmpty = true }: { allowEmpty?: boolean } = {}) => {
      const locs = normalizeLocationConfigs(d.inventory_locations);
      const hasLocs = locs.length > 0;
      const used = String(d.inventory_url_used || '');
      const neu = String(d.inventory_url_new || '');
      const hasLegacyUrls = Boolean(used || neu);
      if (hasLocs) {
        setLocationConfigs(locs);
      } else if (hasLegacyUrls) {
        setLocationConfigs([{
          location_name: String(d.dealer_name || 'Main Lot'),
          inventory_url_used: used,
          inventory_url_new: neu,
          csv_enabled: false,
          csv_url: '',
        }]);
      } else if (allowEmpty) {
        // Do not wipe an already-hydrated form with an empty server payload.
      }
      if (d.dealer_name                  !== undefined && (allowEmpty || d.dealer_name)) setDealerName(String(d.dealer_name || ''));
      if (d.salesperson_filter           !== undefined) setScraperSpId(String(d.salesperson_filter || ''));
      if (d.scraper_frequency            !== undefined) setSyncFreq(String(d.scraper_frequency || 'daily'));
      if (d.facebook_business_manager_id !== undefined) setFbBusinessId(String(d.facebook_business_manager_id || ''));
      if (d.commerce_catalog_id          !== undefined) setCommerceCatalogId(String(d.commerce_catalog_id || ''));
      if (d.meta_pixel_id                !== undefined) setMetaPixelId(String(d.meta_pixel_id || ''));
      if (d.user_id) setFeedUserId(String(d.user_id));
    };
    if (cached) apply(cached);

    // Token-free endpoint — the local Hub resolves the account server-side.
    // Server merges dealer_config.json so a refresh always restores URLs.
    fetch(`${API_BASE}/marketplace/settings`)
      .then(r => r.json())
      .then((d: SettingsCache) => {
        const locs = normalizeLocationConfigs(d.inventory_locations);
        const hasServerData = locs.some(l =>
          l.inventory_url_used || l.inventory_url_new || l.csv_url || l.location_name
        ) || Boolean(d.inventory_url_used || d.inventory_url_new || d.dealer_name);
        if (hasServerData) {
          apply(d, { allowEmpty: true });
          writeCachedSettings({
            ...d,
            inventory_locations: locs.length ? locs : (cached?.inventory_locations ?? []),
          });
        } else if (cached) {
          // Keep cached form; re-push to backend so disk/DB catch up.
          apply(cached, { allowEmpty: false });
        } else {
          apply(d);
          setScraperOpen(true);
        }
        setSettingsLoaded(true);
      })
      .catch(() => { setSettingsLoaded(true); });
  }, []);

  const handleScraperSave = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanedLocations = locationConfigs
      .map(loc => ({
        location_name: loc.location_name.trim(),
        inventory_url_new: loc.inventory_url_new.trim(),
        inventory_url_used: loc.inventory_url_used.trim(),
        csv_enabled: Boolean(loc.csv_enabled),
        csv_url: loc.csv_url.trim(),
      }))
      .filter(loc =>
        loc.location_name
        || loc.inventory_url_new
        || loc.inventory_url_used
        || loc.csv_url
        || loc.csv_enabled
      );

    const body = {
      inventory_locations:            cleanedLocations,
      inventory_url_used:           cleanedLocations[0]?.inventory_url_used || '',
      inventory_url_new:            cleanedLocations[0]?.inventory_url_new || '',
      salesperson_filter:           scraperSpId.trim(),
      scraper_frequency:            syncFreq,
      dealer_name:                  dealerName.trim(),
      facebook_business_manager_id: fbBusinessId.trim(),
      commerce_catalog_id:          commerceCatalogId.trim(),
      meta_pixel_id:                metaPixelId.trim(),
    };

    // Persist locally and confirm immediately — the manager's input is never
    // lost and the green badge doesn't wait on the round trip.
    writeCachedSettings(body);
    setScraperSaving(true);
    setScraperSaveMsg('Settings Saved Successfully!');
    setScraperSaveNote('');

    try {
      const res = await fetch(`${API_BASE}/marketplace/settings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface real validation problems (e.g. a malformed URL) as a
        // secondary note — the local save already succeeded.
        setScraperSaveNote(data.error || 'Saved locally, but the engine rejected the sync.');
      } else if (data.sync_triggered) {
        setScraperSaveNote('Inventory refreshing in the background…');
      }
    } catch {
      setScraperSaveNote('Saved locally — engine offline, will sync when it reconnects.');
    } finally {
      setScraperSaving(false);
      setTimeout(() => { setScraperSaveMsg(''); setScraperSaveNote(''); }, 5000);
    }
  }, [locationConfigs, scraperSpId, syncFreq, dealerName, fbBusinessId, commerceCatalogId, metaPixelId]);

  return (
    <div className="space-y-6">

      {/* ── ⚙️ Inventory Scraper & Source Setup ────────────────────────── */}
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
        <button
          type="button"
          onClick={() => setScraperOpen(p => !p)}
          className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Settings className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="text-left min-w-0">
              <p className="text-sm font-semibold">⚙️ Inventory Scraper &amp; Source Setup</p>
              {!scraperOpen && hasAnyInventoryUrl && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {locationSummary || primaryUsedUrl || primaryNewUrl}
                </p>
              )}
              {!scraperOpen && !hasAnyInventoryUrl && (
                <p className="text-xs text-amber-500 mt-0.5 font-medium">
                  Inventory source not configured — click to set up
                </p>
              )}
            </div>
          </div>
          {scraperOpen
            ? <ChevronUp  className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
        </button>

        {scraperOpen && (
          <div className="border-t px-4 py-5 space-y-4">
            {/* Quick Setup Instructions */}
            <div className="rounded-lg bg-sky-400/10 border border-sky-400/25 px-4 py-3 space-y-1.5">
              <p className="text-xs font-semibold text-sky-300 dark:text-blue-400">💡 Quick Setup Instructions</p>
              <p className="text-xs text-sky-300 leading-relaxed">
                1. Add each dealership rooftop with a Location Name plus its New and Used inventory page URLs.
              </p>
              <p className="text-xs text-sky-300 leading-relaxed">
                2. (Optional) Enter your Salesperson ID if you only want your assigned inventory to display.
              </p>
              <p className="text-xs text-sky-300 leading-relaxed">
                3. Select your preferred sync frequency, fill in your Meta IDs, then click "Save Settings".
              </p>
            </div>

            <form onSubmit={handleScraperSave} className="space-y-5">

              {/* ── Two-column layout: Scraper left, Meta right ─────────────── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* ── Left: Inventory Scraper ──────────────────────────────── */}
                <div className="space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Dealership Locations
                  </p>

                  <div className="space-y-3">
                    {locationConfigs.map((loc, index) => (
                      <div
                        key={`loc-${index}`}
                        className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3 space-y-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-muted-foreground">
                            Location {index + 1}
                          </p>
                          <button
                            type="button"
                            onClick={() => removeLocationConfig(index)}
                            className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300"
                            aria-label={`Delete location ${index + 1}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete Location
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`ms-loc-name-${index}`} className="text-xs font-medium">
                            Location Name
                          </Label>
                          <Input
                            id={`ms-loc-name-${index}`}
                            value={loc.location_name}
                            onChange={e => updateLocationConfig(index, 'location_name', e.target.value)}
                            placeholder='e.g. University Ford - St. Albans'
                          />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label htmlFor={`ms-loc-new-${index}`} className="text-xs font-medium">
                              New Inventory URL
                            </Label>
                            <Input
                              id={`ms-loc-new-${index}`}
                              value={loc.inventory_url_new}
                              onChange={e => updateLocationConfig(index, 'inventory_url_new', e.target.value)}
                              placeholder="https://yourdealer.com/new-inventory/"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`ms-loc-used-${index}`} className="text-xs font-medium">
                              Used Inventory URL
                            </Label>
                            <Input
                              id={`ms-loc-used-${index}`}
                              value={loc.inventory_url_used}
                              onChange={e => updateLocationConfig(index, 'inventory_url_used', e.target.value)}
                              placeholder="https://yourdealer.com/used-inventory/"
                            />
                          </div>
                        </div>

                        <div className="rounded-md border border-slate-700/50 bg-slate-900/50 p-3 space-y-3">
                          <label
                            htmlFor={`ms-csv-enabled-${index}`}
                            className="flex items-center gap-2 cursor-pointer select-none"
                          >
                            <Checkbox
                              id={`ms-csv-enabled-${index}`}
                              checked={loc.csv_enabled}
                              onCheckedChange={(checked) =>
                                updateLocationConfig(index, 'csv_enabled', checked === true)
                              }
                            />
                            <span className="text-xs font-medium">
                              Enable Automated CSV Feed
                            </span>
                          </label>
                          {loc.csv_enabled && (
                            <div className="space-y-2">
                              <div className="space-y-1.5">
                                <Label htmlFor={`ms-csv-url-${index}`} className="text-xs font-medium">
                                  CSV File URL / Remote Path
                                </Label>
                                <Input
                                  id={`ms-csv-url-${index}`}
                                  value={loc.csv_url}
                                  onChange={e => updateLocationConfig(index, 'csv_url', e.target.value)}
                                  placeholder="https://example.com/inventory.csv"
                                />
                              </div>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={csvSyncingIdx === index || !loc.csv_url.trim()}
                                onClick={() => handleCsvSyncNow(index)}
                                className="w-full sm:w-auto"
                              >
                                {csvSyncingIdx === index ? (
                                  <>
                                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    Syncing CSV…
                                  </>
                                ) : (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                                    Sync CSV Now
                                  </>
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {csvSyncMsg && (
                    <p className="text-xs text-sky-300">{csvSyncMsg}</p>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addLocationConfig}
                    className="w-full sm:w-auto"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                    Add Another Location
                  </Button>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="ms-sp-id" className="text-xs font-medium">
                        Salesperson ID{' '}
                        <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <Input
                        id="ms-sp-id"
                        value={scraperSpId}
                        onChange={e => setScraperSpId(e.target.value)}
                        placeholder="e.g. jdoe"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ms-sync-freq" className="text-xs font-medium">Auto-Sync Frequency</Label>
                      <Select value={syncFreq} onValueChange={setSyncFreq}>
                        <SelectTrigger id="ms-sync-freq"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="manual">Manual only</SelectItem>
                          <SelectItem value="hourly">Hourly</SelectItem>
                          <SelectItem value="6hours">Every 6 hours</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* ── Vertical divider (desktop only) ─────────────────────── */}
                <div className="hidden lg:block w-px bg-border self-stretch" />

                {/* ── Right: Meta Catalog & Facebook Marketplace ───────────── */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Meta Catalog &amp; Facebook Marketplace Integration
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowMetaGuide(true)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 dark:text-blue-400 hover:underline underline-offset-2"
                    >
                      <BookOpen className="w-3 h-3" />
                      Setup Guide
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="ms-fb-bm-id" className="text-xs font-medium">
                        Facebook Business Manager ID
                      </Label>
                      <Input
                        id="ms-fb-bm-id"
                        value={fbBusinessId}
                        onChange={e => setFbBusinessId(e.target.value)}
                        placeholder="e.g. 123456789012345"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ms-commerce-catalog-id" className="text-xs font-medium">
                        Commerce Account Catalog ID
                      </Label>
                      <Input
                        id="ms-commerce-catalog-id"
                        value={commerceCatalogId}
                        onChange={e => setCommerceCatalogId(e.target.value)}
                        placeholder="e.g. 987654321098765"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ms-meta-pixel-id" className="text-xs font-medium">
                        Meta Pixel ID{' '}
                        <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <Input
                        id="ms-meta-pixel-id"
                        value={metaPixelId}
                        onChange={e => setMetaPixelId(e.target.value)}
                        placeholder="e.g. 1234567890"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {scraperSaveMsg && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-300">
                    <Check className="h-4 w-4 flex-shrink-0" />
                    {scraperSaveMsg}
                  </div>
                  {scraperSaveNote && (
                    <p className="px-1 text-xs text-slate-400">{scraperSaveNote}</p>
                  )}
                </div>
              )}

              <Button type="submit" size="sm" disabled={scraperSaving} className="gap-2">
                {scraperSaving
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving…</>
                  : <><Save    className="w-3.5 h-3.5" />Save Settings</>}
              </Button>
            </form>
          </div>
        )}
      </div>

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-amber-300/90">
          <Store className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Inventory Sync</span>
        </div>
        <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent md:text-3xl">
          Marketplace Hub
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          {(() => {
            const _activeUrl = primaryUsedUrl || primaryNewUrl;
            if (!_activeUrl) {
              return <>Configure your inventory source URLs in the ⚙️ setup panel above.</>;
            }
            let _domain = _activeUrl;
            try { _domain = new URL(_activeUrl).hostname.replace(/^www\./, ''); } catch { /* leave as-is */ }
            const _name = dealerName || 'Your Dealership';
            return <>{_name} live inventory — scraped from {_domain}.</>;
          })()}
          {' '}<span className="font-medium text-slate-200">Manually select vehicles to include in the Meta catalog feed.</span>
        </p>
      </div>

      <div className="flex w-full items-center gap-1 rounded-lg border border-slate-800/60 bg-slate-950/50 p-1 sm:w-fit">
        <button
          onClick={() => setActiveTab('publisher')}
          className={`flex flex-1 sm:flex-none items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'publisher'
              ? 'border border-amber-300/30 bg-gradient-to-b from-amber-300/20 to-amber-500/10 text-amber-100 shadow-sm'
              : 'text-slate-400 hover:text-slate-100'
          }`}
        >
          <Radio className="h-4 w-4" />
          Publisher
        </button>
        <button
          onClick={() => setActiveTab('inventory')}
          className={`flex flex-1 sm:flex-none items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'inventory'
              ? 'border border-amber-300/30 bg-gradient-to-b from-amber-300/20 to-amber-500/10 text-amber-100 shadow-sm'
              : 'text-slate-400 hover:text-slate-100'
          }`}
        >
          <LayoutGrid className="h-4 w-4" />
          Inventory
        </button>
        <button
          onClick={() => setActiveTab('queue')}
          className={`flex flex-1 sm:flex-none items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'queue'
              ? 'border border-amber-300/30 bg-gradient-to-b from-amber-300/20 to-amber-500/10 text-amber-100 shadow-sm'
              : 'text-slate-400 hover:text-slate-100'
          }`}
        >
          <ListOrdered className="w-4 h-4" />
          Posting Queue
        </button>
      </div>

      {activeTab === 'publisher' ? (
        <PublisherView />
      ) : activeTab === 'inventory' ? (
        <InventoryView
          token={token!}
          dealerName={dealerName}
          inventoryUrl={primaryUsedUrl || primaryNewUrl}
          feedUserId={feedUserId}
          commerceCatalogId={commerceCatalogId}
          onOpenMetaGuide={() => setShowMetaGuide(true)}
        />
      ) : (
        <QueueView token={token!} />
      )}

      {/* ── Meta Setup Guide Modal ─────────────────────────────────────────────
          Rendered at the MarketplaceHub root so it works from any tab and from
          both trigger sites (inventory header button + scraper-form shortcut).
          All state it reads — commerceCatalogId, feedUserId, settingsLoaded —
          already live here; no DOM hacks needed.
      ──────────────────────────────────────────────────────────────────────── */}
      {showMetaGuide && (() => {
        const catalogId = commerceCatalogId.trim();
        const feedId    = catalogId || feedUserId || '';
        // Prefer Commerce Catalog ID; fall back to account user_id.
        // Domain is always the live origin — never a hardcoded dealer URL.
        const feedUrl   = feedId
          ? `${window.location.origin}/api/feeds/meta?format=csv&${
              catalogId ? `catalog_id=${encodeURIComponent(catalogId)}` : `user_id=${encodeURIComponent(String(feedId))}`
            }`
          : '';

        const handleCopyFeed = async () => {
          try {
            await navigator.clipboard.writeText(feedUrl);
            setFeedCopied(true);
            setTimeout(() => setFeedCopied(false), 2500);
          } catch {
            alert('Copy failed — please select and copy the URL manually.');
          }
        };

        const steps = [
          {
            n: 1,
            title: 'Copy your custom Feed URL',
            body: (
              <div className="mt-2 space-y-2">
                {!settingsLoaded ? (
                  <p className="text-xs text-muted-foreground italic">Loading your settings…</p>
                ) : !feedUrl ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Save your Commerce Catalog ID in the Inventory Setup panel first — your unique feed URL will appear here.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-[11px] text-foreground break-all select-all">
                      {feedUrl}
                    </div>
                    <button
                      onClick={handleCopyFeed}
                      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                        feedCopied
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      }`}
                    >
                      {feedCopied
                        ? <><CheckCheck className="w-3.5 h-3.5" />Copied!</>
                        : <><Link2 className="w-3.5 h-3.5" />Copy Feed Link</>}
                    </button>
                    {!catalogId && feedUserId && (
                      <p className="text-[11px] text-muted-foreground">
                        No Commerce Catalog ID saved yet — using your account ID as the feed identifier. Save a Commerce Catalog ID in the setup panel for a permanent, catalog-linked URL.
                      </p>
                    )}
                  </>
                )}
              </div>
            ),
          },
          {
            n: 2,
            title: 'Open Meta Commerce Manager',
            body: (
              <a
                href="https://business.facebook.com/commerce"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-sky-300 hover:underline dark:text-blue-400"
              >
                business.facebook.com/commerce <ExternalLink className="w-3 h-3" />
              </a>
            ),
          },
          {
            n: 3,
            title: 'Select your Catalog',
            body: (
              <p className="mt-1 text-sm text-muted-foreground">
                Choose an existing catalog, or create a new one under <strong>Auto &gt; Vehicles</strong>.
              </p>
            ),
          },
          {
            n: 4,
            title: 'Navigate to Data Sources',
            body: (
              <p className="mt-1 text-sm text-muted-foreground">
                In the left menu, click <strong>Catalog</strong>, then select <strong>Data sources</strong>.
              </p>
            ),
          },
          {
            n: 5,
            title: 'Add a Data Feed',
            body: (
              <p className="mt-1 text-sm text-muted-foreground">
                Click <strong>Add Data Feed</strong>, then select <strong>Use a URL or Google Sheets (Scheduled Feed)</strong>.
              </p>
            ),
          },
          {
            n: 6,
            title: 'Paste your Feed URL and schedule',
            body: (
              <p className="mt-1 text-sm text-muted-foreground">
                Paste the copied Feed URL, set the update frequency to <strong>Hourly</strong>, then click <strong>Upload</strong>.
              </p>
            ),
          },
        ];

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowMetaGuide(false); }}
          >
            <div className="relative w-full max-w-[95vw] sm:max-w-lg rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md shadow-2xl flex flex-col max-h-[85dvh]">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="w-4.5 h-4.5 text-sky-300 dark:text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold leading-tight">How to Connect Your Inventory to Meta Commerce Manager</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">Follow these steps to publish your live feed to Facebook &amp; Instagram.</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowMetaGuide(false)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0 mt-0.5"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Steps */}
              <div className="overflow-y-auto px-6 py-5 space-y-5 flex-1">
                {steps.map((step) => (
                  <div key={step.n} className="flex gap-4">
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold mt-0.5">
                      {step.n}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{step.title}</p>
                      {step.body}
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between gap-3 rounded-b-xl flex-shrink-0">
                <p className="text-[11px] text-muted-foreground">
                  Meta refreshes your feed on the schedule you set. New and sold vehicles update automatically.
                </p>
                <button
                  onClick={() => setShowMetaGuide(false)}
                  className="flex-shrink-0 rounded-md px-4 py-1.5 text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
