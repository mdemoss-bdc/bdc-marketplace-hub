/**
 * Compatibility entry for tooling that expects `artifacts/api-server/api/index.ts`.
 * The live Vercel catch-all is `api/[[...path]].js`; this re-exports the Express app
 * that mounts non-destructive multi-user auth (login / register / signup).
 */
export { default } from "../src/app";
