/**
 * Re-export shim — auth lives in auth.tsx (server-backed password sessions).
 */
export {
  useAuth,
  AuthProvider,
  LOCAL_ACCOUNTS,
  type MockRole,
  type User,
  type LocalAccountPreset,
} from './auth';
