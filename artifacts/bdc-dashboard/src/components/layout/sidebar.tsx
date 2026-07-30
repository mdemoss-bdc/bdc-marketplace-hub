import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'wouter';
import { LogOut, Store, CreditCard, X, MailOpen, Heart, Shield, Gift, Users, Wrench, ChevronDown, Check, Film, LogIn, ClipboardList, LayoutDashboard, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import type { MockRole } from '@/lib/auth';
import { UserProfileModal } from '@/components/UserProfileModal';
import { BrandLogo } from '@/components/BrandLogo';

// Nav items for rooftop admins — Dashboard Hub leads
const NAV_ROOFTOP = [
  { path: '/dashboard',      label: 'Dashboard Hub',          icon: LayoutDashboard },
  { path: '/leads',          label: 'Lead Center',            icon: Inbox },
  { path: '/marketplace-hub',label: 'Marketplace Hub',        icon: Store },
  { path: '/tiktok',         label: 'TikTok Hub',             icon: Film },
  { path: '/forms',          label: 'Paperwork Desk',         icon: ClipboardList },
  { path: '/wishlist',       label: 'Wishlist',               icon: Heart },
  { path: '/customer-mail',  label: 'Customer Cards & Mail',  icon: MailOpen },
  { path: '/referrals',      label: 'Refer & Earn',           icon: Gift },
];

// Nav items for individual reps — Dashboard Hub leads
const NAV_REP = [
  { path: '/dashboard',      label: 'Dashboard Hub',          icon: LayoutDashboard },
  { path: '/leads',          label: 'Lead Center',            icon: Inbox },
  { path: '/marketplace-hub',label: 'Marketplace Hub',        icon: Store },
  { path: '/tiktok',         label: 'TikTok Hub',             icon: Film },
  { path: '/forms',          label: 'Paperwork Desk',         icon: ClipboardList },
  { path: '/wishlist',       label: 'Wishlist',               icon: Heart },
  { path: '/customer-mail',  label: 'Customer Cards & Mail',  icon: MailOpen },
  { path: '/referrals',      label: 'Refer & Earn',           icon: Gift },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

// ── Shared chrome tokens ─────────────────────────────────────────────────────
// Centralised so the sidebar, its badges, and the App.tsx header stay visually
// identical. Amber reads as the anodized accent; slate carries the brushed
// metal canvas.
const RAIL = 'bg-gradient-to-b from-amber-200 via-amber-400 to-amber-600';

/** Low-profile nav row. Active rows get an anodized amber wash, an inset
 *  hairline, and a metallic left rail instead of a solid block fill. */
function navRowClass(isActive: boolean) {
  return cn(
    'group relative flex items-center gap-3 rounded-lg px-3 py-2.5',
    'text-sm font-medium tracking-tight',
    'transition-all duration-200 ease-out',
    isActive
      ? cn(
          'text-amber-50',
          'bg-gradient-to-r from-amber-400/[0.14] via-amber-400/[0.05] to-transparent',
          'ring-1 ring-inset ring-amber-300/20',
          'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]',
        )
      : cn(
          'text-slate-400',
          'hover:text-slate-100 hover:bg-white/[0.04]',
          'hover:ring-1 hover:ring-inset hover:ring-white/[0.06]',
        ),
  );
}

/** Hairline pill used for PRO / ADMIN markers — outlined, never a solid block. */
function pillClass(tone: 'amber' | 'red' | 'silver') {
  return cn(
    'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]',
    'ring-1 ring-inset',
    tone === 'amber'  && 'bg-amber-400/10 text-amber-300 ring-amber-300/25',
    tone === 'red'    && 'bg-red-500/10 text-red-300 ring-red-400/25',
    tone === 'silver' && 'bg-white/[0.06] text-slate-300 ring-white/10',
  );
}

/** Uppercase micro-label for metadata rows. */
const META_LABEL = 'text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500';

const VIEW_AS_OPTIONS: { role: MockRole; label: string; desc: string }[] = [
  { role: 'master_admin', label: 'Master Admin Console', desc: 'Full platform control view' },
  { role: 'rooftop_admin', label: 'Dealership Admin (Rooftop)', desc: '10-seat license panel view' },
];

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [location] = useLocation();
  const {
    user, logout, isSubscribed, isMasterAdmin,
    mockRole, effectiveIsMasterAdmin, effectiveOrgRole, setMockRole,
    token,
  } = useAuth();
  const canAccessAdminConsole =
    Boolean(effectiveIsMasterAdmin || user?.rbac_role === 'Admin');
  const [profileOpen,    setProfileOpen]    = useState(false);
  const [viewAsOpen,     setViewAsOpen]     = useState(false);
  const [switching,      setSwitching]      = useState(false);
  const viewAsRef = useRef<HTMLDivElement>(null);

  // Role-based nav: rooftop admins see Dashboard; reps go straight to their hub
  const navItems = effectiveOrgRole === 'admin' ? NAV_ROOFTOP : NAV_REP;

  // ── Close View-As dropdown on outside click ───────────────────────────────
  useEffect(() => {
    if (!viewAsOpen) return;
    function handler(e: MouseEvent) {
      if (viewAsRef.current && !viewAsRef.current.contains(e.target as Node)) {
        setViewAsOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [viewAsOpen]);

  async function handleViewAs(role: MockRole) {
    if (switching) return;
    setSwitching(true);
    setViewAsOpen(false);
    try {
      await setMockRole(role);
    } finally {
      setSwitching(false);
    }
  }

  // ── Wishlist match badge ──────────────────────────────────────────────────
  const [wishlistMatchCount, setWishlistMatchCount] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token) return;   // poll for all authenticated users, not just Pro

    async function fetchBadge() {
      try {
        const r = await fetch('/api/v1/wishlist', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const data = await r.json();
          const count = (data.entries ?? []).filter(
            (e: { matches?: unknown[] }) => (e.matches?.length ?? 0) > 0
          ).length;
          setWishlistMatchCount(count);
        }
      } catch {
        // network error — leave badge unchanged
      }
    }

    fetchBadge();
    pollRef.current = setInterval(fetchBadge, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [token]);

  // ── Lead Center SLA breach badge ──────────────────────────────────────────
  // /api/leads is open on the local engine — no session token is sent.
  const [slaBreachCount, setSlaBreachCount] = useState(0);
  const slaPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function fetchSlaBadge() {
      try {
        const r = await fetch('/api/leads?sla_only=1');
        if (r.ok) {
          const data = await r.json();
          setSlaBreachCount((data.leads ?? []).length);
        }
      } catch {
        // network error — leave badge unchanged
      }
    }

    fetchSlaBadge();
    slaPollRef.current = setInterval(fetchSlaBadge, 20_000);
    return () => { if (slaPollRef.current) clearInterval(slaPollRef.current); };
  }, []);

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar panel — deep slate canvas, smoked glass, razor-thin edge */}
      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex h-dvh w-64 flex-col',
          'bg-slate-950 supports-[backdrop-filter]:bg-slate-950/80',
          'backdrop-blur-xl backdrop-saturate-150',
          'border-r border-slate-800/80',
          'transform transition-transform duration-200 ease-in-out',
          'md:translate-x-0',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Vertical depth wash + hairline inner highlight along the right edge */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.03] via-transparent to-black/40"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-white/[0.07] to-transparent"
        />

        <div className="relative flex items-start justify-between gap-2 border-b border-slate-800/80 px-5 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo className="h-9 w-9 flex-shrink-0 rounded-lg" />
            <div className="min-w-0">
              <h1 className="font-display text-[17px] font-bold leading-none tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
                BDC Manager Desk
              </h1>
              <p className={cn(META_LABEL, 'mt-2')}>Sales Command Center</p>
            </div>
          </div>
          {/* Close button — mobile only */}
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-1 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="relative flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {/* Admin Console — Admin RBAC / master admin only (hidden for Reviewer) */}
          {canAccessAdminConsole && (
            <Link
              href="/admin"
              onClick={onClose}
              className={navRowClass(location === '/admin')}
            >
              {location === '/admin' && (
                <span aria-hidden="true" className={cn('absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full', RAIL)} />
              )}
              <Shield className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">Admin Console</span>
              <span className={pillClass('red')}>Admin</span>
            </Link>
          )}

          {/* Team & Seats — visible to Rooftop org admins (or rooftop_admin preview) */}
          {effectiveOrgRole === 'admin' && (
            <Link
              href="/team"
              onClick={onClose}
              className={navRowClass(location === '/team')}
            >
              {location === '/team' && (
                <span aria-hidden="true" className={cn('absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full', RAIL)} />
              )}
              <Users className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">Team &amp; Seats</span>
              <span className={pillClass('silver')}>Admin</span>
            </Link>
          )}

          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.path;
            // Marketplace Hub and Wishlist are Pro-gated
            // isLocked drives the PRO badge only — navigation is never blocked
            // so trial users can enter the page and hit the per-action limit there.
            const isLocked = (item.path === '/marketplace-hub' || item.path === '/wishlist' || item.path === '/tiktok') && !isSubscribed;

            // Wishlist badge: visible for all authenticated users (incl. trial)
            const showWishlistBadge =
              item.path === '/wishlist' && wishlistMatchCount > 0;

            // Lead Center badge: leads past the 15-minute response SLA
            const showSlaBadge = item.path === '/leads' && slaBreachCount > 0;

            return (
              <Link
                key={item.path}
                href={item.path}
                onClick={onClose}
                className={navRowClass(isActive)}
                data-testid={`nav-${item.path.slice(1) || 'dashboard'}`}
              >
                {isActive && (
                  <span aria-hidden="true" className={cn('absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full', RAIL)} />
                )}
                <Icon
                  className={cn(
                    'h-4 w-4 flex-shrink-0 transition-colors',
                    isActive ? 'text-amber-300' : 'text-slate-500 group-hover:text-slate-300',
                  )}
                />
                <span className="flex-1 truncate">{item.label}</span>

                {isLocked ? (
                  <span className={pillClass('amber')}>Pro</span>
                ) : showSlaBadge ? (
                  <span
                    title={`${slaBreachCount} lead${slaBreachCount === 1 ? '' : 's'} past the 15-minute SLA`}
                    className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-400/90 px-1 text-[10px] font-bold leading-none text-slate-950 ring-1 ring-inset ring-white/25"
                  >
                    {slaBreachCount > 9 ? '9+' : slaBreachCount}
                  </span>
                ) : showWishlistBadge ? (
                  <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500/90 px-1 text-[10px] font-bold leading-none text-white ring-1 ring-inset ring-white/20">
                    {wishlistMatchCount > 9 ? '9+' : wishlistMatchCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="relative space-y-3 border-t border-slate-800/80 p-4 pb-safe">
          {/* Upgrade prompt for non-subscribers */}
          {!isSubscribed && (
            <Link
              href="/pricing"
              onClick={onClose}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold',
                'bg-gradient-to-r from-amber-400/[0.16] to-amber-400/[0.04]',
                'text-amber-200 ring-1 ring-inset ring-amber-300/25',
                'transition-all duration-200 hover:from-amber-400/25 hover:text-amber-100',
              )}
            >
              <CreditCard className="h-3.5 w-3.5 flex-shrink-0" />
              Upgrade to Pro — $75/mo
            </Link>
          )}

          {/* ── Login Screen shortcut (master admin only) ──────────────── */}
          {isMasterAdmin && (
            <Link
              href="/login?preview=true"
              onClick={onClose}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2',
                'text-[11px] font-semibold uppercase tracking-[0.1em]',
                'bg-white/[0.03] text-slate-400 ring-1 ring-inset ring-white/[0.06]',
                'transition-all duration-200 hover:bg-white/[0.07] hover:text-slate-100',
              )}
            >
              <LogIn className="h-3 w-3 flex-shrink-0 text-amber-400/80" />
              <span>Login Screen</span>
            </Link>
          )}

          {/* Engine status */}
          <div className="flex items-center justify-between">
            <span className={META_LABEL}>Engine Status</span>
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_0_rgba(52,211,153,0.8)]" />
              </span>
              <span className="font-mono-data text-[11px] font-medium uppercase tracking-wider text-slate-300">
                Online
              </span>
            </span>
          </div>

          {/* ── View As — master admin role-preview switcher ───────────── */}
          {isMasterAdmin && (
            <div className="relative" ref={viewAsRef}>
              <button
                type="button"
                disabled={switching}
                onClick={() => setViewAsOpen(p => !p)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs',
                  'bg-white/[0.03] text-slate-400 ring-1 ring-inset ring-white/[0.06]',
                  'transition-all duration-200 hover:bg-white/[0.07] hover:text-slate-100',
                  switching && 'pointer-events-none opacity-60',
                )}
              >
                <Wrench className="h-3 w-3 flex-shrink-0 text-amber-400/80" />
                <span className="flex-1 text-left leading-none">
                  <span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">View as</span>{' '}
                  <span className="font-semibold text-amber-200">
                    {mockRole === 'rooftop_admin' ? 'Rooftop Admin' : 'Master Admin'}
                  </span>
                </span>
                <ChevronDown className={cn(
                  'h-3 w-3 flex-shrink-0 transition-transform duration-200',
                  viewAsOpen && 'rotate-180',
                )} />
              </button>

              {viewAsOpen && (
                <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/95 shadow-2xl shadow-black/60 backdrop-blur-xl">
                  <div className="flex items-center gap-1.5 border-b border-slate-800/80 px-3 py-2">
                    <Wrench className="h-3 w-3 text-amber-400/70" />
                    <span className={META_LABEL}>Role Preview</span>
                  </div>
                  {VIEW_AS_OPTIONS.map(opt => {
                    const active = mockRole === opt.role || (mockRole === '' && opt.role === 'master_admin');
                    return (
                      <button
                        key={opt.role}
                        type="button"
                        onClick={() => handleViewAs(opt.role)}
                        className={cn(
                          'w-full px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]',
                          active && 'bg-amber-400/[0.08]',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className={cn(
                            'text-xs font-medium',
                            active ? 'text-amber-200' : 'text-slate-200',
                          )}>
                            {opt.label}
                          </span>
                          {active && <Check className="h-3 w-3 flex-shrink-0 text-amber-300" />}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-500">
                          {opt.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Logged-in user — name, role, switch account / log out */}
          {user && (
            <div className="space-y-2 border-t border-slate-800/60 pt-3">
              <button
                onClick={() => setProfileOpen(true)}
                className="-m-1 flex w-full min-w-0 items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-white/[0.05]"
                aria-label="Open profile"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-amber-300/25 to-amber-600/10 text-xs font-bold uppercase text-amber-200 ring-1 ring-inset ring-amber-300/25">
                  {(user.name || user.username)[0]}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-slate-200">
                    {user.name || user.username}
                  </span>
                  <span className="block truncate text-[10px] text-slate-500">
                    @{user.username}
                    <span className="mx-1 text-slate-700">·</span>
                    <span className="uppercase tracking-[0.14em] text-amber-300/80">
                      {user.role || (isSubscribed ? 'pro' : 'trial')}
                    </span>
                  </span>
                </span>
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => { logout(); onClose(); }}
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-2',
                    'text-[10px] font-semibold uppercase tracking-[0.1em]',
                    'bg-white/[0.03] text-slate-400 ring-1 ring-inset ring-white/[0.06]',
                    'transition-colors hover:bg-amber-400/[0.08] hover:text-amber-200',
                  )}
                >
                  <Users className="h-3 w-3" />
                  Switch
                </button>
                <button
                  type="button"
                  onClick={() => { logout(); onClose(); }}
                  aria-label="Log out"
                  className={cn(
                    'inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-2',
                    'text-[10px] font-semibold uppercase tracking-[0.1em]',
                    'bg-white/[0.03] text-slate-400 ring-1 ring-inset ring-white/[0.06]',
                    'transition-colors hover:bg-red-500/10 hover:text-red-300',
                  )}
                >
                  <LogOut className="h-3 w-3" />
                  Log Out
                </button>
              </div>
            </div>
          )}

          <UserProfileModal open={profileOpen} onOpenChange={setProfileOpen} />
        </div>
      </aside>
    </>
  );
}
