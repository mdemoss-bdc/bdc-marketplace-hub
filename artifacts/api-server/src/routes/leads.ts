/**
 * Lead Center routes for the artifacts Express app.
 * Delegates to root `api/_routes/leads.js` / `api/_lib/leads.js`.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function emptyLeads() {
  return { leads: [], total: 0 };
}

function loadLeadsLib(): {
  getLeadsSafe: (opts?: Record<string, unknown>) => Promise<{ leads: unknown[]; total: number }>;
  emptyLeadsPayload: () => { leads: unknown[]; total: number };
  resolveTenantScope: (req: Request) => Promise<number | null>;
} {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_lib/leads.js"),
    path.resolve(process.cwd(), "api/_lib/leads.js"),
    path.resolve(process.cwd(), "../api/_lib/leads.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file) as ReturnType<typeof loadLeadsLib>;
    } catch {
      /* try next */
    }
  }
  throw new Error("leads.js helper not found");
}

/** GET /api/leads and /api/v1/leads */
async function listLeads(req: Request, res: Response) {
  try {
    const lib = loadLeadsLib();
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const slaRaw = typeof req.query.sla_only === "string" ? req.query.sla_only : "0";
    const slaOnly = ["1", "true", "yes"].includes(slaRaw.toLowerCase());
    const organizationId = await lib.resolveTenantScope(req);
    const payload = await lib.getLeadsSafe({
      status,
      source,
      sla_only: slaOnly,
      organization_id: organizationId,
    });
    res.status(200).json(payload ?? emptyLeads());
  } catch (err) {
    console.error("[leads]", err);
    res.status(200).json(emptyLeads());
  }
}

router.get("/leads", listLeads);
router.get("/v1/leads", listLeads);

export default router;
