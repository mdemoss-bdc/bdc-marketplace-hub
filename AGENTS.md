# BDC Automation Engine & Manager Desk

A zero-dependency automotive BDC (Business Development Center) automation engine with a full-featured Manager Desk dashboard. The Python backend handles lead processing, trade valuations, appointment booking, and autonomous re-engagement — backed by SQLite locally and PostgreSQL in production. The React frontend gives sales managers a real-time command center.

## Run & Operate

Copy `.env.example` to `.env` first, then:

- `pnpm install` — install all workspace dependencies
- `pip install -r requirements.txt` — install Python extras (scraping, email, billing)
- `pnpm run dev:api` — Python BDC engine on `http://127.0.0.1:8080`
- `pnpm run dev:web` — Manager Desk dashboard on `http://localhost:5173` (proxies `/api` to the engine)
- `pnpm run dev:mockup` — component sandbox on `http://localhost:5174`
- `pnpm run dev` — dashboard + sandbox together (run `dev:api` in a second terminal)
- `pnpm run build` — typecheck + production build of every workspace package
- `pnpm --filter @workspace/api-spec run codegen` — regenerate React Query hooks and Zod schemas from the OpenAPI spec

The engine reads `PORT` (default `8080`) and `HOST` (default `0.0.0.0`), so it deploys unchanged to any standard container or PaaS host.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9 (frontend tooling)
- **BDC Backend**: Python 3.13, stdlib only (`http.server`, `sqlite3`, `threading`, `urllib`)
- **Database**: SQLite (`artifacts/api-server/bdc_production.db`) by default; PostgreSQL when `DATABASE_URL` is set
- **Frontend**: React + Vite, Tailwind CSS, Wouter routing, TanStack React Query
- API codegen: Orval (from OpenAPI spec in `lib/api-spec/openapi.yaml`)

## Where Things Live

- `artifacts/api-server/bdc_engine.py` — Python BDC engine (all backend logic)
- `artifacts/api-server/bdc_production.db` — SQLite database (auto-created on first run)
- `artifacts/bdc-dashboard/src/` — React Manager Desk dashboard
- `lib/api-spec/openapi.yaml` — OpenAPI source of truth for all BDC endpoints
- `lib/api-client-react/src/generated/` — Auto-generated React Query hooks (do not hand-edit)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/lead | Inbound lead gateway (NLP processing) |
| POST | /api/v1/twilio/inbound | Twilio SMS webhook |
| GET | /api/v1/appointments | Sales desk appointment board |
| GET | /api/v1/sessions | Full lead pipeline |
| GET | /api/v1/analytics | KPI metrics |
| GET | /api/vehicles | Live scraped showroom inventory |
| GET | /api/healthz | Health check |

## Manager Desk Pages

- **Dashboard** (`/`) — Live KPI cards + upcoming appointments (auto-refreshes every 10s)
- **Appointments** (`/appointments`) — Full appointment board with customer details
- **Leads** (`/leads`) — Lead pipeline with status badges; escalated leads are visually prominent
- **Inventory** (`/inventory`) — Vehicle inventory with availability status and search
- **TikTok Hub** (`/tiktok`) — Dynamic scripter, shot-list builder, and posting queue
- **Lead Gateway** (`/lead-gateway`) — Test the BDC engine: submit a lead, see the bot reply + intent

## Configuration

All configuration is plain environment variables loaded from `.env` (see `.env.example`).
Nothing is platform-specific — the same variables work locally, in Docker, and on any cloud host.

Cox Automotive / VinSolutions CRM sync requires `COX_CLIENT_ID`, `COX_CLIENT_SECRET`, and
`COX_DEALER_ID`. Without them, leads are saved locally only and the engine logs
`INFO Cox credentials not configured`.

## Architecture Decisions

- **Python stdlib only** — no pip dependencies for the engine itself; runs anywhere Python 3 is available
- **SQLite by default, Postgres opt-in** — `DATABASE_URL` switches the storage layer via `pg_compat`
- **Background threading** — `BDCFollowUpWorker` daemon thread polls every 5s for 24hr re-engagement
- **OpenAPI-first** — frontend hooks generated from spec; Python backend implements same contract
- **Path prefix required** — the Vite dev proxy forwards `/api/*` without rewriting; the Python handler matches full `/api/v1/...` paths

## Gotchas

- Always run codegen after changing `lib/api-spec/openapi.yaml` before touching frontend code
- The Python server CWD is `artifacts/api-server/` — relative paths in `bdc_engine.py` are relative to that dir
- SQLite DB is created at `artifacts/api-server/bdc_production.db` on first startup
- The 24hr re-engagement threshold uses real wall-clock time; the demo worker polls every 5s

## User Preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
