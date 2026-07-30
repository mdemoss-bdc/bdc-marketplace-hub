import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { setAuthTokenGetter } from '@workspace/api-client-react';

export type MockRole = '' | 'master_admin' | 'rooftop_admin';

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  is_master_admin: boolean;
  /** RBAC: Admin (full desk) | Reviewer (limited) */
  rbac_role: 'Admin' | 'Reviewer' | '';
  subscription_status: string;
  subscription_tier: string;
  org_role: string;
  organization_id: number | null;
  email: string;
  email_verified: boolean;
  is_suspended: boolean;
  created_at: string;
  recovery_id?: string;
  mock_role: MockRole;
  tiktok_connected: boolean;
  tiktok_token_expires_at: string;
  tiktok_privacy_level: string;
  pending_extra_seats: number;
  /** Display name for the account switcher / header. */
  name: string;
  /** Short role label: admin | rep | manager */
  role: string;
}

/** Preset labels for the optional account switcher UI (display only). */
export interface LocalAccountPreset {
  id: string;
  label: string;
  description: string;
  user: User;
}

const TOKEN_KEY = 'bdc_token';
const USER_KEY = 'bdc_user';
const ACTIVE_USER_KEY = 'active_user';
/**
 * Server-issued session marker (Vercel serverless HMAC tokens).
 * Legacy client-only tokens are rejected.
 */
const CLIENT_TOKEN_PREFIX = 'client-fallback:';
const VERCEL_SESSION_PREFIX = 'vs_';

/** Optional absolute API origin for production (e.g. https://api.example.com). */
const VITE_API_URL = String(
  import.meta.env.VITE_API_BASE_URL ??
    import.meta.env.VITE_API_URL ??
    import.meta.env.NEXT_PUBLIC_API_URL ??
    '',
)
  .trim()
  .replace(/\/$/, '');

/**
 * Local Vite proxies `/api` → the Python engine (or Node catch-all).
 * On Vercel, same-origin `/api/auth/*` is rewritten to `api/index.js`.
 * Set VITE_API_BASE_URL / VITE_API_URL only when the API is on another origin.
 */
function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (VITE_API_URL) return `${VITE_API_URL}${suffix}`;
  return suffix.startsWith('/api') ? suffix : `/api${suffix}`;
}

function isClientFallbackToken(token: string | null | undefined): boolean {
  return Boolean(token && token.startsWith(CLIENT_TOKEN_PREFIX));
}

function isVercelSessionToken(token: string | null | undefined): boolean {
  return Boolean(token && token.startsWith(VERCEL_SESSION_PREFIX));
}

function roleFromUser(u: {
  is_master_admin?: boolean;
  is_admin?: boolean;
  org_role?: string;
}): string {
  if (u.is_master_admin) return 'admin';
  if (u.org_role === 'admin') return 'manager';
  if (u.is_admin) return 'manager';
  return 'rep';
}

function mapApiUser(raw: Record<string, unknown>): User {
  const username = String(raw.username ?? '');
  const isAdmin = Boolean(raw.is_admin);
  const isMaster = Boolean(raw.is_master_admin);
  const rbacRaw = String(raw.role ?? raw.rbac_role ?? '').trim();
  const rbac_role: User['rbac_role'] =
    rbacRaw === 'Admin' || rbacRaw === 'Reviewer'
      ? rbacRaw
      : isMaster || (isAdmin && username.toLowerCase() === 'mdemoss')
        ? 'Admin'
        : username.toLowerCase() === 'testreviewer'
          ? 'Reviewer'
          : isAdmin
            ? 'Admin'
            : 'Reviewer';
  return {
    id: Number(raw.id) || 0,
    username,
    name: String(raw.full_name || raw.name || username),
    role: roleFromUser({
      is_master_admin: isMaster,
      is_admin: isAdmin,
      org_role: String(raw.org_role ?? ''),
    }),
    rbac_role,
    is_admin: isAdmin,
    is_master_admin: isMaster,
    subscription_status: String(raw.subscription_status ?? 'inactive'),
    subscription_tier: String(raw.subscription_tier ?? ''),
    org_role: String(raw.org_role ?? ''),
    organization_id:
      raw.organization_id === null || raw.organization_id === undefined
        ? null
        : Number(raw.organization_id),
    email: String(raw.email ?? ''),
    email_verified: Boolean(raw.email_verified),
    is_suspended: Boolean(raw.is_suspended),
    created_at: String(raw.created_at ?? ''),
    recovery_id: raw.recovery_id ? String(raw.recovery_id) : undefined,
    mock_role: (String(raw.mock_role ?? '') as MockRole) || '',
    tiktok_connected: Boolean(raw.tiktok_connected),
    tiktok_token_expires_at: String(raw.tiktok_token_expires_at ?? ''),
    tiktok_privacy_level: String(raw.tiktok_privacy_level ?? 'SELF_ONLY'),
    pending_extra_seats: Number(raw.pending_extra_seats) || 0,
  };
}

function readStoredToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t || t === 'local-dev-force-auth') return null;
    return t;
  } catch {
    return null;
  }
}

function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY) || localStorage.getItem(ACTIVE_USER_KEY);
    if (!raw || raw === '') return null;
    const parsed = JSON.parse(raw) as User;
    if (!parsed?.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistSession(token: string | null, user: User | null) {
  if (token && user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(ACTIVE_USER_KEY, JSON.stringify(user));
    localStorage.setItem('user', user.username);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.setItem(ACTIVE_USER_KEY, '');
    localStorage.removeItem('user');
  }
}

function buildUser(partial: {
  id: number;
  username: string;
  name: string;
  role: string;
  is_admin?: boolean;
  is_master_admin?: boolean;
  org_role?: string;
}): User {
  const isAdmin = Boolean(partial.is_admin);
  return {
    id: partial.id,
    username: partial.username,
    name: partial.name,
    role: partial.role,
    is_admin: isAdmin,
    is_master_admin: Boolean(partial.is_master_admin),
    rbac_role: partial.is_master_admin ? 'Admin' : isAdmin ? 'Admin' : 'Reviewer',
    subscription_status: 'active',
    subscription_tier: isAdmin ? 'pro_lifetime' : 'pro_annual',
    org_role: partial.org_role ?? '',
    organization_id: null,
    email: `${partial.username}@local.dev`,
    email_verified: true,
    is_suspended: false,
    created_at: '2024-01-01T00:00:00Z',
    mock_role: '',
    tiktok_connected: false,
    tiktok_token_expires_at: '',
    tiktok_privacy_level: 'SELF_ONLY',
    pending_extra_seats: 0,
  };
}

/** Display presets only — never used to grant a session without a password. */
export const LOCAL_ACCOUNTS: LocalAccountPreset[] = [
  {
    id: 'mdemoss',
    label: 'Primary Admin',
    description: 'Full master-admin access to every desk tool.',
    user: buildUser({
      id: 9,
      username: 'mdemoss',
      name: 'Matthew DeMoss',
      role: 'admin',
      is_admin: true,
      is_master_admin: true,
    }),
  },
  {
    id: 'jdemoss',
    label: 'J DeMoss',
    description: 'Local desk account for jdemoss.',
    user: buildUser({
      id: 22,
      username: 'jdemoss',
      name: 'J DeMoss',
      role: 'rep',
      is_admin: false,
      is_master_admin: false,
    }),
  },
  {
    id: 'mdemoss1',
    label: 'Test Account',
    description: 'BDC rep workspace for inventory and posting checks.',
    user: buildUser({
      id: 21,
      username: 'mdemoss1',
      name: 'BDC Test User',
      role: 'rep',
      is_admin: false,
      is_master_admin: false,
    }),
  },
  {
    id: 'sales_manager',
    label: 'Sales / Manager View',
    description: 'Rooftop manager lens — team tools without master admin.',
    user: buildUser({
      id: 30,
      username: 'sales.manager',
      name: 'Sales Manager',
      role: 'manager',
      is_admin: true,
      is_master_admin: false,
      org_role: 'admin',
    }),
  },
];

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isSubscribed: boolean;
  isEmailVerified: boolean;
  isMasterAdmin: boolean;
  mockRole: MockRole;
  effectiveIsMasterAdmin: boolean;
  effectiveOrgRole: string;
  switchAccount: (accountId: string) => void;
  setMockRole: (role: MockRole) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email: string, tosAccepted: boolean, visitorId?: string, referralCode?: string, orgInvite?: string, accountType?: 'individual' | 'rooftop', dealershipName?: string, extraSeats?: number, billingCycle?: 'monthly' | 'annual' | 'lifetime', fullName?: string) => Promise<void>;
  logout: () => Promise<void>;
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(token?: string | null): Promise<User> {
  const headers: HeadersInit = {};
  if (token && !isClientFallbackToken(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(apiUrl('/api/auth/me'), {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    throw new Error('Session expired. Please sign in again.');
  }
  const data = await res.json();
  return mapApiUser(data as Record<string, unknown>);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  const applySession = useCallback((nextToken: string | null, nextUser: User | null) => {
    setToken(nextToken);
    setUser(nextUser);
    persistSession(nextToken, nextUser);
  }, []);

  // Restore session on boot via cookie + /api/auth/me (JWT HttpOnly preferred).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = readStoredToken();
      if (stored && isClientFallbackToken(stored)) {
        persistSession(null, null);
      }
      try {
        // Cookie session first; Bearer token as fallback for local Python.
        const me = await fetchMe(stored && !isClientFallbackToken(stored) ? stored : null);
        if (!cancelled) {
          applySession(stored && !isClientFallbackToken(stored) ? stored : 'cookie-session', me);
        }
      } catch {
        if (!cancelled) applySession(null, null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [applySession]);

  useEffect(() => {
    setAuthTokenGetter(() => {
      const t = tokenRef.current;
      if (!t || t === 'cookie-session' || isClientFallbackToken(t)) return null;
      return t;
    });
  }, [token]);

  const login = useCallback(async (username: string, password: string) => {
    const trimmedUser = username.trim().toLowerCase();
    if (!trimmedUser || !password) {
      throw new Error('Invalid credentials');
    }

    let res: Response;
    try {
      res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmedUser, password }),
      });
    } catch {
      throw new Error('Could not reach the authentication server.');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : 'Invalid credentials',
      );
    }

    const sessionToken = String(data.token || 'cookie-session');
    try {
      const me = await fetchMe(data.token ? String(data.token) : null);
      applySession(sessionToken, me);
    } catch {
      applySession(sessionToken, mapApiUser(data as Record<string, unknown>));
    }
  }, [applySession]);

  const register = useCallback(async (
    username: string, password: string, email: string, tosAccepted: boolean,
    visitorId = '', referralCode = '', orgInvite = '',
    accountType: 'individual' | 'rooftop' = 'individual',
    dealershipName = '', extraSeats = 0,
    billingCycle: 'monthly' | 'annual' | 'lifetime' = 'monthly',
    fullName = '',
  ) => {
    if (!username.trim()) throw new Error('Username is required.');
    if (!password) throw new Error('Password is required.');
    if (!email.trim()) throw new Error('Email address is required.');

    const res = await fetch(apiUrl('/api/auth/register'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.trim().toLowerCase(),
        password,
        email: email.trim().toLowerCase(),
        full_name: fullName.trim() || username.trim(),
        tos_accepted: tosAccepted,
        visitor_id: visitorId,
        referral_code: referralCode,
        org_invite: orgInvite,
        account_type: accountType,
        dealership_name: dealershipName,
        extra_seats: extraSeats,
        billing_cycle: billingCycle,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string' ? data.error : 'Registration failed.',
      );
    }
    const sessionToken = String(data.token || 'cookie-session');
    try {
      const me = await fetchMe(data.token ? String(data.token) : null);
      applySession(sessionToken, me);
    } catch {
      applySession(sessionToken, mapApiUser(data as Record<string, unknown>));
    }
  }, [applySession]);

  const logout = useCallback(async () => {
    const tok = tokenRef.current;
    try {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...(tok && tok !== 'cookie-session' && !isClientFallbackToken(tok)
            ? { Authorization: `Bearer ${tok}` }
            : {}),
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    } catch {
      // Still clear local session if the network call fails.
    }
    applySession(null, null);
  }, [applySession]);

  const authFetch = useCallback(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      const tok = tokenRef.current;
      const headers = new Headers(init.headers);
      if (tok && tok !== 'cookie-session' && !isClientFallbackToken(tok)) {
        headers.set('Authorization', `Bearer ${tok}`);
      }
      const url =
        typeof input === 'string'
          ? (input.startsWith('http://') || input.startsWith('https://')
              ? input
              : apiUrl(input))
          : input;
      return fetch(url, { ...init, headers, credentials: 'include' });
    },
    [],
  );

  const refreshUser = useCallback(async () => {
    const tok = tokenRef.current;
    try {
      const me = await fetchMe(tok && tok !== 'cookie-session' ? tok : null);
      applySession(tok || 'cookie-session', me);
    } catch {
      applySession(null, null);
    }
  }, [applySession]);

  const switchAccount = useCallback((_accountId: string) => {
    console.warn('[auth] switchAccount is disabled; use the login form with a password.');
  }, []);

  const setMockRole = useCallback(async (role: MockRole) => {
    const tok = tokenRef.current;
    if (!tok) return;
    if (!isClientFallbackToken(tok) && !isVercelSessionToken(tok)) {
      try {
        await fetch(apiUrl('/api/admin/impersonate'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ mock_role: role }),
        });
      } catch {
        // Fall through to local override if the endpoint is unavailable.
      }
    }
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, mock_role: role };
      persistSession(tok, next);
      return next;
    });
  }, []);

  const isAuthenticated = Boolean(user && token);
  const isSubscribed = Boolean(user?.is_admin || user?.subscription_status === 'active');
  const isEmailVerified = Boolean(user?.is_admin || user?.email_verified);
  const isMasterAdmin = Boolean(user?.is_master_admin);
  const mockRole = (user?.mock_role ?? '') as MockRole;
  const effectiveIsMasterAdmin = mockRole === 'rooftop_admin' ? false : isMasterAdmin;
  const effectiveOrgRole = mockRole === 'rooftop_admin' ? 'admin' : (user?.org_role ?? '');

  const value = useMemo(
    () => ({
      user, token, isLoading, isAuthenticated,
      isSubscribed, isEmailVerified,
      isMasterAdmin, mockRole, effectiveIsMasterAdmin, effectiveOrgRole,
      switchAccount, setMockRole,
      login, register, logout, authFetch, refreshUser,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, token, isLoading, isAuthenticated, isSubscribed, isEmailVerified, isMasterAdmin, mockRole, effectiveIsMasterAdmin, effectiveOrgRole, switchAccount, setMockRole, login, register, logout, authFetch, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
