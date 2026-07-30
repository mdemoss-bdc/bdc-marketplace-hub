import { useAuth } from '@/lib/auth';
import { Redirect } from 'wouter';
import { Loader2 } from 'lucide-react';

type AuthGuardProps = {
  children: React.ReactNode;
  /** When set, only users with this RBAC role (or master admin) may pass. */
  requireRole?: 'Admin' | 'Reviewer';
  /** Redirect path when unauthenticated (default /login). */
  loginPath?: string;
};

/**
 * Protects dashboard routes: waits for /api/auth/me, then redirects
 * unauthenticated visitors to /login. Optional Admin-only gate.
 */
export function AuthGuard({
  children,
  requireRole,
  loginPath = '/login',
}: AuthGuardProps) {
  const { user, isAuthenticated, isLoading, isMasterAdmin } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 text-sm text-slate-400 gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking session…
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Redirect to={loginPath} />;
  }

  if (requireRole === 'Admin' && !isMasterAdmin && user.rbac_role !== 'Admin') {
    return <Redirect to="/dashboard" />;
  }

  return <>{children}</>;
}
