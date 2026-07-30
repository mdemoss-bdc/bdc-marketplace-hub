/**
 * Auth routes for the local TypeScript api-server.
 *
 * Uses the shared Node auth store (api/_lib/db.js) which prefers persistent
 * PostgreSQL when DATABASE_URL / POSTGRES_URL is set. Register/login both use
 * bcrypt (cost 10) via crypto-passwords.js and case-insensitive usernames.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type AuthUser = Record<string, unknown> & {
  id?: number;
  username?: string;
  role?: string;
  is_admin?: boolean;
  is_master_admin?: boolean;
};

function loadAuthModules(): {
  authenticate: (u: string, p: string) => Promise<AuthUser | null>;
  createUser: (payload: Record<string, unknown>) => Promise<AuthUser>;
  getUserByUsername: (u: string) => Promise<AuthUser | null>;
  adminDirectoryUsers: () => Promise<unknown[]>;
  openDb: () => Promise<unknown>;
  signJwt: (claims: Record<string, unknown>) => string;
  setAuthCookie: (res: Response, token: string) => void;
  backend?: string;
} {
  const bases = [
    path.resolve(__dirname, "../../../../api/_lib"),
    path.resolve(process.cwd(), "api/_lib"),
  ];
  for (const base of bases) {
    try {
      const users = require(path.join(base, "users.js")) as Record<string, unknown>;
      const db = require(path.join(base, "db.js")) as Record<string, unknown>;
      const jwt = require(path.join(base, "jwt.js")) as Record<string, unknown>;
      return {
        authenticate: users.authenticate as never,
        createUser: users.createUser as never,
        getUserByUsername: users.getUserByUsername as never,
        adminDirectoryUsers: users.adminDirectoryUsers as never,
        openDb: db.openDb as never,
        signJwt: jwt.signJwt as never,
        setAuthCookie: jwt.setAuthCookie as never,
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
  const store = loadAuthModules();
  await store.openDb();
  _warmed = true;
}

function sessionPayload(user: AuthUser, token: string) {
  return {
    success: true,
    ...user,
    role: user.role,
    token,
  };
}

router.get("/auth", async (_req: Request, res: Response) => {
  try {
    await warmStore();
    const store = loadAuthModules();
    res.status(200).json({
      success: true,
      backend: store.backend || "unknown",
      message: "Auth uses bcrypt password hashes + case-insensitive usernames.",
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
    const store = loadAuthModules();
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

    const token = store.signJwt({
      sub: user.username,
      id: user.id,
      role: user.role,
      is_admin: user.is_admin,
      is_master_admin: user.is_master_admin,
    });
    store.setAuthCookie(res, token);
    console.log("[AUTH OK]", user.username, "registered + session issued");
    res.status(201).json({
      ...sessionPayload(user, token),
      message: "Account created.",
    });
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
    const store = loadAuthModules();
    const body = (req.body || {}) as Record<string, unknown>;
    const username = String(body.username || body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    console.log("[LOGIN CHECK]", { inputUsername: username, hasPassword: Boolean(password) });
    const user = await store.authenticate(username, password);
    console.log("[LOGIN CHECK]", { inputUsername: username, userFound: !!user });
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = store.signJwt({
      sub: user.username,
      id: user.id,
      role: user.role,
      is_admin: user.is_admin,
      is_master_admin: user.is_master_admin,
    });
    store.setAuthCookie(res, token);
    res.status(200).json(sessionPayload(user, token));
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
    const store = loadAuthModules();
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
