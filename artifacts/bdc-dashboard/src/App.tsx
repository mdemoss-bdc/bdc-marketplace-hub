import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, Redirect, useLocation } from 'wouter';
import { Sidebar } from '@/components/layout/sidebar';
import { AuthProvider, useAuth } from '@/lib/auth';
import Appointments from '@/pages/appointments';
import Leads from '@/pages/leads';
import LeadGateway from '@/pages/lead-gateway';
import EmailDesk from '@/pages/email-desk';
import MarketplaceHub from '@/pages/marketplace-hub';
import Settings from '@/pages/settings';
import LoginPage from '@/pages/login';
import PricingPage from '@/pages/pricing';
import ForgotPassword from '@/pages/forgot-password';
import ResetPassword from '@/pages/reset-password';
import CustomerMail from '@/pages/customer-mail';
import Wishlist from '@/pages/wishlist';
import TermsOfService from '@/pages/terms';
import NotFound from '@/pages/not-found';
import { Menu, LogOut, Users } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { HelpAssistant } from '@/components/HelpAssistant';
import { AdminFixTool }  from '@/components/AdminFixTool';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import VerifyEmail from '@/pages/verify-email';
import AdminPage from '@/pages/admin';
import ReferralsPage from '@/pages/referrals';
import TeamPage from '@/pages/team';
import TikTokHub from '@/pages/tiktok';
import LandingPage from '@/pages/landing';
import PrivacyPage from '@/pages/privacy';
import SuspendedPage from '@/pages/suspended';
import FormsPage from '@/pages/forms';
import DashboardHub from '@/pages/dashboard-hub';
import { activateDevToolsDeterrent } from '@/lib/devtools-deterrent';
import { AuthGuard } from '@/components/AuthGuard';

const queryClient = new QueryClient();

/** Route → section label for the desktop header's uppercase metadata slot.
 *  Kept here rather than exported from sidebar.tsx: a non-component export
 *  alongside a component breaks React Fast Refresh for that module. */
const SECTION_LABELS: Record<string, string> = {
  '/dashboard':       'Dashboard Hub',
  '/marketplace-hub': 'Marketplace Hub',
  '/tiktok':          'TikTok Hub',
  '/forms':           'Paperwork Desk',
  '/wishlist':        'Wishlist',
  '/customer-mail':   'Customer Cards & Mail',
  '/referrals':       'Refer & Earn',
  '/admin':           'Admin Console',
  '/team':            'Team & Seats',
  '/settings':        'Settings',
  '/pricing':         'Pricing',
  '/leads':           'Lead Center',
  '/appointments':    'Appointments',
  '/email-desk':      'Email Desk',
  '/lead-gateway':    'Lead Gateway',
  '/terms':           'Terms of Service',
};

/** Mounts the production DevTools deterrent once at the app root.
 *  No-ops automatically in development (import.meta.env.PROD guard). */
function SecurityShield() {
  useEffect(() => {
    const cleanup = activateDevToolsDeterrent();
    return cleanup;
  }, []);
  return null;
}

/** Wraps a route that requires an active subscription.
 *  Admins always pass. Unpaid users are sent to /pricing.
 *  Loading gate removed — force-auth keeps isLoading=false. */
function SubscribedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isSubscribed } = useAuth();
  if (!isSubscribed) return <Redirect to="/pricing" />;
  return <Component />;
}

/** Wraps a route that is accessible only to the master admin. */
function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isMasterAdmin } = useAuth();
  if (!isMasterAdmin) return <Redirect to="/marketplace-hub" />;
  return <Component />;
}

/** Shell rendered for anonymous visitors on public pages.
 *  The landing page (`/`) owns its own full-page layout with hero + footer.
 *  All other public paths use a minimal branded header + centred content. */
function PublicRouter() {
  return (
    <Switch>
      {/* Landing page owns its own layout — no wrapper shell */}
      <Route path="/" component={LandingPage} />
      <Route path="/privacy" component={PrivacyPage} />

      {/* Login page — full-page auth form, no shell wrapper */}
      <Route path="/login" component={LoginPage} />
      {/* /register is retired — direct creation only; redirect to login */}
      <Route path="/register">{() => <Redirect to="/login" />}</Route>

      {/* All other public paths share the minimal branded shell */}
      <Route>
        {() => (
          <div className="min-h-dvh bg-background flex flex-col">
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-800/80 bg-slate-950/85 px-6 backdrop-blur-xl backdrop-saturate-150">
              <a href="/" className="flex items-center gap-2.5">
                <BrandLogo className="h-8 w-8 flex-shrink-0 rounded-md ring-1 ring-white/10" />
                <span className="font-display text-sm font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
                  BDC Manager
                </span>
              </a>
              <div className="flex items-center gap-5">
                <a
                  href="/pricing"
                  className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 transition-colors hover:text-slate-100"
                >
                  Pricing
                </a>
                <a
                  href="/login"
                  className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300 transition-colors hover:text-amber-100"
                >
                  Sign in →
                </a>
              </div>
            </header>
            <main className="flex-1 px-4 py-8">
              <Switch>
                <Route path="/pricing" component={PricingPage} />
                <Route path="/forgot-password" component={ForgotPassword} />
                <Route path="/reset-password" component={ResetPassword} />
                <Route path="/terms" component={TermsOfService} />
                <Route path="/verify-email" component={VerifyEmail} />
                <Route path="/suspended" component={SuspendedPage} />
                {/* Unknown public path → landing */}
                <Route>{() => <Redirect to="/" />}</Route>
              </Switch>
            </main>
          </div>
        )}
      </Route>
    </Switch>
  );
}

function Router() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const sectionLabel = SECTION_LABELS[location] ?? 'Dashboard Hub';
  const displayName = user?.name || user?.username || 'Account';
  const displayRole = (user?.role || 'user').toUpperCase();

  return (
    <div className="flex min-h-dvh bg-slate-950 text-slate-100">
      {/* Mobile top header bar — smoked glass over the deep slate chrome */}
      <header className="fixed left-0 right-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-slate-800/80 bg-slate-950/85 px-4 backdrop-blur-xl backdrop-saturate-150 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation menu"
          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <BrandLogo className="h-8 w-8 flex-shrink-0 rounded-md ring-1 ring-white/10" />
        <h1 className="font-display text-sm font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
          BDC Manager
        </h1>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-right">
            <span className="block truncate text-[11px] font-medium text-slate-200">{displayName}</span>
            <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">{displayRole}</span>
          </span>
          <button
            type="button"
            onClick={() => logout()}
            aria-label="Switch account / log out"
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-amber-200"
          >
            <Users className="h-4 w-4" />
          </button>
        </div>
      </header>

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content — offset for fixed sidebar on desktop, offset for mobile header on mobile */}
      <div className="flex min-w-0 flex-1 flex-col pt-14 md:ml-64 md:pt-0">
        {/* Desktop header — section metadata + active account */}
        <header className="sticky top-0 z-30 hidden h-12 items-center gap-4 border-b border-slate-800/80 bg-slate-950/85 px-8 backdrop-blur-xl backdrop-saturate-150 md:flex">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {sectionLabel}
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-slate-700/80" />
          <span className="font-mono-data text-[10px] uppercase tracking-[0.14em] text-slate-600">
            Sales Command Center
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_0_rgba(52,211,153,0.8)]" />
            </span>
            <span className="font-mono-data text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Engine Online
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-slate-700/80" />
            <div className="flex items-center gap-2.5">
              <div className="text-right leading-tight">
                <div className="text-[11px] font-medium text-slate-200">{displayName}</div>
                <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">
                  {displayRole}
                </div>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-white/[0.03] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 transition-colors hover:border-amber-300/30 hover:bg-amber-400/[0.08] hover:text-amber-200"
              >
                <LogOut className="h-3 w-3" />
                Switch / Log Out
              </button>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 pb-safe md:p-8">
        <EmailVerificationBanner />
        <Switch>

          {/* Root → Dashboard Hub directly (no login / splash / role redirect) */}
          <Route path="/" component={DashboardHub} />
          <Route path="/dashboard">{() => (
            <AuthGuard>
              <DashboardHub />
            </AuthGuard>
          )}</Route>
          <Route path="/appointments" component={Appointments} />
          <Route path="/leads" component={Leads} />
          <Route path="/inventory">{() => <Redirect to="/marketplace-hub" />}</Route>
          <Route path="/lead-gateway" component={LeadGateway} />
          <Route path="/email-desk" component={EmailDesk} />
          {/* Marketplace Hub & Wishlist: trial gating is at the API level, not here */}
          <Route path="/marketplace-hub" component={MarketplaceHub} />
          <Route path="/pricing" component={PricingPage} />
          <Route path="/settings" component={Settings} />
          <Route path="/terms" component={TermsOfService} />
          <Route path="/customer-mail">
            {() => <SubscribedRoute component={CustomerMail} />}
          </Route>
          <Route path="/wishlist" component={Wishlist} />
          {/* Legacy free-generator URL → redirect to Marketplace Hub */}
          <Route path="/free-generator">{() => <Redirect to="/marketplace-hub" />}</Route>
          <Route path="/forgot-password" component={ForgotPassword} />
          <Route path="/reset-password" component={ResetPassword} />
          <Route path="/verify-email" component={VerifyEmail} />
          <Route path="/referrals" component={ReferralsPage} />
          <Route path="/team" component={TeamPage} />
          <Route path="/tiktok">{() => <SubscribedRoute component={TikTokHub} />}</Route>
          <Route path="/forms" component={FormsPage} />
          <Route path="/admin">{() => (
            <AuthGuard requireRole="Admin">
              <AdminRoute component={AdminPage} />
            </AuthGuard>
          )}</Route>
          <Route path="/suspended" component={SuspendedPage} />
          {/* Authenticated users hitting login/register go straight to the app,
              UNLESS ?preview=true is set (master admin preview shortcut). */}
          <Route path="/login">{() => <Redirect to="/dashboard" />}</Route>
          <Route path="/register">{() => <Redirect to="/dashboard" />}</Route>
          <Route component={NotFound} />
        </Switch>
        </main>
      </div>

      {/* Floating AI Help Assistant — rendered outside <main> so it overlays all content */}
      <HelpAssistant />
      {/* Master Admin AI Fix Generator — bottom-left, only visible to mdemoss */}
      <AdminFixTool />
    </div>
  );
}

/**
 * Session gate — public marketing routes stay open; everything else requires
 * an authenticated session (cookie JWT / Bearer). Unauthenticated users go to /login.
 */
function AuthGate() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [location] = useLocation();

  if (
    location === '/pricing' ||
    location === '/privacy' ||
    location === '/terms' ||
    location === '/forgot-password' ||
    location === '/reset-password' ||
    location === '/verify-email' ||
    location === '/suspended'
  ) {
    return <PublicRouter />;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 text-sm text-slate-400">
        Checking session…
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    if (location === '/login' || location === '/register') {
      return <LoginPage />;
    }
    // Deep-link to /dashboard or /admin without a session → /login
    return <LoginPage />;
  }

  return <Router />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          {/* Mounts production-only DevTools deterrent — no-ops in dev */}
          <SecurityShield />
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <AuthGate />
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
