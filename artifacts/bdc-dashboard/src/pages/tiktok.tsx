/**
 * TikTok AI Video Studio — connection setup, upload, AI catchphrase, and direct posting
 * with trial gating (3 posts/day · 5-day trial window for non-Pro users).
 *
 * Flow:
 *  1. Connect TikTok via the ⚙️ Connection & Account Setup card at the top.
 *  2. Select privacy level and optionally generate an AI catchphrase.
 *  3. "Post to TikTok":
 *       a. POST /api/tiktok/publish/init → { upload_url, publish_id, chunk_size, total_chunks }
 *       b. PUT chunks directly to TikTok's upload_url (10 MB each, Content-Range header).
 *       c. Poll GET /api/tiktok/publish/status?publish_id=… every 3 s (max 20 tries).
 *       d. Show success or descriptive error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Film, Upload, Sparkles, Send, Loader2, CheckCircle2,
  AlertCircle, X, UploadCloud, RefreshCw, Settings,
  Lock, CreditCard, Crown, Wifi, WifiOff, ChevronDown, ChevronUp,
  Clock, History, ExternalLink, KeyRound, ShieldAlert,
  Wand2, Camera, Copy, CheckCheck, Car, Search,
} from 'lucide-react';
import {
  buildShotList,
  daysOnLot,
  type ScriptVehicle,
} from '@/lib/tiktok-scripter';

// ── Constants ─────────────────────────────────────────────────────────────

const ACCEPTED_EXT   = ['.mp4', '.mov'];
const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime'];
const MAX_BYTES      = 500 * 1024 * 1024; // 500 MB
const MAX_CAPTION    = 2200;

interface ScriptScene {
  order: number;
  duration_s: number;
  camera: string;
  voiceover: string;
  line?: string;
}

interface ApiScriptOption {
  option: string;
  style: string;
  script_title: string;
  hook: string;
  scenes: ScriptScene[];
  cta: string;
  hashtags?: string[];
}

interface ScriptApiResponse {
  vin: string;
  vehicle: Record<string, unknown>;
  scripts: ApiScriptOption[];
  script_title?: string;
  hook?: string;
  scenes?: ScriptScene[];
  cta?: string;
}

const PRIVACY_OPTIONS = [
  { value: 'PUBLIC_TO_EVERYONE',   label: 'Public — everyone can see it' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Friends — mutual followers only' },
  { value: 'SELF_ONLY',            label: 'Private — only me' },
];

// ── Types ──────────────────────────────────────────────────────────────────

type UploadPhase = 'idle' | 'init' | 'uploading' | 'processing' | 'done' | 'error';

interface ConfigStatus {
  configured: boolean;
  missing: string[];
}

interface TrialStatus {
  is_pro: boolean;
  allowed: boolean;
  trial_day: number;
  days_remaining: number;
  posts_today: number;
  daily_limit: number | null;
  trial_expired: boolean;
  daily_limit_hit: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtBytes(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function validateVideo(file: File): string | null {
  const okExt  = ACCEPTED_EXT.some(e => file.name.toLowerCase().endsWith(e));
  const okMime = ACCEPTED_TYPES.includes(file.type) || file.type === '';
  if (!okExt && !okMime)
    return 'Unsupported format — please choose an MP4 or MOV file.';
  if (file.size > MAX_BYTES)
    return `File too large (${fmtBytes(file.size)}) — max 500 MB.`;
  return null;
}

function vehicleBadge(v: ScriptVehicle): string {
  const title = [v.year || '', v.make, v.model, v.trim].filter(Boolean).join(' ').trim();
  const stock = v.stock_number ? `Stock #${v.stock_number}` : 'Stock #N/A';
  return `${title || 'Vehicle'} - ${stock}`;
}

function formatScriptForClipboard(script: ApiScriptOption): string {
  const lines = [
    `SCRIPT: ${script.script_title}`,
    '',
    `HOOK: ${script.hook}`,
    '',
  ];
  for (const scene of script.scenes || []) {
    lines.push(scene.camera);
    lines.push(`"${scene.voiceover}"`);
    lines.push('');
  }
  lines.push(`CTA: ${script.cta}`);
  if (script.hashtags?.length) {
    lines.push('');
    lines.push(script.hashtags.join(' '));
  }
  return lines.join('\n');
}

function mapApiVehicle(raw: Record<string, unknown>): ScriptVehicle | null {
  const vin = String(raw.vin || '').trim();
  if (!vin) return null;
  return {
    vin,
    stock_number: String(raw.stock_number || ''),
    year: Number(raw.year) || 0,
    make: String(raw.make || ''),
    model: String(raw.model || ''),
    trim: String(raw.trim || ''),
    price: Number(raw.price) || 0,
    mileage: Number(raw.mileage) || 0,
    exterior_color: String(raw.exterior_color || raw.color || ''),
    image_url: String(raw.image_url || ''),
    last_seen: String(raw.last_seen || ''),
  };
}

// ── Dynamic Scripter helper components ─────────────────────────────────────

function VehicleStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-800/50 bg-slate-950/50 px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function CameraBadge({ text }: { text: string }) {
  const label = text.replace(/^\[Camera:\s*/i, '').replace(/\]$/, '').trim() || text;
  return (
    <span className="inline-flex max-w-full items-start gap-1.5 rounded-md border border-amber-300/30 bg-gradient-to-b from-amber-300/20 to-amber-500/10 px-2 py-1 text-[11px] font-medium leading-snug text-amber-200">
      <Camera className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-300" />
      <span className="min-w-0">
        <span className="mr-1 font-semibold uppercase tracking-wider text-amber-300/80">Camera</span>
        {label}
      </span>
    </span>
  );
}

// ── Trial-expired paywall ──────────────────────────────────────────────────

function TrialExpiredPaywall() {
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-16 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-slate-900/80 ring-1 ring-slate-800">
        <Lock className="h-9 w-9 text-slate-500" />
      </div>
      <div className="space-y-2">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
          <Crown className="h-3.5 w-3.5" />
          Trial Ended
        </div>
        <h2 className="font-display text-2xl font-bold tracking-tight text-slate-100">
          Your 5-Day Trial Has Ended
        </h2>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-slate-400">
          Upgrade to Pro ($149/mo) to keep auto-posting to TikTok with unlimited
          daily posts and no expiry locks.
        </p>
      </div>
      <div className="flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/pricing">
          <Button className="gap-2 border-0 bg-[#ff0050] px-6 font-semibold text-white shadow-sm hover:bg-[#d4003f]">
            <CreditCard className="h-4 w-4" />
            Upgrade to Pro — $149/mo
          </Button>
        </Link>
      </div>
    </div>
  );
}

// ── Trial status bar ───────────────────────────────────────────────────────

function TrialStatusBar({ trial }: { trial: TrialStatus }) {
  if (trial.is_pro) return null;
  const used  = trial.posts_today;
  const limit = trial.daily_limit ?? 3;
  const pct   = Math.min(100, Math.round((used / limit) * 100));

  const barColor =
    pct >= 100 ? 'bg-destructive' :
    pct >= 67  ? 'bg-amber-500'   :
                 'bg-green-500';

  const bannerColor =
    trial.daily_limit_hit
      ? 'bg-destructive/10 border-destructive/20'
      : pct >= 67
        ? 'bg-amber-400/10 border-amber-300/25'
        : 'bg-muted/60 border-border';

  const dayLabel = trial.trial_day === 0
    ? '5 days available'
    : `Day ${trial.trial_day} of 5${trial.days_remaining > 0 ? ` · ${trial.days_remaining} day${trial.days_remaining !== 1 ? 's' : ''} left` : ''}`;

  return (
    <div className={cn('rounded-xl border px-4 py-3 space-y-2', bannerColor)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium flex items-center gap-1.5">
          {trial.daily_limit_hit
            ? <AlertCircle className="w-3.5 h-3.5 text-destructive" />
            : <Film className="w-3.5 h-3.5 text-[#ff0050]" />}
          <span className={trial.daily_limit_hit ? 'text-destructive font-semibold' : ''}>
            Free Trial
          </span>
        </span>
        <span className="text-muted-foreground tabular-nums">{dayLabel}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-500', barColor)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <span className={cn('font-semibold', trial.daily_limit_hit ? 'text-destructive' : 'text-foreground')}>
            {used} of {limit}
          </span>{' '}
          daily posts used today
        </span>
        {trial.daily_limit_hit && (
          <Link href="/pricing">
            <span className="text-[#ff0050] font-semibold hover:underline cursor-pointer">
              Upgrade to Pro →
            </span>
          </Link>
        )}
      </div>
      {trial.daily_limit_hit && (
        <p className="text-xs text-destructive font-medium pt-0.5">
          You've reached your 3 daily trial posts! Upgrade to Pro for unlimited posting.
        </p>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function TikTokHub() {
  const { user, authFetch, refreshUser } = useAuth();
  const searchStr = useSearch();

  // TikTok API credentials status (fetched once on mount, no auth required)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);

  // Setup card
  const [setupOpen,       setSetupOpen]       = useState(false);
  const [privacyLevel,    setPrivacyLevel]    = useState(
    () => user?.tiktok_privacy_level || 'SELF_ONLY',
  );
  const [privacySaving,   setPrivacySaving]   = useState(false);
  const [connecting,      setConnecting]      = useState(false);
  const [disconnecting,   setDisconnecting]   = useState(false);
  const [connectError,    setConnectError]    = useState('');

  // Trial
  const [trial,        setTrial]        = useState<TrialStatus | null>(null);
  const [trialLoading, setTrialLoading] = useState(true);

  // Video
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoURL,  setVideoURL]  = useState('');
  const [fileError, setFileError] = useState('');
  const [dragging,  setDragging]  = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Caption
  const [caption,    setCaption]    = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError,   setGenError]   = useState('');

  // Publish
  const [phase,           setPhase]           = useState<UploadPhase>('idle');
  const [progress,        setProgress]        = useState(0);
  const [stepMsg,         setStepMsg]         = useState('');
  const [result,          setResult]          = useState<{ ok: boolean; msg: string } | null>(null);
  const [tokenExpired,    setTokenExpired]    = useState(false);
  const [refreshExpired,  setRefreshExpired]  = useState(false);

  // Post history
  interface TikTokPost {
    publish_id: string;
    title: string;
    posted_at: string;
    status: 'PROCESSING' | 'PUBLISH_COMPLETE' | 'FAILED' | string;
    video_url: string;
    failure_reason?: string;
  }
  const [posts,        setPosts]        = useState<TikTokPost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [timeoutHours, setTimeoutHours] = useState(24);

  // ── Dynamic Scripter — inventory from /api/vehicles + server scripts ──
  const [scriptInventory,    setScriptInventory]    = useState<ScriptVehicle[]>([]);
  const [scriptInvLoading,   setScriptInvLoading]   = useState(true);
  const [selectedVin,        setSelectedVin]        = useState('');
  const [vehicleSearch,      setVehicleSearch]      = useState('');
  const [pickerOpen,         setPickerOpen]         = useState(false);
  const [apiScripts,         setApiScripts]         = useState<ApiScriptOption[]>([]);
  const [scriptsLoading,     setScriptsLoading]     = useState(false);
  const [scriptsError,       setScriptsError]       = useState('');
  const [copiedOption,       setCopiedOption]       = useState<string | null>(null);
  const [checkedShots,       setCheckedShots]       = useState<Set<number>>(new Set());
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Check if TikTok API credentials are configured (public endpoint) ──

  useEffect(() => {
    fetch('/api/tiktok/config-status')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setConfigStatus(d as ConfigStatus); })
      .catch(() => {});
  }, []);

  // ── Fetch live showroom inventory for the Dynamic Scripter ─────────────
  // Prefer /api/vehicles; fall back to marketplace hub API.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setScriptInvLoading(true);
      try {
        let list: ScriptVehicle[] = [];
        const primary = await authFetch('/api/vehicles?status=ACTIVE').catch(() => null);
        if (primary && primary.ok) {
          const data = await primary.json();
          const raw = Array.isArray(data.vehicles)
            ? data.vehicles
            : Array.isArray(data.inventory)
              ? data.inventory
              : [];
          list = raw.map((r: Record<string, unknown>) => mapApiVehicle(r)).filter(Boolean) as ScriptVehicle[];
        }
        if (list.length === 0) {
          const fallback = await authFetch('/api/v1/marketplace?status=ACTIVE');
          if (fallback.ok) {
            const data = await fallback.json();
            const raw = Array.isArray(data.inventory) ? data.inventory : [];
            list = raw.map((r: Record<string, unknown>) => mapApiVehicle(r)).filter(Boolean) as ScriptVehicle[];
          }
        }
        if (!cancelled) {
          setScriptInventory(list);
          const defaultVehicle = list.find(v => v.price > 0) || list[0];
          setSelectedVin(prev => prev || defaultVehicle?.vin || '');
        }
      } catch { /* empty-state UI covers this */ }
      finally { if (!cancelled) setScriptInvLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [authFetch]);

  // Close vehicle picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen]);

  // Generate 3 script styles whenever the selected VIN changes
  useEffect(() => {
    if (!selectedVin) {
      setApiScripts([]);
      setScriptsError('');
      return;
    }
    let cancelled = false;
    (async () => {
      setScriptsLoading(true);
      setScriptsError('');
      try {
        const res = await authFetch('/api/generate-tiktok-script', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vin: selectedVin }),
        });
        const data = await res.json() as ScriptApiResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || 'Script generation failed');
        if (!cancelled) setApiScripts(Array.isArray(data.scripts) ? data.scripts : []);
      } catch (e: unknown) {
        if (!cancelled) {
          setApiScripts([]);
          setScriptsError(e instanceof Error ? e.message : 'Script generation failed');
        }
      } finally {
        if (!cancelled) setScriptsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedVin, authFetch]);
  // ── Handle OAuth callback query params ────────────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    const status = params.get('tiktok');
    if (status === 'connected') {
      refreshUser?.();
      setConnectError('');
      setSetupOpen(true);
    } else if (status === 'error') {
      const reason = params.get('reason') || 'unknown';
      setConnectError(`TikTok connection failed (${reason}). Please try again.`);
      setSetupOpen(true);
    }
  }, [searchStr, refreshUser]);

  // ── Fetch trial status ────────────────────────────────────────────────

  const fetchTrial = useCallback(async () => {
    try {
      const res = await authFetch('/api/tiktok/trial-status');
      if (res.ok) setTrial(await res.json() as TrialStatus);
    } catch { /* ignore */ } finally {
      setTrialLoading(false);
    }
  }, [authFetch]);

  const fetchPosts = useCallback(async () => {
    setPostsLoading(true);
    try {
      const res = await authFetch('/api/tiktok/posts');
      if (res.ok) {
        const data = await res.json();
        setPosts(data.posts ?? []);
        if (data.timeout_hours) setTimeoutHours(data.timeout_hours);
      }
    } catch { /* ignore */ } finally {
      setPostsLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    if (user?.tiktok_connected) {
      fetchTrial();
      fetchPosts();
    } else {
      setTrialLoading(false);
    }
  }, [user, fetchTrial, fetchPosts]);

  // ── Sync privacy level from server after user refresh ────────────────
  // (Runs once when user loads; keeps local state in sync after reconnect)
  useEffect(() => {
    if (user?.tiktok_privacy_level) {
      setPrivacyLevel(user.tiktok_privacy_level);
    }
  }, [user?.tiktok_privacy_level]);

  // ── Privacy level change — persist to settings API ───────────────────
  const handlePrivacyChange = useCallback(async (newLevel: string) => {
    setPrivacyLevel(newLevel);
    setPrivacySaving(true);
    try {
      await authFetch('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiktok_privacy_level: newLevel }),
      });
    } catch { /* non-fatal — local state already updated */ } finally {
      setPrivacySaving(false);
    }
  }, [authFetch]);

  // ── TikTok connect / disconnect ───────────────────────────────────────

  const handleConnect = async () => {
    setConnecting(true);
    setConnectError('');
    setTokenExpired(false);
    setRefreshExpired(false);
    try {
      const res  = await authFetch('/api/tiktok/oauth/start');
      const data = await res.json();
      if (!res.ok) {
        // Surface the "credentials not set up" state distinctly
        if (data.error === 'not_configured') {
          const missing = (data.missing_secrets as string[] | undefined) ?? [];
          setConnectError(
            `TikTok API keys are not configured on this server. ` +
            `Add ${missing.join(' and ')} to the server's .env file, then restart the server.`
          );
          setConnecting(false);
          return;
        }
        throw new Error(data.message || data.error || 'Could not start OAuth');
      }
      if (!data.auth_url) throw new Error('No auth URL returned');
      window.location.href = data.auth_url;
    } catch (e: unknown) {
      setConnectError(e instanceof Error ? e.message : 'Connection failed');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect your TikTok account? You can reconnect any time.')) return;
    setDisconnecting(true);
    try {
      await authFetch('/api/tiktok/disconnect', { method: 'DELETE' });
      await refreshUser?.();
      setTrial(null);
      setTrialLoading(false);
      setTokenExpired(false);
      setRefreshExpired(false);
      setConnectError('');
    } catch { /* silent */ } finally {
      setDisconnecting(false);
    }
  };

  // ── Video selection ──────────────────────────────────────────────────

  const pickFile = useCallback((file: File) => {
    const err = validateVideo(file);
    if (err) { setFileError(err); return; }
    setFileError('');
    setVideoFile(file);
    setVideoURL(URL.createObjectURL(file));
    setResult(null);
    setPhase('idle');
    setProgress(0);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  };

  const clearVideo = () => {
    setVideoFile(null);
    setVideoURL('');
    setFileError('');
    setResult(null);
    setPhase('idle');
    setProgress(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ── AI catchphrase ───────────────────────────────────────────────────

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError('');
    try {
      const res  = await authFetch('/api/tiktok/catchphrase', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');
      setCaption(data.catchphrase || '');
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setGenerating(false);
    }
  };

  // ── Dynamic Scripter — derived state + handlers ─────────────────────

  const selectedVehicle = scriptInventory.find(v => v.vin === selectedVin) || null;
  const shotList = buildShotList(selectedVehicle);
  const shotTotalSecs = shotList.reduce((sum, s) => sum + s.seconds, 0);

  const filteredInventory = (() => {
    const q = vehicleSearch.trim().toLowerCase();
    if (!q) return scriptInventory;
    return scriptInventory.filter((v) => {
      const hay = `${v.year} ${v.make} ${v.model} ${v.trim} ${v.stock_number} ${v.vin}`.toLowerCase();
      return hay.includes(q);
    });
  })();

  // Reset the shot checklist whenever the active vehicle changes
  useEffect(() => { setCheckedShots(new Set()); setCopiedOption(null); }, [selectedVin]);

  const handleCopyScript = async (script: ApiScriptOption) => {
    try {
      await navigator.clipboard.writeText(formatScriptForClipboard(script));
      setCopiedOption(script.option);
      setTimeout(() => setCopiedOption((prev) => (prev === script.option ? null : prev)), 2500);
    } catch {
      alert('Copy failed — please select and copy manually.');
    }
  };

  const toggleShot = (id: number) => {
    setCheckedShots(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSendToCaption = (script: ApiScriptOption) => {
    const tags = (script.hashtags || []).join(' ');
    const combined = `${script.hook} ${script.cta} ${tags}`.trim();
    setCaption(combined.slice(0, MAX_CAPTION));
  };

  // ── Publish pipeline ─────────────────────────────────────────────────

  const handlePublish = async () => {
    if (!videoFile || !caption.trim() || phase !== 'idle') return;
    setPhase('init');
    setProgress(0);
    setResult(null);

    try {
      setStepMsg('Initialising upload with TikTok…');
      const initRes = await authFetch('/api/tiktok/publish/init', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:         caption.trim().slice(0, 150),
          video_size:    videoFile.size,
          mime_type:     videoFile.type || 'video/mp4',
          privacy_level: privacyLevel,
        }),
      });
      const initData = await initRes.json();

      if (!initRes.ok) {
        const trialErr = initData?.error;
        if (trialErr === 'tiktok_refresh_expired') {
          setRefreshExpired(true);
          setTokenExpired(true);
          setConnectError(initData?.message || 'Your TikTok authorization has fully expired. Please reconnect your account.');
          setSetupOpen(true);
          await refreshUser?.();
        } else if (trialErr === 'tiktok_token_expired') {
          setTokenExpired(true);
          setConnectError(initData?.message || 'Your TikTok session has expired. Please reconnect your account.');
          setSetupOpen(true);
          await refreshUser?.();
        } else if (trialErr === 'trial_expired' || trialErr === 'daily_limit_hit') {
          await fetchTrial();
        }
        throw new Error(initData?.message || initData?.error || 'Init failed');
      }
      if (!initData.success) throw new Error(initData.error || 'Init failed');

      const { upload_url, chunk_size, total_chunks, publish_id } = initData as {
        upload_url: string; chunk_size: number; total_chunks: number; publish_id: string;
      };

      setPhase('uploading');
      for (let i = 0; i < total_chunks; i++) {
        setStepMsg(`Uploading chunk ${i + 1} of ${total_chunks}…`);
        const start = i * chunk_size;
        const end   = Math.min(start + chunk_size - 1, videoFile.size - 1);
        const chunk = videoFile.slice(start, end + 1);
        const up = await fetch(upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': videoFile.type || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${videoFile.size}` },
          body: chunk,
        });
        if (!up.ok && up.status !== 206 && up.status !== 200)
          throw new Error(`Chunk ${i + 1} upload failed (HTTP ${up.status})`);
        setProgress(Math.round(((i + 1) / total_chunks) * 85));
      }

      setPhase('processing');
      setStepMsg('TikTok is processing your video…');
      let finished = false;
      for (let attempt = 0; attempt < 20 && !finished; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const sr = await authFetch(`/api/tiktok/publish/status?publish_id=${encodeURIComponent(publish_id)}`);
        const sd = await sr.json();
        if (!sr.ok && (sd.error === 'tiktok_refresh_expired' || sd.error === 'tiktok_token_expired')) {
          if (sd.error === 'tiktok_refresh_expired') {
            setRefreshExpired(true);
          }
          setTokenExpired(true);
          setConnectError(sd.message || (
            sd.error === 'tiktok_refresh_expired'
              ? 'Your TikTok authorization has fully expired. Please reconnect your account.'
              : 'Your TikTok session has expired. Please reconnect your account.'
          ));
          setSetupOpen(true);
          await refreshUser?.();
          throw new Error(sd.message || (
            sd.error === 'tiktok_refresh_expired'
              ? 'TikTok authorization fully expired. Please reconnect your account.'
              : 'TikTok session expired. Please reconnect.'
          ));
        }
        if (sd.status === 'PUBLISH_COMPLETE') {
          finished = true;
          setProgress(100);
          setPhase('done');
          setResult({ ok: true, msg: 'Video posted to TikTok! It may take a few minutes to appear on your profile.' });
          fetchTrial();
          fetchPosts();
        } else if (sd.status === 'FAILED') {
          throw new Error(sd.fail_reason || 'TikTok processing failed');
        }
        setProgress(85 + Math.round((attempt / 20) * 14));
      }
      if (!finished) {
        setPhase('done');
        setProgress(100);
        setResult({ ok: true, msg: 'Upload complete. TikTok is still processing — check your profile in a few minutes.' });
        fetchTrial();
        fetchPosts();
      }
    } catch (e: unknown) {
      setPhase('error');
      setResult({ ok: false, msg: e instanceof Error ? e.message : 'Upload failed.' });
    }
  };

  const resetPublish = () => { setPhase('idle'); setProgress(0); setStepMsg(''); setResult(null); };

  const isPublishing  = phase === 'init' || phase === 'uploading' || phase === 'processing';
  const trialBlocked  = !trial?.is_pro && (trial?.daily_limit_hit === true);
  const canPublish    = !!videoFile && !!caption.trim() && !isPublishing && !trialBlocked;
  const isConnected   = !!user?.tiktok_connected;

  // Detect expired token proactively from the user object (backend sets this field).
  const tokenExpiredFromUser = isConnected && !!user?.tiktok_token_expires_at &&
    (new Date(user.tiktok_token_expires_at).getTime() - Date.now() < 60_000);
  const showReconnectPrompt = tokenExpired || tokenExpiredFromUser;
  const showFullReconnect   = refreshExpired;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto space-y-5 py-2">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#ff0050]/10 flex items-center justify-center flex-shrink-0">
          <Film className="w-5 h-5 text-[#ff0050]" />
        </div>
        <div>
          <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent">
            TikTok AI Video Studio
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            Connect your TikTok account, upload vehicle videos, generate AI hooks, and post directly.
          </p>
        </div>
      </div>

      {/* ── Dynamic Scripter & Shot-List Builder ─────────────────── */}
      <div className="overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md">
        <div className="flex items-start gap-2.5 border-b border-slate-800/60 px-5 py-4">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-amber-400/10">
            <Wand2 className="h-4 w-4 text-amber-300" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Dynamic Scripter &amp; Shot List</h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Pick a vehicle from live inventory — we generate three camera-ready scripts with B-roll cues.
            </p>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {scriptInvLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          ) : scriptInventory.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Car className="h-8 w-8 text-slate-600" />
              <p className="text-sm text-slate-400">No active inventory yet.</p>
              <Link href="/marketplace-hub">
                <span className="cursor-pointer text-xs font-semibold text-amber-300 hover:underline">
                  Run a marketplace sync →
                </span>
              </Link>
            </div>
          ) : (
            <>
              {/* Searchable vehicle selector */}
              <div className="space-y-1.5" ref={pickerRef}>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Active Vehicle
                </label>
                <button
                  type="button"
                  onClick={() => setPickerOpen((o) => !o)}
                  className="flex h-11 w-full items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-950/70 px-3 text-left text-sm text-slate-100 transition-colors hover:border-amber-300/30"
                >
                  <Car className="h-4 w-4 flex-shrink-0 text-amber-300/80" />
                  <span className="min-w-0 flex-1 truncate">
                    {selectedVehicle ? vehicleBadge(selectedVehicle) : 'Choose a vehicle…'}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-slate-500 transition-transform', pickerOpen && 'rotate-180')} />
                </button>

                {pickerOpen && (
                  <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950 shadow-2xl shadow-black/50">
                    <div className="flex items-center gap-2 border-b border-slate-800/80 px-3 py-2">
                      <Search className="h-3.5 w-3.5 text-slate-500" />
                      <input
                        autoFocus
                        value={vehicleSearch}
                        onChange={(e) => setVehicleSearch(e.target.value)}
                        placeholder="Search year, make, model, stock #, VIN…"
                        className="h-8 w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-600 outline-none"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                      {filteredInventory.length === 0 ? (
                        <p className="px-3 py-4 text-center text-xs text-slate-500">No matches</p>
                      ) : (
                        filteredInventory.slice(0, 80).map((v) => {
                          const active = v.vin === selectedVin;
                          return (
                            <button
                              key={v.vin}
                              type="button"
                              onClick={() => {
                                setSelectedVin(v.vin);
                                setPickerOpen(false);
                                setVehicleSearch('');
                              }}
                              className={cn(
                                'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors',
                                active ? 'bg-amber-400/10' : 'hover:bg-white/[0.04]',
                              )}
                            >
                              <span className={cn('text-sm font-medium', active ? 'text-amber-100' : 'text-slate-100')}>
                                {vehicleBadge(v)}
                              </span>
                              <span className="font-mono text-[10px] text-slate-500">
                                VIN {v.vin}
                                {v.price > 0 ? ` · $${v.price.toLocaleString()}` : ''}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {selectedVehicle && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <VehicleStat label="Price" value={selectedVehicle.price > 0 ? `$${selectedVehicle.price.toLocaleString()}` : '—'} />
                  <VehicleStat label="Mileage" value={selectedVehicle.mileage > 0 ? `${selectedVehicle.mileage.toLocaleString()} mi` : '—'} />
                  <VehicleStat label="Color" value={selectedVehicle.exterior_color || '—'} />
                  <VehicleStat label="Days on Lot" value={`${daysOnLot(selectedVehicle.last_seen)} d`} />
                </div>
              )}

              {/* Interactive script cards — Option A / B / C */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Generated Scripts
                  </label>
                  {scriptsLoading && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Loader2 className="h-3 w-3 animate-spin" /> Generating…
                    </span>
                  )}
                </div>

                {scriptsError && (
                  <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                    {scriptsError}
                  </div>
                )}

                {!scriptsLoading && !scriptsError && apiScripts.length === 0 && selectedVin && (
                  <p className="text-sm text-slate-500">No scripts returned for this VIN.</p>
                )}

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  {apiScripts.map((script) => {
                    const copied = copiedOption === script.option;
                    return (
                      <article
                        key={script.option}
                        className="flex flex-col overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/80 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] backdrop-blur-md"
                      >
                        <div className="flex items-start justify-between gap-2 border-b border-slate-800/60 px-3.5 py-3">
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300/80">
                              Option {script.option}
                            </p>
                            <h3 className="mt-0.5 text-sm font-semibold text-slate-100">
                              {script.script_title}
                            </h3>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCopyScript(script)}
                            className={cn(
                              'h-7 flex-shrink-0 gap-1 border-slate-700/60 bg-white/[0.03] px-2 text-[11px]',
                              copied
                                ? 'border-emerald-400/40 text-emerald-300'
                                : 'text-slate-300 hover:border-amber-300/30 hover:text-amber-100',
                            )}
                          >
                            {copied
                              ? <><CheckCheck className="h-3.5 w-3.5" /> Copied!</>
                              : <><Copy className="h-3.5 w-3.5" /> Copy Script</>}
                          </Button>
                        </div>

                        <div className="flex flex-1 flex-col gap-3 p-3.5">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Hook</p>
                            <p className="mt-1 text-sm leading-snug text-slate-200">{script.hook}</p>
                          </div>

                          <div className="space-y-2.5">
                            {(script.scenes || []).map((scene) => (
                              <div
                                key={`${script.option}-${scene.order}`}
                                className="space-y-1.5 rounded-lg border border-slate-800/50 bg-slate-950/40 p-2.5"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                    Scene {scene.order}
                                  </span>
                                  <span className="font-mono text-[10px] text-slate-600">{scene.duration_s}s</span>
                                </div>
                                <CameraBadge text={scene.camera} />
                                <p className="text-xs leading-relaxed text-slate-300">
                                  &ldquo;{scene.voiceover}&rdquo;
                                </p>
                              </div>
                            ))}
                          </div>

                          <div className="mt-auto border-t border-slate-800/50 pt-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">CTA</p>
                            <p className="mt-1 text-sm text-slate-200">{script.cta}</p>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="mt-2 h-7 gap-1.5 border border-slate-700/50 bg-white/[0.04] text-[11px] text-slate-200 hover:bg-white/[0.08]"
                              onClick={() => handleSendToCaption(script)}
                            >
                              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                              Send to Caption Box
                            </Button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              {/* Visual shot-list sequence builder */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Visual Shot-List Sequence
                  </label>
                  <span className="text-[11px] text-slate-500">~{shotTotalSecs}s total</span>
                </div>
                <div className="space-y-1.5">
                  {shotList.map((shot, i) => {
                    const checked = checkedShots.has(shot.id);
                    return (
                      <button
                        key={shot.id}
                        type="button"
                        onClick={() => toggleShot(shot.id)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                          checked
                            ? 'border-emerald-400/30 bg-emerald-400/10'
                            : 'border-slate-800/60 bg-slate-950/40 hover:bg-white/[0.04]',
                        )}
                      >
                        <div className={cn(
                          'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold',
                          checked ? 'border-emerald-400 bg-emerald-400 text-slate-950' : 'border-slate-600 text-slate-500',
                        )}>
                          {checked ? '✓' : i + 1}
                        </div>
                        <span className={cn('flex-1 text-sm text-slate-200', checked && 'text-slate-500 line-through')}>
                          Shot {i + 1}: {shot.label}{' '}
                          <span className="text-slate-500">({shot.seconds}s)</span>
                        </span>
                        <Camera className={cn('h-3.5 w-3.5 flex-shrink-0', checked ? 'text-emerald-400' : 'text-slate-600')} />
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── TikTok API credentials not configured — admin setup guide ── */}
      {configStatus && !configStatus.configured && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-400/10 px-4 py-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
              <KeyRound className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-200 flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                TikTok API credentials not configured
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 leading-relaxed">
                The following environment variables must be set before anyone can connect a TikTok account:
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {configStatus.missing.map(k => (
                  <code key={k} className="text-[11px] font-mono bg-amber-100 dark:bg-amber-900/50 text-amber-200 px-2 py-0.5 rounded border border-amber-300/25 dark:border-amber-700">
                    {k}
                  </code>
                ))}
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 leading-relaxed">
                1. Open your TikTok developer portal → create an app → copy the <strong>Client Key</strong> and <strong>Client Secret</strong>.<br />
                2. Add both keys to the <strong>.env</strong> file at the project root.<br />
                3. Restart the API server — the Connect button will unlock automatically.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Token-expired reconnect banner ──────────────────────────── */}
      {showReconnectPrompt && (
        <div className={cn(
          'rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3',
          showFullReconnect
            ? 'border-destructive/40 bg-destructive/5 dark:bg-destructive/10'
            : 'border-amber-300 dark:border-amber-700 bg-amber-400/10',
        )}>
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <AlertCircle className={cn(
              'w-4 h-4 flex-shrink-0 mt-0.5',
              showFullReconnect
                ? 'text-destructive'
                : 'text-amber-600 dark:text-amber-400',
            )} />
            <div>
              <p className={cn(
                'text-sm font-semibold',
                showFullReconnect
                  ? 'text-destructive'
                  : 'text-amber-200',
              )}>
                {showFullReconnect ? 'TikTok Authorization Expired' : 'TikTok Session Expired'}
              </p>
              <p className={cn(
                'text-xs mt-0.5 leading-relaxed',
                showFullReconnect
                  ? 'text-destructive/80'
                  : 'text-amber-700 dark:text-amber-400',
              )}>
                {showFullReconnect
                  ? 'Your TikTok authorization has fully expired (refresh token gone). You must reconnect your account to continue posting.'
                  : 'Your TikTok access token has expired. Reconnect to continue posting videos.'}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={connecting}
            className="gap-1.5 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0 shrink-0"
          >
            {connecting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting…</>
              : <><RefreshCw className="w-3.5 h-3.5" /> Reconnect TikTok</>}
          </Button>
        </div>
      )}

      {/* ── ⚙️ TikTok Connection & Account Setup ────────────────────── */}
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
        <button
          type="button"
          onClick={() => setSetupOpen(p => !p)}
          className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={cn(
              'w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0',
              isConnected ? 'bg-green-500/10' : 'bg-muted',
            )}>
              <Settings className={cn('w-3.5 h-3.5', isConnected ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')} />
            </div>
            <div className="text-left min-w-0">
              <p className="text-sm font-semibold">⚙️ TikTok Connection &amp; Account Setup</p>
              {!setupOpen && (
                <p className="text-xs mt-0.5 font-medium">
                  {isConnected
                    ? <span className="text-green-600 dark:text-green-400 flex items-center gap-1">
                        <Wifi className="w-3 h-3" /> Connected
                      </span>
                    : <span className="text-amber-500 flex items-center gap-1">
                        <WifiOff className="w-3 h-3" /> Not connected — click to set up
                      </span>}
                </p>
              )}
            </div>
          </div>
          {setupOpen
            ? <ChevronUp   className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
        </button>

        {setupOpen && (
          <div className="border-t px-4 py-5 space-y-4">
            {/* Quick Setup Instructions */}
            <div className="rounded-lg bg-sky-400/10 border border-sky-400/25 px-4 py-3 space-y-1.5">
              <p className="text-xs font-semibold text-sky-300 dark:text-blue-400">💡 Quick Setup Instructions</p>
              <p className="text-xs text-sky-300 leading-relaxed">
                1. Click "Connect TikTok Account" and authorize BDC Manager Desk in TikTok.
              </p>
              <p className="text-xs text-sky-300 leading-relaxed">
                2. Choose your default video privacy setting (Public recommended for maximum reach).
              </p>
              <p className="text-xs text-sky-300 leading-relaxed">
                3. Use the AI Video Studio below to upload walkarounds, generate catchy hooks, and post!
              </p>
            </div>

            {/* Connection status + actions */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium flex-1',
                isConnected
                  ? 'bg-emerald-400/10 dark:bg-green-950/20 border-emerald-400/25 dark:border-green-800 text-green-700 dark:text-green-400'
                  : 'bg-muted/60 border-border text-muted-foreground',
              )}>
                {isConnected
                  ? <><Wifi    className="w-4 h-4 flex-shrink-0" /> TikTok Account Connected</>
                  : <><WifiOff className="w-4 h-4 flex-shrink-0" /> TikTok Not Connected</>}
              </div>
              {isConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="gap-1.5 text-destructive border-destructive/40 hover:bg-destructive/10"
                >
                  {disconnecting
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Disconnecting…</>
                    : <><WifiOff className="w-3.5 h-3.5" /> Disconnect TikTok</>}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="gap-1.5 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0"
                >
                  {connecting
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting…</>
                    : <><Wifi className="w-3.5 h-3.5" /> Connect TikTok Account</>}
                </Button>
              )}
            </div>

            {connectError && (
              <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {connectError}
              </div>
            )}

            {/* Default Privacy Level */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Default Video Privacy
              </label>
              <div className="flex items-center gap-2">
                <Select value={privacyLevel} onValueChange={handlePrivacyChange}>
                  <SelectTrigger className="h-9 text-sm max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIVACY_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {privacySaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground flex-shrink-0" />}
              </div>
              <p className="text-[11px] text-muted-foreground">
                This preference is saved to your account and persists across sessions.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Studio content (only when connected) ───────────────────────── */}
      {!isConnected ? (
        <div className="rounded-xl border border-dashed bg-muted/20 py-14 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
            <Film className="w-6 h-6 text-muted-foreground/40" />
          </div>
          <div>
            <p className="font-semibold text-muted-foreground">Studio Locked</p>
            <p className="text-sm text-muted-foreground/70 mt-1 max-w-xs">
              Connect your TikTok account above to unlock the AI Video Studio.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => { setSetupOpen(true); handleConnect(); }}
            disabled={connecting}
            className="gap-1.5 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0"
          >
            {connecting
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting…</>
              : <><Wifi className="w-3.5 h-3.5" /> Connect TikTok Account</>}
          </Button>
        </div>
      ) : trialLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : trial?.trial_expired ? (
        <TrialExpiredPaywall />
      ) : (
        <>
          {/* Trial status bar */}
          {trial && !trial.is_pro && <TrialStatusBar trial={trial} />}

          {/* Two-column studio layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Left: Video drop-zone */}
            <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
              <div className="px-5 py-4 border-b">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <UploadCloud className="w-4 h-4 text-muted-foreground" />
                  Video File
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">MP4 or MOV · max 500 MB</p>
              </div>
              <div className="p-5">
                {!videoFile ? (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => fileRef.current?.click()}
                    className={cn(
                      'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed',
                      'min-h-[220px] cursor-pointer transition-colors select-none',
                      dragging
                        ? 'border-[#ff0050] bg-[#ff0050]/5 text-[#ff0050]'
                        : 'border-border hover:border-primary/50 hover:bg-muted/30 text-muted-foreground',
                    )}
                  >
                    <div className={cn('w-12 h-12 rounded-full flex items-center justify-center transition-colors', dragging ? 'bg-[#ff0050]/10' : 'bg-muted')}>
                      <Upload className="w-5 h-5" />
                    </div>
                    <div className="text-center space-y-1">
                      <p className="text-sm font-medium">{dragging ? 'Drop it here!' : 'Drag & drop or click to browse'}</p>
                      <p className="text-xs opacity-70">MP4 / MOV · up to 500 MB</p>
                    </div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept={ACCEPTED_EXT.join(',')}
                      className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
                      <video src={videoURL} className="w-full h-full object-contain" controls preload="metadata" />
                      <button
                        onClick={clearVideo}
                        disabled={isPublishing}
                        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center transition-colors"
                        aria-label="Remove video"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-muted/40">
                      <Film className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{videoFile.name}</p>
                        <p className="text-[11px] text-muted-foreground">{fmtBytes(videoFile.size)}</p>
                      </div>
                      <button onClick={clearVideo} disabled={isPublishing} className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded flex-shrink-0" aria-label="Remove video">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {fileError && (
                  <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    {fileError}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Caption + Publish */}
            <div className="flex flex-col gap-5">

              {/* AI Catchphrase Generator */}
              <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
                <div className="px-5 py-4 border-b">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    AI Catchphrase Generator
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">Generate a car-sales hook + hashtags optimised for TikTok.</p>
                </div>
                <div className="p-5 space-y-3">
                  <Button variant="outline" size="sm" onClick={handleGenerate} disabled={generating} className="gap-1.5">
                    {generating
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating…</>
                      : <><Sparkles className="w-3.5 h-3.5 text-amber-500" /> Generate Catchphrase</>}
                  </Button>
                  {genError && (
                    <p className="text-xs text-destructive flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {genError}
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <Textarea
                      placeholder="Your caption will appear here after generation, or type your own…"
                      value={caption}
                      onChange={(e) => setCaption(e.target.value.slice(0, MAX_CAPTION))}
                      rows={5}
                      className="resize-none text-sm leading-relaxed font-mono"
                      disabled={isPublishing}
                    />
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>Edit before posting. First 150 chars used as TikTok title.</span>
                      <span className={cn(caption.length > MAX_CAPTION * 0.9 && 'text-amber-500 font-semibold')}>
                        {caption.length} / {MAX_CAPTION}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Publish Panel */}
              <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
                <div className="px-5 py-4 border-b">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Send className="w-4 h-4 text-[#ff0050]" />
                    Post to TikTok
                    {trial?.is_pro && (
                      <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5 rounded-full">
                        <Crown className="w-2.5 h-2.5" /> PRO · Unlimited
                      </span>
                    )}
                  </h2>
                </div>
                <div className="p-5 space-y-4">

                  {/* Readiness checklist */}
                  <div className="space-y-1.5">
                    {[
                      { ok: !!videoFile,      label: videoFile ? videoFile.name.slice(0, 32) : 'No video selected' },
                      { ok: !!caption.trim(), label: caption.trim() ? 'Caption ready' : 'No caption yet' },
                    ].map((item, i) => (
                      <div key={i} className={cn('flex items-center gap-2 text-xs', item.ok ? 'text-foreground' : 'text-muted-foreground')}>
                        <div className={cn('w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center', item.ok ? 'border-green-500 bg-green-500 text-white text-[9px] font-bold' : 'border-muted-foreground/40')}>
                          {item.ok && '✓'}
                        </div>
                        <span className="truncate">{item.label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Progress */}
                  {isPublishing && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#ff0050] flex-shrink-0" />
                        <span className="text-xs text-muted-foreground">{stepMsg}</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-[#ff0050] transition-all duration-500" style={{ width: `${progress}%` }} />
                      </div>
                      <p className="text-[11px] text-right text-muted-foreground">{progress}%</p>
                    </div>
                  )}

                  {/* Result */}
                  {result && (
                    <div className={cn(
                      'flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-xs',
                      result.ok
                        ? 'bg-emerald-400/10 dark:bg-green-950/20 border-emerald-400/25 dark:border-green-800 text-emerald-200 dark:text-green-300'
                        : 'bg-destructive/10 border-destructive/20 text-destructive',
                    )}>
                      {result.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                      <span className="flex-1 leading-snug">{result.msg}</span>
                      <button onClick={resetPublish} className="opacity-50 hover:opacity-100 flex-shrink-0 mt-0.5">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Daily-limit block */}
                  {trialBlocked && !isPublishing && (
                    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border bg-destructive/10 border-destructive/20 text-xs text-destructive">
                      <Lock className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span className="flex-1 leading-snug">You've reached your 3 daily trial posts! Upgrade to Pro for unlimited posting.</span>
                    </div>
                  )}

                  {/* Publish button */}
                  {trialBlocked && !isPublishing ? (
                    <Link href="/pricing" className="block">
                      <Button className="w-full gap-2 font-semibold" variant="outline">
                        <CreditCard className="w-4 h-4" />
                        Upgrade to Pro — Unlimited Posts
                      </Button>
                    </Link>
                  ) : (
                    <Button
                      className="w-full gap-2 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0 font-semibold shadow-sm"
                      disabled={!canPublish}
                      onClick={handlePublish}
                    >
                      {isPublishing
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Posting…</>
                        : <><Send className="w-4 h-4" /> Post to TikTok</>}
                    </Button>
                  )}

                  <p className="text-[11px] text-muted-foreground text-center leading-snug">
                    Video is chunked and uploaded directly from your browser to TikTok's servers —
                    it never passes through BDC Manager Desk infrastructure.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* ── Recent Posts ─────────────────────────────────────────── */}
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 backdrop-blur-md overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <History className="w-4 h-4 text-muted-foreground" />
                Recent Posts
              </h2>
              <button
                onClick={fetchPosts}
                disabled={postsLoading}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                aria-label="Refresh post history"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', postsLoading && 'animate-spin')} />
                Refresh
              </button>
            </div>

            {postsLoading && posts.length === 0 ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : posts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-center px-4">
                <Clock className="w-8 h-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No posts yet — your history will appear here after your first upload.</p>
              </div>
            ) : (
              <div className="divide-y">
                {posts.map((post) => {
                  const isComplete  = post.status === 'PUBLISH_COMPLETE';
                  const isFailed    = post.status === 'FAILED';
                  const isTimedOut  = isFailed && post.failure_reason === 'timed_out';
                  const isProcessing = post.status === 'PROCESSING';
                  return (
                    <div key={post.publish_id} className="px-5 py-3 flex items-start gap-3">
                      <div className={cn(
                        'w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5',
                        isComplete   ? 'bg-green-500/10'      :
                        isFailed     ? 'bg-destructive/10'    :
                                       'bg-amber-500/10',
                      )}>
                        {isComplete   && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />}
                        {isFailed     && <AlertCircle  className="w-3.5 h-3.5 text-destructive" />}
                        {isProcessing && <Loader2      className="w-3.5 h-3.5 text-amber-500 animate-spin" />}
                        {!isComplete && !isFailed && !isProcessing && <Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{post.title || '(no title)'}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {post.posted_at
                            ? new Date(post.posted_at).toLocaleString(undefined, {
                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                              })
                            : '—'}
                        </p>
                        {isTimedOut && (
                          <p className="text-[11px] text-destructive/80 mt-0.5">
                            TikTok did not confirm this post (timed out after {timeoutHours} hours) — safe to re-post
                          </p>
                        )}
                        {isFailed && !isTimedOut && (
                          <p className="text-[11px] text-destructive/80 mt-0.5">
                            Upload or API error — safe to re-post
                          </p>
                        )}
                      </div>
                      <span className={cn(
                        'flex-shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-0.5',
                        isComplete   ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'   :
                        isFailed     ? 'bg-destructive/10 text-destructive'                                      :
                                       'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
                      )}>
                        {isComplete ? 'Live' : isFailed ? (isTimedOut ? 'Timed Out' : 'Failed') : 'Processing'}
                      </span>
                      {isComplete && post.video_url && (
                        <a
                          href={post.video_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View on TikTok"
                          className="flex-shrink-0 text-muted-foreground hover:text-[#ff0050] transition-colors p-1 rounded"
                          aria-label="View on TikTok"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
