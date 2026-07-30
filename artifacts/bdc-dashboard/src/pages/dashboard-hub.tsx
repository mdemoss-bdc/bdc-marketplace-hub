import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  LayoutDashboard, Printer, MessageSquare, ClipboardList, Loader2,
  Car, AlertTriangle, Radio, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Chrome tokens ────────────────────────────────────────────────────────────
// Mirrors the slate/amber language of the sidebar and app header so the hub
// reads as one continuous executive surface.

/** Smoked-glass container: deep slate, razor-thin edge, saturated blur. */
const GLASS =
  'rounded-xl border border-slate-800/60 bg-slate-900/80 ' +
  'backdrop-blur-xl backdrop-saturate-150 ' +
  'shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]';

/** Uppercase metric / section label. */
const META = 'text-xs font-semibold uppercase tracking-wider text-slate-400';

/** Smaller uppercase label for form fields. */
const FIELD_LABEL =
  'text-[10px] font-semibold uppercase tracking-wider text-slate-500';

/** Dark treatment for the shared Input component, which defaults to light. */
const INPUT_DARK =
  'h-9 rounded-lg border-slate-700/60 bg-slate-950/60 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 focus-visible:ring-amber-400/40 ' +
  'focus-visible:ring-offset-0 focus-visible:border-amber-300/40';

/** Outlined control for secondary actions on a dark surface. */
const BTN_GHOST =
  'border-slate-700/60 bg-white/[0.03] text-slate-300 ' +
  'hover:bg-white/[0.08] hover:text-slate-50 hover:border-slate-600';

interface ApiVehicle {
  id: number;
  vin: string;
  stock_number: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  price: number;
  mileage: number;
  image_url: string;
  status: string;
  last_seen: string;
  condition: string;
}

interface DealState {
  buyerName: string;
  vin: string;
  stockNumber: string;
  price: string;
  mileage: string;
}

interface HubVehicle {
  id: string;
  vin: string;
  stockNumber: string;
  year: number;
  make: string;
  model: string;
  price: number;
  mileage: number;
  daysOnLot: number;
  imageUrl: string;
}

function daysSince(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function mapVehicle(v: ApiVehicle): HubVehicle {
  const titleModel = [v.model, v.trim].filter(Boolean).join(' ').trim() || v.model;
  return {
    id: String(v.id),
    vin: v.vin || '',
    stockNumber: v.stock_number || 'N/A',
    year: Number(v.year) || 0,
    make: v.make || '',
    model: titleModel,
    price: Number(v.price) || 0,
    mileage: Number(v.mileage) || 0,
    // Approximate DOL from last_seen until a true arrival date exists in schema
    daysOnLot: daysSince(v.last_seen),
    imageUrl: v.image_url || '',
  };
}

/** One KPI tile — uppercase label, tabular figure, quiet caption. */
function MetricTile({
  icon: Icon,
  label,
  caption,
  children,
  iconClass,
}: {
  icon: typeof Car;
  label: string;
  caption?: string;
  children: ReactNode;
  iconClass?: string;
}) {
  return (
    <div className={cn(GLASS, 'p-4')}>
      <div className={cn('flex items-center gap-2', META)}>
        <Icon className={cn('h-3.5 w-3.5', iconClass ?? 'text-slate-500')} />
        <span className="truncate">{label}</span>
      </div>
      {children}
      {caption && (
        <p className="mt-1 text-[11px] tracking-tight text-slate-500">{caption}</p>
      )}
    </div>
  );
}

export default function DashboardHub() {
  const { authFetch } = useAuth();
  const [, setLocation] = useLocation();
  const reduceMotion = useReducedMotion();

  const [dealState, setDealState] = useState<DealState>({
    buyerName: '',
    vin: '',
    stockNumber: '',
    price: '',
    mileage: '',
  });
  const [inventory, setInventory] = useState<HubVehicle[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [escalatedLeads, setEscalatedLeads] = useState(0);
  const [metaUp, setMetaUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingForms, setSavingForms] = useState(false);
  const [smsFlash, setSmsFlash] = useState<string | null>(null);
  const [loadFlash, setLoadFlash] = useState<string | null>(null);

  const loadHub = useCallback(async () => {
    setLoading(true);
    try {
      const [invRes, sessRes, healthRes] = await Promise.all([
        // Prefer /api/vehicles (dynamic marketplace_inventory); both this and the
        // fallback are token-free so live scrape KPIs render without a session.
        fetch('/api/vehicles?status=ACTIVE').catch(() => null)
          .then(async (r) => (r && r.ok ? r : fetch('/api/marketplace/inventory?status=ACTIVE'))),
        authFetch('/api/v1/sessions').catch(() => null),
        fetch('/api/healthz').catch(() => null),
      ]);

      if (invRes && invRes.ok) {
        const data = await invRes.json();
        const list: ApiVehicle[] = Array.isArray(data.vehicles)
          ? data.vehicles
          : Array.isArray(data.inventory)
            ? data.inventory
            : [];
        setInventory(list.slice(0, 48).map(mapVehicle));
        setActiveCount(
          Number(data.active) || Number(data.counts?.ACTIVE) || list.length,
        );
      }

      if (sessRes && sessRes.ok) {
        const sdata = await sessRes.json();
        const sessions = Array.isArray(sdata.sessions) ? sdata.sessions : [];
        setEscalatedLeads(
          sessions.filter((s: { status?: string }) => s.status === 'ESCALATE_TO_DESK').length,
        );
      }

      if (healthRes && healthRes.ok) {
        const h = await healthRes.json();
        setMetaUp(h.status === 'UP');
      }
    } catch {
      /* keep prior state */
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    loadHub();
    const id = setInterval(loadHub, 30_000);
    return () => clearInterval(id);
  }, [loadHub]);

  const agedCount = useMemo(
    () => inventory.filter((v) => v.daysOnLot >= 60).length,
    [inventory],
  );

  const patchDeal = <K extends keyof DealState>(key: K, value: DealState[K]) => {
    setDealState((prev) => ({ ...prev, [key]: value }));
  };

  const autoFillFromVehicle = (vehicle: HubVehicle) => {
    setDealState((prev) => ({
      buyerName: prev.buyerName,
      vin: vehicle.vin,
      stockNumber: vehicle.stockNumber,
      price: vehicle.price > 0 ? String(vehicle.price) : '',
      mileage: vehicle.mileage > 0 ? String(vehicle.mileage) : '',
    }));
    setLoadFlash(vehicle.stockNumber);
    setTimeout(() => setLoadFlash(null), 2000);
  };

  const pushToForms = async (vehicle?: HubVehicle) => {
    const next = vehicle
      ? {
          buyerName: dealState.buyerName,
          vin: vehicle.vin,
          stockNumber: vehicle.stockNumber,
          price: vehicle.price > 0 ? String(vehicle.price) : '',
          mileage: vehicle.mileage > 0 ? String(vehicle.mileage) : '',
        }
      : dealState;

    if (vehicle) setDealState(next);
    setSavingForms(true);
    try {
      await authFetch('/api/v1/forms/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyer_name: next.buyerName,
          vin: next.vin,
          stock_number: next.stockNumber,
          price: next.price,
          mileage: next.mileage,
          active_form: 'test_drive',
          notes: '',
        }),
      });
      setLocation('/forms');
    } finally {
      setSavingForms(false);
    }
  };

  const copySmsCard = async (vehicle: HubVehicle) => {
    const textMessage =
      `Hey! Here are the details on the ${vehicle.year} ${vehicle.make} ${vehicle.model}. ` +
      `Price: $${vehicle.price.toLocaleString()}, Mileage: ${vehicle.mileage.toLocaleString()} mi. ` +
      `Let me know when you want to take it for a spin!`;
    try {
      await navigator.clipboard.writeText(textMessage);
      setSmsFlash(vehicle.stockNumber);
      setTimeout(() => setSmsFlash(null), 2500);
    } catch {
      window.prompt('Copy this SMS card:', textMessage);
    }
  };

  const dealFields: {
    key: keyof DealState;
    label: string;
    placeholder: string;
    mono?: boolean;
    transform?: (raw: string) => string;
  }[] = [
    { key: 'buyerName',   label: 'Buyer Full Name',  placeholder: 'John Doe' },
    {
      key: 'vin', label: 'VIN', placeholder: '17-Digit VIN', mono: true,
      transform: (raw) => raw.toUpperCase().slice(0, 17),
    },
    { key: 'stockNumber', label: 'Stock Number',    placeholder: 'Stock #' },
    { key: 'price',       label: 'Selling Price',   placeholder: '48950' },
    { key: 'mileage',     label: 'Current Mileage', placeholder: 'Odometer' },
  ];

  return (
    // Full-bleed executive canvas: negative margins cancel <main>'s padding so
    // the slate meets the sidebar and header edge-to-edge. The top margin is
    // gated on :first-child — when the email banner renders above us it stays
    // on the light shell instead of being swallowed by the dark panel.
    <div
      className={cn(
        'relative -mx-4 -mb-4 px-4 pb-10 pt-4 md:-mx-8 md:-mb-8 md:px-8 md:pb-14 md:pt-7',
        'first:-mt-4 md:first:-mt-8',
        'min-h-[calc(100dvh-3rem)] bg-slate-950',
      )}
    >
      {/* Faint amber wash bleeding down from the header line. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,0.07),transparent_65%)]"
      />

      <div className="relative mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-amber-300/90">
              <LayoutDashboard className="h-4 w-4" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">
                Command Center
              </span>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
              Dashboard Hub
            </h1>
            <p className="mt-1.5 text-sm tracking-tight text-slate-400">
              Load a vehicle into paperwork, copy an SMS card, and watch live scrape KPIs in one place.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={loadHub}
            disabled={loading}
            className={BTN_GHOST}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
            Refresh
          </Button>
        </div>

        {/* Master universal forms intake bar — low-profile executive strip */}
        <section className={cn(GLASS, 'space-y-2.5 px-4 py-3')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={cn('flex items-center gap-2', META)}>
              <Printer className="h-3.5 w-3.5 text-amber-400/70" />
              Universal Forms Header
              <span className="font-normal normal-case tracking-normal text-slate-600">
                — autofills document templates
              </span>
            </h2>
            <Button
              size="sm"
              onClick={() => pushToForms()}
              disabled={savingForms}
              className="h-8 bg-gradient-to-b from-amber-300 to-amber-500 text-[11px] font-semibold uppercase tracking-wider text-slate-950 hover:from-amber-200 hover:to-amber-400"
            >
              {savingForms
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ClipboardList className="h-3.5 w-3.5" />}
              Open Forms
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
            {dealFields.map((field) => (
              <label key={field.key} className="space-y-1">
                <span className={FIELD_LABEL}>{field.label}</span>
                <Input
                  placeholder={field.placeholder}
                  className={cn(INPUT_DARK, field.mono && 'font-mono')}
                  value={dealState[field.key]}
                  onChange={(e) =>
                    patchDeal(
                      field.key,
                      field.transform ? field.transform(e.target.value) : e.target.value,
                    )
                  }
                />
              </label>
            ))}
          </div>
        </section>

        {/* KPI counters */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricTile
            icon={AlertTriangle}
            label="Unanswered Leads"
            caption="Escalated to desk"
            iconClass={escalatedLeads > 0 ? 'text-red-400' : 'text-slate-500'}
          >
            <div
              className={cn(
                'mt-2 text-3xl font-bold tabular-nums tracking-tight',
                escalatedLeads > 0 ? 'text-red-300' : 'text-slate-100',
              )}
            >
              {escalatedLeads}
            </div>
          </MetricTile>

          <MetricTile
            icon={Car}
            label="Active Scrape Count"
            caption="ACTIVE inventory rows"
          >
            <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-slate-100">
              {activeCount}
            </div>
          </MetricTile>

          <MetricTile
            icon={Clock}
            label="Aged Inventory (60d+)"
            caption="Based on last seen age"
            iconClass="text-amber-400/80"
          >
            <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-amber-300">
              {agedCount}
            </div>
          </MetricTile>

          <MetricTile icon={Radio} label="Meta Sync Status">
            <div
              className={cn(
                'mt-3 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5',
                'text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                metaUp
                  ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/25'
                  : 'bg-white/[0.04] text-slate-400 ring-white/10',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  metaUp
                    ? 'bg-emerald-400 shadow-[0_0_6px_0_rgba(52,211,153,0.8)]'
                    : 'bg-slate-500',
                )}
              />
              {metaUp ? 'Feed Engine Up' : 'Checking…'}
            </div>
          </MetricTile>
        </section>

        {/* Live inventory */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 font-display text-lg font-bold tracking-tight text-slate-100">
            <Car className="h-5 w-5 text-amber-400/80" />
            Live Scraped Showroom Inventory
          </h3>

          {loading && inventory.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm uppercase tracking-wider text-slate-500">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading inventory…
            </div>
          ) : inventory.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
              No active inventory yet. Run a marketplace sync, then refresh this hub.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {inventory.map((car) => (
                <motion.article
                  key={car.id}
                  // Spring lift: overshoots slightly then settles, so the card
                  // feels weighted rather than linearly animated.
                  whileHover={reduceMotion ? undefined : { y: -5, scale: 1.007 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 24, mass: 0.6 }}
                  className={cn(
                    GLASS,
                    'group flex flex-col overflow-hidden sm:flex-row',
                    'transition-[border-color,box-shadow] duration-300',
                    'hover:border-amber-300/25',
                    // Re-declares the inset hairline so it survives the hover shadow.
                    'hover:shadow-[0_22px_45px_-20px_rgba(0,0,0,0.85),inset_0_1px_0_0_rgba(255,255,255,0.06)]',
                  )}
                >
                  <div className="h-40 w-full shrink-0 overflow-hidden bg-slate-950/60 sm:w-40">
                    {car.imageUrl ? (
                      <img
                        src={car.imageUrl}
                        alt={`${car.make} ${car.model}`}
                        className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-700">
                        <Car className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-4">
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-sm font-bold leading-snug tracking-tight text-slate-100">
                          {car.year} {car.make} {car.model}
                        </h4>
                        <span
                          className={cn(
                            'shrink-0 rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
                            'ring-1 ring-inset',
                            car.daysOnLot >= 30
                              ? 'bg-amber-400/10 text-amber-300 ring-amber-300/25'
                              : 'bg-white/[0.04] text-slate-400 ring-white/10',
                          )}
                        >
                          {car.daysOnLot}d tracked
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-slate-500">
                        VIN: {car.vin || '—'}
                      </p>
                      <div className="mt-3 flex gap-5">
                        <div>
                          <span className={cn('block', FIELD_LABEL)}>Price</span>
                          <span className="text-base font-bold tabular-nums tracking-tight text-amber-300">
                            {car.price > 0 ? `$${car.price.toLocaleString()}` : '—'}
                          </span>
                        </div>
                        <div>
                          <span className={cn('block', FIELD_LABEL)}>Mileage</span>
                          <span className="text-base font-semibold tabular-nums tracking-tight text-slate-200">
                            {car.mileage > 0 ? `${car.mileage.toLocaleString()} mi` : '—'}
                          </span>
                        </div>
                        <div>
                          <span className={cn('block', FIELD_LABEL)}>Stock #</span>
                          <span className="font-mono text-base font-semibold text-slate-200">
                            {car.stockNumber}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        className="h-8 bg-gradient-to-b from-amber-300 to-amber-500 text-[11px] font-semibold uppercase tracking-wider text-slate-950 hover:from-amber-200 hover:to-amber-400"
                        onClick={() => pushToForms(car)}
                        disabled={savingForms}
                      >
                        <ClipboardList className="h-3.5 w-3.5" />
                        {loadFlash === car.stockNumber ? 'Loaded' : 'Load Into Forms'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(BTN_GHOST, 'h-8 text-[11px] font-semibold uppercase tracking-wider')}
                        onClick={() => {
                          autoFillFromVehicle(car);
                          copySmsCard(car);
                        }}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        {smsFlash === car.stockNumber ? 'Copied!' : 'Copy SMS Card'}
                      </Button>
                    </div>
                  </div>
                </motion.article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
