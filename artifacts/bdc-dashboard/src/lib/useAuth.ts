/**
 * Re-export shim — auth lives in auth.tsx (localStorage `active_user` switcher).
 */
export {
  useAuth,
  AuthProvider,
  LOCAL_ACCOUNTS,
  type MockRole,
  type User,
  type LocalAccountPreset,
} from './auth';
