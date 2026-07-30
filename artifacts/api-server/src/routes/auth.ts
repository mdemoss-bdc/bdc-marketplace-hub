/**
 * Auth routes for the local TypeScript api-server.
 *
 * Production auth (non-destructive seed, login, register/signup, vault persistence)
 * is implemented in the Vercel catch-all:
 *   - api/[[...path]].js
 *   - api/_lib/app.js
 *   - api/_lib/db.js
 *   - api/_routes/auth/*
 *
 * This router advertises the same paths for local api-server health/docs and
 * proxies method hints; full credential handling is owned by the shared CJS store.
 */
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

router.get("/auth", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Auth routes are served by the Vercel catch-all (api/[[...path]].js).",
    endpoints: [
      "POST /api/auth/login",
      "POST /api/auth/register",
      "POST /api/auth/signup",
      "POST /api/auth/logout",
      "GET|POST /api/auth/me",
    ],
    baseline_accounts: ["mdemoss", "testreviewer", "jdemoss", "jdmoss (alias → jdemoss)"],
    notes: [
      "POST /api/auth/register creates a scrypt-hashed user and returns a JWT.",
      "Duplicate username/email returns HTTP 400 with a clear error message.",
      "Baseline seeding is non-destructive (existing password hashes are preserved).",
      "jdemoss / jdmoss both authenticate with password Jdemoss123!.",
      "Login usernames are matched case-insensitively.",
      "New signups persist to SQLite + auth vault mirror.",
    ],
  });
});

export default router;
