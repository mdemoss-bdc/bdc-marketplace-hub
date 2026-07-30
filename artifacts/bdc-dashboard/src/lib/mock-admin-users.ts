/**
 * Frontend mock user directory for static / Vercel deploys where
 * `/api/admin/users` is unreachable. Used by the Admin Console table.
 */

export type MockAdminUser = {
  id: number;
  username: string;
  full_name: string;
  email: string;
  subscription_status: string;
  subscription_tier: string;
  is_admin: boolean;
  is_suspended: boolean;
  email_verified: boolean;
  created_at: string;
  recovery_id?: string;
  org_id?: number | null;
  org_role?: string;
  org_name?: string;
  org_max_seats?: number;
};

/** Full test roster rendered in the admin user directory. */
export const MOCK_ADMIN_USERS: MockAdminUser[] = [
  {
    id: 9,
    username: 'mdemoss',
    full_name: 'Matthew DeMoss',
    email: 'mdemoss@local.dev',
    subscription_status: 'active',
    subscription_tier: 'pro_lifetime',
    is_admin: true,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-01-01T00:00:00Z',
    recovery_id: 'MD-DEMO-0009-AAAA',
    org_id: null,
    org_role: '',
    org_name: '',
  },
  {
    id: 20,
    username: 'testreviewer',
    full_name: 'Test Reviewer',
    email: 'testreviewer@local.dev',
    subscription_status: 'active',
    subscription_tier: 'rooftop_monthly',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-06-01T00:00:00Z',
    recovery_id: 'TR-DEMO-0020-BBBB',
    org_id: 1,
    org_role: 'admin',
    org_name: 'Demo Rooftop Motors',
    org_max_seats: 5,
  },
  {
    id: 22,
    username: 'jdemoss',
    full_name: 'J DeMoss',
    email: 'jdemoss@local.dev',
    subscription_status: 'active',
    subscription_tier: 'pro_annual',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-08-15T00:00:00Z',
    recovery_id: 'JD-DEMO-0022-CCCC',
    org_id: null,
    org_role: '',
    org_name: '',
  },
  {
    id: 21,
    username: 'mdemoss1',
    full_name: 'BDC Test User',
    email: 'mdemoss1@local.dev',
    subscription_status: 'active',
    subscription_tier: 'rooftop_monthly',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-09-01T00:00:00Z',
    recovery_id: 'M1-DEMO-0021-DDDD',
    org_id: 1,
    org_role: 'member',
    org_name: 'Demo Rooftop Motors',
    org_max_seats: 5,
  },
  {
    id: 30,
    username: 'sales.manager',
    full_name: 'Sales Manager',
    email: 'sales.manager@local.dev',
    subscription_status: 'active',
    subscription_tier: 'pro_annual',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-10-01T00:00:00Z',
    recovery_id: 'SM-DEMO-0030-EEEE',
    org_id: 2,
    org_role: 'admin',
    org_name: 'University Ford Desk',
    org_max_seats: 8,
  },
  {
    id: 31,
    username: 'desk.rep',
    full_name: 'Desk Rep',
    email: 'desk.rep@local.dev',
    subscription_status: 'inactive',
    subscription_tier: '',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2025-01-12T00:00:00Z',
    recovery_id: 'DR-DEMO-0031-FFFF',
    org_id: 2,
    org_role: 'member',
    org_name: 'University Ford Desk',
    org_max_seats: 8,
  },
];

export function getMockAdminUsersPayload(): { users: MockAdminUser[] } {
  return { users: MOCK_ADMIN_USERS.map((u) => ({ ...u })) };
}
