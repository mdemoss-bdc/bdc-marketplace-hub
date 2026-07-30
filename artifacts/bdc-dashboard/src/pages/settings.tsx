import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Loader2, CheckCircle, XCircle, Eye, EyeOff,
  Link2, Copy, Check, MapPin,
  RefreshCw, CreditCard, AlertTriangle, Film,
} from 'lucide-react';

const API_BASE = '/api';

// ── Small shared sub-components ────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm font-semibold text-foreground/80 uppercase tracking-wider pb-1 border-b border-border">
      {children}
    </div>
  );
}

function StatusBanner({ ok, message }: { ok: boolean; message: string }) {
  const colorClass = ok
    ? 'bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400'
    : 'bg-destructive/10 border-destructive/20 text-destructive';
  return (
    <div className={`flex items-start gap-2 p-3 rounded-md text-sm border ${colorClass}`}>
      {ok
        ? <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        : <XCircle    className="w-4 h-4 flex-shrink-0 mt-0.5" />}
      <span className="flex-1 leading-snug">{message}</span>
    </div>
  );
}

function SecretInput({
  id, label, value, maskedPlaceholder, onChange, note,
}: {
  id: string; label: string; value: string; maskedPlaceholder?: string;
  onChange: (v: string) => void; note?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {maskedPlaceholder && !value && (
          <span className="ml-2 font-normal text-muted-foreground text-xs">
            (currently set — enter a new value to change)
          </span>
        )}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          placeholder={maskedPlaceholder || `Enter ${label}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          className="pr-10"
        />
        <button
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          aria-label={show ? 'Hide' : 'Show'}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="flex-shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

const SCRAPER_FREQUENCIES = [
  { value: 'daily',       label: 'Daily',       description: 'Once per day (default)' },
  { value: 'twice_daily', label: 'Twice Daily',  description: 'Morning and afternoon' },
  { value: 'weekly',      label: 'Weekly',       description: 'Once per week' },
];

// ── Main component ─────────────────────────────────────────────────────────

export default function Settings() {
  const { token, authFetch, user, refreshUser } = useAuth();

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [userId, setUserId] = useState<number>(0);

  // ── Contact info (loaded passthrough — kept so postSettings never clears them) ──
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPhone, setAccountPhone] = useState('');

  // ── Facebook / Meta Integration ───────────────────────────────────
  const [fbPageId, setFbPageId]                           = useState('');
  const [fbAccessToken, setFbAccessToken]                 = useState('');
  const [fbAccessTokenMasked, setFbAccessTokenMasked]     = useState('');
  const [catalogToken, setCatalogToken]                   = useState('');
  const [savingFacebook, setSavingFacebook]               = useState(false);
  const [fbStatus, setFbStatus]                           = useState<'idle' | 'success' | 'error'>('idle');
  const [fbMsg, setFbMsg]                                 = useState('');

  // ── Scraper & Sync Schedules ──────────────────────────────────────
  const [inventoryUrlUsed, setInventoryUrlUsed]     = useState('');
  const [inventoryUrlNew, setInventoryUrlNew]       = useState('');
  const [salespersonFilter, setSalespersonFilter]   = useState('');
  const [scraperFrequency, setScraperFrequency]     = useState('daily');
  const [savingInventory, setSavingInventory]       = useState(false);
  const [invStatus, setInvStatus]                   = useState<'idle' | 'success' | 'error'>('idle');
  const [invMsg, setInvMsg]                         = useState('');

  // ── Dealership Info (return address for printed envelopes) ───────
  const [dealerName, setDealerName]                 = useState('');
  const [dealerAddressLine1, setDealerAddressLine1] = useState('');
  const [dealerCity, setDealerCity]                 = useState('');
  const [dealerState, setDealerState]               = useState('');
  const [dealerZip, setDealerZip]                   = useState('');
  const [savingDealer, setSavingDealer]             = useState(false);
  const [dealerStatus, setDealerStatus]             = useState<'idle' | 'success' | 'error'>('idle');
  const [dealerMsg, setDealerMsg]                   = useState('');

  // ── Dealership Locations ──────────────────────────────────────────
  interface LocationRow { location: string; enabled: boolean }
  const [locations, setLocations]               = useState<LocationRow[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [savingLocations, setSavingLocations]   = useState(false);
  const [locStatus, setLocStatus]               = useState<'idle' | 'success' | 'error'>('idle');
  const [locMsg, setLocMsg]                     = useState('');

  // ── Billing & Subscription ────────────────────────────────────────
  interface BillingStatus {
    subscription_status: string;
    is_admin: boolean;
    stripe_customer_id: string;
    stripe_subscription_id: string;
    subscription_period_end: string;
    subscription_cancel_scheduled: boolean;
  }
  const [billingStatus, setBillingStatus]   = useState<BillingStatus | null>(null);
  const [loadingBilling, setLoadingBilling] = useState(true);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling]           = useState(false);
  const [reactivating, setReactivating]       = useState(false);
  const [billingActionMsg, setBillingActionMsg] = useState('');

  // ── TikTok Integration ─────────────────────────────────────────────
  const [tiktokConnecting, setTiktokConnecting] = useState(false);
  const [tiktokMsg,        setTiktokMsg]        = useState('');
  const [tiktokMsgOk,      setTiktokMsgOk]      = useState(false);

  // ── Derived: TikTok token expiry ──────────────────────────────────
  // Show a reconnect prompt when the stored token is expired or about to expire
  // (within 60 seconds). The backend surfaces tiktok_token_expires_at on /api/auth/me.
  const tiktokNeedsReconnect = useMemo(() => {
    if (!user?.tiktok_connected) return false;
    const expiresAt = user?.tiktok_token_expires_at;
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() - Date.now() < 60_000;
  }, [user]);

  // ── Helpers ───────────────────────────────────────────────────────
  const formatDate = (isoStr: string) => {
    if (!isoStr) return '';
    try {
      return new Date(isoStr).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      });
    } catch {
      return isoStr;
    }
  };

  // ── Derived ───────────────────────────────────────────────────────
  // Multi-tenant Meta feed — scoped by the logged-in user's account id.
  const catalogUrl = userId
    ? `${window.location.origin}/api/feeds/meta?format=csv&user_id=${userId}`
    : '';

  // ── Load settings ──────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    authFetch(`${API_BASE}/v1/settings`)
      .then((r) => r.json())
      .then((data) => {
        setAccountEmail(data.email || '');
        setAccountPhone(data.phone || '');
        setFbPageId(data.fb_page_id || '');
        setFbAccessTokenMasked(data.fb_access_token_masked || '');
        setCatalogToken(data.catalog_token || '');
        setInventoryUrlUsed(data.inventory_url_used || '');
        setInventoryUrlNew(data.inventory_url_new || '');
        setSalespersonFilter(data.salesperson_filter || '');
        setScraperFrequency(data.scraper_frequency || 'daily');
        setUserId(data.user_id || 0);
        setDealerName(data.dealer_name || '');
        setDealerAddressLine1(data.dealer_address_line1 || '');
        setDealerCity(data.dealer_city || '');
        setDealerState(data.dealer_state || '');
        setDealerZip(data.dealer_zip || '');
      })
      .catch(() => {})
      .finally(() => setLoadingSettings(false));
  }, [token, authFetch]);

  // ── Load billing status ────────────────────────────────────────────
  const loadBillingStatus = useCallback(() => {
    if (!token) return;
    setLoadingBilling(true);
    authFetch(`${API_BASE}/v1/billing/status`)
      .then((r) => r.json())
      .then((data) => setBillingStatus(data))
      .catch(() => {})
      .finally(() => setLoadingBilling(false));
  }, [token, authFetch]);

  useEffect(() => { loadBillingStatus(); }, [loadBillingStatus]);

  // Cancel subscription (cancel_at_period_end = true)
  const handleCancelSubscription = useCallback(async () => {
    setCancelling(true);
    setBillingActionMsg('');
    try {
      const res  = await authFetch(`${API_BASE}/v1/billing/cancel`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancellation failed.');
      setShowCancelModal(false);
      loadBillingStatus();
    } catch (err: unknown) {
      setBillingActionMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setCancelling(false);
    }
  }, [authFetch, loadBillingStatus]);

  // Reactivate subscription (cancel_at_period_end = false)
  const handleReactivate = useCallback(async () => {
    setReactivating(true);
    setBillingActionMsg('');
    try {
      const res  = await authFetch(`${API_BASE}/v1/billing/reactivate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reactivation failed.');
      loadBillingStatus();
    } catch (err: unknown) {
      setBillingActionMsg(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setReactivating(false);
    }
  }, [authFetch, loadBillingStatus]);

  // Handle TikTok OAuth callback query params on page load
  useEffect(() => {
    const params     = new URLSearchParams(window.location.search);
    const tiktokParam = params.get('tiktok');
    if (tiktokParam === 'connected') {
      setTiktokMsgOk(true);
      setTiktokMsg('TikTok account connected successfully!');
      refreshUser();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (tiktokParam === 'error') {
      const reason = params.get('reason') || 'unknown';
      setTiktokMsgOk(false);
      setTiktokMsg(`TikTok connection failed (${reason}). Please try again.`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnectTikTok = useCallback(async () => {
    setTiktokConnecting(true);
    setTiktokMsg('');
    try {
      const res  = await authFetch('/api/tiktok/oauth/start');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start TikTok auth.');
      if (data.auth_url) window.location.href = data.auth_url;
    } catch (err: unknown) {
      setTiktokMsgOk(false);
      setTiktokMsg(err instanceof Error ? err.message : 'Connection failed.');
      setTiktokConnecting(false);
    }
  }, [authFetch]);

  const handleDisconnectTikTok = useCallback(async () => {
    setTiktokConnecting(true);
    setTiktokMsg('');
    try {
      const res  = await authFetch('/api/tiktok/disconnect', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Disconnect failed.');
      setTiktokMsgOk(true);
      setTiktokMsg('TikTok account disconnected.');
      refreshUser();
    } catch (err: unknown) {
      setTiktokMsgOk(false);
      setTiktokMsg(err instanceof Error ? err.message : 'Disconnect failed.');
    } finally {
      setTiktokConnecting(false);
    }
  }, [authFetch, refreshUser]);

  // ── Load locations ─────────────────────────────────────────────────
  const reloadLocations = useCallback(() => {
    if (!token) return;
    setLoadingLocations(true);
    authFetch(`${API_BASE}/v1/locations`)
      .then((r) => r.json())
      .then((data) => setLocations(
        (data.locations ?? []).map((l: { location: string; enabled: number | boolean }) => ({
          location: l.location,
          enabled: Boolean(l.enabled),
        }))
      ))
      .catch(() => {})
      .finally(() => setLoadingLocations(false));
  }, [token, authFetch]);

  useEffect(() => { reloadLocations(); }, [reloadLocations]);

  // ── Shared post helper (sends all active fields to /api/v1/settings) ─
  const postSettings = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/v1/settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:              accountEmail,
        phone:              accountPhone,
        fb_page_id:         fbPageId,
        fb_access_token:    fbAccessToken,   // empty = don't overwrite stored token
        catalog_token:      catalogToken,
        inventory_url_used:   inventoryUrlUsed,
        inventory_url_new:    inventoryUrlNew,
        salesperson_filter:   salespersonFilter,
        scraper_frequency:    scraperFrequency,
        dealer_name:          dealerName,
        dealer_address_line1: dealerAddressLine1,
        dealer_city:          dealerCity,
        dealer_state:         dealerState,
        dealer_zip:           dealerZip,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    return data;
  }, [
    authFetch, accountEmail, accountPhone, fbPageId, fbAccessToken,
    catalogToken, inventoryUrlUsed, inventoryUrlNew, salespersonFilter, scraperFrequency,
    dealerName, dealerAddressLine1, dealerCity, dealerState, dealerZip,
  ]);

  // ── Save: Facebook / Meta ──────────────────────────────────────────
  const handleSaveFacebook = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingFacebook(true);
    setFbStatus('idle');
    try {
      await postSettings();
      setFbStatus('success');
      setFbMsg('Facebook settings saved.');
      if (fbAccessToken) {
        const l = fbAccessToken.length;
        setFbAccessTokenMasked(l > 4 ? '*'.repeat(l - 4) + fbAccessToken.slice(-4) : '*'.repeat(l));
        setFbAccessToken('');
      }
    } catch (err: unknown) {
      setFbStatus('error');
      setFbMsg(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingFacebook(false);
    }
  }, [postSettings, fbAccessToken]);

  // ── Save: Scraper & Sync ───────────────────────────────────────────
  const handleSaveInventory = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingInventory(true);
    setInvStatus('idle');
    try {
      await postSettings();
      setInvStatus('success');
      setInvMsg('Scraper settings saved. Changes take effect on the next sync cycle.');
    } catch (err: unknown) {
      setInvStatus('error');
      setInvMsg(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingInventory(false);
    }
  }, [postSettings]);

  // ── Locations helpers ──────────────────────────────────────────────
  const toggleLocation = useCallback((name: string, checked: boolean) => {
    setLocations((prev) =>
      prev.map((l) => (l.location === name ? { ...l, enabled: checked } : l))
    );
  }, []);

  const selectAllLocations   = useCallback(() =>
    setLocations((prev) => prev.map((l) => ({ ...l, enabled: true }))), []);
  const deselectAllLocations = useCallback(() =>
    setLocations((prev) => prev.map((l) => ({ ...l, enabled: false }))), []);

  const handleSaveLocations = useCallback(async () => {
    setSavingLocations(true);
    setLocStatus('idle');
    try {
      const locMap: Record<string, boolean> = {};
      locations.forEach((l) => { locMap[l.location] = l.enabled; });
      const res = await authFetch(`${API_BASE}/v1/locations`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locations: locMap }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setLocStatus('success');
      setLocMsg('Location filter saved.');
    } catch (err: unknown) {
      setLocStatus('error');
      setLocMsg(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingLocations(false);
    }
  }, [authFetch, locations]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-display font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your account, Meta integration, inventory source, and sync schedules.
        </p>
      </div>

      {/* ── 0. Billing & Subscription ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            Billing &amp; Subscription
          </CardTitle>
          <CardDescription>
            Your current plan, billing cycle, and cancellation options.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingBilling ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : billingStatus?.is_admin ? (
            <div className="flex items-center gap-3 py-1">
              <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-0 text-xs">
                Admin Account
              </Badge>
              <span className="text-sm text-muted-foreground">
                Full access · Billing does not apply to admin accounts.
              </span>
            </div>
          ) : billingStatus?.subscription_status === 'active' ? (
            <div className="space-y-4">
              {/* Plan info row */}
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-3">
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-sm font-semibold">BDC Manager Desk Pro</p>
                    <p className="text-xs text-muted-foreground mt-0.5">$75.00 / month · recurring</p>
                  </div>
                  {billingStatus.subscription_cancel_scheduled ? (
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-700 text-xs font-medium">
                      ⚠ Cancels {formatDate(billingStatus.subscription_period_end)} · Access Active
                    </Badge>
                  ) : (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border border-green-200 dark:border-green-800 text-xs font-medium">
                      ✓ Active
                    </Badge>
                  )}
                </div>

                {/* Cancellation notice */}
                {billingStatus.subscription_cancel_scheduled && (
                  <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                    Your subscription is scheduled to cancel on{' '}
                    <strong>{formatDate(billingStatus.subscription_period_end)}</strong>.
                    You retain full access to all features — including your Meta catalog feed —
                    until that date. No refund will be issued for the remaining time in this
                    billing period.
                  </div>
                )}

                {/* Next renewal (only shown when NOT canceling) */}
                {!billingStatus.subscription_cancel_scheduled && billingStatus.subscription_period_end && (
                  <p className="text-xs text-muted-foreground">
                    Next renewal:{' '}
                    <span className="font-medium text-foreground/70">
                      {formatDate(billingStatus.subscription_period_end)}
                    </span>
                  </p>
                )}
              </div>

              {billingActionMsg && (
                <StatusBanner ok={false} message={billingActionMsg} />
              )}

              {billingStatus.subscription_cancel_scheduled ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReactivate}
                  disabled={reactivating}
                  className="gap-2 border-green-500/50 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/40"
                >
                  {reactivating
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Reactivating…</>
                    : <><RefreshCw className="w-3.5 h-3.5" />Reactivate Subscription</>}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setBillingActionMsg(''); setShowCancelModal(true); }}
                  className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/5"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Cancel Subscription
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-muted-foreground text-xs">
                  No active subscription
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Subscribe to unlock the Marketplace Hub, posting queue, and Meta catalog feed.
              </p>
              <Button asChild size="sm" className="gap-2 w-fit">
                <a href="/pricing">Upgrade to Pro — $75/month</a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Facebook / Meta Integration ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-blue-500" />
            Facebook / Meta Integration
          </CardTitle>
          <CardDescription>
            Automotive catalog feed for Meta Commerce Manager, your Facebook Page ID,
            and API access token for posting and catalog management.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingSettings ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : (
            <form onSubmit={handleSaveFacebook} className="space-y-5">

              {/* Catalog Feed */}
              {catalogUrl && (
                <div className="space-y-3">
                  <SectionLabel>Catalog Feed</SectionLabel>

                  <div className="space-y-2">
                    <Label>Feed URL</Label>
                    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                      <span className="flex-1 font-mono text-xs break-all text-foreground/80">
                        {catalogUrl}
                      </span>
                      <CopyButton text={catalogUrl} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Paste into Meta Commerce Manager → Data sources → Add catalog → Scheduled feed.
                      Meta scrapes it automatically to populate your vehicle ads.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="catalogToken">
                      Catalog Token
                      <span className="ml-2 font-normal text-muted-foreground text-xs">
                        (optional — restricts access via ?token=)
                      </span>
                    </Label>
                    <Input
                      id="catalogToken"
                      type="text"
                      placeholder="Leave blank for open access"
                      value={catalogToken}
                      onChange={(e) => setCatalogToken(e.target.value)}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      If set, requests to your feed URL must include{' '}
                      <code className="font-mono bg-muted px-1 rounded">?token=yourtoken</code>.
                    </p>
                  </div>
                </div>
              )}

              {/* Meta API Credentials */}
              <div className="space-y-3">
                <SectionLabel>Meta API Credentials</SectionLabel>

                <div className="space-y-2">
                  <Label htmlFor="fbPageId">Facebook Page ID</Label>
                  <Input
                    id="fbPageId"
                    type="text"
                    placeholder="e.g. 1234567890"
                    value={fbPageId}
                    onChange={(e) => setFbPageId(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Found in your Facebook Page Settings → Page Info → Page ID.
                  </p>
                </div>

                <SecretInput
                  id="fbAccessToken"
                  label="Meta Access Token"
                  value={fbAccessToken}
                  maskedPlaceholder={fbAccessTokenMasked}
                  onChange={setFbAccessToken}
                  note="Generate a long-lived Page Access Token in Meta's Graph API Explorer. Required for posting and catalog management."
                />
              </div>

              {fbStatus !== 'idle' && (
                <StatusBanner ok={fbStatus === 'success'} message={fbMsg} />
              )}

              <Button type="submit" disabled={savingFacebook}>
                {savingFacebook
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</>
                  : 'Save Facebook Settings'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* ── 3. Scraper & Sync Schedules ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-emerald-500" />
            Scraper &amp; Sync Schedules
          </CardTitle>
          <CardDescription>
            Inventory source URLs, salesperson scope filter, and sync frequency.
            Each rep can point to a different dealer site or URL.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingSettings ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />Loading…
            </div>
          ) : (
            <form onSubmit={handleSaveInventory} className="space-y-5">

              {/* Source URLs */}
              <div className="space-y-3">
                <SectionLabel>Inventory Source URLs</SectionLabel>

                <div className="space-y-2">
                  <Label htmlFor="invUrlUsed">Used Inventory Page</Label>
                  <Input
                    id="invUrlUsed"
                    type="url"
                    placeholder="https://www.mosescars.com/search-all-used-inventory.html"
                    value={inventoryUrlUsed}
                    onChange={(e) => setInventoryUrlUsed(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the Moses Auto Group used-inventory default.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="invUrlNew">New Inventory Page</Label>
                  <Input
                    id="invUrlNew"
                    type="url"
                    placeholder="https://www.mosescars.com/search-all-new-inventory.html"
                    value={inventoryUrlNew}
                    onChange={(e) => setInventoryUrlNew(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the Moses Auto Group new-inventory default.
                  </p>
                </div>
              </div>

              {/* Salesperson filter */}
              <div className="space-y-3">
                <SectionLabel>Salesperson Filter</SectionLabel>
                <div className="space-y-2">
                  <Label htmlFor="spFilter">
                    Salesperson ID
                    <span className="ml-2 font-normal text-muted-foreground text-xs">(optional)</span>
                  </Label>
                  <Input
                    id="spFilter"
                    type="text"
                    placeholder="e.g. SP-001 — leave blank to show all vehicles"
                    value={salespersonFilter}
                    onChange={(e) => setSalespersonFilter(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    When set, Marketplace Hub only shows vehicles assigned to this salesperson.
                  </p>
                </div>
              </div>

              {/* Sync frequency */}
              <div className="space-y-3">
                <SectionLabel>Auto-Sync Frequency</SectionLabel>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {SCRAPER_FREQUENCIES.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setScraperFrequency(opt.value)}
                      className={[
                        'text-left rounded-lg border px-4 py-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        scraperFrequency === opt.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-border hover:border-muted-foreground/40 hover:bg-muted/30',
                      ].join(' ')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm">{opt.label}</span>
                        {scraperFrequency === opt.value && (
                          <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Controls how often the background scraper fetches new inventory from your source URL.
                  Changes take effect on the next scraper cycle.
                </p>
              </div>

              {invStatus !== 'idle' && (
                <StatusBanner ok={invStatus === 'success'} message={invMsg} />
              )}

              <Button type="submit" disabled={savingInventory}>
                {savingInventory
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</>
                  : 'Save Scraper Settings'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* ── 4. Dealership Locations ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-emerald-500" />
            Dealership Locations to Include
          </CardTitle>
          <CardDescription>
            Select which store locations appear in your Marketplace Hub and Meta Catalog feed.
            New locations discovered during a sync are added automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingLocations ? (
            <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />Loading locations…
            </div>
          ) : locations.length === 0 ? (
            <div className="rounded-md border bg-muted/30 px-4 py-6 text-center space-y-2">
              <MapPin className="w-8 h-8 text-muted-foreground/40 mx-auto" />
              <p className="text-sm font-medium text-muted-foreground">No locations discovered yet</p>
              <p className="text-xs text-muted-foreground max-xs mx-auto">
                Locations will automatically appear here once inventory is scraped
                from your website URL. Add your inventory URL above and click{' '}
                <strong>Sync Now</strong> in the Marketplace Hub to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Select / deselect all */}
              <div className="flex items-center gap-3 pb-1 border-b border-border">
                <span className="text-xs text-muted-foreground flex-1">
                  {locations.filter((l) => l.enabled).length} of {locations.length} selected
                </span>
                <button
                  type="button"
                  onClick={selectAllLocations}
                  className="text-xs text-primary hover:text-primary/80 font-medium underline underline-offset-2"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={deselectAllLocations}
                  className="text-xs text-muted-foreground hover:text-foreground font-medium underline underline-offset-2"
                >
                  Deselect all
                </button>
              </div>

              {/* Checkbox list */}
              <div className="space-y-2.5">
                {locations.map((loc) => (
                  <div key={loc.location} className="flex items-center gap-3">
                    <Checkbox
                      id={`loc-${loc.location}`}
                      checked={loc.enabled}
                      onCheckedChange={(v) => toggleLocation(loc.location, Boolean(v))}
                    />
                    <label
                      htmlFor={`loc-${loc.location}`}
                      className="text-sm leading-none cursor-pointer select-none"
                    >
                      {loc.location}
                    </label>
                    {!loc.enabled && (
                      <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">
                        excluded
                      </Badge>
                    )}
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground pt-1 border-t border-border">
                Vehicles whose location isn't tagged (or isn't on this list) are always included.
              </p>

              {locStatus !== 'idle' && (
                <StatusBanner ok={locStatus === 'success'} message={locMsg} />
              )}

              <div className="pt-1">
                <Button type="button" disabled={savingLocations} onClick={handleSaveLocations}>
                  {savingLocations
                    ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving…</>
                    : 'Save Location Filter'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── TikTok Account ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-[#ff0050] flex items-center justify-center flex-shrink-0">
              <Film className="w-2.5 h-2.5 text-white" />
            </div>
            TikTok Account
          </CardTitle>
          <CardDescription>
            Connect your TikTok account to post vehicle videos directly from the TikTok Hub.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tiktokMsg && (
            <div className="mb-4">
              <StatusBanner ok={tiktokMsgOk} message={tiktokMsg} />
            </div>
          )}
          {user?.tiktok_connected ? (
            <div className="space-y-3">
              {/* Token-expired reconnect prompt */}
              {tiktokNeedsReconnect && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">TikTok Session Expired</p>
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                        Your TikTok access token has expired. Reconnect to keep posting videos.
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleConnectTikTok}
                    disabled={tiktokConnecting}
                    className="gap-1.5 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0 shrink-0"
                  >
                    {tiktokConnecting
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting…</>
                      : <><RefreshCw className="w-3.5 h-3.5" /> Reconnect TikTok</>}
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                <div className="w-8 h-8 rounded-full bg-[#ff0050]/10 flex items-center justify-center flex-shrink-0">
                  <Film className="w-4 h-4 text-[#ff0050]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">TikTok Connected</p>
                  <p className="text-xs text-muted-foreground">
                    {tiktokNeedsReconnect
                      ? 'Session expired — reconnect above to restore posting.'
                      : 'Your account is linked and ready to post videos.'}
                  </p>
                </div>
                <Badge className={tiktokNeedsReconnect
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 text-xs'}>
                  {tiktokNeedsReconnect ? '⚠ Expired' : '✓ Connected'}
                </Badge>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectTikTok}
                disabled={tiktokConnecting}
                className="gap-2 text-destructive border-destructive/30 hover:bg-destructive/5"
              >
                {tiktokConnecting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Disconnecting…</>
                  : <><XCircle className="w-3.5 h-3.5" /> Disconnect TikTok</>}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Connect your TikTok account to start posting vehicle showcase videos.
                You'll be redirected to TikTok to authorise access.
              </p>
              <Button
                size="sm"
                onClick={handleConnectTikTok}
                disabled={tiktokConnecting}
                className="gap-2 bg-[#ff0050] hover:bg-[#d4003f] text-white border-0"
              >
                {tiktokConnecting
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Redirecting…</>
                  : <><Film className="w-3.5 h-3.5" /> Connect TikTok Account</>}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cancel Subscription Modal ────────────────────────────────── */}
      {showCancelModal && billingStatus && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !cancelling) setShowCancelModal(false);
          }}
        >
          <div className="w-full max-w-[95vw] sm:max-w-md rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <AlertTriangle className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h2 className="font-bold text-lg leading-tight">Cancel Subscription?</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  This will schedule your subscription to end at the current billing period.
                </p>
              </div>
            </div>

            {/* Warning body */}
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
              Are you sure you want to cancel? Your subscription will remain active until{' '}
              <strong>
                {billingStatus.subscription_period_end
                  ? formatDate(billingStatus.subscription_period_end)
                  : 'the end of your current billing period'}
              </strong>
              , and you will continue to have full access to your Meta feeds and tools until
              then. <strong>No refunds or partial credits will be issued</strong> for remaining
              time in this billing period.
            </div>

            {billingActionMsg && (
              <StatusBanner ok={false} message={billingActionMsg} />
            )}

            {/* Buttons — "Keep" on left, destructive on right */}
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowCancelModal(false)}
                disabled={cancelling}
              >
                Keep My Subscription
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleCancelSubscription}
                disabled={cancelling}
              >
                {cancelling
                  ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Cancelling…</>
                  : 'Confirm Cancellation'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
