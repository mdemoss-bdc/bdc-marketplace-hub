/**
 * Auth routes for the local TypeScript api-server.
 *
 * Uses the shared Node auth store (api/_lib/db.js) which prefers persistent
 * PostgreSQL when DATABASE_URL / POSTGRES_URL is set.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAuthStore(): {
  authenticate: (u: string, p: string) => Promise<Record<string, unknown> | null>;
  createUser: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getUserByUsername: (u: string) => Promise<Record<string, unknown> | null>;
  adminDirectoryUsers: () => Promise<unknown[]>;
  openDb: () => Promise<unknown>;
  backend?: string;
} {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_lib/users.js"),
    path.resolve(process.cwd(), "api/_lib/users.js"),
  ];
  for (const file of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const users = require(file) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const db = require(file.replace(/users\.js$/, "db.js")) as Record<string, unknown>;
      return {
        authenticate: users.authenticate as never,
        createUser: users.createUser as never,
        getUserByUsername: users.getUserByUsername as never,
        adminDirectoryUsers: users.adminDirectoryUsers as never,
        openDb: db.openDb as never,
        backend: String(db.backend || ""),
      };
    } catch {
      /* try next */
    }
  }
  throw new Error("Auth store (api/_lib/users.js) not found");
}

let _warmed = false;
async function warmStore() {
  if (_warmed) return;
  const store = loadAuthStore();
  await store.openDb();
  _warmed = true;
}

router.get("/auth", async (_req: Request, res: Response) => {
  try {
    await warmStore();
    const store = loadAuthStore();
    res.status(200).json({
      success: true,
      backend: store.backend || "unknown",
      message: "Auth routes persist users to PostgreSQL when DATABASE_URL is set.",
      endpoints: [
        "POST /api/auth/login",
        "POST /api/auth/register",
        "POST /api/auth/signup",
        "GET /api/admin/users",
      ],
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Auth store unavailable",
    });
  }
});

router.post(["/auth/register", "/auth/signup"], async (req: Request, res: Response) => {
  try {
    await warmStore();
    const store = loadAuthStore();
    const body = (req.body || {}) as Record<string, unknown>;
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.full_name || body.name || username).trim();
    const accountType = String(body.account_type || "").trim().toLowerCase();

    const user = await store.createUser({
      username,
      password,
      email,
      full_name: fullName,
      account_type: accountType,
      subscription_status: "inactive",
      role: "Reviewer",
    });
    res.status(201).json({ success: true, ...user, message: "Account created." });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : "Registration failed.",
    });
  }
});

router.post("/auth/login", async (req: Request, res: Response) => {
  try {
    await warmStore();
    const store = loadAuthStore();
    const body = (req.body || {}) as Record<string, unknown>;
    const username = String(body.username || body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = await store.authenticate(username, password);
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    res.status(200).json({ success: true, ...user });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Login failed.",
    });
  }
});

router.get("/admin/users", async (req: Request, res: Response) => {
  try {
    await warmStore();
    const store = loadAuthStore();
    // Lightweight gate: require Authorization header presence for desk builds;
    // production Vercel route enforces Admin RBAC via JWT.
    const auth = String(req.headers.authorization || "");
    if (!auth) {
      res.status(401).json({ error: "Authorization required." });
      return;
    }
    const users = await store.adminDirectoryUsers();
    res.status(200).json({ users });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : "Failed to list users.",
    });
  }
});

export default router;
