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
  /** Display name for the local account switcher. */
  name: string;
  /** Short role label: admin | rep | manager */
  role: string;
}

/** Preset local accounts — no external identity provider. */
export interface LocalAccountPreset {
  id: string;
  label: string;
  description: string;
  user: User;
}

const ACTIVE_USER_KEY = 'active_user';
const LOCAL_TOKEN = 'local-dev-force-auth';

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

/** Stable numeric id for free-typed local usernames. */
function localIdForUsername(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) {
    h = (h * 31 + username.charCodeAt(i)) >>> 0;
  }
  return 1000 + (h % 90000);
}

function resolveLocalUser(usernameRaw: string): User {
  const username = usernameRaw.trim().toLowerCase();
  const preset = LOCAL_ACCOUNTS.find(
    (a) => a.user.username.toLowerCase() === username,
  );
  if (preset) return { ...preset.user, mock_role: '' };

  // Free-typed username — mint a local session profile on the fly.
  const pretty = usernameRaw.trim() || username;
  return buildUser({
    id: localIdForUsername(username),
    username,
    name: pretty,
    role: 'rep',
    is_admin: false,
    is_master_admin: false,
  });
}
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
  /** One-click local account switch — writes `active_user` to localStorage. */
  switchAccount: (accountId: string) => void;
  setMockRole: (role: MockRole) => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email: string, tosAccepted: boolean, visitorId?: string, referralCode?: string, orgInvite?: string, accountType?: 'individual' | 'rooftop', dealershipName?: string, extraSeats?: number, billingCycle?: 'monthly' | 'annual' | 'lifetime') => Promise<void>;
  logout: () => Promise<void>;
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Empty string = explicitly logged out. Missing key = first visit → Primary Admin. */
function readActiveUser(): User | null {
  try {
    const raw = localStorage.getItem(ACTIVE_USER_KEY);
    if (raw === null) return LOCAL_ACCOUNTS[0].user;
    if (raw === '') return null;
    const parsed = JSON.parse(raw) as User;
    if (!parsed?.username) return null;
    return parsed;
  } catch {
    return LOCAL_ACCOUNTS[0].user;
  }
}

function writeActiveUser(user: User | null) {
  if (user) {
    localStorage.setItem(ACTIVE_USER_KEY, JSON.stringify(user));
    localStorage.setItem('bdc_user', JSON.stringify(user));
    localStorage.setItem('bdc_token', LOCAL_TOKEN);
    // Explicit session key requested by the local login flow.
    localStorage.setItem('user', user.username);
  } else {
    localStorage.setItem(ACTIVE_USER_KEY, '');
    localStorage.removeItem('bdc_user');
    localStorage.removeItem('bdc_token');
    localStorage.removeItem('user');
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readActiveUser());
  const [token, setToken] = useState<string | null>(() =>
    readActiveUser() ? LOCAL_TOKEN : null,
  );
  // Local auth never blocks first paint with a network spinner.
  const [isLoading] = useState(false);

  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;

  useEffect(() => {
    setAuthTokenGetter(() => token);
  }, [token]);

  const applyUser = useCallback((next: User | null) => {
    setUser(next);
    setToken(next ? LOCAL_TOKEN : null);
    writeActiveUser(next);
  }, []);

  const switchAccount = useCallback((accountId: string) => {
    const preset = LOCAL_ACCOUNTS.find((a) => a.id === accountId);
    if (!preset) return;
    applyUser({ ...preset.user, mock_role: '' });
  }, [applyUser]);

  const login = useCallback(async (username: string, password: string) => {
    const trimmedUser = username.trim();
    if (!trimmedUser) {
      throw new Error('Username is required.');
    }
    if (!password) {
      throw new Error('Password is required.');
    }
    // Local auth: any non-empty password is accepted for any username
    // (mdemoss, mdemoss1, jdemoss, or a free-typed account).
    applyUser(resolveLocalUser(trimmedUser));
  }, [applyUser]);

  const register = useCallback(async (
    username: string, password: string, _email: string, _tosAccepted: boolean,
    _visitorId = '', _referralCode = '', _orgInvite = '',
    _accountType: 'individual' | 'rooftop' = 'individual',
    _dealershipName = '', _extraSeats = 0,
    _billingCycle: 'monthly' | 'annual' | 'lifetime' = 'monthly',
  ) => {
    if (!username.trim()) throw new Error('Username is required.');
    if (!password) throw new Error('Password is required.');
    applyUser(resolveLocalUser(username));
  }, [applyUser]);

  const logout = useCallback(async () => {
    // Local-only — no network call to any auth provider.
    applyUser(null);
  }, [applyUser]);

  const authFetch = useCallback(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      const tok = tokenRef.current;
      const headers = new Headers(init.headers);
      if (tok) headers.set('Authorization', `Bearer ${tok}`);
      // Never auto-clear the local session on API 401 — that bounced users
      // into a login loop. Logout is an explicit UI action only.
      return fetch(input, { ...init, headers });
    },
    [],
  );

  const refreshUser = useCallback(async () => {
    const current = readActiveUser();
    if (current) setUser(current);
  }, []);

  const setMockRole = useCallback(async (role: MockRole) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, mock_role: role };
      writeActiveUser(next);
      return next;
    });
  }, []);

  const isAuthenticated        = Boolean(user);
  const isSubscribed           = Boolean(user?.is_admin || user?.subscription_status === 'active');
  const isEmailVerified        = Boolean(user?.is_admin || user?.email_verified);
  const isMasterAdmin          = Boolean(user?.is_master_admin);
  const mockRole               = (user?.mock_role ?? '') as MockRole;
  const effectiveIsMasterAdmin = mockRole === 'rooftop_admin' ? false : isMasterAdmin;
  const effectiveOrgRole       = mockRole === 'rooftop_admin' ? 'admin' : (user?.org_role ?? '');

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
