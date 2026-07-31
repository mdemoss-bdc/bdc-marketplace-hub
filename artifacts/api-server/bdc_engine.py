"""
Automotive BDC Automation Engine & REST API Server
---------------------------------------------------
A zero-dependency, high-performance lead management engine built entirely
with Python standard libraries.

Features:
  - ACID persistent session tracking (SQLite)
  - Black Book trade valuation engine with mileage & condition scaling
  - Shorthand NLP entity extraction (re)
  - Autonomous 24hr lead re-engagement background daemon (threading)
  - Manager Desk REST API & Analytics Endpoints (http.server)
  - Multi-CRM sync: Cox Automotive / VinSolutions AND DealerPeak Open API
"""

import base64
import csv
import hashlib
import hmac as _hmac_mod
import html.parser
import io
import json
import os
import random
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import stripe as _stripe_module
except ImportError:
    _stripe_module = None  # type: ignore

# =====================================================================
# CONFIGURATION & CONSTANTS
# =====================================================================
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, "..", ".."))


# ── Environment loading ───────────────────────────────────────────────────────
# Standard `.env` support with zero third-party dependencies: python-dotenv is
# used when installed, otherwise a minimal parser handles KEY=VALUE lines.  Real
# environment variables always win over file values.
def _load_dotenv() -> None:
    candidates = [
        os.environ.get("ENV_FILE", ""),
        os.path.join(_SCRIPT_DIR, ".env"),
        os.path.join(_REPO_ROOT, ".env"),
    ]
    for path in candidates:
        if not path or not os.path.exists(path):
            continue
        try:
            from dotenv import load_dotenv  # type: ignore
            load_dotenv(path, override=False)
            continue
        except ImportError:
            pass
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    if key.startswith("export "):
                        key = key[7:].strip()
                    value = value.strip().strip('"').strip("'")
                    os.environ.setdefault(key, value)
        except OSError as exc:
            print(f"WARNING: could not read env file {path}: {exc}")


_load_dotenv()

# ── Database connection ───────────────────────────────────────────────────────
# When DATABASE_URL is set the engine talks to PostgreSQL through the pg_compat
# shim.  Otherwise it uses the on-disk SQLite file, creating it on first run so
# a fresh clone boots with no external services.
DATABASE_URL = os.environ.get("DATABASE_URL", "")
_LOCAL_SQLITE = os.environ.get(
    "SQLITE_PATH", os.path.join(_SCRIPT_DIR, "bdc_production.db")
)
if DATABASE_URL:
    import pg_compat as sqlite3  # noqa: E402
    DB_FILE = DATABASE_URL
else:
    import sqlite3  # noqa: E402  — real stdlib SQLite for standalone runs
    DB_FILE = _LOCAL_SQLITE
    _sqlite_dir = os.path.dirname(os.path.abspath(_LOCAL_SQLITE))
    if _sqlite_dir:
        os.makedirs(_sqlite_dir, exist_ok=True)
    if os.path.exists(_LOCAL_SQLITE):
        print(f"[LOCAL] DATABASE_URL unset — using SQLite file {_LOCAL_SQLITE}")
    else:
        print(f"[LOCAL] DATABASE_URL unset — creating SQLite file {_LOCAL_SQLITE}")

# Multi-user scrape cancellation registry (sync_sessions table).
try:
    import scraper_engine as _scraper_engine  # noqa: E402
    _scraper_engine.configure(DB_FILE)
except Exception as _se_cfg_err:
    _scraper_engine = None  # type: ignore[assignment]
    print(f"[SCRAPE] scraper_engine unavailable: {_se_cfg_err}")

# Optional CSV inventory feed ingestion (hourly + Sync CSV Now).
try:
    import csv_engine as _csv_engine  # noqa: E402
except Exception as _csv_cfg_err:
    _csv_engine = None  # type: ignore[assignment]
    print(f"[CSV] csv_engine unavailable: {_csv_cfg_err}")

# Permanent on-disk dealer / scraper settings (dealer_config.json).
try:
    import dealer_config as _dealer_config  # noqa: E402
except Exception as _dc_cfg_err:
    _dealer_config = None  # type: ignore[assignment]
    print(f"[CONFIG] dealer_config unavailable: {_dc_cfg_err}")

SERVER_PORT = int(os.environ.get("PORT", 8080))
SERVER_HOST = os.environ.get("HOST", "0.0.0.0")

# ── App base URL — used in every outgoing email link ──────────────────────────
# Set this to the public origin of the deployment (e.g. https://app.example.com).
# All verification, password-reset, security-alert, and referral emails build
# their click-through URLs from this value.  When the variable is missing the
# server still starts and falls back to the request Host header where possible,
# but a loud WARNING is printed at startup so the problem is caught before any
# real email is sent.
APP_BASE_URL: str = os.environ.get("APP_BASE_URL", "").rstrip("/")
if not APP_BASE_URL:
    print(
        "WARNING: APP_BASE_URL is not set. Outgoing email links may be broken. "
        "Set this environment variable to the public origin of the deployment "
        "(e.g. https://app.example.com) before sending real email."
    )

CURRENT_YEAR = 2026
AVG_MILES_PER_YEAR = 12000

# ── Free-tool rate limiting (soft, in-memory, resets on server restart) ──────
# Key: "ip:YYYY-MM-DD"  ->  request count today
_FREE_TOOL_RATE: dict[str, int] = {}
FREE_TOOL_DAILY_LIMIT = 3

# ── Registration IP rate limiting ─────────────────────────────────────────────
# Prevents spam signups.  Key: "ip:YYYY-MM-DD"  ->  new-account count today.
# Soft in-memory; resets on server restart (acceptable — server restarts are rare).
_REG_RATE: dict[str, int] = {}
REG_DAILY_LIMIT = 3   # max new accounts per IP address per 24-hour window

# ── Authenticated trial quota ─────────────────────────────────────────────────
# Key: "user_id:action:YYYY-MM-DD"  ->  count today
# Actions: 'ai_post' | 'wishlist_entry'
# Resets each server restart (acceptable: free tier is limited anyway).
_TRIAL_QUOTA: dict[str, int] = {}
TRIAL_DAILY_LIMIT = 3   # actions per day
TRIAL_MAX_DAYS    = 5   # calendar days from registration


def _check_trial_access(user: dict, action: str) -> tuple[bool, dict]:
    """Return (allowed, error_body).  error_body is {} when allowed.

    Admins and active Pro subscribers always pass.  Free/trial users are checked
    against TRIAL_MAX_DAYS and TRIAL_DAILY_LIMIT per action type.
    """
    if user.get('is_admin') or user.get('subscription_status') == 'active':
        return True, {}

    # Trial window: TRIAL_MAX_DAYS calendar days from registration
    created_raw = user.get('created_at', '') or ''
    try:
        created_date = datetime.strptime(created_raw[:10], '%Y-%m-%d')
        days_elapsed = (datetime.now() - created_date).days
    except Exception:
        days_elapsed = 0          # brand-new or unknown -> give benefit of the doubt

    if days_elapsed >= TRIAL_MAX_DAYS:
        return False, {
            'error':   'trial_expired',
            'message': (
                f'Your {TRIAL_MAX_DAYS}-day free trial has ended. '
                'Upgrade to BDC Manager Desk Pro ($75/mo) for unlimited AI posts, '
                'Wishlist leads, and inventory sync.'
            ),
        }

    # Daily per-action cap
    today = datetime.now().strftime('%Y-%m-%d')
    key   = f"{user['id']}:{action}:{today}"
    used  = _TRIAL_QUOTA.get(key, 0)
    if used >= TRIAL_DAILY_LIMIT:
        return False, {
            'error':     'trial_limit',
            'message':   (
                f'Daily trial limit reached ({TRIAL_DAILY_LIMIT} per day). '
                'Upgrade to BDC Manager Desk Pro ($75/mo) for unlimited access.'
            ),
            'used':      used,
            'limit':     TRIAL_DAILY_LIMIT,
            'remaining': 0,
        }
    return True, {}


def _consume_trial_quota(user: dict, action: str) -> None:
    """Increment the per-user, per-action, per-day counter.  No-op for Pro users."""
    if user.get('is_admin') or user.get('subscription_status') == 'active':
        return
    today = datetime.now().strftime('%Y-%m-%d')
    key   = f"{user['id']}:{action}:{today}"
    _TRIAL_QUOTA[key] = _TRIAL_QUOTA.get(key, 0) + 1

# Cox Automotive / VinSolutions Credentials (fallback to env; per-user DB creds take priority)
COX_CLIENT_ID = os.environ.get("COX_CLIENT_ID", "")
COX_CLIENT_SECRET = os.environ.get("COX_CLIENT_SECRET", "")
COX_DEALER_ID = os.environ.get("COX_DEALER_ID", "")
COX_TOKEN_URL = "https://auth.coxautoinc.com/oauth/token"
COX_LEAD_API_URL = "https://api.coxautoinc.com/connect/crm/leads/v1"

# Stripe billing
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

# ── Moses Auto Group Inventory Scraper ───────────────────────────────────────
MOSES_NEW_URL  = "https://www.mosescars.com/search-all-new-inventory.html"
MOSES_USED_URL = "https://www.mosescars.com/search-all-used-inventory.html"

# ── DealerOn API probe time budget ────────────────────────────────────────────
# Caps the wall-clock time spent across Cosmos / GetInventory pagination.
# University Ford (~280 vehicles at pn=48) finishes in a few seconds; larger
# rooftops with 1 000+ VINs need headroom for the parallel page fan-out.
# Once the deadline is reached, the probe returns whatever it has collected.
DEALERON_API_PROBE_BUDGET_SECS = 90

# For NEW vehicles, Moses franchise locations are fixed by franchise agreement.
# Used vehicles can appear at any rooftop, so we leave them as the sitemap default.
# All sitemap URLs use "St+Albans" in the path regardless of actual rooftop.
MAKE_TO_LOCATION_NEW: dict[str, str] = {
    # Huntington / Barboursville campus
    'Honda':      'Huntington / Barboursville',
    'Volkswagen': 'Huntington / Barboursville',
    'VW':         'Huntington / Barboursville',
    # Charleston campus
    'GMC':        'Charleston',
    'Cadillac':   'Charleston',
    # St. Albans campus (default for most franchise makes)
    'BMW':        'St. Albans',
    'Ford':       'St. Albans',
    'Lincoln':    'St. Albans',
    'Nissan':     'St. Albans',
    'Lexus':      'St. Albans',
    'Toyota':     'St. Albans',
}

MOSES_SCRAPER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Headers for the free-tool URL scraper — realistic Chrome fingerprint so
# dealership sites don't block the server-side fetch.
FREE_TOOL_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# ── Moses Auto Group canonical dealership group names ─────────────────────────
# These are pre-seeded into every user account so the Settings -> Locations card
# shows up immediately — without requiring a sync first.
# Values are (location_name, enabled_by_default).
MOSES_DEFAULT_LOCATIONS: list[tuple[str, bool]] = [
    ("St. Albans",                 True),   # Ford, Lincoln, BMW, Nissan, Toyota, Supercenter
    ("Charleston",                 True),   # Cadillac, GMC, Pre-Owned
    ("Huntington / Barboursville", True),   # Honda, Volkswagen
    ("Teays Valley / Hurricane",   True),   # Factory Outlet
    ("Morgantown",                 False),  # Toyota, Mitsubishi — opt-in only
]

# Keyword -> canonical group name mapping.
# Each tuple is ([keywords_to_match_in_lowercased_string], canonical_name).
MOSES_LOCATION_KEYWORDS: list[tuple[list[str], str]] = [
    (["st. albans", "st albans", "stalbans", "saint albans", "kanawha city",
      "stalbans ford", "stalbans toyota", "stalbans bmw", "stalbans nissan"],
     "St. Albans"),
    (["charleston", "south charleston"],
     "Charleston"),
    (["huntington", "barboursville", "cabell",
      "moses honda", "moses vw", "moses volkswagen"],
     "Huntington / Barboursville"),
    (["teays valley", "teays", "hurricane", "putnam",
      "factory outlet", "moses outlet"],
     "Teays Valley / Hurricane"),
    (["morgantown", "monongalia", "cheat lake",
      "moses morgantown"],
     "Morgantown"),
]

# Realistic demo inventory seeded when live scraping returns nothing.
# Each vehicle includes a `location` field mapped to one of the five
# Moses Auto Group canonical store groups so that the location filter
# in Settings immediately works against the demo data.
_IMG_F150 = (
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf'
    '?auto=format&fit=crop&w=1200&q=80'
)
_IMG_BRONCO = (
    'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b'
    '?auto=format&fit=crop&w=1200&q=80'
)
_IMG_AUDI = (
    'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6'
    '?auto=format&fit=crop&w=1200&q=80'
)
_IMG_HONDA = (
    'https://images.unsplash.com/photo-1619767886558-efdc259cde1a'
    '?auto=format&fit=crop&w=1200&q=80'
)
_IMG_MUSTANG = (
    'https://images.unsplash.com/photo-1584345604476-8ec5e12e42dd'
    '?auto=format&fit=crop&w=1200&q=80'
)
_IMG_TAHOE = (
    'https://images.unsplash.com/photo-1583121274602-3e2820c69888'
    '?auto=format&fit=crop&w=1200&q=80'
)

MOSES_DEMO_INVENTORY = [
    # ── New vehicles — Moses Honda / Volkswagen (Huntington / Barboursville) ──
    {"vin": "1HGCV1F3XPA056001", "stock_number": "NH1001", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Accord",        "trim": "Sport 2.0T",          "mileage": 5,    "price": 34995, "exterior_color": "Sonic Gray Pearl",         "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "2HGFC2F56PH501123", "stock_number": "NH1002", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Civic",         "trim": "EX Sedan",            "mileage": 3,    "price": 28845, "exterior_color": "Rallye Red",               "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "5FNYF8H59PB001001", "stock_number": "NH1003", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Pilot",         "trim": "TrailSport AWD",      "mileage": 8,    "price": 48750, "exterior_color": "Sonic Gray Pearl",         "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "1HGCR2F35PA112334", "stock_number": "NH1004", "condition": "New",  "year": 2025, "make": "Honda",  "model": "CR-V",          "trim": "EX-L AWD",            "mileage": 10,   "price": 37450, "exterior_color": "Radiant Red Metallic",     "interior_color": "Gray",       "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "19XFL1H72PE100055", "stock_number": "NH1005", "condition": "New",  "year": 2025, "make": "Honda",  "model": "HR-V",          "trim": "Sport AWD",           "mileage": 6,    "price": 29395, "exterior_color": "Aegean Blue Metallic",     "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "7FBEX1H15PE000222", "stock_number": "NH1006", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Prologue",      "trim": "Elite AWD",           "mileage": 15,   "price": 55895, "exterior_color": "Lunar Silver Metallic",    "interior_color": "Ebony",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "2HGFC4B50PH200033", "stock_number": "NH1007", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Civic",         "trim": "Si Sedan",            "mileage": 12,   "price": 31945, "exterior_color": "Championship White",       "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "1HGCV2F39PA450012", "stock_number": "NH1008", "condition": "New",  "year": 2025, "make": "Honda",  "model": "Accord",        "trim": "Touring Hybrid",      "mileage": 4,    "price": 41995, "exterior_color": "Meteoroid Gray Metallic",  "interior_color": "Gray",       "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    # ── Hero sample units requested for local showroom / KPI demos ────────────
    {"vin": "1FTFW1E85PFA12345", "stock_number": "SF1501", "condition": "Used", "year": 2023, "make": "Ford",   "model": "F-150",         "trim": "Lariat 4x4 SuperCrew", "mileage": 28400, "price": 52995, "exterior_color": "Antimatter Blue",         "interior_color": "Black",      "image_url": _IMG_F150,  "location": "St. Albans"},
    {"vin": "WAUF2AFC5PN012345", "stock_number": "SA6001", "condition": "Used", "year": 2023, "make": "Audi",   "model": "A6",            "trim": "Premium Plus Quattro", "mileage": 19200, "price": 48900, "exterior_color": "Mythos Black Metallic",    "interior_color": "Espresso",   "image_url": _IMG_AUDI,  "location": "Charleston"},
    {"vin": "1FMEE5DP5PLA12345", "stock_number": "SB3001", "condition": "New",  "year": 2024, "make": "Ford",   "model": "Bronco",        "trim": "Outer Banks 4-Door",   "mileage": 12,    "price": 51990, "exterior_color": "Area 51",                  "interior_color": "Black Onyx", "image_url": _IMG_BRONCO,"location": "St. Albans"},
    # ── Used vehicles ────────────────────────────────────────────────────────
    {"vin": "1HGCV1F34MA123011", "stock_number": "UH2001", "condition": "Used", "year": 2022, "make": "Honda",  "model": "Accord",        "trim": "EX-L",                "mileage": 34200, "price": 27995, "exterior_color": "Platinum White Pearl",    "interior_color": "Ivory",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "2HGFC2F57MH404344", "stock_number": "UH2002", "condition": "Used", "year": 2022, "make": "Honda",  "model": "Civic",         "trim": "Sport",               "mileage": 29800, "price": 21500, "exterior_color": "Smoky Topaz Metallic",   "interior_color": "Black",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "5FNRL6H76MB050066", "stock_number": "UH2003", "condition": "Used", "year": 2022, "make": "Honda",  "model": "Odyssey",       "trim": "EX-L",                "mileage": 48300, "price": 34900, "exterior_color": "Lunar Silver Metallic",  "interior_color": "Beige",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "1HGCR2F50MA001022", "stock_number": "UH2004", "condition": "Used", "year": 2022, "make": "Honda",  "model": "CR-V",          "trim": "Touring AWD",         "mileage": 41700, "price": 31990, "exterior_color": "Still Night Pearl",      "interior_color": "Ivory",      "image_url": _IMG_HONDA, "location": "Huntington / Barboursville"},
    {"vin": "1FTEW1EP5MKD12346", "stock_number": "UF3001", "condition": "Used", "year": 2021, "make": "Ford",   "model": "F-150",         "trim": "XLT 4x4 SuperCrew",   "mileage": 58400, "price": 38750, "exterior_color": "Carbonized Gray Metallic","interior_color": "Gray",       "image_url": _IMG_F150,  "location": "St. Albans"},
    {"vin": "2T1BURHE0MC999867", "stock_number": "UT3001", "condition": "Used", "year": 2021, "make": "Toyota", "model": "Corolla",       "trim": "LE",                  "mileage": 31200, "price": 19995, "exterior_color": "Blizzard Pearl",         "interior_color": "Ash Gray",   "image_url": "", "location": "St. Albans"},
    {"vin": "1C4RJFBG6MC743201", "stock_number": "UJ3001", "condition": "Used", "year": 2021, "make": "Jeep",   "model": "Grand Cherokee","trim": "Laredo 4x4",          "mileage": 47800, "price": 32500, "exterior_color": "Bright White Clearcoat", "interior_color": "Black",      "image_url": "", "location": "Teays Valley / Hurricane"},
    {"vin": "19UUB2F34MA013466", "stock_number": "UT3002", "condition": "Used", "year": 2022, "make": "Acura",  "model": "TLX",           "trim": "Technology Package",  "mileage": 22100, "price": 37900, "exterior_color": "Majestic Black Pearl",    "interior_color": "Ebony",      "image_url": "", "location": "St. Albans"},
    {"vin": "5GAKVBKD1EJ188012", "stock_number": "UG3001", "condition": "Used", "year": 2020, "make": "GMC",    "model": "Acadia",        "trim": "SLT AWD",             "mileage": 62300, "price": 26995, "exterior_color": "Summit White",            "interior_color": "Jet Black",  "image_url": "", "location": "Charleston"},
]

# Alias used by seed_sample_inventory() — always includes the hero units.
SAMPLE_SEED_INVENTORY = list(MOSES_DEMO_INVENTORY)

# ── Hard-fallback fleet ───────────────────────────────────────────────────────
# The guaranteed backup used by seed_fallback_vehicles() when a live scrape is
# blocked or returns nothing.  Five fully-populated rows so every dashboard
# surface (KPI counts, showroom grid, TikTok scripter, Marketplace feed) has
# real-looking data to render.  VINs follow the 17-character standard alphabet
# (no I/O/Q) and carry correct model-year position-10 codes: P=2023, R=2024,
# N=2022, M=2021.
FALLBACK_SEED_INVENTORY: list[dict] = [
    {
        "vin": "WAUE3AF25PN012345", "stock_number": "FB1001", "condition": "Used",
        "year": 2023, "make": "Audi", "model": "A6", "trim": "Premium Plus 45 TFSI quattro",
        "mileage": 18420, "price": 47985, "retail_price": 51400, "savings": 3415,
        "exterior_color": "Mythos Black Metallic", "interior_color": "Okapi Brown",
        "image_url": _IMG_AUDI, "location": "Charleston",
    },
    {
        "vin": "1FTFW3L58RFA24680", "stock_number": "FB1002", "condition": "New",
        "year": 2024, "make": "Ford", "model": "F-150", "trim": "Lariat 4x4 SuperCrew 3.5L EcoBoost",
        "mileage": 32, "price": 63450, "retail_price": 67290, "savings": 3840,
        "exterior_color": "Agate Black Metallic", "interior_color": "Black Onyx",
        "image_url": _IMG_F150, "location": "St. Albans",
    },
    {
        "vin": "1FMDE5BH8NLA33217", "stock_number": "FB1003", "condition": "Used",
        "year": 2022, "make": "Ford", "model": "Bronco", "trim": "Outer Banks 4-Door 4x4",
        "mileage": 26890, "price": 44975, "retail_price": 47500, "savings": 2525,
        "exterior_color": "Cactus Gray", "interior_color": "Navy Pier",
        "image_url": _IMG_BRONCO, "location": "St. Albans",
    },
    {
        "vin": "1FA6P8CF4P5102938", "stock_number": "FB1004", "condition": "Used",
        "year": 2023, "make": "Ford", "model": "Mustang", "trim": "GT Premium Fastback 5.0L V8",
        "mileage": 11240, "price": 49900, "retail_price": 53250, "savings": 3350,
        "exterior_color": "Race Red", "interior_color": "Ebony",
        "image_url": _IMG_MUSTANG, "location": "Charleston",
    },
    {
        "vin": "1GNSKPKD2MR114725", "stock_number": "FB1005", "condition": "Used",
        "year": 2021, "make": "Chevrolet", "model": "Tahoe", "trim": "LT 4WD",
        "mileage": 54310, "price": 46590, "retail_price": 49900, "savings": 3310,
        "exterior_color": "Satin Steel Metallic", "interior_color": "Jet Black",
        "image_url": _IMG_TAHOE, "location": "Teays Valley / Hurricane",
    },
]

# True when running against the on-disk SQLite preview DB (no DATABASE_URL).
_IS_LOCAL_PREVIEW = not bool(DATABASE_URL)

# ── Local development conveniences ───────────────────────────────────────────
# Both flags are hard-gated on _IS_LOCAL_PREVIEW, so any real deployment — which
# always supplies DATABASE_URL — cannot turn them on even if the env vars leak
# into its environment. Set either to "0" to opt out locally.

# Single-session enforcement is a production anti-account-sharing measure: a new
# login evicts the previous token. Locally that makes every extra browser tab
# fight the others, and the evicted tab gets bounced back to the login screen on
# its next request. Allow concurrent sessions when running on the preview DB.
ALLOW_MULTI_SESSION = (
    _IS_LOCAL_PREVIEW and os.environ.get("ALLOW_MULTI_SESSION", "1") == "1"
)

# Enables POST /api/auth/dev-login, which mints a real session token for
# DEV_LOGIN_USER without a password so the local UI boots straight into the app.
DEV_AUTOLOGIN = (
    _IS_LOCAL_PREVIEW and os.environ.get("DEV_AUTOLOGIN", "1") == "1"
)
DEV_LOGIN_USER = os.environ.get("DEV_LOGIN_USER", "mdemoss").strip().lower()

# AI Integration — any OpenAI-compatible endpoint.
# Point OPENAI_BASE_URL at api.openai.com, a self-hosted gateway, or a proxy.
# The AI_INTEGRATIONS_* names are still honoured for backward compatibility.
AI_BASE_URL = (
    os.environ.get("OPENAI_BASE_URL")
    or os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
    or "https://api.openai.com/v1"
)
AI_API_KEY = (
    os.environ.get("OPENAI_API_KEY")
    or os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")
    or ""
)

# DealerPeak Open API
DEALERPEAK_LEAD_URL = "https://api.dealerpeak.com/crm/v1/leads"
DEALERPEAK_DEALER_URL = "https://api.dealerpeak.com/crm/v1/dealers"

# In-memory session cache: token (str) -> user_id (int)
# Populated from SQLite on startup so tokens survive server restarts.
_ACTIVE_SESSIONS: dict = {}

# Per-user sync job state for the full-crawl progress endpoint.
# user_id -> {phase, synced, total, enriched, done, error, started}
_SYNC_JOBS: dict = {}

# ── Security exploit monitoring ───────────────────────────────────────────────
# Compiled patterns for SQL injection, XSS / script injection, and path traversal.
_SQLI_PATTERNS = re.compile(
    r"('|\b)(OR|AND)\b.{0,20}\b\d+\s*=\s*\d+|"   # ' OR 1=1
    r"\bUNION\b.{0,20}\bSELECT\b|"
    r"\bDROP\s+TABLE\b|\bDROP\s+DATABASE\b|"
    r"\bINSERT\s+INTO\b.{0,30}\bVALUES\b|"
    r";\s*(DROP|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT)\b|"
    r"\bEXEC\s*\(|\bxp_cmdshell\b|"
    r"\bSLEEP\s*\(\s*\d+|\bBENCHMARK\s*\(|"
    r"\bINTO\s+OUTFILE\b|\bLOAD_FILE\s*\(|"
    r"1\s*=\s*1\s*--|\'\s*--|\"\s*--",
    re.IGNORECASE,
)
_XSS_PATTERNS = re.compile(
    r"<\s*script[\s>]|javascript\s*:|"
    r"\bon(error|load|click|mouseover|focus|blur)\s*=|"
    r"<\s*iframe[\s>]|<\s*object[\s>]|<\s*embed[\s>]|"
    r"\beval\s*\(|document\.cookie|document\.write",
    re.IGNORECASE,
)
_PATH_TRAVERSAL_PATTERN = re.compile(
    r"\.\.[/\\]|%2e%2e[%2f%5c]|%252e%252e",
    re.IGNORECASE,
)
# Rate limiting — per-user timestamp buckets for management POST endpoints.
_RATE_LIMITER: dict  = {}   # user_id -> [unix_timestamp, ...]
_LOGIN_FAILS: dict = {}     # ip -> [unix_timestamp, ...]  (auth brute-force guard)
_LOGIN_FAIL_WINDOW = 15 * 60
_LOGIN_FAIL_MAX = 5
_RATE_LIMIT_WINDOW   = 60.0  # seconds per window
_RATE_LIMIT_MAX      = 80    # max management POSTs per window before suspension


def _persist_token(token: str, user_id: int) -> None:
    """Write a session token to the persistent user_sessions table."""
    conn = sqlite3.connect(DB_FILE)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO user_sessions (token, user_id) VALUES (?, ?)",
            (token, user_id),
        )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _revoke_token(token: str) -> None:
    """Remove a session token from the persistent store and the memory cache."""
    _ACTIVE_SESSIONS.pop(token, None)
    conn = sqlite3.connect(DB_FILE)
    try:
        conn.execute("DELETE FROM user_sessions WHERE token = ?", (token,))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _resolve_user_id(token: str) -> int | None:
    """Return the user_id for *token*, checking memory first then the DB.

    On a DB hit the result is written back into _ACTIVE_SESSIONS so the
    next call is instant.  This is the single chokepoint that makes every
    auth check survive server restarts — callers never touch _ACTIVE_SESSIONS
    directly.
    """
    user_id = _ACTIVE_SESSIONS.get(token)
    if user_id:
        return user_id
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT user_id FROM user_sessions WHERE token = ?", (token,))
    row = cursor.fetchone()
    conn.close()
    if row:
        _ACTIVE_SESSIONS[token] = row[0]
        return row[0]
    return None


def _dealer_hosts(*urls: str) -> set:
    """Registrable hosts for the configured dealer URLs (e.g. {'universityfordwv.com'}).

    Used to tell this dealer's vehicles apart from rows left behind by a
    previously configured source.
    """
    hosts = set()
    for raw in urls:
        if not raw:
            continue
        try:
            netloc = urllib.parse.urlparse(raw.strip()).netloc.lower()
        except Exception:
            continue
        netloc = netloc.split('@')[-1].split(':')[0]
        if not netloc:
            continue
        parts = [p for p in netloc.split('.') if p]
        # Keep the last two labels so www./inventory. subdomains still match.
        hosts.add('.'.join(parts[-2:]) if len(parts) >= 2 else netloc)
    return hosts


def _purge_foreign_inventory(user_id: int, hosts: set) -> int:
    """Delete this user's inventory rows that came from a different dealer site.

    Compares each row's vdp_url against *hosts*.  Rows with no vdp_url are left
    alone — their origin can't be established, so deleting them risks discarding
    legitimately scraped vehicles.  Returns the number of rows removed.

    Unlike the scraper's normal pre-sync purge this does NOT spare
    posted_status='posted' rows: a listing carried over from a former dealer
    source is exactly the stale data that needs clearing.
    """
    if not hosts:
        return 0
    removed = 0
    conn = sqlite3.connect(DB_FILE)
    try:
        rows = conn.execute(
            "SELECT id, vdp_url FROM marketplace_inventory "
            "WHERE user_id = ? AND IFNULL(TRIM(vdp_url),'') <> ''",
            (user_id,),
        ).fetchall()
        stale = []
        for row_id, vdp in rows:
            row_host = _dealer_hosts(vdp)
            if row_host and not (row_host & hosts):
                stale.append(row_id)
        if stale:
            conn.executemany(
                "DELETE FROM marketplace_inventory WHERE id = ?",
                [(i,) for i in stale],
            )
            conn.commit()
            removed = len(stale)
    except Exception as exc:
        print(f"[PURGE u{user_id}] Foreign-inventory purge failed: {exc}")
    finally:
        conn.close()
    if removed:
        print(f"[PURGE u{user_id}] Removed {removed} row(s) not matching "
              f"{sorted(hosts)}.")
    return removed


def _local_settings_user_id(token: str = "") -> int | None:
    """Resolve the user whose settings the local Marketplace Hub should edit.

    Prefers the caller's session when one exists so multi-user installs still
    scope correctly.  Without a session (local Hub / public scrape routes),
    prefer a rooftop with configured inventory URLs — University Ford first
    when present — then the most recently synced account, not merely the
    lowest ``users.id`` (which on shared DBs often points at a different
    dealer than the Hub is viewing).
    """
    if token:
        user_id = _resolve_user_id(token)
        if user_id:
            return user_id
    # Prefer the user_id stamped into dealer_config.json when present.
    if _dealer_config is not None:
        try:
            _disk_uid = (_dealer_config.load_dealer_config() or {}).get("user_id")
            if _disk_uid is not None:
                _disk_uid = int(_disk_uid)
                _chk = sqlite3.connect(DB_FILE)
                try:
                    _row = _chk.execute(
                        "SELECT id FROM users WHERE id = ?", (_disk_uid,)
                    ).fetchone()
                finally:
                    _chk.close()
                if _row:
                    return _disk_uid
        except Exception:
            pass
    conn = sqlite3.connect(DB_FILE)
    try:
        row = conn.execute(
            """
            SELECT u.id
              FROM users u
              LEFT JOIN marketplace_inventory mi
                ON mi.user_id = u.id AND mi.status = 'ACTIVE'
             WHERE (u.inventory_url_used IS NOT NULL AND trim(u.inventory_url_used) != '')
                OR (u.inventory_url_new  IS NOT NULL AND trim(u.inventory_url_new)  != '')
                OR (u.inventory_locations IS NOT NULL AND trim(u.inventory_locations) NOT IN ('', '[]'))
             GROUP BY u.id
             ORDER BY
               CASE WHEN lower(coalesce(u.inventory_url_used,'') || ' ' ||
                               coalesce(u.inventory_url_new,'') || ' ' ||
                               coalesce(u.inventory_locations,''))
                         LIKE '%universityford%' THEN 0 ELSE 1 END,
               MAX(mi.last_seen) IS NULL,
               MAX(mi.last_seen) DESC,
               COUNT(mi.id) DESC,
               u.id DESC
             LIMIT 1
            """
        ).fetchone()
        if row:
            return row[0]
        row = conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _load_sessions_from_db() -> None:
    """Repopulate _ACTIVE_SESSIONS from SQLite on server startup.

    Called once in main() after init_db() so all previously issued tokens
    are valid immediately without requiring users to log in again.
    """
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT token, user_id FROM user_sessions")
        rows = cursor.fetchall()
    except sqlite3.OperationalError:
        rows = []  # table not created yet (first boot before init_db runs)
    conn.close()
    for token, user_id in rows:
        _ACTIVE_SESSIONS[token] = user_id
    if rows:
        print(f"[AUTH] Restored {len(rows)} session(s) from database.")


def _log_security_event(
    user_id: int,
    username: str,
    ip: str,
    path: str,
    violation_type: str,
    snippet: str,
) -> None:
    """Write a security audit record to the database and print to stderr."""
    try:
        _ac = sqlite3.connect(DB_FILE)
        _ac.execute(
            "INSERT INTO security_audit_log "
            "(user_id, username, ip_address, request_path, violation_type, payload_snippet) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, username, ip[:64], path[:512], violation_type[:64], snippet[:512]),
        )
        _ac.commit()
        _ac.close()
    except Exception as _ae:
        print(f"[SECURITY] Audit log write failed: {_ae}")
    print(
        f"[SECURITY] VIOLATION uid={user_id} user={username!r} ip={ip} "
        f"type={violation_type} path={path[:80]!r}"
    )


RAW_CSV_INVENTORY = """StockNo,Year,Make,Model,Trim,Price,Status,BodyStyle,Category
P1234,2022,Ford,F-150,XLT 4WD,$38500,AVAILABLE,Truck,Truck
P5678,2021,Ford,Mustang,GT Premium,$31000,AVAILABLE,Coupe,Sports
P9012,2020,Audi,A4,2.0T Premium Plus,$27900,SOLD,Sedan,Luxury
P3456,2023,Chevrolet,Tahoe,RST 4WD,$58900,AVAILABLE,SUV,Fullsize SUV
P7890,2022,GMC,Yukon,SLT 4WD,$54500,AVAILABLE,SUV,Fullsize SUV
P2468,2021,BMW,330i,xDrive,$29500,AVAILABLE,Sedan,Luxury
P1357,2022,Honda,Accord,Sport 1.5T,$26200,AVAILABLE,Sedan,Midsize
"""

TRADE_MARKET_DATABASE = {
    ("2018", "honda", "civic"): {"base_wholesale": 14500},
    ("2020", "toyota", "rav4"): {"base_wholesale": 21000},
    ("2019", "ford", "f-150"): {"base_wholesale": 26500},
}


# =====================================================================
# MULTI-CRM CLIENT  (VinSolutions via Cox OAuth  |  DealerPeak Open API)
# =====================================================================
def _get_cox_oauth_token(client_id: str = "", client_secret: str = "") -> str | None:
    """Fetch a Cox OAuth 2.0 bearer token using stdlib urllib.

    Accepts explicit per-user credentials; falls back to global env-var creds.
    """
    cid = client_id or COX_CLIENT_ID
    csecret = client_secret or COX_CLIENT_SECRET
    if not cid:
        return None

    # Cox Automotive follows RFC 6749 §2.3.1: client credentials must be
    # sent as HTTP Basic auth, NOT as body parameters.
    basic_token = base64.b64encode(f"{cid}:{csecret}".encode("utf-8")).decode("utf-8")

    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
    }).encode("utf-8")

    req = urllib.request.Request(
        COX_TOKEN_URL,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {basic_token}",
        },
    )
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            return res_data.get("access_token")
    except Exception as err:
        print(f"WARNING Cox OAuth Error: {err}")
        return None


# =====================================================================
# AI EMAIL HELPERS
# =====================================================================
def _call_openai_chat(messages: list[dict], model: str = "gpt-5-nano") -> str | None:
    """POST to the configured OpenAI-compatible endpoint using stdlib urllib.

    Returns the first choice content string, or None on any error.
    """
    if not AI_BASE_URL or not AI_API_KEY:
        return None
    payload = json.dumps({
        "model": model,
        "max_completion_tokens": 512,
        "messages": messages,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{AI_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {AI_API_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
    except Exception as err:
        print(f"WARNING AI Chat Error: {err}")
        return None


# =====================================================================
# TIKTOK INTEGRATION
# =====================================================================
TIKTOK_CLIENT_KEY    = os.environ.get("TIKTOK_CLIENT_KEY",    "")
TIKTOK_CLIENT_SECRET = os.environ.get("TIKTOK_CLIENT_SECRET", "")
TIKTOK_AUTH_URL      = "https://www.tiktok.com/v2/auth/authorize/"

# ---------------------------------------------------------------------------
# _tiktok_creds() — runtime credential resolver
# ---------------------------------------------------------------------------
# All TikTok route handlers MUST call this instead of reading the module-level
# globals directly.  Priority:
#   1. system_settings table (set via Admin Console) — no restart required.
#   2. TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET env vars (startup fallback).
#
# Because the DB is queried on every call the credentials take effect the
# instant the Admin Console writes them, for every active user session and
# every new OAuth flow — without touching the server process.
# ---------------------------------------------------------------------------
def _tiktok_creds() -> tuple[str, str]:
    """Return (client_key, client_secret) resolved from DB then env vars."""
    try:
        _c = sqlite3.connect(DB_FILE)
        _c.row_factory = sqlite3.Row
        rows = _c.execute(
            "SELECT key, value FROM system_settings "
            "WHERE key IN ('tiktok_client_key', 'tiktok_client_secret')"
        ).fetchall()
        _c.close()
        db_map = {r['key']: r['value'] for r in rows}
        ck = db_map.get('tiktok_client_key',    '').strip() or TIKTOK_CLIENT_KEY
        cs = db_map.get('tiktok_client_secret', '').strip() or TIKTOK_CLIENT_SECRET
        return ck, cs
    except Exception:
        return TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
TIKTOK_TOKEN_URL     = "https://open.tiktokapis.com/v2/oauth/token/"
TIKTOK_API_BASE      = "https://open.tiktokapis.com"

# ── Stateless, HMAC-signed TikTok OAuth state tokens ─────────────────────────
# No in-memory dict means state survives server restarts and works across
# every tenant simultaneously. Each token encodes the user_id + timestamp
# and is signed with TIKTOK_CLIENT_SECRET (falling back to SESSION_SECRET).
# Tokens expire after 10 minutes — long enough for any human OAuth flow.

def _tiktok_state_key() -> bytes:
    """Return the signing key for TikTok state tokens.

    Uses _tiktok_creds() so the HMAC key stays consistent whether the secret
    comes from the Admin Console database or an environment variable.
    """
    _, cs = _tiktok_creds()
    key = (
        cs
        or os.environ.get("SESSION_SECRET", "")
        or "bdc-tiktok-state-fallback"
    )
    return key.encode("utf-8")

def _tiktok_make_state(user_id: int) -> str:
    """Generate a tamper-proof, short-lived state token embedding user_id."""
    ts      = int(time.time())
    payload = f"{user_id}.{ts}"
    sig     = _hmac_mod.new(_tiktok_state_key(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    raw     = f"{payload}|{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")

def _tiktok_verify_state(state: str) -> int | None:
    """Return user_id from a valid state token, or None if invalid/expired."""
    try:
        padded = state + "=" * (-len(state) % 4)
        raw    = base64.urlsafe_b64decode(padded).decode("utf-8")
        payload, sig = raw.split("|", 1)
        uid_str, ts_str = payload.split(".", 1)
        user_id, ts = int(uid_str), int(ts_str)
        if int(time.time()) - ts > 600:          # 10-minute window
            return None
        expected = _hmac_mod.new(_tiktok_state_key(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not _hmac_mod.compare_digest(sig, expected):
            return None
        return user_id
    except Exception:
        return None

def _tiktok_base_url(host_header: str) -> str:
    """Return the application base URL for building TikTok redirect URIs.

    Prefers the APP_BASE_URL env var (production domain).  Falls back to the
    HTTP Host header so the OAuth flow also works behind a dev proxy.
    """
    if APP_BASE_URL:
        return APP_BASE_URL
    host = (host_header or "localhost").split(",")[0].strip()
    # Loopback hosts are plain HTTP; anything with a real domain is served
    # over TLS in every environment we deploy to.
    bare_host = host.split(":")[0].lower()
    is_local = bare_host in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]")
    scheme = "http" if is_local else "https"
    return f"{scheme}://{host}"

_TIKTOK_TRIAL_DAYS  = 5
_TIKTOK_DAILY_LIMIT = 3

# How many hours a tiktok_posts row may remain in PROCESSING status before it
# is automatically aged out to FAILED.  TikTok never sends a terminal callback
# for silently-dropped publish jobs, so without this timeout the row stays
# PROCESSING forever and clutters the hub UI.
# Raise or lower this to taste; 24 hours is conservative enough to let a slow
# but successful publish finish while still cleaning up genuine dead jobs.
TIKTOK_PROCESSING_TIMEOUT_HOURS = 24


class TikTokTokenExpiredError(Exception):
    """Raised when the TikTok access token has expired and cannot be refreshed."""


class TikTokRefreshExpiredError(TikTokTokenExpiredError):
    """Raised when the TikTok *refresh* token itself has expired; full re-authorisation required."""


class TikTokTokenManager:
    """Manages TikTok access-token lifecycle — refresh before expiry, revoke on failure."""

    # How many seconds before expiry to proactively refresh (5 minutes).
    _REFRESH_BUFFER_SECS = 5 * 60

    @staticmethod
    def refresh_if_needed(user_id: int, force: bool = False) -> tuple[str, bool]:
        """Return (access_token, was_refreshed) for *user_id*, refreshing if necessary.

        Algorithm:
          1. Read current token + refresh_token + expires_at from DB.
          2. If no access token -> raise TikTokTokenExpiredError (not connected).
          3. If *force* is True, or expires_at is missing, or the token expires within
             REFRESH_BUFFER_SECS:
               a. Call TikTok's OAuth refresh endpoint with the stored refresh_token.
               b. On success -> atomically write the new access_token, refresh_token,
                  and expires_at to the DB and return (new_access_token, True).
               c. On failure -> NULL-out both tokens in the DB (forces re-connect) and
                  raise TikTokTokenExpiredError.
          4. Otherwise return (current_access_token, False) unchanged.

        Args:
            user_id: ID of the user whose token to manage.
            force:   When True, always execute the refresh regardless of expiry time.
                     Used by the background token-refresh daemon.

        Raises:
            TikTokTokenExpiredError – token is expired and could not be refreshed.
        """
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT tiktok_access_token, tiktok_refresh_token, tiktok_token_expires_at "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        conn.close()

        if not row or not row["tiktok_access_token"]:
            raise TikTokTokenExpiredError("TikTok account not connected.")

        access_token   = row["tiktok_access_token"]
        refresh_token  = row["tiktok_refresh_token"] or ""
        expires_at_str = row["tiktok_token_expires_at"] or ""

        # Determine whether a refresh is needed.
        needs_refresh = force  # daemon passes force=True to bypass the buffer window
        if not needs_refresh:
            if not expires_at_str:
                needs_refresh = True  # no expiry stored -> refresh defensively
            else:
                try:
                    expires_dt    = datetime.fromisoformat(expires_at_str)
                    secs_remaining = (expires_dt - datetime.utcnow()).total_seconds()
                    if secs_remaining < TikTokTokenManager._REFRESH_BUFFER_SECS:
                        needs_refresh = True
                except (ValueError, TypeError):
                    needs_refresh = True

        if not needs_refresh:
            return access_token, False

        # ── Attempt refresh ──────────────────────────────────────────────
        if not refresh_token:
            TikTokTokenManager._revoke_stored_tokens(user_id)
            raise TikTokRefreshExpiredError(
                "TikTok authorization has fully expired. "
                "Please reconnect your TikTok account to continue posting."
            )

        _ck_r, _cs_r = _tiktok_creds()
        _payload = urllib.parse.urlencode({
            "client_key":    _ck_r,
            "client_secret": _cs_r,
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
        }).encode("utf-8")
        _req = urllib.request.Request(
            TIKTOK_TOKEN_URL,
            data=_payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(_req, timeout=15) as _resp:
                _data = json.loads(_resp.read().decode("utf-8"))
        except Exception as _err:
            print(f"[TikTok] Token refresh HTTP error for user_id={user_id}: {_err}")
            TikTokTokenManager._revoke_stored_tokens(user_id)
            raise TikTokTokenExpiredError(
                "TikTok token refresh failed. Please reconnect your TikTok account."
            ) from _err

        _new_access  = _data.get("access_token", "")
        _new_refresh = _data.get("refresh_token", refresh_token)  # keep old if not rotated
        _exp_in      = int(_data.get("expires_in", 86400))
        _new_exp_at  = (datetime.utcnow() + timedelta(seconds=_exp_in)).isoformat()

        if not _new_access:
            print(f"[TikTok] Token refresh returned no access_token for user_id={user_id}: {_data}")
            TikTokTokenManager._revoke_stored_tokens(user_id)
            # TikTok returns an error body (e.g. "error": "invalid_grant") when the
            # refresh token itself is expired — treat any non-access-token response as
            # a fully-expired authorization that requires re-connecting.
            _tt_err = _data.get("error", "")
            if _tt_err in ("invalid_grant", "refresh_token_expired", "token_expired") or _tt_err:
                raise TikTokRefreshExpiredError(
                    "Your TikTok authorization has fully expired. "
                    "Please reconnect your TikTok account to continue posting."
                )
            raise TikTokRefreshExpiredError(
                "TikTok returned an invalid response during token refresh. "
                "Please reconnect your TikTok account."
            )

        # Atomically persist the new tokens.
        _wconn = sqlite3.connect(DB_FILE)
        try:
            _wconn.execute(
                "UPDATE users SET tiktok_access_token=?, tiktok_refresh_token=?, "
                "tiktok_token_expires_at=? WHERE id=?",
                (_new_access, _new_refresh, _new_exp_at, user_id),
            )
            _wconn.commit()
        except Exception:
            try:
                _wconn.rollback()
            except Exception:
                pass
            raise
        finally:
            _wconn.close()
        print(f"[TikTok] Token refreshed successfully for user_id={user_id}, expires={_new_exp_at}")
        return _new_access, True

    @staticmethod
    def _revoke_stored_tokens(user_id: int) -> None:
        """NULL-out the stored tokens so the user is prompted to reconnect."""
        _rc = sqlite3.connect(DB_FILE)
        try:
            _rc.execute(
                "UPDATE users SET tiktok_access_token=NULL, tiktok_refresh_token=NULL, "
                "tiktok_token_expires_at=NULL WHERE id=?",
                (user_id,),
            )
            _rc.commit()
        except Exception:
            try:
                _rc.rollback()
            except Exception:
                pass
            raise
        finally:
            _rc.close()


def _get_tiktok_trial_status(user: dict) -> dict:
    """Return TikTok trial eligibility for a user dict (as returned by get_user_by_token).

    Result keys:
      is_pro          — True for admin / active-subscription users (unlimited posting)
      allowed         — True when posting is permitted right now
      trial_day       — current day in the trial window (1–5); 0 if trial not yet started
      days_remaining  — calendar days left including today (0–5)
      posts_today     — posts already made in today's UTC day
      daily_limit     — 3 for trial; None for Pro
      trial_expired   — True when elapsed days ≥ TRIAL_DAYS
      daily_limit_hit — True when posts_today ≥ DAILY_LIMIT
    """
    is_pro = bool(user.get("is_admin")) or user.get("subscription_status") == "active"
    if is_pro:
        return {
            "is_pro": True, "allowed": True, "trial_day": 0,
            "days_remaining": 0, "posts_today": 0,
            "daily_limit": None, "trial_expired": False, "daily_limit_hit": False,
        }

    today_str = datetime.utcnow().strftime("%Y-%m-%d")

    try:
        daily_map = json.loads(user.get("tiktok_daily_posts") or "{}")
    except (json.JSONDecodeError, TypeError):
        daily_map = {}
    posts_today = int(daily_map.get(today_str, 0))

    trial_start_str = user.get("tiktok_trial_start_date") or ""
    if not trial_start_str:
        daily_limit_hit = posts_today >= _TIKTOK_DAILY_LIMIT
        return {
            "is_pro": False, "allowed": not daily_limit_hit,
            "trial_day": 0, "days_remaining": _TIKTOK_TRIAL_DAYS,
            "posts_today": posts_today, "daily_limit": _TIKTOK_DAILY_LIMIT,
            "trial_expired": False, "daily_limit_hit": daily_limit_hit,
        }

    try:
        trial_start    = datetime.strptime(trial_start_str[:10], "%Y-%m-%d")
        today_dt       = datetime.strptime(today_str, "%Y-%m-%d")
        elapsed        = (today_dt - trial_start).days   # 0 on the first day
        trial_day      = elapsed + 1
        days_remaining = max(0, _TIKTOK_TRIAL_DAYS - elapsed)
        trial_expired  = elapsed >= _TIKTOK_TRIAL_DAYS
    except (ValueError, TypeError):
        trial_day = 1; days_remaining = _TIKTOK_TRIAL_DAYS; trial_expired = False

    daily_limit_hit = posts_today >= _TIKTOK_DAILY_LIMIT
    allowed = not trial_expired and not daily_limit_hit
    return {
        "is_pro": False, "allowed": allowed, "trial_day": trial_day,
        "days_remaining": days_remaining, "posts_today": posts_today,
        "daily_limit": _TIKTOK_DAILY_LIMIT, "trial_expired": trial_expired,
        "daily_limit_hit": daily_limit_hit,
    }


def _increment_tiktok_daily_post(user_id: int) -> None:
    """Set tiktok_trial_start_date on first post and increment today's UTC count."""
    today_str = datetime.utcnow().strftime("%Y-%m-%d")
    _ic = sqlite3.connect(DB_FILE)
    _ic.row_factory = sqlite3.Row
    try:
        row = _ic.execute(
            "SELECT tiktok_trial_start_date, tiktok_daily_posts FROM users WHERE id=?",
            (user_id,),
        ).fetchone()
        if not row:
            return
        trial_start = row["tiktok_trial_start_date"] or today_str
        try:
            daily_map = json.loads(row["tiktok_daily_posts"] or "{}")
        except (json.JSONDecodeError, TypeError):
            daily_map = {}
        daily_map[today_str] = daily_map.get(today_str, 0) + 1
        # Prune entries older than 8 days to prevent unbounded JSON growth
        cutoff = (datetime.utcnow() - timedelta(days=8)).strftime("%Y-%m-%d")
        daily_map = {k: v for k, v in daily_map.items() if k >= cutoff}
        _ic.execute(
            "UPDATE users SET tiktok_trial_start_date=?, tiktok_daily_posts=? WHERE id=?",
            (trial_start, json.dumps(daily_map), user_id),
        )
        _ic.commit()
    except Exception:
        try:
            _ic.rollback()
        except Exception:
            pass
        raise
    finally:
        _ic.close()


def generate_reengagement_email(phone_number: str, customer_name: str) -> dict:
    """Fetch customer history then call the AI to write a personalised
    re-engagement email.  Always returns a dict with keys
    ``subject``, ``body``, and ``summary`` (never None).
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT role, text FROM messages WHERE phone_number = ? "
        "ORDER BY timestamp DESC LIMIT 12",
        (phone_number,),
    )
    msgs = list(reversed(cursor.fetchall()))
    cursor.execute(
        "SELECT active_stock_no, trade_vehicle FROM sessions WHERE phone_number = ?",
        (phone_number,),
    )
    sess = cursor.fetchone()
    conn.close()

    first_name = (customer_name.split()[0] if customer_name else "there") or "there"

    # Build readable conversation history
    history_lines = []
    for m in msgs:
        label = "Customer" if m["role"] == "customer" else "BDC"
        history_lines.append(f"{label}: {m['text']}")
    history = "\n".join(history_lines) if history_lines else "No prior conversation on record."

    # Vehicle context
    ctx_parts: list[str] = []
    if sess:
        stock = sess["active_stock_no"] or ""
        trade = sess["trade_vehicle"] or ""
        if stock:
            car = next((c for c in LIVE_INVENTORY if c["stock_no"] == stock), None)
            if car:
                ctx_parts.append(
                    f"They were previously interested in a "
                    f"{car['year']} {car['make']} {car['model']} (Stock #{stock})."
                )
        if trade:
            ctx_parts.append(f"They have a trade-in vehicle: {trade}.")
    vehicle_context = " ".join(ctx_parts)

    system_prompt = (
        "You are a professional automotive BDC (Business Development Center) manager. "
        "Write a warm, concise re-engagement email to a customer you have not spoken to in 60–90 days. "
        "Requirements: (1) Reference their last conversation naturally; "
        "(2) Ask how their current vehicle is treating them; "
        "(3) Mention fresh inventory and invite them to explore upgrades or other vehicle types; "
        "(4) Close with a soft, friendly call-to-action. "
        "Keep it under 150 words. Do NOT use generic filler phrases. "
        "Return ONLY a JSON object with exactly two keys: 'subject' and 'body'. "
        "No markdown, no code fences, no extra keys."
    )
    user_prompt = (
        f"Customer name: {customer_name}\n"
        f"{vehicle_context}\n\n"
        f"Previous conversation:\n{history}\n\n"
        "Write the re-engagement email now."
    )

    raw = _call_openai_chat(
        [{"role": "system", "content": system_prompt},
         {"role": "user",   "content": user_prompt}],
        model="gpt-5-nano",
    )

    subject = f"Checking in, {first_name}!"
    body = (
        f"Hi {first_name},\n\n"
        "Hope you're doing great! It's been a little while and I wanted to touch base. "
        "How is your current vehicle treating you?\n\n"
        "We've just received some exciting new inventory — from fresh SUVs to "
        "fuel-efficient sedans — and I'd love to show you a few options that might "
        "be a perfect fit, whether you're looking to upgrade, switch things up, or "
        "just explore what's new.\n\n"
        "Would you be open to stopping by or jumping on a quick call this week?\n\n"
        "Looking forward to hearing from you!"
    )
    if raw:
        try:
            parsed = json.loads(raw)
            subject = parsed.get("subject", subject)
            body    = parsed.get("body", body)
        except (json.JSONDecodeError, AttributeError):
            # AI returned free text instead of JSON — use it as the body
            body = raw

    # One-line summary from the most recent exchange
    if history_lines:
        last = history_lines[-1]
        summary = last[:120] + ("…" if len(last) > 120 else "")
    else:
        summary = "No prior conversation on record."

    return {"subject": subject, "body": body, "summary": summary}


class CRMClient:
    """Routes lead syncs and connection tests to VinSolutions or DealerPeak
    based on the ``crm_provider`` key in the supplied credentials dict.

    Expected crm_creds keys
    -----------------------
    crm_provider        : "vinsolutions" (default) | "dealerpeak"

    VinSolutions / Cox  : cox_client_id, cox_client_secret, cox_dealer_id
    DealerPeak          : dealerpeak_api_key, dealerpeak_dealer_id
    """

    # ── Public interface ─────────────────────────────────────────────

    @staticmethod
    def push_lead(
        session_data: dict,
        note: str = "",
        crm_creds: dict | None = None,
    ) -> None:
        """Push a lead/appointment/trade event to the configured CRM."""
        creds = crm_creds or {}
        provider = creds.get("crm_provider", "vinsolutions").lower()
        if provider == "dealerpeak":
            CRMClient._push_dealerpeak(session_data, note, creds)
        else:
            CRMClient._push_vinsolutions(session_data, note, creds)

    @staticmethod
    def test_connection(crm_creds: dict) -> tuple[bool, str, bool]:
        """Validate credentials against the live CRM API.

        Returns (success: bool, message: str, is_simulated: bool).
        """
        provider = crm_creds.get("crm_provider", "vinsolutions").lower()
        if provider == "dealerpeak":
            ok, msg = CRMClient._test_dealerpeak(crm_creds)
            return ok, msg, False
        return CRMClient._test_vinsolutions(crm_creds)

    # ── VinSolutions (Cox Automotive OAuth) ─────────────────────────

    @staticmethod
    def _push_vinsolutions(session_data: dict, note: str, creds: dict) -> None:
        token = _get_cox_oauth_token(
            client_id=creds.get("cox_client_id", ""),
            client_secret=creds.get("cox_client_secret", ""),
        )
        if not token:
            name = f"{session_data.get('first_name', 'Lead')} {session_data.get('last_name', '')}".strip()
            print(f"INFO VinSolutions SIMULATED push — '{name}' saved locally only (no live credentials).")
            return

        dealer_id = creds.get("cox_dealer_id", "") or COX_DEALER_ID
        payload = {
            "dealerId": dealer_id,
            "customer": {
                "firstName": session_data.get("first_name", "Valued"),
                "lastName": session_data.get("last_name", "Customer"),
                "phones": [
                    {"number": session_data.get("phone_number"), "type": "MOBILE"}
                ],
            },
            "vehicleOfInterest": {
                "stockNumber": session_data.get("active_stock_no", "")
            },
            "tradeIn": {"description": session_data.get("trade_vehicle", "")},
            "notes": note,
        }
        req = urllib.request.Request(
            COX_LEAD_API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                print(f"SUCCESS VinSolutions CRM Synced. HTTP {resp.status}")
        except Exception as err:
            print(f"ERROR VinSolutions API Push: {err}")

    @staticmethod
    def _test_vinsolutions(creds: dict) -> tuple[bool, str, bool]:
        """Returns (ok, message, is_simulated).

        VinSolutions always runs in Mock / Sandbox Mode — no external
        HTTP request is made to the Cox Automotive OAuth endpoint.
        Live credentials are stored for future use but are not validated
        against the real API during development.
        """
        return (
            True,
            "VinSolutions connected successfully (Simulation Mode). "
            "No live request was made to Cox Automotive — "
            "leads are stored locally and CRM pushes are logged only.",
            True,
        )

    # ── DealerPeak Open API ──────────────────────────────────────────

    @staticmethod
    def _push_dealerpeak(session_data: dict, note: str, creds: dict) -> None:
        api_key = creds.get("dealerpeak_api_key", "")
        dealer_id = creds.get("dealerpeak_dealer_id", "")
        if not api_key:
            print("INFO DealerPeak credentials not configured — saved locally only.")
            return

        payload = {
            "dealerId": dealer_id,
            "customer": {
                "firstName": session_data.get("first_name", "Valued"),
                "lastName": session_data.get("last_name", "Customer"),
                "phone": session_data.get("phone_number"),
            },
            "vehicleOfInterest": {
                "stockNumber": session_data.get("active_stock_no", "")
            },
            "tradeIn": {"description": session_data.get("trade_vehicle", "")},
            "notes": note,
        }
        req = urllib.request.Request(
            DEALERPEAK_LEAD_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                print(f"SUCCESS DealerPeak CRM Synced. HTTP {resp.status}")
        except Exception as err:
            print(f"ERROR DealerPeak API Push: {err}")

    @staticmethod
    def _test_dealerpeak(creds: dict) -> tuple[bool, str]:
        api_key = creds.get("dealerpeak_api_key", "")
        dealer_id = creds.get("dealerpeak_dealer_id", "")
        if not api_key or not dealer_id:
            return False, "DealerPeak API Key and Dealer ID are both required."
        url = f"{DEALERPEAK_DEALER_URL}/{urllib.parse.quote(dealer_id, safe='')}"
        req = urllib.request.Request(
            url,
            headers={"X-API-Key": api_key, "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return True, f"DealerPeak credentials valid — dealer record confirmed (HTTP {resp.status})."
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                return False, f"DealerPeak API key rejected (HTTP {err.code}). Check your API Key."
            if err.code == 404:
                return False, f"DealerPeak Dealer ID '{dealer_id}' not found (HTTP 404)."
            return False, f"DealerPeak API returned HTTP {err.code}."
        except Exception as err:
            return False, f"DealerPeak connection failed: {err}"


# =====================================================================
# DATABASE MANAGEMENT
# =====================================================================
def init_db():
    """Initialize SQLite database tables if they do not exist."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                phone_number TEXT PRIMARY KEY,
                first_name TEXT,
                last_name TEXT,
                source TEXT,
                active_stock_no TEXT,
                trade_vehicle TEXT,
                status TEXT DEFAULT 'ACTIVE',
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT,
                role TEXT,
                text TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(phone_number) REFERENCES sessions(phone_number)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT,
                appt_type TEXT,
                time_slot TEXT,
                status TEXT DEFAULT 'CONFIRMED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(phone_number) REFERENCES sessions(phone_number)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS email_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                phone_number TEXT NOT NULL,
                customer_name TEXT DEFAULT '',
                last_conversation_summary TEXT DEFAULT '',
                email_subject TEXT DEFAULT '',
                email_body TEXT DEFAULT '',
                status TEXT DEFAULT 'pending_review',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                cox_client_id TEXT DEFAULT '',
                cox_client_secret TEXT DEFAULT '',
                cox_dealer_id TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS user_sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """
        )

        # ── Multi-tenant schema guard ──────────────────────────────────────
        # If any marketplace table is missing the user_id column, add it via
        # ALTER TABLE so existing rows are preserved. Dropping the table is
        # never permitted during a schema migration — data must survive.
        for _tbl in ('marketplace_inventory', 'posting_queue', 'posting_cycle'):
            cursor.execute(f"PRAGMA table_info({_tbl})")
            _cols = [r[1] for r in cursor.fetchall()]
            if _cols and 'user_id' not in _cols:
                try:
                    cursor.execute(
                        f"ALTER TABLE {_tbl} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0"
                    )
                    print(f"[INIT] Migrated {_tbl} -> multi-tenant schema (user_id column added).")
                except sqlite3.OperationalError:
                    pass  # column already present — nothing to do

        # ── Single-session enforcement column ─────────────────────────────────
        # active_session_id tracks which token is the *current* login for each
        # user — a new login overwrites it, instantly displacing anyone who was
        # already signed in with an older token.
        try:
            cursor.execute(
                "ALTER TABLE users ADD COLUMN active_session_id TEXT DEFAULT ''"
            )
            print("[INIT] Migrated users -> single-session enforcement "
                  "(active_session_id column added).")
        except Exception:
            pass  # column already present — nothing to do

        conn.commit()

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS marketplace_inventory (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL DEFAULT 0,
                vin            TEXT NOT NULL,
                stock_number   TEXT DEFAULT '',
                condition      TEXT DEFAULT 'Used',
                year           INTEGER DEFAULT 0,
                make           TEXT DEFAULT '',
                model          TEXT DEFAULT '',
                trim           TEXT DEFAULT '',
                mileage        INTEGER DEFAULT 0,
                price          INTEGER DEFAULT 0,
                exterior_color TEXT DEFAULT '',
                interior_color TEXT DEFAULT '',
                image_url      TEXT DEFAULT '',
                status         TEXT DEFAULT 'ACTIVE',
                last_seen      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, vin)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS posting_queue (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL DEFAULT 0,
                queue_date     TEXT NOT NULL,
                vin            TEXT NOT NULL,
                stock_number   TEXT DEFAULT '',
                year           INTEGER DEFAULT 0,
                make           TEXT DEFAULT '',
                model          TEXT DEFAULT '',
                trim           TEXT DEFAULT '',
                scheduled_time TEXT NOT NULL,
                status         TEXT DEFAULT 'Pending',
                posted_at      TIMESTAMP,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, queue_date, vin)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS posting_cycle (
                user_id     INTEGER NOT NULL DEFAULT 0,
                vin         TEXT NOT NULL,
                posted_date TEXT NOT NULL,
                PRIMARY KEY (user_id, vin)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS customers (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id           INTEGER NOT NULL,
                name              TEXT    DEFAULT '',
                email             TEXT    DEFAULT '',
                address_line1     TEXT    DEFAULT '',
                address_line2     TEXT    DEFAULT '',
                city              TEXT    DEFAULT '',
                state             TEXT    DEFAULT '',
                zip               TEXT    DEFAULT '',
                vehicle_purchased TEXT    DEFAULT '',
                notes             TEXT    DEFAULT '',
                created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS user_locations (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER NOT NULL,
                location      TEXT NOT NULL,
                enabled       INTEGER NOT NULL DEFAULT 1,
                discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, location),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS wishlist (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER NOT NULL,
                customer_name TEXT    DEFAULT '',
                phone         TEXT    DEFAULT '',
                city          TEXT    DEFAULT '',
                state         TEXT    DEFAULT '',
                condition     TEXT    DEFAULT 'Any',
                make          TEXT    DEFAULT '',
                model         TEXT    DEFAULT '',
                keyword       TEXT    DEFAULT '',
                year_min      INTEGER DEFAULT 0,
                year_max      INTEGER DEFAULT 0,
                max_mileage   INTEGER DEFAULT 0,
                max_budget    INTEGER DEFAULT 0,
                notes         TEXT    DEFAULT '',
                status        TEXT    DEFAULT 'Active',
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS organizations (
                id                        INTEGER PRIMARY KEY AUTOINCREMENT,
                name                      TEXT    NOT NULL DEFAULT '',
                owner_user_id             INTEGER NOT NULL,
                seat_limit                INTEGER NOT NULL DEFAULT 10,
                subscription_status       TEXT    NOT NULL DEFAULT 'inactive',
                subscription_tier         TEXT    NOT NULL DEFAULT '',
                stripe_customer_id        TEXT             DEFAULT '',
                stripe_subscription_id    TEXT             DEFAULT '',
                subscription_period_end   TEXT             DEFAULT '',
                subscription_cancel_scheduled INTEGER NOT NULL DEFAULT 0,
                created_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(owner_user_id) REFERENCES users(id)
            )
        """
        )

        # Schema migrations — safe to re-run; silently skip if column already exists
        _migrations = [
            "ALTER TABLE users    ADD COLUMN salesperson_id      TEXT DEFAULT ''",
            "ALTER TABLE sessions ADD COLUMN assigned_salesperson_id TEXT DEFAULT NULL",
            "ALTER TABLE messages ADD COLUMN sent_by_user_id     INTEGER DEFAULT NULL",
            # CRM provider routing
            "ALTER TABLE users    ADD COLUMN crm_provider        TEXT DEFAULT 'vinsolutions'",
            "ALTER TABLE users    ADD COLUMN dealerpeak_api_key  TEXT DEFAULT ''",
            "ALTER TABLE users    ADD COLUMN dealerpeak_dealer_id TEXT DEFAULT ''",
            # Email re-engagement system
            "ALTER TABLE sessions ADD COLUMN email TEXT DEFAULT ''",
            "ALTER TABLE sessions ADD COLUMN opt_out INTEGER DEFAULT 0",
            "ALTER TABLE users    ADD COLUMN auto_send_emails INTEGER DEFAULT 0",
            # Multi-tenant marketplace / catalog fields
            "ALTER TABLE users    ADD COLUMN inventory_url_used TEXT DEFAULT ''",
            "ALTER TABLE users    ADD COLUMN inventory_url_new  TEXT DEFAULT ''",
            "ALTER TABLE users    ADD COLUMN salesperson_filter TEXT DEFAULT ''",
            "ALTER TABLE users    ADD COLUMN catalog_token      TEXT DEFAULT ''",
            # Location column on inventory rows
            "ALTER TABLE marketplace_inventory ADD COLUMN location TEXT DEFAULT ''",
            # Dealership group / multi-rooftop network name (e.g. University Ford)
            "ALTER TABLE marketplace_inventory ADD COLUMN dealership_group TEXT DEFAULT ''",
            # Multi-location scraper source configs (JSON array of
            # {location_name, inventory_url_new, inventory_url_used})
            "ALTER TABLE users ADD COLUMN inventory_locations TEXT DEFAULT '[]'",
            # Manual posting status — 'not_posted' | 'queued' | 'posted'
            # Never overwritten by scrape syncs; only changed via the posting API.
            "ALTER TABLE marketplace_inventory ADD COLUMN posted_status TEXT DEFAULT 'not_posted'",
            # Stripe billing & admin flag
            "ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'inactive'",
            "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
            # VDP source URL — stored so condition can be re-derived from the URL
            # without re-fetching the sitemap on every startup.
            "ALTER TABLE marketplace_inventory ADD COLUMN vdp_url TEXT DEFAULT ''",
            # Account email — required for password recovery
            "ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''",
            # Account recovery phone
            "ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''",
            # Dealership return address — used for printed customer envelopes
            "ALTER TABLE users ADD COLUMN dealer_name TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_address_line1 TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_city TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_state TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_zip TEXT DEFAULT ''",
            # Facebook / Meta integration
            "ALTER TABLE users ADD COLUMN fb_page_id TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN fb_access_token TEXT DEFAULT ''",
            # Scraper schedule
            "ALTER TABLE users ADD COLUMN scraper_frequency TEXT DEFAULT 'daily'",
            # Pricing breakdown fields — extracted from dealer VDP pages
            "ALTER TABLE marketplace_inventory ADD COLUMN doc_fee INTEGER DEFAULT 0",
            "ALTER TABLE marketplace_inventory ADD COLUMN retail_price INTEGER DEFAULT 0",
            "ALTER TABLE marketplace_inventory ADD COLUMN savings INTEGER DEFAULT 0",
            # AI-generated Marketplace listing copy (saved from Hub modal)
            "ALTER TABLE marketplace_inventory ADD COLUMN ai_description TEXT DEFAULT ''",
            # Subscription billing-cycle tracking — used for cancellation UX
            "ALTER TABLE users ADD COLUMN subscription_period_end    TEXT    DEFAULT ''",
            "ALTER TABLE users ADD COLUMN subscription_cancel_scheduled INTEGER DEFAULT 0",
            # Wishlist — Vehicle Choice 2 columns
            "ALTER TABLE wishlist ADD COLUMN condition2   TEXT    DEFAULT 'Any'",
            "ALTER TABLE wishlist ADD COLUMN make2        TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN model2       TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN keyword2     TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN year_min2    INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN year_max2    INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN max_mileage2 INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN max_budget2  INTEGER DEFAULT 0",
            # Wishlist — Vehicle Choice 3 columns
            "ALTER TABLE wishlist ADD COLUMN condition3   TEXT    DEFAULT 'Any'",
            "ALTER TABLE wishlist ADD COLUMN make3        TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN model3       TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN keyword3     TEXT    DEFAULT ''",
            "ALTER TABLE wishlist ADD COLUMN year_min3    INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN year_max3    INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN max_mileage3 INTEGER DEFAULT 0",
            "ALTER TABLE wishlist ADD COLUMN max_budget3  INTEGER DEFAULT 0",
            # Email verification (auto-verified — soft gate removed)
            "ALTER TABLE users ADD COLUMN email_verified    INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE users ADD COLUMN verification_token TEXT DEFAULT NULL",
            # Browser fingerprint — device-level trial deduplication
            "ALTER TABLE users ADD COLUMN visitor_id TEXT DEFAULT ''",
            # Suspension flag — set by master admin to immediately block login
            "ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0",
            # Email-change revocation columns
            "ALTER TABLE users ADD COLUMN old_email_history      TEXT    DEFAULT ''",
            "ALTER TABLE users ADD COLUMN email_revert_token     TEXT    DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN email_revert_expires_at TEXT   DEFAULT NULL",
            # Unique Recovery ID — identity verification if email access is lost
            "ALTER TABLE users ADD COLUMN recovery_id TEXT DEFAULT NULL",
            # Referral program — shareable codes, referrer link, credit balance
            "ALTER TABLE users ADD COLUMN referral_code TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN referred_by INTEGER DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN account_credit REAL DEFAULT 0.0",
            # Multi-tier subscription plans
            "ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN organization_id INTEGER DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN org_role TEXT DEFAULT ''",
            # Rooftop team management — unique invite code per org
            "ALTER TABLE organizations ADD COLUMN invite_code TEXT DEFAULT ''",
            # Seat usage counter — kept in sync by create-member / remove-member;
            # recalculated from actual user count at every startup to prevent drift.
            "ALTER TABLE organizations ADD COLUMN used_seats INTEGER NOT NULL DEFAULT 0",
            # Dealership profile — contact info and logo for customer cards & mailers
            "ALTER TABLE users ADD COLUMN dealer_phone         TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_support_email TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN dealer_logo_url      TEXT DEFAULT ''",
            # Master admin role-preview switcher — stores which view mdemoss is previewing
            "ALTER TABLE users ADD COLUMN mock_role            TEXT DEFAULT ''",
            # TikTok integration — OAuth tokens and account identifier
            "ALTER TABLE users ADD COLUMN tiktok_access_token     TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN tiktok_refresh_token    TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN tiktok_open_id          TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN tiktok_token_expires_at TEXT DEFAULT NULL",
            # TikTok trial gating — start date and per-day post counts
            "ALTER TABLE users ADD COLUMN tiktok_trial_start_date TEXT DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN tiktok_daily_posts       TEXT DEFAULT NULL",
            # TikTok per-user default video privacy preference
            "ALTER TABLE users ADD COLUMN tiktok_privacy_level     TEXT DEFAULT 'SELF_ONLY'",
            # TikTok post history — live video URL once post reaches PUBLISH_COMPLETE
            "ALTER TABLE tiktok_posts ADD COLUMN video_url TEXT DEFAULT ''",
            # TikTok post history — reason string set when a row is force-failed
            # Current values: 'timed_out' (sweep), '' / NULL (upload/API error)
            "ALTER TABLE tiktok_posts ADD COLUMN failure_reason TEXT DEFAULT ''",
            # Extra seats chosen at registration — held until rooftop checkout completes.
            # Cleared (set to 0) once the org is provisioned with the correct seat_limit.
            "ALTER TABLE users ADD COLUMN pending_extra_seats INTEGER NOT NULL DEFAULT 0",
            # Billing cycle chosen on the landing page / register form — preserved so
            # the Stripe checkout session defaults to the right interval even if the
            # user navigates to the pricing page from a fresh session.
            # Values: 'monthly' | 'annual' | 'lifetime'
            "ALTER TABLE users ADD COLUMN pending_billing_cycle TEXT NOT NULL DEFAULT 'monthly'",
            # Meta / Facebook Marketplace catalog integration IDs
            "ALTER TABLE users ADD COLUMN facebook_business_manager_id TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN commerce_catalog_id           TEXT DEFAULT ''",
            "ALTER TABLE users ADD COLUMN meta_pixel_id                 TEXT DEFAULT ''",
            # Team member profile fields — full display name and job role
            "ALTER TABLE users ADD COLUMN job_title TEXT DEFAULT ''",
            # RBAC role: Admin | Reviewer (desk-level access control)
            "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'Reviewer'",
        ]
        for _sql in _migrations:
            try:
                cursor.execute(_sql)
            except sqlite3.OperationalError:
                pass  # column already present

        # Backfill RBAC roles for known accounts (idempotent).
        try:
            cursor.execute(
                "UPDATE users SET role = 'Admin' "
                "WHERE LOWER(username) = ? OR is_admin = 1",
                (os.environ.get('ADMIN_USER', 'mdemoss').strip().lower(),),
            )
            cursor.execute(
                "UPDATE users SET role = 'Reviewer' "
                "WHERE LOWER(username) IN ('testreviewer', 'jdemoss')"
            )
            cursor.execute(
                "UPDATE users SET role = 'Reviewer' "
                "WHERE COALESCE(role, '') = ''"
            )
        except Exception as _role_err:
            print(f"[INIT] role backfill warning: {_role_err}")

        # Bypass email verification globally: every existing account (including
        # mdemoss and any unverified demo / trial users) is marked verified on
        # every startup. Safe to re-run — only flips rows that are still 0.
        try:
            cursor.execute(
                "UPDATE users SET email_verified = 1, verification_token = NULL "
                "WHERE COALESCE(email_verified, 0) = 0 OR verification_token IS NOT NULL"
            )
            if cursor.rowcount:
                print(f"[INIT] Auto-verified {cursor.rowcount} existing user account(s).")
        except Exception as _ev_err:
            print(f"[INIT] email_verified backfill warning: {_ev_err}")

        # Global runtime key/value store — admin-configurable without a restart.
        # Used for TikTok API credentials and any future per-server settings.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS system_settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Security audit log — forensic record of every automated suspension event.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS security_audit_log (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id         INTEGER NOT NULL,
                username        TEXT    NOT NULL DEFAULT '',
                ip_address      TEXT    NOT NULL DEFAULT '',
                request_path    TEXT    NOT NULL DEFAULT '',
                violation_type  TEXT    NOT NULL DEFAULT '',
                payload_snippet TEXT    NOT NULL DEFAULT '',
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Multi-user scrape cancellation registry — one row per Sync All /
        # /api/scrape job.  Workers poll status between pages/batches.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_sessions (
                session_id    TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'running',
                scraped_count INTEGER NOT NULL DEFAULT 0,
                updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        try:
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_sync_sessions_user_status "
                "ON sync_sessions (user_id, status)"
            )
        except sqlite3.OperationalError:
            pass
        if _scraper_engine is not None:
            try:
                _scraper_engine.ensure_schema(conn)
                # Fill blank / legacy rooftop labels so the Hub Location dropdown
                # has options immediately after upgrade (no full re-scrape needed).
                _bf = _scraper_engine.backfill_inventory_rooftops()
                if _bf:
                    print(f"[INIT] Backfilled rooftop location on {_bf} inventory row(s).")
            except Exception as _ss_err:
                print(f"[INIT] sync_sessions / rooftop backfill warning: {_ss_err}")

        # Dealership paper forms — shared master fields for Test Drive / Gate Pass /
        # Delivery Checklist drafts (one active draft per user).
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS forms_drafts (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id       INTEGER NOT NULL UNIQUE,
                buyer_name    TEXT    NOT NULL DEFAULT '',
                vin           TEXT    NOT NULL DEFAULT '',
                stock_number  TEXT    NOT NULL DEFAULT '',
                price         TEXT    NOT NULL DEFAULT '',
                mileage       TEXT    NOT NULL DEFAULT '',
                active_form   TEXT    NOT NULL DEFAULT 'test_drive',
                notes         TEXT    NOT NULL DEFAULT '',
                updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )

        # Backfill referral codes for accounts that pre-date the referral feature.
        # _generate_referral_code is defined below init_db but is resolved at call
        # time (called from main() after all defs), so forward references are safe.
        _rc_missing = conn.execute(
            "SELECT id, username FROM users WHERE referral_code IS NULL OR referral_code = ''"
        ).fetchall()
        for _rc_row in _rc_missing:
            conn.execute(
                "UPDATE users SET referral_code = ? WHERE id = ?",
                (_generate_referral_code(_rc_row[1] if isinstance(_rc_row, dict) else _rc_row[1]), _rc_row[0] if isinstance(_rc_row, dict) else _rc_row[0]),
            )
        if _rc_missing:
            conn.commit()
            print(f"[INIT] Backfilled referral codes for {len(_rc_missing)} existing account(s).")

        # Password reset tokens — created once, idempotent
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                token      TEXT UNIQUE NOT NULL,
                expires_at TEXT NOT NULL,
                used       INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )

        # Legal agreement audit log — immutable proof of ToS acceptance.
        # Each row is one acceptance event (registration or checkout).
        # Submitted to payment processors as evidence in chargeback disputes.
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS legal_agreements (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                context     TEXT    NOT NULL DEFAULT '',
                ip_address  TEXT    NOT NULL DEFAULT '',
                user_agent  TEXT    NOT NULL DEFAULT '',
                agreed      INTEGER NOT NULL DEFAULT 1,
                agreed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )

        # Referral program — one row per referred signup; status pending -> converted
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS referrals (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                referrer_id      INTEGER NOT NULL,
                referred_user_id INTEGER NOT NULL UNIQUE,
                status           TEXT    NOT NULL DEFAULT 'pending',
                credit_amount    REAL    NOT NULL DEFAULT 25.0,
                created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # Billing events — audit trail for credit awards and invoice applications
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS billing_events (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id              INTEGER NOT NULL,
                event_type           TEXT    NOT NULL DEFAULT '',
                stripe_invoice_id    TEXT    NOT NULL DEFAULT '',
                amount_cents         INTEGER NOT NULL DEFAULT 0,
                credit_applied_cents INTEGER NOT NULL DEFAULT 0,
                description          TEXT    NOT NULL DEFAULT '',
                created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # TikTok post history — one row per publish attempt
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS tiktok_posts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER NOT NULL,
                publish_id     TEXT    NOT NULL,
                title          TEXT    NOT NULL DEFAULT '',
                posted_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status         TEXT    NOT NULL DEFAULT 'PROCESSING',
                video_url      TEXT    NOT NULL DEFAULT '',
                failure_reason TEXT    NOT NULL DEFAULT '',
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )

        # Backfill: existing accounts with no inventory URL configured get the
        # Moses Auto Group defaults so their Settings page shows the correct URLs
        # immediately after upgrading.  The condition is safe to re-run — it only
        # updates rows where BOTH url columns are empty.
        cursor.execute(
            """UPDATE users
                  SET inventory_url_used = ?,
                      inventory_url_new  = ?
                WHERE (inventory_url_used IS NULL OR inventory_url_used = '')
                  AND (inventory_url_new  IS NULL OR inventory_url_new  = '')""",
            (MOSES_USED_URL, MOSES_NEW_URL),
        )
        if cursor.rowcount:
            print(f"[INIT] Backfilled Moses default URLs for {cursor.rowcount} existing account(s).")

        # Backfill: seed the five canonical Moses locations for every existing user
        # that has not yet received them.  INSERT OR IGNORE means re-running is safe
        # and any changes the user already made (e.g. disabling Morgantown) are never
        # overwritten.
        cursor.execute("SELECT id FROM users")
        all_user_ids = [r[0] for r in cursor.fetchall()]
        loc_seeded = 0
        for uid in all_user_ids:
            for loc_name, loc_enabled in MOSES_DEFAULT_LOCATIONS:
                cursor.execute(
                    "INSERT OR IGNORE INTO user_locations "
                    "(user_id, location, enabled) VALUES (?, ?, ?)",
                    (uid, loc_name, 1 if loc_enabled else 0),
                )
                loc_seeded += cursor.rowcount
        if loc_seeded:
            print(f"[INIT] Pre-seeded {loc_seeded} default location row(s) across "
                  f"{len(all_user_ids)} account(s).")

        # Backfill: update existing demo inventory rows that have a blank location.
        # These rows were inserted before the `location` field was added to
        # MOSES_DEMO_INVENTORY and can be safely back-filled from the constant.
        # The CASE guard ensures real scraped data with an existing location is
        # never overwritten.
        inv_backfilled = 0
        for demo_v in MOSES_DEMO_INVENTORY:
            if demo_v.get('location'):
                cursor.execute(
                    "UPDATE marketplace_inventory SET location=? "
                    "WHERE vin=? AND (location IS NULL OR location='')",
                    (demo_v['location'], demo_v['vin']),
                )
                inv_backfilled += cursor.rowcount
        if inv_backfilled:
            print(f"[INIT] Backfilled location on {inv_backfilled} existing "
                  f"demo inventory row(s).")

        # ── Master admin: seed / sync on every startup ────────────────────────
        # Password + admin flags may re-sync from env so the account stays
        # reachable after DB resets. Email is set from ADMIN_EMAIL only when
        # creating the account (or when the stored email is blank) — never
        # overwrite a profile email the user already saved.
        _MASTER_USER  = os.environ.get('ADMIN_USER',  'mdemoss').strip().lower()
        _MASTER_EMAIL = (os.environ.get('ADMIN_EMAIL') or '').strip().lower()
        if not _MASTER_EMAIL:
            _MASTER_EMAIL = 'support.bdcmanager@gmail.com'
            print(
                "[INIT] ADMIN_EMAIL unset — using default "
                f"{_MASTER_EMAIL!r} for new master-admin seed only."
            )
        _MASTER_PASS  = (
            os.environ.get('ADMIN_PASSWORD')
            or os.environ.get('DASHBOARD_PASSWORD')
            or os.environ.get('LOGIN_PASSWORD')
            or 'Netsirk115!$'
        ).strip()
        _ma_hash = _hash_password(_MASTER_PASS) if _MASTER_PASS else None
        if not (
            os.environ.get('ADMIN_PASSWORD')
            or os.environ.get('DASHBOARD_PASSWORD')
            or os.environ.get('LOGIN_PASSWORD')
        ):
            print(
                "[INIT] ADMIN_PASSWORD / DASHBOARD_PASSWORD / LOGIN_PASSWORD unset — "
                "using built-in default for master-admin bootstrap only."
            )

        _ma_existing = conn.execute(
            "SELECT id, email FROM users WHERE LOWER(username) = ?", (_MASTER_USER,)
        ).fetchone()
        if not _ma_existing:
            if _ma_hash:
                conn.execute(
                    """INSERT INTO users
                           (username, password_hash, email,
                            is_admin, subscription_status,
                            inventory_url_used, inventory_url_new,
                            recovery_id, referral_code, email_verified, role)
                       VALUES (?, ?, ?, 1, 'active', ?, ?, ?, 'MDEMOSS', 1, 'Admin')""",
                    (
                        _MASTER_USER,
                        _ma_hash,
                        _MASTER_EMAIL,
                        MOSES_USED_URL,
                        MOSES_NEW_URL,
                        secrets.token_urlsafe(16),
                    ),
                )
                print(
                    f"[INIT] Master admin {_MASTER_USER!r} created "
                    f"(email={_MASTER_EMAIL!r})."
                )
            else:
                print(f"[INIT] Master admin {_MASTER_USER!r} NOT created — set DASHBOARD_PASSWORD.")
        else:
            _ma_stored_email = str(_ma_existing['email'] or '').strip().lower()

            # Preserve profile email updates across cold starts. Only backfill
            # when the column is empty so a fresh migrate still gets ADMIN_EMAIL.
            _ma_email_sql = ''
            _ma_email_args: list = []
            if not _ma_stored_email and _MASTER_EMAIL:
                _ma_email_sql = 'email = ?, '
                _ma_email_args = [_MASTER_EMAIL]
                print(
                    f"[INIT] Master admin {_MASTER_USER!r} email backfilled "
                    f"from ADMIN_EMAIL={_MASTER_EMAIL!r}."
                )
            else:
                print(
                    f"[INIT] Master admin {_MASTER_USER!r} email preserved "
                    f"({_ma_stored_email or '(empty)'})."
                )

            if _ma_hash:
                # Preserve Settings password changes: only write the env hash when
                # the stored hash is missing/invalid. Flags + email backfill still run.
                _ma_hash_row = conn.execute(
                    "SELECT password_hash FROM users WHERE LOWER(username) = ?",
                    (_MASTER_USER,),
                ).fetchone()
                _stored_hash = str((_ma_hash_row["password_hash"] if _ma_hash_row else "") or "").strip()
                _hash_missing = (not _stored_hash) or (
                    not _stored_hash.startswith(("pbkdf2:", "scrypt:", "$"))
                )
                if _hash_missing:
                    conn.execute(
                        f"UPDATE users SET password_hash = ?, {_ma_email_sql}"
                        "is_admin = 1, subscription_status = 'active', "
                        "subscription_tier = 'pro_lifetime', email_verified = 1, "
                        "role = 'Admin' "
                        "WHERE LOWER(username) = ?",
                        [_ma_hash, *_ma_email_args, _MASTER_USER],
                    )
                    print(
                        f"[INIT] Master admin {_MASTER_USER!r} missing hash restored "
                        "from ADMIN_PASSWORD env (email not overwritten)."
                    )
                else:
                    conn.execute(
                        f"UPDATE users SET {_ma_email_sql}"
                        "is_admin = 1, subscription_status = 'active', "
                        "subscription_tier = 'pro_lifetime', email_verified = 1, "
                        "role = 'Admin' "
                        "WHERE LOWER(username) = ?",
                        [*_ma_email_args, _MASTER_USER],
                    )
                    print(
                        f"[INIT] Master admin {_MASTER_USER!r} flags synced "
                        "(password preserved — Settings changes kept)."
                    )
            else:
                conn.execute(
                    f"UPDATE users SET {_ma_email_sql}"
                    "is_admin = 1, subscription_status = 'active', "
                    "subscription_tier = 'pro_lifetime', email_verified = 1, "
                    "role = 'Admin' "
                    "WHERE LOWER(username) = ?",
                    [*_ma_email_args, _MASTER_USER],
                )
                print(
                    f"[INIT] Master admin {_MASTER_USER!r} flags synced "
                    "(password unchanged — no env secret)."
                )
        # ── Seed: testreviewer — Rooftop Dealership Admin demo account ───────────
        # Non-destructive: create once; never overwrite an existing password hash.
        _TR_USER  = 'testreviewer'
        _TR_EMAIL = (
            os.environ.get('TESTER_EMAIL')
            or 'reviewer@bdcmanager.com'
        ).strip().lower()
        _TR_PASS  = (
            os.environ.get('TESTER_PASSWORD')
            or 'TestReviewer123!'
        ).strip()
        _tr_existing = conn.execute(
            "SELECT id, password_hash, email, organization_id FROM users WHERE username = ?",
            (_TR_USER,),
        ).fetchone()
        if not _tr_existing:
            _tr_hash = _hash_password(_TR_PASS)
            conn.execute(
                """INSERT INTO users
                       (username, password_hash, email,
                        subscription_status, subscription_tier,
                        inventory_url_used, inventory_url_new,
                        recovery_id, referral_code, email_verified, role)
                   VALUES (?, ?, ?, 'active', 'rooftop_monthly', ?, ?, ?, ?, 1, 'Reviewer')""",
                (
                    _TR_USER,
                    _tr_hash,
                    _TR_EMAIL,
                    MOSES_USED_URL,
                    MOSES_NEW_URL,
                    secrets.token_urlsafe(16),
                    'TESTREVIEWER',
                ),
            )
            conn.commit()
            _tr_uid = conn.execute(
                "SELECT id FROM users WHERE username = ?", (_TR_USER,)
            ).fetchone()[0]
            for _loc_name, _loc_en in MOSES_DEFAULT_LOCATIONS:
                conn.execute(
                    "INSERT OR IGNORE INTO user_locations "
                    "(user_id, location, enabled) VALUES (?, ?, ?)",
                    (_tr_uid, _loc_name, 1 if _loc_en else 0),
                )
            _tr_invite = secrets.token_urlsafe(12)
            conn.execute(
                """INSERT INTO organizations
                       (name, owner_user_id, seat_limit,
                        subscription_status, subscription_tier, invite_code)
                   VALUES (?, ?, 10, 'active', 'rooftop_monthly', ?)""",
                ("Testreviewer's Dealership", _tr_uid, _tr_invite),
            )
            conn.commit()
            _tr_org_id = conn.execute(
                "SELECT id FROM organizations WHERE owner_user_id = ?", (_tr_uid,)
            ).fetchone()[0]
            conn.execute(
                "UPDATE users SET organization_id = ?, org_role = 'admin' WHERE id = ?",
                (_tr_org_id, _tr_uid),
            )
            conn.commit()
            print(
                f"[INIT] Seeded 'testreviewer' (id={_tr_uid}, org={_tr_org_id}, "
                f"email={_TR_EMAIL!r}) — password set once (non-destructive thereafter)."
            )
        else:
            _tr_uid = int(_tr_existing['id'])
            _tr_stored_email = str(_tr_existing['email'] or '').strip()
            _tr_stored_hash = str(_tr_existing['password_hash'] or '').strip()
            if not _tr_stored_email and _TR_EMAIL:
                conn.execute(
                    "UPDATE users SET email = ? WHERE id = ?",
                    (_TR_EMAIL, _tr_uid),
                )
            if not _tr_stored_hash:
                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (_hash_password(_TR_PASS), _tr_uid),
                )
            conn.execute(
                "UPDATE users SET subscription_status = 'active', "
                "subscription_tier = 'rooftop_monthly', org_role = 'admin', "
                "role = 'Reviewer' WHERE id = ?",
                (_tr_uid,),
            )
            if not _tr_existing['organization_id']:
                _tr_invite2 = secrets.token_urlsafe(12)
                conn.execute(
                    """INSERT INTO organizations
                           (name, owner_user_id, seat_limit,
                            subscription_status, subscription_tier, invite_code)
                       VALUES (?, ?, 10, 'active', 'rooftop_monthly', ?)""",
                    ("Testreviewer's Dealership", _tr_uid, _tr_invite2),
                )
                conn.commit()
                _tr_org_id2 = conn.execute(
                    "SELECT id FROM organizations WHERE owner_user_id = ?", (_tr_uid,)
                ).fetchone()[0]
                conn.execute(
                    "UPDATE users SET organization_id = ?, org_role = 'admin' WHERE id = ?",
                    (_tr_org_id2, _tr_uid),
                )
            conn.commit()
            print(
                "[INIT] 'testreviewer' already exists — password preserved (non-destructive)."
            )

        # ── Seed: mdemoss1 — dedicated Rooftop Admin test account ───────────────
        # Force-synced on every startup so the account survives DB resets and
        # schema migrations. Intended for end-to-end testing of the Rooftop
        # Manager UI: team creation, seat management, and org-level controls.
        # email_verified=1 so login works immediately without an email click.
        _MD1_USER  = 'mdemoss1'
        _MD1_EMAIL = 'matthewdemoss+mdemoss1@gmail.com'
        _MD1_PASS  = 'Netsirk115!$'
        _MD1_NAME  = 'Matthew DeMoss'
        _md1_salt  = secrets.token_hex(16)
        _md1_key   = hashlib.pbkdf2_hmac(
            "sha256", _MD1_PASS.encode(), _md1_salt.encode(), 260_000
        )
        _md1_hash  = f"{_md1_salt}:{_md1_key.hex()}"
        _md1_existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (_MD1_USER,)
        ).fetchone()
        if not _md1_existing:
            conn.execute(
                """INSERT INTO users
                       (username, password_hash, email, dealer_name,
                        subscription_status, subscription_tier,
                        recovery_id, referral_code, email_verified)
                   VALUES (?, ?, ?, ?, 'active', 'rooftop_monthly', ?, ?, 1)""",
                (
                    _MD1_USER,
                    _md1_hash,
                    _MD1_EMAIL,
                    _MD1_NAME,
                    secrets.token_urlsafe(16),
                    'MDEMOSS1',
                ),
            )
            conn.commit()
            _md1_uid = conn.execute(
                "SELECT id FROM users WHERE username = ?", (_MD1_USER,)
            ).fetchone()[0]
            # Provision a standalone rooftop org for mdemoss1.
            _md1_invite = secrets.token_urlsafe(12)
            conn.execute(
                """INSERT INTO organizations
                       (name, owner_user_id, seat_limit,
                        subscription_status, subscription_tier, invite_code)
                   VALUES (?, ?, 10, 'active', 'rooftop_monthly', ?)""",
                ("DeMoss Auto Group", _md1_uid, _md1_invite),
            )
            conn.commit()
            _md1_org_id = conn.execute(
                "SELECT id FROM organizations WHERE owner_user_id = ?", (_md1_uid,)
            ).fetchone()[0]
            conn.execute(
                "UPDATE users SET organization_id = ?, org_role = 'admin' WHERE id = ?",
                (_md1_org_id, _md1_uid),
            )
            conn.commit()
            print(
                f"[INIT] Seeded 'mdemoss1' (id={_md1_uid}, org={_md1_org_id}) — "
                "Rooftop Admin account for dealership management testing."
            )
        else:
            # Account exists — force-sync credentials and org status on every
            # restart so the account stays fully active across future deploys.
            _md1_uid = _md1_existing[0]
            conn.execute(
                "UPDATE users SET "
                "password_hash = ?, "
                "email = ?, dealer_name = ?, "
                "subscription_status = 'active', "
                "subscription_tier = 'rooftop_monthly', "
                "org_role = 'admin', email_verified = 1 "
                "WHERE username = ?",
                (_md1_hash, _MD1_EMAIL, _MD1_NAME, _MD1_USER),
            )
            conn.commit()
            # Ensure the account has a rooftop org (idempotent).
            _md1_org_row = conn.execute(
                "SELECT organization_id FROM users WHERE id = ?", (_md1_uid,)
            ).fetchone()
            if not (_md1_org_row and _md1_org_row[0]):
                _md1_invite2 = secrets.token_urlsafe(12)
                conn.execute(
                    """INSERT INTO organizations
                           (name, owner_user_id, seat_limit,
                            subscription_status, subscription_tier, invite_code)
                       VALUES (?, ?, 10, 'active', 'rooftop_monthly', ?)""",
                    ("DeMoss Auto Group", _md1_uid, _md1_invite2),
                )
                conn.commit()
                _md1_org_id2 = conn.execute(
                    "SELECT id FROM organizations WHERE owner_user_id = ?", (_md1_uid,)
                ).fetchone()[0]
                conn.execute(
                    "UPDATE users SET organization_id = ?, org_role = 'admin' "
                    "WHERE id = ?",
                    (_md1_org_id2, _md1_uid),
                )
                conn.commit()
                print(
                    f"[INIT] Provisioned 'DeMoss Auto Group' org (id={_md1_org_id2}) "
                    "for 'mdemoss1' — Rooftop Admin credentials force-synced."
                )
            else:
                print(
                    "[INIT] 'mdemoss1' Rooftop Admin credentials "
                    "force-synced (org already provisioned)."
                )

        # ── Seed: Jdemoss — permanent Pro account (non-destructive + alias) ───
        _JD_USER  = 'jdemoss'
        _JD_EMAIL = (
            os.environ.get('JDEMOSS_EMAIL')
            or 'jdemoss@bdcmanager.com'
        ).strip().lower()
        _JD_PASS  = (
            os.environ.get('JDEMOSS_PASSWORD')
            or 'Jdemoss123!'
        ).strip()
        _jd_existing = conn.execute(
            "SELECT id, password_hash, email FROM users WHERE LOWER(username) = ?",
            (_JD_USER,),
        ).fetchone()
        if not _jd_existing:
            conn.execute(
                """INSERT INTO users
                       (username, password_hash, email,
                        subscription_status, subscription_tier,
                        inventory_url_used, inventory_url_new,
                        recovery_id, referral_code, email_verified, role)
                   VALUES (?, ?, ?, 'active', 'pro_annual', ?, ?, ?, 'JDEMOSS', 1, 'Reviewer')""",
                (
                    _JD_USER,
                    _hash_password(_JD_PASS),
                    _JD_EMAIL,
                    MOSES_USED_URL,
                    MOSES_NEW_URL,
                    secrets.token_urlsafe(16),
                ),
            )
            conn.commit()
            _jd_uid = conn.execute(
                "SELECT id FROM users WHERE LOWER(username) = ?", (_JD_USER,)
            ).fetchone()[0]
            for _loc_name, _loc_en in MOSES_DEFAULT_LOCATIONS:
                conn.execute(
                    "INSERT OR IGNORE INTO user_locations "
                    "(user_id, location, enabled) VALUES (?, ?, ?)",
                    (_jd_uid, _loc_name, 1 if _loc_en else 0),
                )
            print(
                f"[INIT] Seeded 'jdemoss' (id={_jd_uid}, email={_JD_EMAIL!r}) — "
                "password set to Jdemoss123! (alias login: jdmoss)."
            )
        else:
            _jd_stored_email = str(_jd_existing['email'] or '').strip()
            _jd_stored_hash = str(_jd_existing['password_hash'] or '').strip()
            if not _jd_stored_email and _JD_EMAIL:
                conn.execute(
                    "UPDATE users SET email = ? WHERE id = ?",
                    (_JD_EMAIL, _jd_existing['id']),
                )
            # Keep demo password aligned with Jdemoss123! when hash is missing or stale.
            if (not _jd_stored_hash) or (not _verify_password(_JD_PASS, _jd_stored_hash)):
                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (_hash_password(_JD_PASS), _jd_existing['id']),
                )
                print(
                    "[INIT] 'jdemoss' password hash synced to Jdemoss123!/JDEMOSS_PASSWORD."
                )
            else:
                print(
                    "[INIT] 'jdemoss' already exists — password hash already matches baseline."
                )
            conn.execute(
                "UPDATE users SET subscription_status = 'active', "
                "subscription_tier = 'pro_annual', email = COALESCE(NULLIF(email, ''), ?) "
                "WHERE id = ?",
                (_JD_EMAIL, _jd_existing['id']),
            )
            print(
                "[INIT] 'jdemoss' ready (case-insensitive login; alias 'jdmoss' also accepted on Node)."
            )
        # ── Startup seat-counter sync ─────────────────────────────────────────
        # Recalculate used_seats for every org from the actual user count so any
        # missed increment/decrement (e.g. before this column existed) self-heals.
        _sync_orgs = conn.execute("SELECT id FROM organizations").fetchall()
        for _s_org in _sync_orgs:
            _s_cnt = conn.execute(
                "SELECT COUNT(*) AS cnt FROM users WHERE organization_id = ?",
                (_s_org["id"],),
            ).fetchone()
            conn.execute(
                "UPDATE organizations SET used_seats = ? WHERE id = ?",
                (int(_s_cnt["cnt"]) if _s_cnt else 0, _s_org["id"]),
            )
        if _sync_orgs:
            print(f"[INIT] Synced used_seats for {len(_sync_orgs)} org(s).")

        # ── Startup orphan repair ─────────────────────────────────────────────
        # Any user with org_role='member' but no organization_id is an orphan
        # created before the atomic-INSERT fix.  Assign to mdemoss1's org.
        _orphan_rows = conn.execute(
            "SELECT id, username FROM users "
            "WHERE org_role = 'member' "
            "  AND (organization_id IS NULL OR organization_id = 0)"
        ).fetchall()
        if _orphan_rows:
            _md1_org = conn.execute(
                "SELECT organization_id FROM users WHERE username = 'mdemoss1' LIMIT 1"
            ).fetchone()
            _repair_org_id = _md1_org["organization_id"] if _md1_org else None
            if _repair_org_id:
                # Fetch the org's tier so repaired users inherit proper subscription_tier
                _repair_tier_row = conn.execute(
                    "SELECT subscription_tier FROM organizations WHERE id = ? LIMIT 1",
                    (_repair_org_id,),
                ).fetchone()
                _repair_tier = (
                    (_repair_tier_row["subscription_tier"] if _repair_tier_row else None)
                    or "rooftop_monthly"
                )
                for _orph in _orphan_rows:
                    conn.execute(
                        "UPDATE users SET organization_id = ?, "
                        "subscription_status = 'active', "
                        "subscription_tier   = ? "
                        "WHERE id = ?",
                        (_repair_org_id, _repair_tier, _orph["id"]),
                    )
                    print(
                        f"[REPAIR] Orphan '{_orph['username']}' (id={_orph['id']}) "
                        f"-> org {_repair_org_id}, tier={_repair_tier} (DeMoss Auto Group)."
                    )
            else:
                for _orph in _orphan_rows:
                    print(
                        f"[REPAIR] WARNING: orphan '{_orph['username']}' has "
                        "org_role='member' but no org — manual fix required."
                    )

        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()

    # Re-classify any mis-labelled conditions using the live sitemap.
    # This runs quickly (one HTTP round-trip) and is idempotent.
    _startup_condition_cleanup()


# =====================================================================
# AUTH HELPERS
# =====================================================================
def _hash_password(password: str) -> str:
    """Hash a password with bcrypt (cost 10). Falls back to PBKDF2 if bcrypt
    is unavailable.

    Formats:
      • bcrypt  — ``$2b$10$...`` (preferred; matches Node bcryptjs)
      • pbkdf2  — ``pbkdf2:salt_hex:key_hex`` (stdlib fallback)
    """
    try:
        import bcrypt as _bcrypt  # type: ignore
        return _bcrypt.hashpw(
            password.encode("utf-8"),
            _bcrypt.gensalt(rounds=10),
        ).decode("utf-8")
    except Exception:
        salt = secrets.token_hex(16)
        key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000)
        return f"pbkdf2:{salt}:{key.hex()}"


def _verify_password(password: str, stored_hash: str) -> bool:
    """Verify bcrypt, scrypt, or PBKDF2 hashes (Node + Python compatibility)."""
    if not password or not stored_hash:
        return False
    stored = str(stored_hash).strip()
    if not stored:
        return False

    # bcrypt (Node bcryptjs + Python bcrypt)
    if stored.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            import bcrypt as _bcrypt  # type: ignore
            return bool(
                _bcrypt.checkpw(password.encode("utf-8"), stored.encode("utf-8"))
            )
        except Exception:
            return False

    # Legacy Node scrypt:saltHex:hashHex
    if stored.startswith("scrypt:"):
        try:
            _scheme, salt_hex, hash_hex = stored.split(":", 2)
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(hash_hex)
            # Node used scrypt with N=16384,r=8,p=1,keylen=64
            actual = hashlib.scrypt(
                password.encode("utf-8"),
                salt=salt,
                n=16384,
                r=8,
                p=1,
                dklen=len(expected),
            )
            return secrets.compare_digest(actual, expected)
        except Exception:
            return False

    # Prefixed PBKDF2 or legacy bare salt:key
    try:
        body = stored[7:] if stored.startswith("pbkdf2:") else stored
        salt, key_hex = body.split(":", 1)
        if ":" in key_hex and not stored.startswith("pbkdf2:"):
            return False
        key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000)
        return secrets.compare_digest(key.hex(), key_hex)
    except Exception:
        return False


class _DateTimeEncoder(json.JSONEncoder):
    """Extend the stdlib JSON encoder to handle types psycopg2 returns that
    the default encoder cannot serialize (datetime, date, Decimal, UUID, etc.)."""

    def default(self, obj):  # noqa: ANN001
        import datetime as _dt
        import decimal as _dec
        if isinstance(obj, (_dt.datetime, _dt.date)):
            return obj.isoformat()
        if isinstance(obj, _dec.Decimal):
            return float(obj)
        return super().default(obj)


def _generate_recovery_id() -> str:
    """Return a unique 16-char alphanumeric ID formatted as ``REC-XXXX-XXXX-XXXX``.

    Uses an unambiguous alphabet (no O/0, I/1) so the code is easy to
    transcribe from a printed or handwritten copy.
    """
    _CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    segs = [''.join(secrets.choice(_CHARS) for _ in range(4)) for _ in range(3)]
    return 'REC-' + '-'.join(segs)


def _generate_referral_code(username: str) -> str:
    """Return a referral code derived from *username* in the form ``USERNAME25``.

    Characters are uppercased and stripped to alphanumeric-only so the code
    is URL-safe and easy to share verbally.  At most 8 characters from the
    username are used, keeping the total length ≤ 10.
    """
    import re as _re_ref
    clean = _re_ref.sub(r'[^A-Za-z0-9]', '', username).upper()[:8]
    return f"{clean}25"


def _provision_rooftop_org(user_id: int, username: str, plan: str, extra_seats: int = 0) -> None:
    """Create an Organization for a newly-activated Rooftop plan account and
    set the purchasing user as its admin.

    Idempotent: if the user already has an organization_id this is a no-op.
    Called from handle_webhook after checkout.session.completed for any plan
    whose key starts with 'rooftop_'.

    ``extra_seats`` is the number of add-on seats above the base 10 that the
    admin selected at registration. The org's seat_limit is set to 10 + extra_seats
    from day one so it matches what was charged.
    """
    seat_limit = 10 + max(0, int(extra_seats))
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT organization_id FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if row and row["organization_id"]:
                print(f"[TEAM] User {user_id} already owns org {row['organization_id']} — skipping provision.")
                return

            invite_code = secrets.token_urlsafe(12)
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO organizations
                       (name, owner_user_id, seat_limit, subscription_status,
                        subscription_tier, invite_code)
                   VALUES (?, ?, ?, 'active', ?, ?)""",
                (f"{username.title()}'s Dealership", user_id, seat_limit, plan, invite_code),
            )
            conn.commit()
            org_id = cur.lastrowid

            conn.execute(
                "UPDATE users SET organization_id = ?, org_role = 'admin', "
                "pending_extra_seats = 0 WHERE id = ?",
                (org_id, user_id),
            )
            conn.commit()
            print(
                f"[TEAM] Provisioned org id={org_id} for user {user_id} "
                f"(plan={plan}, seat_limit={seat_limit}, invite_code={invite_code})"
            )
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
    except Exception as _e:
        print(f"[TEAM] Error provisioning rooftop org for user {user_id}: {_e}")


def _award_referral_credit(referred_user_id: int) -> None:
    """Award $25.00 billing credit to the referrer when a referred user upgrades to Pro.

    Idempotent — if the referral row is already ``'converted'`` (or absent),
    this is a silent no-op.  Safe to call multiple times.
    """
    CREDIT = 25.0

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row

    ref = conn.execute(
        "SELECT id, referrer_id FROM referrals "
        "WHERE referred_user_id = ? AND status = 'pending'",
        (referred_user_id,),
    ).fetchone()
    if not ref:
        conn.close()
        return  # no pending referral — nothing to award

    referrer_id = ref["referrer_id"]
    referral_id = ref["id"]

    referrer = conn.execute(
        "SELECT username, email, stripe_customer_id FROM users WHERE id = ?",
        (referrer_id,),
    ).fetchone()
    conn.close()
    if not referrer:
        return

    # Mark converted and increment the referrer's account credit atomically
    upd = sqlite3.connect(DB_FILE)
    try:
        upd.execute("UPDATE referrals SET status = 'converted' WHERE id = ?", (referral_id,))
        upd.execute(
            "UPDATE users SET account_credit = account_credit + ? WHERE id = ?",
            (CREDIT, referrer_id),
        )
        upd.commit()
    except Exception:
        try:
            upd.rollback()
        except Exception:
            pass
        raise
    finally:
        upd.close()
    print(
        f"[REFERRAL] Referral id={referral_id} converted — "
        f"${CREDIT:.2f} credited to user id={referrer_id}"
    )

    # Apply credit to the referrer's Stripe customer balance (−cents = credit)
    _rcid = referrer["stripe_customer_id"] or ""
    if _rcid and _stripe_module and STRIPE_SECRET_KEY:
        try:
            _stripe_module.api_key = STRIPE_SECRET_KEY
            _stripe_module.Customer.create_balance_transaction(
                _rcid,
                amount=-int(CREDIT * 100),
                currency="usd",
                description="Referral reward bonus credit",
            )
            print(f"[REFERRAL] Stripe balance credit applied to customer {_rcid}")
            _log_billing_event(
                referrer_id,
                "credit.awarded",
                credit_applied_cents=int(CREDIT * 100),
                description=(
                    f"Referral reward bonus credit of ${CREDIT:.2f} posted "
                    f"to Stripe balance for customer {_rcid}"
                ),
            )
        except Exception as _se:
            print(f"[REFERRAL] Stripe credit error: {_se}")

    # Fire-and-forget email notification to the referrer
    _remail = referrer["email"] or ""
    _rname  = referrer["username"] or "there"
    _app_url = APP_BASE_URL
    if _remail:
        _txt = (
            f"Hi {_rname},\n\n"
            f"Great news — someone you referred just upgraded to BDC Manager Desk Pro!\n\n"
            f"You've earned a $25.00 billing credit. This credit has been applied to your "
            f"account and will automatically reduce your next invoice.\n\n"
            f"Keep sharing your referral link to earn more:\n  {_app_url}/referrals\n\n"
            f"Thank you for spreading the word!\n"
            f"— The BDC Manager Desk Team"
        )
        _html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#16a34a;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">&#x1F4B8; You Earned a $25 Credit!</h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>{_rname}</strong>,</p>
            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
              Someone you referred just upgraded to <strong>BDC Manager Desk Pro</strong>.
              As a thank you, we've credited <strong>$25.00</strong> to your account balance.
            </p>
            <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
              <p style="margin:0;color:#15803d;font-size:32px;font-weight:700;">$25.00</p>
              <p style="margin:4px 0 0;color:#16a34a;font-size:14px;font-weight:600;">Applied to your next invoice</p>
            </div>
            <p style="margin:0 0 16px;color:#374151;font-size:14px;line-height:1.6;">
              This credit has been applied to your Stripe account balance and will automatically
              reduce your next billing cycle.
            </p>
            <p style="margin:0;color:#6b7280;font-size:13px;">
              Share your link: <a href="{_app_url}/referrals" style="color:#f97316;">{_app_url}/referrals</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>"""
        threading.Thread(
            target=_send_email,
            args=(_remail, "🎉 You Earned a $25 Referral Credit!", _txt, _html),
            daemon=True,
        ).start()


def _log_billing_event(
    user_id: int,
    event_type: str,
    stripe_invoice_id: str = '',
    amount_cents: int = 0,
    credit_applied_cents: int = 0,
    description: str = '',
) -> None:
    """Insert one row into billing_events — lightweight, fire-and-forget audit trail.

    Safe to call from any context (threads included) because it opens and
    closes its own connection.  Errors are logged to stdout and never re-raised
    so a logging failure can never block the caller.
    """
    try:
        _bl = sqlite3.connect(DB_FILE)
        try:
            _bl.execute(
                """INSERT INTO billing_events
                   (user_id, event_type, stripe_invoice_id,
                    amount_cents, credit_applied_cents, description)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    user_id, event_type, stripe_invoice_id,
                    amount_cents, credit_applied_cents, description,
                ),
            )
            _bl.commit()
        except Exception:
            try:
                _bl.rollback()
            except Exception:
                pass
            raise
        finally:
            _bl.close()
    except Exception as _ble:
        print(f"[BILLING] billing_events write error: {_ble}")


# ── Email provider constants / helpers (delegates to email_transporter) ───────
_GMAIL_HOST = 'smtp.gmail.com'
_GMAIL_PORT = 465  # SMTP_SSL


def _load_email_transporter():
    """Import email_transporter even when CWD is not artifacts/api-server."""
    try:
        import email_transporter as _mail
        return _mail
    except ImportError:
        import importlib.util
        import pathlib
        _mod_path = pathlib.Path(__file__).resolve().parent / "email_transporter.py"
        _spec = importlib.util.spec_from_file_location("email_transporter", _mod_path)
        if _spec is None or _spec.loader is None:
            raise ImportError("email_transporter.py not found")
        _mail = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mail)
        return _mail


def _send_email(to_addr: str, subject: str, body_text: str, body_html: str = '') -> bool:
    """Route one transactional email through the shared transporter module."""
    try:
        return _load_email_transporter().send_email(to_addr, subject, body_text, body_html)
    except Exception as err:
        print(f"[EMAIL] transporter failure: {err}")
        try:
            _load_email_transporter()._set_last_send_error(str(err))
        except Exception:
            pass
        return False


def _last_email_error() -> str:
    try:
        return str(_load_email_transporter().get_last_send_error() or "")
    except Exception:
        return ""


def _check_email_connection() -> None:
    """Verify / announce the active email provider at server startup."""
    try:
        _load_email_transporter().check_connection()
    except Exception as err:
        print(f"[EMAIL] connection check failed: {err}")


def _build_email_change_messages(
    *,
    new_email: str,
    old_email: str,
    revert_url: str,
    changed_at: str,
) -> tuple[str, str, str, str]:
    """Return (confirm_text, confirm_html, alert_text, alert_html)."""
    confirm_text = (
        "Hi,\n\n"
        "Your BDC Manager Desk account email address was successfully updated.\n\n"
        f"New email: {new_email}\n"
        f"Changed:   {changed_at}\n\n"
        "Your account remains verified — no further action is required.\n\n"
        "If you did not make this change, contact support immediately.\n\n"
        "— The BDC Manager Desk Team"
    )
    confirm_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#2563eb;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">Email Address Updated</h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;">
              Your <strong>BDC Manager Desk</strong> account email address was successfully updated.
            </p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin:0 0 24px;">
              <p style="margin:0 0 6px;font-size:13px;color:#166534;font-weight:600;">New email address</p>
              <p style="margin:0;font-size:15px;color:#15803d;font-weight:700;">{new_email}</p>
              <p style="margin:8px 0 0;font-size:12px;color:#166534;">Changed: {changed_at}</p>
            </div>
            <p style="margin:0;font-size:12px;color:#9ca3af;">— The BDC Manager Desk Team</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""

    alert_text = (
        "SECURITY ALERT — BDC Manager Desk\n\n"
        "The email address on your account was just changed.\n\n"
        f"Changed to:  {new_email}\n"
        f"Changed at:  {changed_at}\n"
        f"Previous:    {old_email or '(none)'}\n\n"
        "If YOU authorized this change, no action is needed.\n\n"
        "If you did NOT authorize this change, click the link below IMMEDIATELY\n"
        "to lock your account and revert the email address:\n\n"
        f"  {revert_url}\n\n"
        "This emergency link expires in 48 hours.\n\n"
        "— The BDC Manager Desk Security Team"
    )
    alert_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#dc2626;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">
              &#9888; SECURITY ALERT: Email Address Changed
            </h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;">
              The email address on your <strong>BDC Manager Desk</strong> account was just changed.
            </p>
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px 20px;margin:0 0 24px;">
              <p style="margin:0 0 4px;font-size:13px;color:#991b1b;font-weight:600;">Changed to</p>
              <p style="margin:0 0 8px;font-size:15px;color:#b91c1c;font-weight:700;">{new_email}</p>
              <p style="margin:0;font-size:12px;color:#991b1b;">At: {changed_at}</p>
            </div>
            <p style="margin:0 0 20px;font-size:15px;color:#111827;font-weight:600;">
              If you did NOT authorize this change, click below immediately:
            </p>
            <a href="{revert_url}"
               style="display:inline-block;background:#dc2626;color:#fff;padding:14px 28px;
                      border-radius:7px;text-decoration:none;font-weight:700;font-size:14px;">
              &#128274; Lock Account &amp; Revert Email Now
            </a>
            <p style="margin:20px 0 4px;font-size:12px;color:#9ca3af;">
              Or paste this link into your browser (expires in 48 hours):
            </p>
            <p style="margin:0 0 24px;font-size:12px;">
              <a href="{revert_url}" style="color:#dc2626;word-break:break-all;">{revert_url}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">— The BDC Manager Desk Security Team</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
    return confirm_text, confirm_html, alert_text, alert_html


def _dispatch_email_change_notifications(
    *,
    user_id: int,
    new_email: str,
    old_email: str,
    revert_token: str,
) -> dict:
    """Send security alert (old address) + confirmation (new address)."""
    revert_base = (APP_BASE_URL or "").rstrip("/") or "http://127.0.0.1:5173"
    revert_url = f"{revert_base}/api/security/revert-email?token={revert_token}"
    changed_at = datetime.now().strftime("%B %d, %Y at %I:%M %p UTC")
    confirm_text, confirm_html, alert_text, alert_html = _build_email_change_messages(
        new_email=new_email,
        old_email=old_email,
        revert_url=revert_url,
        changed_at=changed_at,
    )

    alert_sent = False
    errors: list[str] = []
    if old_email:
        alert_sent = bool(
            _send_email(
                old_email,
                "SECURITY ALERT: Email address changed on your BDC Manager Desk account",
                alert_text,
                alert_html,
            )
        )
        if not alert_sent:
            _err = _last_email_error() or "security alert send failed"
            errors.append(f"alert: {_err}")
        print(
            f"[AUTH] Email-change security alert -> {old_email!r} "
            f"(user id={user_id}, sent={alert_sent})"
        )
    else:
        print(f"[AUTH] No previous email on file for user id={user_id} — skip security alert.")

    confirm_sent = bool(
        _send_email(
            new_email,
            "Your BDC Manager Desk email address has been updated",
            confirm_text,
            confirm_html,
        )
    )
    if not confirm_sent:
        _err = _last_email_error() or "confirmation send failed"
        errors.append(f"confirm: {_err}")
    print(
        f"[AUTH] Email-change confirmation -> {new_email!r} "
        f"(user id={user_id}, sent={confirm_sent})"
    )
    return {
        "alert_sent": alert_sent,
        "confirm_sent": confirm_sent,
        "revert_url": revert_url,
        "error": " | ".join(errors),
    }


def _validate_email(email: str) -> str:
    """Normalise and basic-validate an email address.

    Returns the lower-cased email or raises ValueError.
    """
    email = email.strip().lower()
    if not email or '@' not in email or '.' not in email.split('@')[-1]:
        raise ValueError("A valid email address is required.")
    return email


# ── Anti-abuse registration blocklists ────────────────────────────────────────
# All real domains (gmail, yahoo, outlook, icloud, etc.) are accepted.
# Only known disposable / throwaway / temporary providers are blocked.

# Known disposable / temporary email providers.
_DISPOSABLE_DOMAINS: frozenset[str] = frozenset({
    # Mailinator family
    'mailinator.com', 'mailinator2.com', 'mailinator.net',
    'suremail.info', 'chammy.info', 'tradermail.info',
    # Guerrilla Mail family
    'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.biz',
    'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.org',
    'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'spam4.me',
    # 10 Minute Mail family
    '10minutemail.com', '10minutemail.net', '10minutemail.org',
    '10minutemail.co.za', 'tempr.email', '10minemail.com',
    # Temp Mail family
    'tempmail.com', 'tempmail.net', 'tempmail.org',
    'temp-mail.org', 'temp-mail.io', 'temp-mail.ru',
    # Throw-away / trash
    'trashmail.com', 'trashmail.net', 'trashmail.org', 'trashmail.me',
    'trashmail.at', 'trashmail.io', 'trashmail.xyz',
    'throwam.com', 'throwam.net', 'filzmail.com',
    'maildrop.cc', 'yopmail.com', 'yopmail.fr', 'cool.fr.nf',
    'jetable.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx', 'mega.zik.dj',
    'speed.1s.fr', 'courriel.fr.nf', 'moncourrier.fr.nf', 'monemail.fr.nf',
    'monmail.fr.nf',
    # Misc popular disposable
    'fakeinbox.com', 'discard.email', 'dispostable.com',
    'getnada.com', 'mailnull.com', 'spamgourmet.com',
    'spamgourmet.net', 'spamgourmet.org', 'spamex.com',
    'tempinbox.com', 'safetymail.info', 'mailexpire.com',
    'deadaddress.com', 'getairmail.com', 'mailnesia.com',
    'mailme.lv', 'disposeamail.com', 'throwam.net',
    'fakemails.net', 'tempemails.net', 'mailshell.com',
    'inoutmail.de', 'inoutmail.eu', 'inoutmail.net',
    'getonemail.com', 'binkmail.com', 'uggsrock.com',
})

class UserManager:
    """CRUD helpers for the users table and session tokens."""

    @staticmethod
    def register(
        username:        str,
        password:        str,
        email:           str = '',
        visitor_id:      str = '',
        referral_code:   str = '',
        org_invite:      str = '',
        account_type:    str = '',   # 'individual' | 'rooftop' — sets initial tier
        dealership_name: str = '',   # pre-fills dealer_name for rooftop admins
        extra_seats:     int = 0,    # additional seats above base 10 for rooftop plans
        billing_cycle:   str = '',   # 'monthly' | 'annual' | 'lifetime' — from landing page
    ) -> dict:
        """Create a new user account.

        ``email`` is required for password recovery; raises ValueError if
        missing or malformed.  A duplicate email is also rejected so the
        forgot-password flow can look users up unambiguously.

        ``visitor_id`` is the FingerprintJS browser fingerprint.  If provided,
        any existing trial registered from the same device within the last
        30 days is rejected.

        ``org_invite`` is a Rooftop team invite code.  If valid, the new user
        is automatically assigned to the organization and granted Pro access.
        Seat capacity is enforced: registration is rejected if the org is full.

        ``account_type`` of 'rooftop' sets ``subscription_tier = 'rooftop_pending'``
        so the billing system knows to route this user to the Rooftop checkout.
        ``dealership_name`` pre-fills the dealer_name column used for printed
        envelopes and email headers.
        """
        if len(username) < 3:
            raise ValueError("Username must be at least 3 characters.")
        if len(password) < 6:
            raise ValueError("Password must be at least 6 characters.")
        email = _validate_email(email)

        # ── Anti-abuse: block known disposable / throwaway providers only ──
        # All standard email domains (gmail, yahoo, outlook, icloud, etc.) are
        # accepted — only anonymous throwaway services are rejected.
        _domain = email.split('@')[-1].lower() if '@' in email else ''
        if _domain in _DISPOSABLE_DOMAINS:
            raise ValueError(
                "Disposable or temporary email addresses are not accepted. "
                "Please use a real email address (Gmail, Yahoo, Outlook, etc. are fine)."
            )

        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # ── Anti-abuse: device fingerprint deduplication (30-day window) ──
        if visitor_id:
            cursor.execute(
                "SELECT id FROM users "
                "WHERE visitor_id = ? AND visitor_id != '' "
                "AND created_at >= datetime('now', '-30 days')",
                (visitor_id,),
            )
            if cursor.fetchone():
                conn.close()
                raise ValueError(
                    "A free trial has already been activated on this device. "
                    "Please log in or upgrade to Pro."
                )

        # Check for duplicate email before attempting the INSERT
        cursor.execute(
            "SELECT id FROM users WHERE email = ? AND email != ''",
            (email,),
        )
        if cursor.fetchone():
            conn.close()
            raise ValueError("An account with that email already exists.")

        # Resolve the referral code (if provided) to a referrer user ID
        _referrer_id = None
        if referral_code:
            _rc_norm = referral_code.strip().upper()
            _rc_row = cursor.execute(
                "SELECT id FROM users WHERE referral_code = ? AND referral_code != ''",
                (_rc_norm,),
            ).fetchone()
            if _rc_row:
                _referrer_id = _rc_row["id"] if isinstance(_rc_row, dict) else _rc_row[0]

        # ── Org invite: validate code and check seat capacity ─────────────────
        _org_id_for_invite = None
        if org_invite:
            _oi_code    = org_invite.strip()
            _oi_org_row = cursor.execute(
                "SELECT id, seat_limit FROM organizations WHERE invite_code = ?",
                (_oi_code,),
            ).fetchone()
            if not _oi_org_row:
                conn.close()
                raise ValueError(
                    "Invalid team invite link. "
                    "Please ask your Dealership Admin for a fresh invite link."
                )
            _oi_org_id = _oi_org_row["id"]
            _oi_lim    = _oi_org_row["seat_limit"]
            _oi_cnt    = cursor.execute(
                "SELECT COUNT(*) AS cnt FROM users WHERE organization_id = ?",
                (_oi_org_id,),
            ).fetchone()
            _oi_used = int(_oi_cnt["cnt"]) if _oi_cnt else 0
            if _oi_used >= _oi_lim:
                conn.close()
                raise ValueError(
                    f"Seat limit reached ({_oi_used}/{_oi_lim}). "
                    "Please contact your Dealership Admin to upgrade or free up a seat."
                )
            _org_id_for_invite = _oi_org_id

        try:
            cursor.execute(
                """INSERT INTO users
                       (username, password_hash, email,
                        inventory_url_used, inventory_url_new, visitor_id,
                        recovery_id, referral_code, referred_by,
                        email_verified, role)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Reviewer')""",
                (
                    username.strip().lower(),
                    _hash_password(password),
                    email,
                    MOSES_USED_URL,
                    MOSES_NEW_URL,
                    visitor_id or '',
                    _generate_recovery_id(),
                    _generate_referral_code(username),
                    _referrer_id,
                ),
            )
            conn.commit()
            user_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            try:
                conn.rollback()
            except Exception:
                pass
            conn.close()
            raise ValueError("Username already exists.")

        # ── Account-type specific setup ───────────────────────────────────
        # Rooftop admins: mark tier as 'rooftop_pending' so the pricing page
        # routes them directly to the Rooftop Stripe checkout.
        # Dealership name: pre-fills the return-address used on printed mailers.
        # extra_seats: stored as pending_extra_seats until checkout completes.
        # billing_cycle: stored as pending_billing_cycle so the checkout session
        #   defaults to the interval the user selected on the landing page.
        _acct_sets: list[tuple[str, object]] = []
        if account_type == 'rooftop':
            _acct_sets.append(("subscription_tier = 'rooftop_pending'", None))
        if dealership_name:
            _acct_sets.append(("dealer_name = ?", dealership_name.strip()[:120]))
        _extra_seats_val = max(0, int(extra_seats)) if account_type == 'rooftop' else 0
        if _extra_seats_val > 0:
            _acct_sets.append(("pending_extra_seats = ?", _extra_seats_val))
        _billing_cycle_val = billing_cycle.strip().lower() if billing_cycle else 'monthly'
        if _billing_cycle_val not in ('monthly', 'annual', 'lifetime'):
            _billing_cycle_val = 'monthly'
        _acct_sets.append(("pending_billing_cycle = ?", _billing_cycle_val))
        if _acct_sets:
            _sql_parts = [s for s, _ in _acct_sets]
            _sql_vals  = [v for _, v in _acct_sets if v is not None]
            try:
                cursor.execute(
                    f"UPDATE users SET {', '.join(_sql_parts)} WHERE id = ?",
                    _sql_vals + [user_id],
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise

        # Seed the five canonical Moses locations for this brand-new account.
        try:
            for loc_name, loc_enabled in MOSES_DEFAULT_LOCATIONS:
                cursor.execute(
                    "INSERT OR IGNORE INTO user_locations "
                    "(user_id, location, enabled) VALUES (?, ?, ?)",
                    (user_id, loc_name, 1 if loc_enabled else 0),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise

        # Record the referral relationship if this user signed up via a referral link
        if _referrer_id:
            try:
                cursor.execute(
                    "INSERT OR IGNORE INTO referrals (referrer_id, referred_user_id) VALUES (?, ?)",
                    (_referrer_id, user_id),
                )
                conn.commit()
                print(f"[REFERRAL] User id={user_id} signed up via referral from user id={_referrer_id}")
            except Exception as _re:
                try:
                    conn.rollback()
                except Exception:
                    pass
                print(f"[REFERRAL] Failed to record referral row: {_re}")

        # Assign to org if registering via a team invite — grants immediate Pro access.
        if _org_id_for_invite:
            try:
                cursor.execute(
                    "UPDATE users SET organization_id = ?, org_role = 'member', "
                    "subscription_status = 'active' WHERE id = ?",
                    (_org_id_for_invite, user_id),
                )
                conn.commit()
                print(f"[TEAM] User {user_id} joined org {_org_id_for_invite} as member via invite")
            except Exception as _oe:
                try:
                    conn.rollback()
                except Exception:
                    pass
                print(f"[TEAM] Failed to assign user {user_id} to org: {_oe}")

        conn.close()
        print(f"[AUTH] Registration success — user id={user_id}, username={username.strip().lower()!r}")
        token = secrets.token_urlsafe(32)
        _ACTIVE_SESSIONS[token] = user_id
        _persist_token(token, user_id)
        # Stamp as the sole active session for this new account.
        try:
            _sid_conn = sqlite3.connect(DB_FILE)
            _sid_conn.execute(
                "UPDATE users SET active_session_id = ? WHERE id = ?",
                (token, user_id),
            )
            _sid_conn.commit()
            _sid_conn.close()
        except Exception:
            pass
        # Email verification is bypassed globally — accounts are verified at
        # registration. Clear any leftover token so the banner never appears.
        try:
            _vt_conn = sqlite3.connect(DB_FILE)
            _vt_conn.execute(
                "UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?",
                (user_id,),
            )
            _vt_conn.commit()
            _vt_conn.close()
        except Exception:
            pass
        return {
            "id":                    user_id,
            "username":              username.strip().lower(),
            "is_admin":              False,
            "subscription_status":   "inactive",
            "subscription_tier":     "rooftop_pending" if account_type == 'rooftop' else "",
            "email":                 email,
            "email_verified":        True,
            "token":                 token,
            "pending_extra_seats":   _extra_seats_val,
            "pending_billing_cycle": _billing_cycle_val,
            # Prefixed with "_" — stripped by the handler before sending to the client
            "_verification_token":   "",
        }

    @staticmethod
    def login(username: str, password: str) -> dict:
        normalized = username.strip().lower()
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        # Support login by username OR email so users can enter either.
        # email check is guarded by `email != ''` so empty-email rows
        # never accidentally match an empty input.
        cursor.execute(
            "SELECT id, username, email, password_hash, salesperson_id, is_admin, "
            "subscription_status, subscription_tier, org_role, organization_id, "
            "is_suspended, recovery_id, role FROM users "
            "WHERE LOWER(username) = ? OR (email != '' AND LOWER(email) = ?)",
            (normalized, normalized),
        )
        row = cursor.fetchone()
        print(f"[LOGIN CHECK] {{'inputUsername': {normalized!r}, 'userFound': {bool(row)}}}")
        conn.close()
        if not row:
            print(f"[AUTH] Login failed — no account for identifier: {normalized!r}")
            raise ValueError("Invalid username or password.")
        _master_user = os.environ.get('ADMIN_USER', 'mdemoss').strip().lower()
        _env_pass = (
            os.environ.get('ADMIN_PASSWORD')
            or os.environ.get('DASHBOARD_PASSWORD')
            or os.environ.get('LOGIN_PASSWORD')
            or 'Netsirk115!$'
        ).strip()
        _is_master = (
            str(row["username"] or "").strip().lower() in (_master_user, "mdemoss")
            or normalized in (_master_user, "mdemoss")
        )
        _env_ok = bool(_is_master and _env_pass and password == _env_pass)
        if not _env_ok and not _verify_password(password, row["password_hash"]):
            print(f"[LOGIN FAIL] Password mismatch for: {normalized}")
            print(f"[AUTH] Login failed — password mismatch "
                  f"(user id={row['id']}, username={row['username']!r})")
            raise ValueError("Invalid username or password.")
        if _env_ok and not _verify_password(password, row["password_hash"]):
            # Align stored hash with ADMIN_PASSWORD so Settings + future logins match.
            try:
                _sync = sqlite3.connect(DB_FILE)
                try:
                    _sync.execute(
                        "UPDATE users SET password_hash = ? WHERE id = ?",
                        (_hash_password(password), row["id"]),
                    )
                    _sync.commit()
                    print(f"[AUTH] Synced master-admin hash from ADMIN_PASSWORD "
                          f"(user id={row['id']})")
                finally:
                    _sync.close()
            except Exception as _sync_exc:
                print(f"[AUTH] Env password hash sync failed: {_sync_exc}")
        elif _verify_password(password, row["password_hash"]):
            _stored = str(row["password_hash"] or "")
            if not _stored.startswith(("$2a$", "$2b$", "$2y$")):
                try:
                    _up = sqlite3.connect(DB_FILE)
                    try:
                        _up.execute(
                            "UPDATE users SET password_hash = ? WHERE id = ?",
                            (_hash_password(password), row["id"]),
                        )
                        _up.commit()
                        print(f"[AUTH] Upgraded user id={row['id']} hash to bcrypt")
                    finally:
                        _up.close()
                except Exception as _up_exc:
                    print(f"[AUTH] bcrypt upgrade skipped: {_up_exc}")
        if row["is_suspended"]:
            print(f"[AUTH] Login blocked — account suspended (user id={row['id']})")
            raise ValueError("This account has been suspended. Please contact support.")
        print(f"[AUTH] Login success — user id={row['id']}, username={row['username']!r}")
        # Backfill recovery_id for accounts created before this feature existed
        if not row["recovery_id"]:
            _bf_rid = _generate_recovery_id()
            _bf_conn = sqlite3.connect(DB_FILE)
            try:
                _bf_conn.execute(
                    "UPDATE users SET recovery_id = ? WHERE id = ?",
                    (_bf_rid, row["id"]),
                )
                _bf_conn.commit()
            except Exception:
                try:
                    _bf_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _bf_conn.close()
        token = secrets.token_urlsafe(32)
        _ACTIVE_SESSIONS[token] = row["id"]
        _persist_token(token, row["id"])
        # Stamp this token as the sole active session — any prior session for
        # this account is immediately displaced the next time it makes a request.
        try:
            _sid_conn = sqlite3.connect(DB_FILE)
            _sid_conn.execute(
                "UPDATE users SET active_session_id = ? WHERE id = ?",
                (token, row["id"]),
            )
            _sid_conn.commit()
            _sid_conn.close()
        except Exception:
            pass
        _mu = os.environ.get('ADMIN_USER', 'mdemoss').strip().lower()
        _uname = (row["username"] or "").lower()
        _is_master = bool(row["is_admin"]) and _uname == _mu
        _role = (row["role"] or "").strip() or (
            "Admin" if _is_master or _uname == "mdemoss" or row["is_admin"]
            else "Reviewer"
        )
        return {
            "id":                  row["id"],
            "username":            row["username"],
            "email":               row["email"] or "",
            "salesperson_id":      row["salesperson_id"] or "",
            "is_admin":            bool(row["is_admin"]),
            "is_master_admin":     _is_master,
            "role":                _role,
            "rbac_role":           _role,
            "is_suspended":        bool(row["is_suspended"]),
            "subscription_status": row["subscription_status"] or "inactive",
            "subscription_tier":   row["subscription_tier"] or "",
            "org_role":            row["org_role"] or "",
            "organization_id":     row["organization_id"],
            "email_verified":      True,
            "token":               token,
        }

    @staticmethod
    def dev_login(identifier: str) -> dict:
        """Mint a real session for a local test account, no password required.

        Only reachable while DEV_AUTOLOGIN is on, which in turn requires the
        on-disk SQLite preview DB. Falls back to the lowest-id account so a
        fresh clone still boots when DEV_LOGIN_USER doesn't exist yet.

        mock_role is cleared so a "view as" override left over from an earlier
        session can't redirect the dev straight back off the dashboard.
        """
        _cols = (
            "SELECT id, username, email, salesperson_id, is_admin, "
            "subscription_status, subscription_tier, org_role, organization_id, "
            "is_suspended, email_verified FROM users "
        )
        normalized = (identifier or "").strip().lower()
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            _cols + "WHERE LOWER(username) = ? OR (email != '' AND LOWER(email) = ?)",
            (normalized, normalized),
        )
        row = cursor.fetchone()
        if not row:
            cursor.execute(_cols + "ORDER BY id LIMIT 1")
            row = cursor.fetchone()
        conn.close()
        if not row:
            raise ValueError(
                "No accounts exist in the local database yet — register one first."
            )

        token = secrets.token_urlsafe(32)
        _ACTIVE_SESSIONS[token] = row["id"]
        _persist_token(token, row["id"])
        try:
            _sid_conn = sqlite3.connect(DB_FILE)
            _sid_conn.execute(
                "UPDATE users SET active_session_id = ?, mock_role = '' WHERE id = ?",
                (token, row["id"]),
            )
            _sid_conn.commit()
            _sid_conn.close()
        except Exception:
            pass

        print(f"[AUTH] DEV auto-login — user id={row['id']}, "
              f"username={row['username']!r} (no password checked)")
        return {
            "id":                  row["id"],
            "username":            row["username"],
            "email":               row["email"] or "",
            "salesperson_id":      row["salesperson_id"] or "",
            "is_admin":            bool(row["is_admin"]),
            "is_suspended":        bool(row["is_suspended"]),
            "subscription_status": row["subscription_status"] or "inactive",
            "subscription_tier":   row["subscription_tier"] or "",
            "org_role":            row["org_role"] or "",
            "organization_id":     row["organization_id"],
            "email_verified":      bool(row["email_verified"]),
            "mock_role":           "",
            "token":               token,
        }

    @staticmethod
    def change_password(user_id: int, current_password: str, new_password: str) -> None:
        """Verify ``current_password`` then replace with ``new_password``.

        Raises ValueError on bad current password or weak new password.
        """
        if len(new_password) < 6:
            raise ValueError("New password must be at least 6 characters.")
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        conn.close()
        if not row or not _verify_password(current_password, row["password_hash"]):
            raise ValueError("Current password is incorrect.")
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (_hash_password(new_password), user_id),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def request_password_reset(email: str) -> str | None:
        """Generate a 1-hour reset token for the account with ``email``.

        Returns the raw token string, or None if no matching account exists.
        Callers should always respond with a generic "check your inbox" message
        regardless of the return value to prevent email enumeration.
        """
        email = email.strip().lower()
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM users WHERE email = ? AND email != ''",
            (email,),
        )
        row = cursor.fetchone()
        if not row:
            conn.close()
            return None
        user_id = row["id"]
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now() + timedelta(hours=1)).isoformat()
        try:
            cursor.execute(
                "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
                (user_id, token, expires_at),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return token

    @staticmethod
    def reset_password_with_token(token: str, new_password: str) -> None:
        """Validate ``token`` and set ``new_password`` for the associated account.

        Raises ValueError with a user-friendly message on any failure so the
        caller can forward it directly to the client.
        """
        if len(new_password) < 6:
            raise ValueError("Password must be at least 6 characters.")
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = ?",
            (token.strip(),),
        )
        row = cursor.fetchone()
        if not row:
            conn.close()
            raise ValueError("Invalid or expired reset link. Please request a new one.")
        if row["used"]:
            conn.close()
            raise ValueError("This reset link has already been used. Please request a new one.")
        try:
            if datetime.now() > datetime.fromisoformat(row["expires_at"]):
                conn.close()
                raise ValueError("This reset link has expired. Please request a new one.")
        except (TypeError, ValueError):
            pass
        try:
            cursor.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (_hash_password(new_password), row["user_id"]),
            )
            cursor.execute(
                "UPDATE password_reset_tokens SET used = 1 WHERE id = ?",
                (row["id"],),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def logout(token: str):
        _revoke_token(token)

    @staticmethod
    def get_user_by_token(token: str) -> dict | None:
        """Return id, username, and salesperson_id for the session token."""
        user_id = _resolve_user_id(token)
        if not user_id:
            return None
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, email, salesperson_id, is_admin, subscription_status, "
            "subscription_tier, org_role, organization_id, email_verified, is_suspended, "
            "created_at, recovery_id, mock_role, role, "
            "tiktok_open_id, tiktok_access_token, tiktok_token_expires_at, "
            "tiktok_trial_start_date, tiktok_daily_posts, tiktok_privacy_level, pending_extra_seats, "
            "pending_billing_cycle, active_session_id FROM users WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        conn.close()
        if not row:
            return None
        # Single-session enforcement: if active_session_id is set and doesn't
        # match the token that was presented, a newer login has displaced this
        # session. Return a sentinel so _require_auth can emit the right 401.
        # Skipped under ALLOW_MULTI_SESSION (local preview only) so multiple dev
        # tabs can hold sessions at once instead of evicting each other.
        _stored_sid = row["active_session_id"] or ""
        if _stored_sid and _stored_sid != token and not ALLOW_MULTI_SESSION:
            return {"_session_displaced": True}
        # Backfill recovery_id on first /api/auth/me call (handles legacy sessions)
        _rid = row["recovery_id"]
        if not _rid:
            _rid = _generate_recovery_id()
            _bf2 = sqlite3.connect(DB_FILE)
            try:
                _bf2.execute(
                    "UPDATE users SET recovery_id = ? WHERE id = ?",
                    (_rid, row["id"]),
                )
                _bf2.commit()
            except Exception:
                try:
                    _bf2.rollback()
                except Exception:
                    pass
                raise
            finally:
                _bf2.close()
        # Build master-admin flag using the same env-var logic as startup
        _mu = os.environ.get('ADMIN_USER',  'mdemoss').strip().lower()
        _me = os.environ.get('ADMIN_EMAIL', '').strip().lower()
        _uname = (row["username"] or '').lower()
        _uemail = (row["email"] or '').lower()
        _is_master = bool(row["is_admin"]) and (
            _uname == _mu or (_me and _uemail == _me)
        )
        # Master admin always receives 'pro_lifetime' tier regardless of what is
        # stored in the DB, so the frontend pricing page and subscription guards
        # always see the correct entitlement even across impersonation views.
        _tier = "pro_lifetime" if _is_master else (row["subscription_tier"] or "")
        _status = "active" if _is_master else (row["subscription_status"] or "inactive")
        _role = (row["role"] or "").strip() or (
            "Admin" if _is_master or _uname == "mdemoss" or row["is_admin"]
            else "Reviewer"
        )
        return {
            "id":                  row["id"],
            "username":            row["username"],
            "email":               row["email"] or "",
            "salesperson_id":      row["salesperson_id"] or "",
            "is_admin":            bool(row["is_admin"]),
            "is_master_admin":     _is_master,
            "role":                _role,
            "rbac_role":           _role,
            "subscription_status": _status,
            "subscription_tier":   _tier,
            "org_role":            row["org_role"] or "",
            "organization_id":     row["organization_id"],
            "email_verified":      bool(row["email_verified"]),
            "is_suspended":        bool(row["is_suspended"]),
            "created_at":          row["created_at"] or "",
            "recovery_id":         _rid,
            # Only expose mock_role for the master admin account
            "mock_role":           (row["mock_role"] or "") if _is_master else "",
            "tiktok_open_id":           row["tiktok_open_id"] or "",
            "tiktok_access_token":      row["tiktok_access_token"] or "",
            "tiktok_token_expires_at":  row["tiktok_token_expires_at"] or "",
            "tiktok_trial_start_date":  row["tiktok_trial_start_date"] or "",
            "tiktok_daily_posts":       row["tiktok_daily_posts"] or "{}",
            "tiktok_privacy_level":     row["tiktok_privacy_level"] or "SELF_ONLY",
            "pending_extra_seats":      int(row["pending_extra_seats"] or 0),
            "pending_billing_cycle":    row["pending_billing_cycle"] or "monthly",
        }

    @staticmethod
    def get_settings(token: str) -> dict:
        """Return all user settings including inventory source and catalog config."""
        user_id = _resolve_user_id(token)
        if not user_id:
            return {}
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """SELECT crm_provider,
                      cox_client_id, cox_client_secret, cox_dealer_id,
                      dealerpeak_api_key, dealerpeak_dealer_id,
                      salesperson_id, auto_send_emails,
                      inventory_url_used, inventory_url_new, inventory_locations,
                      salesperson_filter, catalog_token,
                      email, phone, fb_page_id, fb_access_token, scraper_frequency,
                      dealer_name, dealer_address_line1,
                      dealer_city, dealer_state, dealer_zip,
                      dealer_phone, dealer_support_email, dealer_logo_url,
                      facebook_business_manager_id, commerce_catalog_id, meta_pixel_id
               FROM users WHERE id = ?""",
            (user_id,),
        )
        row = cursor.fetchone()
        conn.close()
        if not row:
            return {}
        out = {**dict(row), 'user_id': user_id}
        if _scraper_engine is not None:
            out['inventory_locations'] = _scraper_engine.normalize_inventory_locations(
                out.get('inventory_locations')
            )
        return out

    @staticmethod
    def get_settings_by_id(user_id: int) -> dict:
        """Like get_settings but accepts a user_id directly (no token needed)."""
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """SELECT inventory_url_used, inventory_url_new, inventory_locations,
                      dealer_name, salesperson_filter, scraper_frequency
               FROM users WHERE id = ?""",
            (user_id,),
        )
        row = cursor.fetchone()
        conn.close()
        if not row:
            return {}
        out = dict(row)
        if _scraper_engine is not None:
            out['inventory_locations'] = _scraper_engine.normalize_inventory_locations(
                out.get('inventory_locations')
            )
        return out

    @staticmethod
    def get_all_users() -> list[dict]:
        """Return every registered user with their inventory sync URLs.

        Used by background workers (MosesScraperWorker, PostingQueueWorker)
        to iterate over all accounts without needing a session token.
        """
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, inventory_url_used, inventory_url_new, "
            "inventory_locations, dealer_name FROM users"
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_user_by_catalog_token(catalog_token: str) -> dict | None:
        """Return basic user info for the given catalog_token, or None if not found.

        The catalog_token is an opaque string stored per-user in settings.
        It is the public identifier used in the /api/v1/catalog/<token>.csv URL
        so that the raw numeric user ID is never exposed in feed URLs.
        """
        if not catalog_token:
            return None
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, is_admin, subscription_status "
            "FROM users WHERE catalog_token = ?",
            (catalog_token,),
        )
        row = cursor.fetchone()
        conn.close()
        if not row:
            return None
        return {
            "id":                  row["id"],
            "username":            row["username"],
            "is_admin":            bool(row["is_admin"]),
            "subscription_status": row["subscription_status"] or "inactive",
        }


# =====================================================================
# LEGAL AGREEMENT DB
# =====================================================================
class LegalAgreementDB:
    """Immutable audit log of Terms of Service acceptances.

    Each row records one acceptance event (context = 'registration' |
    'checkout') with the user ID, originating IP address, browser
    User-Agent, and wall-clock timestamp.  This data is submitted to
    payment processors (e.g. Stripe) as proof in chargeback disputes.
    """

    @staticmethod
    def record(user_id: int, context: str,
               ip_address: str = '', user_agent: str = '') -> None:
        """Append an acceptance record. Each call creates a new row so
        the complete history is preserved — no updates, only inserts."""
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO legal_agreements
                    (user_id, context, ip_address, user_agent, agreed)
                VALUES (?, ?, ?, ?, 1)
                """,
                (user_id, context, ip_address[:256], user_agent[:512]),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        print(
            f"[LEGAL] ToS accepted — user_id={user_id} "
            f"context={context} ip={ip_address}"
        )


# =====================================================================
# BILLING MANAGER (Stripe)
# =====================================================================
class BillingManager:
    """Stripe checkout session creation, webhook processing, and status queries."""

    @staticmethod
    def get_status(user_id: int) -> dict:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT subscription_status, subscription_tier, is_admin, stripe_customer_id, "
            "stripe_subscription_id, subscription_period_end, "
            "subscription_cancel_scheduled "
            "FROM users WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        conn.close()
        if not row:
            return {"subscription_status": "inactive", "subscription_tier": "", "is_admin": False}
        return {
            "subscription_status":           row["subscription_status"] or "inactive",
            "subscription_tier":             row["subscription_tier"] or "",
            "is_admin":                      bool(row["is_admin"]),
            "stripe_customer_id":            row["stripe_customer_id"] or "",
            "stripe_subscription_id":        row["stripe_subscription_id"] or "",
            "subscription_period_end":       row["subscription_period_end"] or "",
            "subscription_cancel_scheduled": bool(row["subscription_cancel_scheduled"]),
        }

    @staticmethod
    def cancel_subscription(user_id: int) -> dict:
        """Set cancel_at_period_end = True on the user's active Stripe subscription.

        Does NOT cancel immediately — the subscription stays active until the
        current billing period ends, then Stripe fires customer.subscription.deleted.
        Returns the cancellation timestamp (ISO 8601 UTC).
        """
        if _stripe_module is None or not STRIPE_SECRET_KEY:
            raise RuntimeError("Stripe is not configured on this server.")
        _stripe_module.api_key = STRIPE_SECRET_KEY

        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT stripe_subscription_id FROM users WHERE id = ?", (user_id,)
        )
        row = cursor.fetchone()
        conn.close()
        sub_id = (row["stripe_subscription_id"] or "") if row else ""
        if not sub_id:
            raise ValueError("No active Stripe subscription found for this account.")

        sub = _stripe_module.Subscription.modify(sub_id, cancel_at_period_end=True)
        period_end = sub.get("current_period_end")
        period_end_str = ""
        if period_end:
            try:
                period_end_str = datetime.utcfromtimestamp(int(period_end)).strftime('%Y-%m-%dT%H:%M:%SZ')
            except Exception:
                pass

        conn2 = sqlite3.connect(DB_FILE)
        try:
            conn2.execute(
                "UPDATE users SET subscription_cancel_scheduled = 1, "
                "subscription_period_end = ? WHERE id = ?",
                (period_end_str, user_id),
            )
            conn2.commit()
        except Exception:
            try:
                conn2.rollback()
            except Exception:
                pass
            raise
        finally:
            conn2.close()
        print(f"[BILLING] cancel_at_period_end set — user_id={user_id}, ends={period_end_str}")
        return {"period_end": period_end_str}

    @staticmethod
    def reactivate_subscription(user_id: int) -> dict:
        """Clear cancel_at_period_end on the user's Stripe subscription.

        The subscription continues as normal; no cancellation will occur at
        the end of the current period.
        """
        if _stripe_module is None or not STRIPE_SECRET_KEY:
            raise RuntimeError("Stripe is not configured on this server.")
        _stripe_module.api_key = STRIPE_SECRET_KEY

        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT stripe_subscription_id FROM users WHERE id = ?", (user_id,)
        )
        row = cursor.fetchone()
        conn.close()
        sub_id = (row["stripe_subscription_id"] or "") if row else ""
        if not sub_id:
            raise ValueError("No active Stripe subscription found for this account.")

        _stripe_module.Subscription.modify(sub_id, cancel_at_period_end=False)

        conn2 = sqlite3.connect(DB_FILE)
        try:
            conn2.execute(
                "UPDATE users SET subscription_cancel_scheduled = 0 WHERE id = ?",
                (user_id,),
            )
            conn2.commit()
        except Exception:
            try:
                conn2.rollback()
            except Exception:
                pass
            raise
        finally:
            conn2.close()
        print(f"[BILLING] reactivated — user_id={user_id}")
        return {"status": "reactivated"}

    # ── Plan catalogue ────────────────────────────────────────────────────────
    # All amounts are in cents (USD).
    _PLANS: dict = {
        # ── Individual Pro Rep ─────────────────────────────────────────────
        "pro_monthly": {
            "name":     "BDC Manager Desk — Pro Rep (Monthly)",
            "mode":     "subscription",
            "amount":   14900,       # $149.00/mo
            "interval": "month",
        },
        "pro_annual": {
            "name":     "BDC Manager Desk — Pro Rep (Annual · 2 Months Free)",
            "mode":     "subscription",
            "amount":   149000,      # $1,490.00/yr  (2 months free vs monthly)
            "interval": "year",
        },
        "pro_lifetime": {
            "name":     "BDC Manager Desk — Pro Rep Lifetime Pass",
            "mode":     "payment",
            "amount":   499500,      # $4,995.00 one-time
        },
        # ── Dealership Rooftop (up to 10 seats) ────────────────────────────
        "rooftop_monthly": {
            "name":     "BDC Manager Desk — Dealership Rooftop (Monthly · 10 Seats)",
            "mode":     "subscription",
            "amount":   49500,       # $495.00/mo
            "interval": "month",
        },
        "rooftop_annual": {
            "name":     "BDC Manager Desk — Dealership Rooftop (Annual · 2 Months Free · 10 Seats)",
            "mode":     "subscription",
            "amount":   495000,      # $4,950.00/yr  (2 months free vs monthly)
            "interval": "year",
        },
        "rooftop_lifetime": {
            "name":     "BDC Manager Desk — Dealership Rooftop Lifetime Pass (10 Seats)",
            "mode":     "payment",
            "amount":   1499500,     # $14,995.00 one-time
        },
    }

    @staticmethod
    def create_checkout_session(
        user_id: int,
        username: str,
        plan: str,
        success_url: str,
        cancel_url: str,
        extra_seats: int = 0,
    ) -> str:
        """Create a Stripe Checkout session for the requested subscription plan.

        ``plan`` must be one of the keys in ``BillingManager._PLANS``.
        Recurring plans (monthly/annual) use ``mode='subscription'``;
        Lifetime Pass plans use ``mode='payment'`` (one-time charge, no sub).

        ``extra_seats`` adds an additional line item for seats above the base 10
        included in Rooftop plans ($39/mo, $390/yr, or $990 one-time per seat).
        The count is stored in checkout metadata so the webhook can provision
        the org with the correct seat_limit from day one.
        """
        if _stripe_module is None:
            raise RuntimeError("stripe package is not installed on this server.")
        if not STRIPE_SECRET_KEY:
            raise RuntimeError("STRIPE_SECRET_KEY environment variable is not configured.")

        plan_cfg = BillingManager._PLANS.get(plan)
        if not plan_cfg:
            raise ValueError(
                f"Unknown plan '{plan}'. Valid plans: {', '.join(BillingManager._PLANS)}"
            )
        _stripe_module.api_key = STRIPE_SECRET_KEY

        # Fetch (or create) the Stripe Customer record for this user.
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT stripe_customer_id FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        conn.close()
        customer_id = (row["stripe_customer_id"] or "") if row else ""

        if not customer_id:
            customer = _stripe_module.Customer.create(
                description=username,
                metadata={"user_id": str(user_id), "username": username},
            )
            customer_id = customer.id
            conn2 = sqlite3.connect(DB_FILE)
            try:
                conn2.execute(
                    "UPDATE users SET stripe_customer_id = ? WHERE id = ?",
                    (customer_id, user_id),
                )
                conn2.commit()
            except Exception:
                try:
                    conn2.rollback()
                except Exception:
                    pass
                raise
            finally:
                conn2.close()

        mode   = plan_cfg["mode"]
        amount = plan_cfg["amount"]
        name   = plan_cfg["name"]
        _extra = max(0, int(extra_seats))

        if mode == "subscription":
            _interval = plan_cfg["interval"]
            line_items = [{
                "price_data": {
                    "currency":     "usd",
                    "product_data": {"name": name},
                    "unit_amount":  amount,
                    "recurring":    {"interval": _interval},
                },
                "quantity": 1,
            }]
            # Extra seats for rooftop plans: $39/mo or $390/yr per additional seat
            if _extra > 0 and plan.startswith("rooftop_"):
                _seat_unit = 39000 if _interval == "year" else 3900
                line_items.append({
                    "price_data": {
                        "currency":     "usd",
                        "product_data": {
                            "name": f"BDC Manager Desk — Extra Seats (+{_extra} seat{'s' if _extra != 1 else ''})",
                        },
                        "unit_amount":  _seat_unit,
                        "recurring":    {"interval": _interval},
                    },
                    "quantity": _extra,
                })
        else:
            # Lifetime Pass — one-time payment, no recurring charges.
            line_items = [{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name":        name,
                        "description": "Pay once, use forever. No recurring charges.",
                    },
                    "unit_amount": amount,
                },
                "quantity": 1,
            }]
            # Extra seats for rooftop lifetime: $990 one-time per additional seat
            if _extra > 0 and plan.startswith("rooftop_"):
                line_items.append({
                    "price_data": {
                        "currency": "usd",
                        "product_data": {
                            "name": f"BDC Manager Desk — Extra Seats (+{_extra} seat{'s' if _extra != 1 else ''}, Lifetime)",
                            "description": "Pay once — seats never expire.",
                        },
                        "unit_amount": 99000,  # $990 one-time per extra seat
                    },
                    "quantity": _extra,
                })

        session = _stripe_module.checkout.Session.create(
            customer=customer_id,
            mode=mode,
            line_items=line_items,
            # plan + extra_seats stored in metadata so the webhook knows which
            # tier to activate and how many seats to provision from day one.
            metadata={
                "user_id":    str(user_id),
                "plan":       plan,
                "extra_seats": str(_extra),
            },
            success_url=success_url,
            cancel_url=cancel_url,
        )
        return session.url  # type: ignore[return-value]

    @staticmethod
    def create_video_checkout_session(success_url: str, cancel_url: str) -> str:
        """One-time $3.00 Stripe Checkout session to unlock video upload for a single listing."""
        if _stripe_module is None:
            raise RuntimeError("stripe package is not installed on this server.")
        if not STRIPE_SECRET_KEY:
            raise RuntimeError("STRIPE_SECRET_KEY environment variable is not configured.")
        _stripe_module.api_key = STRIPE_SECRET_KEY
        session = _stripe_module.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name": "BDC Manager Desk — Video Post Unlock",
                        "description": "Attach a walkaround video to one Facebook Marketplace listing",
                    },
                    "unit_amount": 300,  # $3.00
                },
                "quantity": 1,
            }],
            success_url=success_url,
            cancel_url=cancel_url,
        )
        return session.url  # type: ignore[return-value]

    @staticmethod
    def verify_video_session(session_id: str) -> bool:
        """Return True when the given Stripe Checkout session has been paid."""
        if _stripe_module is None or not STRIPE_SECRET_KEY:
            return False
        _stripe_module.api_key = STRIPE_SECRET_KEY
        try:
            sess = _stripe_module.checkout.Session.retrieve(session_id)
            return sess.get("payment_status") == "paid"
        except Exception:
            return False

    @staticmethod
    def handle_webhook(payload_bytes: bytes, sig_header: str) -> None:
        if _stripe_module is None:
            raise RuntimeError("stripe package is not installed on this server.")
        _stripe_module.api_key = STRIPE_SECRET_KEY

        if not STRIPE_WEBHOOK_SECRET:
            raise RuntimeError("STRIPE_WEBHOOK_SECRET environment variable is not configured.")

        try:
            event = _stripe_module.Webhook.construct_event(
                payload_bytes, sig_header, STRIPE_WEBHOOK_SECRET
            )
        except _stripe_module.error.SignatureVerificationError as exc:
            raise ValueError(f"Invalid webhook signature: {exc}") from exc

        event_type = event["type"]
        obj = event["data"]["object"]

        if event_type == "checkout.session.completed":
            _meta           = obj.get("metadata", {})
            user_id_str     = _meta.get("user_id")
            plan            = _meta.get("plan", "pro_monthly")
            mode            = obj.get("mode", "subscription")
            subscription_id = obj.get("subscription")
            customer_id     = obj.get("customer")
            payment_status  = obj.get("payment_status", "")

            if not user_id_str:
                print("[BILLING] checkout.session.completed — no user_id in metadata, skipping.")
                return

            _uid = int(user_id_str)

            # ── Seat expansion: expand org capacity, skip subscription update ──
            if _meta.get("type") == "seat_expansion":
                _se_org_id   = int(_meta.get("org_id", 0))
                _se_extra    = int(_meta.get("extra_seats", 0))
                if _se_org_id > 0 and _se_extra > 0 and (
                    (mode == "payment" and payment_status == "paid") or
                    (mode == "subscription" and obj.get("subscription"))
                ):
                    _se_conn = sqlite3.connect(DB_FILE)
                    try:
                        _se_conn.execute(
                            "UPDATE organizations SET seat_limit = seat_limit + ? WHERE id = ?",
                            (_se_extra, _se_org_id),
                        )
                        _se_conn.commit()
                    except Exception:
                        try:
                            _se_conn.rollback()
                        except Exception:
                            pass
                        raise
                    finally:
                        _se_conn.close()
                    print(
                        f"[TEAM] Seat expansion: org {_se_org_id} += {_se_extra} seats "
                        f"(interval={_meta.get('interval')}, user={_uid})."
                    )
                else:
                    print(f"[TEAM] Seat expansion skipped: org={_se_org_id}, seats={_se_extra}, mode={mode}, status={payment_status}.")
                return

            if mode == "payment" and payment_status == "paid":
                # Lifetime Pass — one-time charge; no subscription_id.
                # subscription_status is set to 'active' permanently; no
                # subscription_period_end means expiry checks never fire.
                conn = sqlite3.connect(DB_FILE)
                try:
                    conn.execute(
                        "UPDATE users SET stripe_customer_id = COALESCE(NULLIF(?, ''), stripe_customer_id), "
                        "subscription_status = 'active', subscription_tier = ? WHERE id = ?",
                        (customer_id or "", plan, _uid),
                    )
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()
                print(
                    f"[BILLING] checkout.session.completed (lifetime) — "
                    f"user {user_id_str} -> plan={plan}, status=active."
                )
            elif mode == "subscription" and subscription_id:
                conn = sqlite3.connect(DB_FILE)
                try:
                    conn.execute(
                        "UPDATE users SET stripe_subscription_id = ?, stripe_customer_id = ?, "
                        "subscription_status = 'active', subscription_tier = ? WHERE id = ?",
                        (subscription_id, customer_id or "", plan, _uid),
                    )
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()
                print(
                    f"[BILLING] checkout.session.completed (subscription) — "
                    f"user {user_id_str} -> plan={plan}, sub_id={subscription_id}."
                )
            else:
                print(
                    f"[BILLING] checkout.session.completed — unhandled "
                    f"mode={mode}, payment_status={payment_status}; skipping."
                )
                return

            # Provision Rooftop organization for rooftop plan checkouts.
            if plan.startswith('rooftop_'):
                try:
                    _pv_conn = sqlite3.connect(DB_FILE)
                    _pv_conn.row_factory = sqlite3.Row
                    _pv_row  = _pv_conn.execute(
                        "SELECT username FROM users WHERE id = ?", (_uid,)
                    ).fetchone()
                    _pv_conn.close()
                    _pv_uname = _pv_row["username"] if _pv_row else str(_uid)
                    # Pass extra_seats from checkout metadata so the org is
                    # provisioned with seat_limit = 10 + extra_seats from day one.
                    _pv_extra = int(_meta.get("extra_seats", 0) or 0)
                    _provision_rooftop_org(_uid, _pv_uname, plan, _pv_extra)
                except Exception as _pe:
                    print(f"[TEAM] Org provision error for user {_uid}: {_pe}")

            # Award referral credit to the referrer if this user was referred.
            try:
                _award_referral_credit(_uid)
            except Exception as _re:
                print(f"[REFERRAL] Award credit error after checkout: {_re}")

        elif event_type == "customer.subscription.updated":
            subscription_id      = obj.get("id")
            stripe_status        = obj.get("status", "")
            cancel_at_period_end = bool(obj.get("cancel_at_period_end", False))
            current_period_end   = obj.get("current_period_end")
            db_status = "active" if stripe_status in ("active", "trialing") else "inactive"
            period_end_str = ""
            if current_period_end:
                try:
                    period_end_str = datetime.utcfromtimestamp(
                        int(current_period_end)
                    ).strftime('%Y-%m-%dT%H:%M:%SZ')
                except Exception:
                    pass
            if subscription_id:
                conn = sqlite3.connect(DB_FILE)
                try:
                    conn.execute(
                        "UPDATE users SET subscription_status = ?, "
                        "subscription_cancel_scheduled = ?, "
                        "subscription_period_end = ? "
                        "WHERE stripe_subscription_id = ?",
                        (db_status, int(cancel_at_period_end), period_end_str, subscription_id),
                    )
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()
                print(
                    f"[BILLING] subscription.updated — {subscription_id} -> {db_status}, "
                    f"cancel_scheduled={cancel_at_period_end}, period_end={period_end_str}."
                )

        elif event_type == "customer.subscription.deleted":
            subscription_id = obj.get("id")
            if subscription_id:
                conn = sqlite3.connect(DB_FILE)
                try:
                    # Lifetime accounts never have a stripe_subscription_id so this
                    # guard is belt-and-suspenders — they are never accidentally deactivated.
                    conn.execute(
                        "UPDATE users SET subscription_status = 'inactive', "
                        "stripe_subscription_id = '', subscription_tier = '', "
                        "subscription_cancel_scheduled = 0, subscription_period_end = '' "
                        "WHERE stripe_subscription_id = ? "
                        "AND (subscription_tier IS NULL OR subscription_tier NOT LIKE '%_lifetime')",
                        (subscription_id,),
                    )
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()
                print(f"[BILLING] subscription.deleted — {subscription_id} deactivated.")

        elif event_type == "invoice.created":
            # Stripe automatically applies any negative customer balance (credit) to
            # newly-created invoices.  Log the event as an audit trail so we have a
            # record of when the balance was queued for deduction.
            _ic_customer = obj.get("customer")
            _ic_inv_id   = obj.get("id", "")
            _ic_starting = obj.get("starting_balance", 0)   # negative = credit available
            if _ic_customer and _ic_starting < 0:
                _ic_conn = sqlite3.connect(DB_FILE)
                _ic_conn.row_factory = sqlite3.Row
                _ic_user = _ic_conn.execute(
                    "SELECT id FROM users WHERE stripe_customer_id = ?",
                    (_ic_customer,),
                ).fetchone()
                _ic_conn.close()
                if _ic_user:
                    _ic_credit = abs(_ic_starting)
                    _log_billing_event(
                        _ic_user["id"],
                        "invoice.created",
                        stripe_invoice_id=_ic_inv_id,
                        credit_applied_cents=_ic_credit,
                        description=(
                            f"Invoice created — ${_ic_credit / 100:.2f} referral credit "
                            f"balance queued for automatic deduction from invoice {_ic_inv_id}"
                        ),
                    )
                    print(
                        f"[BILLING] invoice.created — ${_ic_credit / 100:.2f} referral "
                        f"credit will auto-apply to invoice {_ic_inv_id} "
                        f"(user {_ic_user['id']})"
                    )

        elif event_type == "invoice.paid":
            # After Stripe collects payment:
            #   starting_balance (negative) = credit available before invoice
            #   ending_balance   (negative) = remaining credit after deduction
            # Sync account_credit to Stripe's authoritative post-payment balance.
            _ip_customer = obj.get("customer")
            _ip_inv_id   = obj.get("id", "")
            _ip_starting = obj.get("starting_balance", 0)
            _ip_ending   = obj.get("ending_balance", 0)
            _ip_paid     = obj.get("amount_paid", 0)
            if _ip_customer:
                _ip_conn = sqlite3.connect(DB_FILE)
                _ip_conn.row_factory = sqlite3.Row
                _ip_user = _ip_conn.execute(
                    "SELECT id FROM users WHERE stripe_customer_id = ?",
                    (_ip_customer,),
                ).fetchone()
                try:
                    if _ip_user:
                        _ip_uid       = _ip_user["id"]
                        _credit_used  = max(0, abs(_ip_starting) - abs(_ip_ending))
                        _remaining    = max(0.0, abs(_ip_ending) / 100.0)
                        try:
                            _ip_conn.execute(
                                "UPDATE users SET account_credit = ? WHERE id = ?",
                                (_remaining, _ip_uid),
                            )
                            _ip_conn.commit()
                        except Exception:
                            try:
                                _ip_conn.rollback()
                            except Exception:
                                pass
                            raise
                        _log_billing_event(
                            _ip_uid,
                            "invoice.paid",
                            stripe_invoice_id=_ip_inv_id,
                            amount_cents=_ip_paid,
                            credit_applied_cents=_credit_used,
                            description=(
                                f"Invoice paid — ${_credit_used / 100:.2f} referral credit "
                                f"applied to renewal cycle; remaining credit: ${_remaining:.2f}"
                            ),
                        )
                        print(
                            f"[BILLING] invoice.paid — ${_credit_used / 100:.2f} referral "
                            f"credit applied to invoice {_ip_inv_id}; "
                            f"remaining balance: ${_remaining:.2f} (user {_ip_uid})"
                        )
                finally:
                    _ip_conn.close()

    @staticmethod
    def update_settings(
        token: str,
        # Account / recovery
        email=None,
        phone=None,
        # Facebook / Meta
        fb_page_id=None,
        fb_access_token=None,
        # Meta Catalog & Marketplace integration IDs
        facebook_business_manager_id=None,
        commerce_catalog_id=None,
        meta_pixel_id=None,
        # Catalog
        catalog_token=None,
        # Inventory source
        inventory_url_used=None,
        inventory_url_new=None,
        inventory_locations=None,
        salesperson_filter=None,
        # Scraper schedule
        scraper_frequency=None,
        # Dealership return address (for printed customer envelopes)
        dealer_name=None,
        dealer_address_line1=None,
        dealer_city=None,
        dealer_state=None,
        dealer_zip=None,
        # CRM (retained for backwards-compat; no longer exposed in UI)
        crm_provider=None,
        cox_client_id=None,
        cox_client_secret=None,
        cox_dealer_id=None,
        dealerpeak_api_key=None,
        dealerpeak_dealer_id=None,
        salesperson_id=None,
        # TikTok per-user default privacy preference
        tiktok_privacy_level=None,
    ):
        """Persist user settings.

        Only columns explicitly passed with a non-None value are updated.
        Passing None (the default) for any field leaves that column untouched,
        preventing partial saves from wiping unrelated settings.

        Secret fields (fb_access_token, CRM credentials) additionally require
        a non-empty string so masked UI placeholders don't clear stored secrets.
        """
        user_id = _resolve_user_id(token)
        if not user_id:
            raise ValueError("Unauthenticated.")
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()

            # Build a selective UPDATE — only touch columns that were explicitly
            # supplied (non-None).  This prevents any partial-save caller from
            # accidentally blanking fields it didn't include in its payload.
            _regular = [
                ('email',                        email),
                ('phone',                        phone),
                ('fb_page_id',                   fb_page_id),
                ('facebook_business_manager_id', facebook_business_manager_id),
                ('commerce_catalog_id',          commerce_catalog_id),
                ('meta_pixel_id',                meta_pixel_id),
                ('catalog_token',                catalog_token),
                ('inventory_url_used',           inventory_url_used),
                ('inventory_url_new',            inventory_url_new),
                ('inventory_locations',          inventory_locations),
                ('salesperson_filter',           salesperson_filter),
                ('scraper_frequency',            scraper_frequency),
                ('dealer_name',                  dealer_name),
                ('dealer_address_line1',         dealer_address_line1),
                ('dealer_city',                  dealer_city),
                ('dealer_state',                 dealer_state),
                ('dealer_zip',                   dealer_zip),
                ('crm_provider',                 crm_provider),
                ('cox_client_id',                cox_client_id),
                ('cox_dealer_id',                cox_dealer_id),
                ('dealerpeak_dealer_id',         dealerpeak_dealer_id),
                ('salesperson_id',               salesperson_id),
                ('tiktok_privacy_level',         tiktok_privacy_level),
            ]
            _cols_to_set = [(col, val) for col, val in _regular if val is not None]
            if _cols_to_set:
                _set_clause = ', '.join(f'{col} = ?' for col, _ in _cols_to_set)
                _params = [val for _, val in _cols_to_set] + [user_id]
                cursor.execute(
                    f'UPDATE users SET {_set_clause} WHERE id = ?',
                    _params,
                )

            # Secrets: only overwrite when a new, non-empty value is provided
            if fb_access_token:
                cursor.execute(
                    "UPDATE users SET fb_access_token = ? WHERE id = ?",
                    (fb_access_token, user_id),
                )
            if cox_client_secret:
                cursor.execute(
                    "UPDATE users SET cox_client_secret = ? WHERE id = ?",
                    (cox_client_secret, user_id),
                )
            if dealerpeak_api_key:
                cursor.execute(
                    "UPDATE users SET dealerpeak_api_key = ? WHERE id = ?",
                    (dealerpeak_api_key, user_id),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def get_all_users() -> list[dict]:
        """Return all registered users with their inventory sync settings."""
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, inventory_url_used, inventory_url_new, "
            "salesperson_filter FROM users"
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]


# =====================================================================
# EMAIL QUEUE MANAGER
# =====================================================================
class EmailQueueManager:
    """CRUD helpers for the email_queue table."""

    @staticmethod
    def get_queue(user_id: int) -> list[dict]:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM email_queue WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def create_draft(
        user_id: int,
        phone_number: str,
        customer_name: str,
        summary: str,
        subject: str,
        body: str,
    ) -> int:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """INSERT INTO email_queue
                   (user_id, phone_number, customer_name, last_conversation_summary,
                    email_subject, email_body, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending_review')""",
                (user_id, phone_number, customer_name, summary, subject, body),
            )
            conn.commit()
            row_id = cursor.lastrowid
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return row_id

    @staticmethod
    def update_status(email_id: int, user_id: int, status: str) -> bool:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """UPDATE email_queue
                   SET status = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND user_id = ?""",
                (status, email_id, user_id),
            )
            affected = cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return affected > 0

    @staticmethod
    def update_body(
        email_id: int, user_id: int, subject: str, body: str
    ) -> bool:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """UPDATE email_queue
                   SET email_subject = ?, email_body = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND user_id = ?""",
                (subject, body, email_id, user_id),
            )
            affected = cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return affected > 0

    @staticmethod
    def has_pending_draft(user_id: int, phone_number: str) -> bool:
        """True if this customer already has an un-actioned draft in the queue."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            """SELECT 1 FROM email_queue
               WHERE user_id = ? AND phone_number = ? AND status = 'pending_review'
               LIMIT 1""",
            (user_id, phone_number),
        )
        result = cursor.fetchone()
        conn.close()
        return result is not None


class DBSessionManager:
    """Interface for database CRUD operations and desk analytics."""

    @staticmethod
    def get_or_create_session(
        phone_number: str,
        first_name: str = "Customer",
        last_name: str = "Lead",
        source: str = "Website",
        assigned_salesperson_id: str = "",
    ) -> dict:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.cursor()

            cursor.execute(
                "SELECT * FROM sessions WHERE phone_number = ?", (phone_number,)
            )
            session = cursor.fetchone()

            if not session:
                cursor.execute(
                    """
                    INSERT INTO sessions
                        (phone_number, first_name, last_name, source, assigned_salesperson_id)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (phone_number, first_name, last_name, source,
                     assigned_salesperson_id or None),
                )
                conn.commit()
                cursor.execute(
                    "SELECT * FROM sessions WHERE phone_number = ?",
                    (phone_number,),
                )
                session = cursor.fetchone()
            elif assigned_salesperson_id and not session["assigned_salesperson_id"]:
                # Back-fill salesperson assignment on existing unassigned sessions
                cursor.execute(
                    "UPDATE sessions SET assigned_salesperson_id = ? WHERE phone_number = ?",
                    (assigned_salesperson_id, phone_number),
                )
                conn.commit()
                cursor.execute(
                    "SELECT * FROM sessions WHERE phone_number = ?",
                    (phone_number,),
                )
                session = cursor.fetchone()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return dict(session)

    @staticmethod
    def update_session_activity(
        phone_number: str, stock_no: str = None, trade_vehicle: str = None
    ):
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            cursor.execute(
                "UPDATE sessions SET last_activity = ? WHERE phone_number = ?",
                (now_str, phone_number),
            )

            if stock_no:
                cursor.execute(
                    "UPDATE sessions SET active_stock_no = ? WHERE phone_number = ?",
                    (stock_no, phone_number),
                )
            if trade_vehicle:
                cursor.execute(
                    "UPDATE sessions SET trade_vehicle = ? WHERE phone_number = ?",
                    (trade_vehicle, phone_number),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def add_message(
        phone_number: str,
        role: str,
        text: str,
        sent_by_user_id: int | None = None,
    ):
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            cursor.execute(
                """
                INSERT INTO messages (phone_number, role, text, timestamp, sent_by_user_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (phone_number, role, text, now_str, sent_by_user_id),
            )
            cursor.execute(
                "UPDATE sessions SET last_activity = ? WHERE phone_number = ?",
                (now_str, phone_number),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def has_prior_contact(phone_number: str, user_id: int) -> bool:
        """Return True if this user has previously sent any bot message to this phone."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*) FROM messages
            WHERE phone_number = ?
              AND role LIKE 'bot%'
              AND sent_by_user_id = ?
            """,
            (phone_number, user_id),
        )
        count = cursor.fetchone()[0]
        conn.close()
        return count > 0

    @staticmethod
    def book_appointment(
        phone_number: str, appt_type: str, time_slot: str
    ) -> int:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO appointments (phone_number, appt_type, time_slot)
                VALUES (?, ?, ?)
                """,
                (phone_number, appt_type, time_slot),
            )
            cursor.execute(
                "UPDATE sessions SET status = 'BOOKED' WHERE phone_number = ?",
                (phone_number,),
            )
            conn.commit()
            appt_id = cursor.lastrowid
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return appt_id

    @staticmethod
    def update_status(phone_number: str, status: str):
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE sessions SET status = ? WHERE phone_number = ?",
                (status, phone_number),
            )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

    @staticmethod
    def get_all_appointments() -> list:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id, s.first_name, s.last_name, a.phone_number,
                   a.appt_type, a.time_slot, s.active_stock_no,
                   s.trade_vehicle, a.status, a.created_at
            FROM appointments a
            JOIN sessions s ON a.phone_number = s.phone_number
            ORDER BY a.id DESC
        """
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_all_sessions() -> list:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT phone_number, first_name, last_name, source,
                   active_stock_no, trade_vehicle, status,
                   last_activity, created_at
            FROM sessions
            ORDER BY last_activity DESC
        """
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_desk_analytics(user_id: int = 0) -> dict:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Total active (non-sold) vehicles for this user
        cursor.execute(
            "SELECT COUNT(*) as total FROM marketplace_inventory "
            "WHERE user_id=? AND status='ACTIVE'",
            (user_id,),
        )
        total_active_inventory = cursor.fetchone()["total"]

        # Vehicles currently posted / in the Facebook feed
        cursor.execute(
            "SELECT COUNT(*) as total FROM marketplace_inventory "
            "WHERE user_id=? AND status='ACTIVE' AND posted_status='posted'",
            (user_id,),
        )
        vehicles_posted = cursor.fetchone()["total"]

        # SOLD vehicles still marked as posted — need immediate action
        cursor.execute(
            "SELECT COUNT(*) as total FROM marketplace_inventory "
            "WHERE user_id=? AND status='SOLD' AND posted_status='posted'",
            (user_id,),
        )
        sold_still_posted = cursor.fetchone()["total"]

        conn.close()

        return {
            "total_active_inventory":    total_active_inventory,
            "vehicles_posted_to_facebook": vehicles_posted,
            "sold_still_posted":         sold_still_posted,
        }


# =====================================================================
# DATA HELPERS & NLP PARSERS
# =====================================================================
def load_inventory_database(csv_text: str) -> list:
    reader = csv.DictReader(io.StringIO(csv_text.strip()))
    inventory = []
    for row in reader:
        price_clean = row["Price"].replace("$", "").replace(",", "").strip()
        try:
            raw_price = int(price_clean)
            formatted_price = f"${raw_price:,}"
        except ValueError:
            raw_price = 0
            formatted_price = "$0"

        inventory.append(
            {
                "stock_no": row["StockNo"].strip(),
                "year": int(row["Year"]),
                "make": row["Make"].strip(),
                "model": row["Model"].strip(),
                "trim": row["Trim"].strip(),
                "price": formatted_price,
                "raw_price": raw_price,
                "status": row["Status"].strip().upper(),
                "body_style": row["BodyStyle"].strip(),
                "category": row["Category"].strip(),
            }
        )
    return inventory


LIVE_INVENTORY = load_inventory_database(RAW_CSV_INVENTORY)


def extract_appointment_slot(text: str) -> str:
    clean = text.lower()
    time_regex = (
        r"\b(today|tomorrow|saturday|monday|tuesday|wednesday|thursday|friday|sunday)?"
        r"\s*(at|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b"
    )
    time_match = re.search(time_regex, clean)

    if time_match:
        day = time_match.group(1) or "Today"
        hour = time_match.group(3)
        minute = time_match.group(4) or "00"
        ampm = time_match.group(5) or "pm"
        return f"{day.title()} at {hour}:{minute} {ampm.upper()}"
    return "Tomorrow at 2:00 PM" if "tomorrow" in clean else None


def extract_trade_entities(text: str) -> dict:
    clean_text = text.lower().replace(",", "")
    year_match = re.search(
        r"\b(20[0-2][0-9]|1[0-9]|2[0-6])\b|'([0-2][0-9])", clean_text
    )
    extracted_year = None
    if year_match:
        y_str = year_match.group(1) or year_match.group(2)
        extracted_year = (
            int(y_str) if len(y_str) == 4 else int("20" + y_str.zfill(2))
        )

    mileage_match = re.search(
        r"\b(\d{1,3})\s*k\b|\b(\d{5,6})\b|\b(\d{1,3})\s*thousand\b", clean_text
    )
    extracted_miles = None
    if mileage_match:
        if mileage_match.group(1):
            extracted_miles = int(mileage_match.group(1)) * 1000
        elif mileage_match.group(2):
            extracted_miles = int(mileage_match.group(2))
        elif mileage_match.group(3):
            extracted_miles = int(mileage_match.group(3)) * 1000

    extracted_condition = "AVERAGE"
    if any(k in clean_text for k in ["clean", "mint", "great", "excellent"]):
        extracted_condition = "EXCELLENT"
    elif any(
        k in clean_text for k in ["rough", "dents", "needs work", "fair"]
    ):
        extracted_condition = "ROUGH"

    extracted_make, extracted_model = None, None
    for (_, make, model) in TRADE_MARKET_DATABASE.keys():
        if make in clean_text and model in clean_text:
            extracted_make, extracted_model = make, model
            break
        elif model in clean_text:
            extracted_make, extracted_model = make, model
            break

    return {
        "year": extracted_year,
        "make": extracted_make,
        "model": extracted_model,
        "mileage": extracted_miles,
        "condition": extracted_condition,
    }


def calculate_trade_valuation(parsed_data: dict) -> dict:
    if not (
        parsed_data["year"]
        and parsed_data["make"]
        and parsed_data["model"]
    ):
        return None

    key = (
        str(parsed_data["year"]),
        parsed_data["make"].lower(),
        parsed_data["model"].lower(),
    )
    if key not in TRADE_MARKET_DATABASE:
        return None

    base_val = TRADE_MARKET_DATABASE[key]["base_wholesale"]
    vehicle_age = max(1, CURRENT_YEAR - parsed_data["year"])
    expected_mileage = vehicle_age * AVG_MILES_PER_YEAR

    act_miles = (
        parsed_data["mileage"]
        if parsed_data["mileage"]
        else expected_mileage
    )
    mileage_delta = act_miles - expected_mileage
    mileage_adj = -int(mileage_delta * 0.10)

    adjusted_base = base_val + mileage_adj
    mult_map = {"EXCELLENT": 1.05, "AVERAGE": 1.00, "ROUGH": 0.85}
    mult = mult_map.get(parsed_data["condition"], 1.00)

    final_val = adjusted_base * mult
    low_est = int(round((final_val * 0.95) / 100) * 100)
    high_est = int(round((final_val * 1.05) / 100) * 100)

    return {
        "year": parsed_data["year"],
        "make": parsed_data["make"].title(),
        "model": parsed_data["model"].title(),
        "actual_miles": act_miles,
        "condition": parsed_data["condition"],
        "low_est": f"${low_est:,}",
        "high_est": f"${high_est:,}",
    }


# =====================================================================
# CORE PIPELINE CONTROLLER
# =====================================================================
def handle_pipeline_lead(
    data: dict,
    crm_creds: dict | None = None,
    user_id: int | None = None,
    salesperson_id: str = "",
) -> dict:
    phone = data.get("phone_number", "304-555-0000")
    first_name = data.get("first_name", "Valued")
    last_name = data.get("last_name", "Customer")
    source = data.get("source", "HTTP API")
    message = data.get("message", "")
    # Inbound payloads may carry the assigned salesperson explicitly
    payload_sp_id = data.get("assigned_salesperson_id", "")

    session = DBSessionManager.get_or_create_session(
        phone, first_name, last_name, source,
        assigned_salesperson_id=payload_sp_id,
    )
    DBSessionManager.add_message(phone, "customer", message)

    # ── LEAD ASSIGNMENT GUARDRAIL ────────────────────────────────────
    # Run only when a logged-in user's salesperson_id is set.
    # Skip the lead if:
    #   (a) the session's assigned_salesperson_id is set AND doesn't match, AND
    #   (b) this user has no prior contact history with this phone number.
    if salesperson_id:
        assigned = session.get("assigned_salesperson_id") or payload_sp_id
        assigned_to_me = (not assigned) or (assigned == salesperson_id)
        prior_contact = (
            user_id is not None
            and DBSessionManager.has_prior_contact(phone, user_id)
        )
        if not assigned_to_me and not prior_contact:
            DBSessionManager.update_status(phone, "SKIPPED_NOT_MY_LEAD")
            print(
                f"[GUARDRAIL] Skipped {phone} — assigned to SP#{assigned}, "
                f"not SP#{salesperson_id}, no prior contact."
            )
            return {
                "status": 200,
                "intent": "SKIPPED_NOT_MY_LEAD",
                "escalated": False,
                "reply": None,
                "reason": (
                    f"Lead is assigned to salesperson {assigned!r}. "
                    "No prior contact by this user — automated reply suppressed."
                ),
            }
    # ── END GUARDRAIL ────────────────────────────────────────────────

    msg_lower = message.lower()

    for car in LIVE_INVENTORY:
        if car["model"].lower() in msg_lower:
            DBSessionManager.update_session_activity(
                phone, stock_no=car["stock_no"]
            )
            break

    session = DBSessionManager.get_or_create_session(
        phone, first_name, last_name, source
    )
    active_stock = session["active_stock_no"]
    active_car = next(
        (c for c in LIVE_INVENTORY if c["stock_no"] == active_stock),
        None,
    )

    # Trade-valuation keywords take highest priority — checked before
    # appointment keywords so that messages like "come in for a trade appraisal"
    # or "what would you give me for my Tahoe?" are never mis-classified as
    # APPOINTMENT_BOOKED or AVAILABILITY_CHECK.
    trade_keywords = [
        "trade-in", "trade in", "give me for", "gimme for my",
        "trade", "worth",
    ]

    appt_keywords = [
        "schedule", "test drive", "come in", "tomorrow",
        "today at", "appraisal drop"
    ]

    if any(k in msg_lower for k in trade_keywords):
        parsed_trade = extract_trade_entities(message)
        valuation = calculate_trade_valuation(parsed_trade)

        if valuation:
            trade_str = (
                f"{valuation['year']} {valuation['make']} {valuation['model']}"
            )
            DBSessionManager.update_session_activity(
                phone, trade_vehicle=trade_str
            )
            reply = (
                f"Got it! For a {valuation['year']} {valuation['make']} "
                f"{valuation['model']} with ~{valuation['actual_miles']:,} "
                f"miles ({valuation['condition'].lower()} condition), "
                f"estimated trade value is currently {valuation['low_est']} - "
                f"{valuation['high_est']}. Would you like to set up a quick "
                "10-minute key drop appraisal tomorrow at 4pm?"
            )
            updated_session = DBSessionManager.get_or_create_session(phone)
            CRMClient.push_lead(
                updated_session,
                note=f"Trade valuation generated: {valuation['low_est']}-{valuation['high_est']}",
                crm_creds=crm_creds,
            )
        else:
            reply = (
                "I can definitely get you an aggressive trade value! Could you "
                "provide the exact year, make, model, and approx mileage?"
            )

        DBSessionManager.add_message(phone, "bot", reply, sent_by_user_id=user_id)
        return {
            "status": 200,
            "intent": "AUTOMATED_TRADE_VALUATION",
            "escalated": True,
            "reply": reply,
        }

    elif any(k in msg_lower for k in appt_keywords):
        slot = extract_appointment_slot(message) or "Tomorrow at 2:00 PM"
        appt_type = (
            "Appraisal & Test Drive"
            if session["trade_vehicle"]
            else "VIP Test Drive"
        )
        _ = DBSessionManager.book_appointment(phone, appt_type, slot)

        reply = (
            f"You're all set, {session['first_name']}! I have locked in "
            f"your {appt_type} for {slot}. When you arrive, ask for our "
            "Sales Desk—we'll have the keys ready for you!"
        )
        DBSessionManager.add_message(phone, "bot", reply, sent_by_user_id=user_id)

        CRMClient.push_lead(
            session,
            note=f"Appt booked for {slot} ({appt_type})",
            crm_creds=crm_creds,
        )

        return {
            "status": 200,
            "intent": "APPOINTMENT_BOOKED",
            "escalated": True,
            "reply": reply,
            "booked_slot": slot,
        }

    elif active_car:
        reply = (
            f"Yes! The {active_car['year']} {active_car['make']} "
            f"{active_car['model']} {active_car['trim']} is available for "
            f"{active_car['price']} (Stock #{active_car['stock_no']}). "
            "Would you like to schedule a test drive today or tomorrow?"
        )
        DBSessionManager.add_message(phone, "bot", reply, sent_by_user_id=user_id)
        return {
            "status": 200,
            "intent": "AVAILABILITY_CHECK",
            "escalated": False,
            "reply": reply,
        }

    else:
        reply = "Hello! How can we assist with your vehicle search today?"
        DBSessionManager.add_message(phone, "bot", reply, sent_by_user_id=user_id)
        return {
            "status": 200,
            "intent": "GENERAL_INFO",
            "escalated": False,
            "reply": reply,
        }


# =====================================================================
# BACKGROUND RE-ENGAGEMENT WORKER
# =====================================================================
class BDCFollowUpWorker(threading.Thread):
    """Polls database on a background thread to re-engage stale leads."""

    def __init__(self, check_interval_seconds=5):
        super().__init__()
        self.check_interval = check_interval_seconds
        self.daemon = True
        self.running = True

    def run(self):
        while self.running:
            try:
                self.process_unbooked_leads()
            except Exception as err:
                print(f"WARNING Worker Error: {err}")
            time.sleep(self.check_interval)

    def process_unbooked_leads(self):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT * FROM sessions
            WHERE status IN ('ACTIVE', 'FOLLOWED_UP')
            """
        )
        leads = cursor.fetchall()
        conn.close()

        now = datetime.now()

        for lead in leads:
            phone = lead["phone_number"]
            name = lead["first_name"]
            status = lead["status"]
            trade = lead["trade_vehicle"]
            stock = lead["active_stock_no"]

            last_act = datetime.strptime(
                lead["last_activity"], "%Y-%m-%d %H:%M:%S"
            )
            elapsed_hours = (now - last_act).total_seconds() / 3600.0

            if status == "ACTIVE" and elapsed_hours >= 24.0:
                if trade:
                    msg = (
                        f"Hey {name}! I noticed you received the trade estimate "
                        f"on your {trade}. We have strong pre-owned demand right "
                        "now—would tomorrow or Saturday work better for a 10-min key drop?"
                    )
                elif stock:
                    car = next(
                        (c for c in LIVE_INVENTORY if c["stock_no"] == stock),
                        None,
                    )
                    car_name = (
                        f"{car['year']} {car['make']} {car['model']}"
                        if car
                        else "vehicle"
                    )
                    msg = (
                        f"Hi {name}, checking in on the {car_name} (Stock #{stock}). "
                        "I have two VIP test drive slots open tomorrow afternoon. "
                        "Would you like me to hold one for you?"
                    )
                else:
                    msg = (
                        f"Hi {name}, wanted to see if you had any questions "
                        "regarding our available inventory?"
                    )

                DBSessionManager.add_message(phone, "bot_followup", msg)
                DBSessionManager.update_status(phone, "FOLLOWED_UP")
                print(f"[RE-ENGAGEMENT] -> {name} ({phone})")

            elif status == "FOLLOWED_UP" and elapsed_hours >= 24.0:
                DBSessionManager.update_status(phone, "ESCALATE_TO_DESK")
                print(
                    f"[DESK ESCALATION] Lead {name} ({phone}) "
                    "flagged for direct phone call follow-up."
                )


# =====================================================================
# EMAIL RE-ENGAGEMENT WORKER  (60-day cadence)
# =====================================================================
class EmailReengagementWorker(threading.Thread):
    """Background daemon that finds leads silent for 60+ days and generates
    AI-written pending email drafts for manager review.

    Guardrails enforced:
      • Skip opted-out contacts  (sessions.opt_out = 1)
      • Skip leads assigned to another salesperson
      • Skip customers who already have a pending_review draft in the queue
      • Skip closed / booked / skipped sessions
    """

    SCAN_INTERVAL = 60 * 30  # every 30 minutes
    REENGAGEMENT_DAYS = 60

    def __init__(self):
        super().__init__()
        self.daemon = True
        self.running = True

    def run(self):
        time.sleep(15)  # let the main server finish init before first scan
        while self.running:
            try:
                self._scan_and_generate()
            except Exception as err:
                print(f"WARNING EmailWorker: {err}")
            time.sleep(self.SCAN_INTERVAL)

    def _scan_and_generate(self):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # All registered users with their salesperson mapping and send preference
        cursor.execute(
            "SELECT id, salesperson_id, auto_send_emails FROM users"
        )
        users = [dict(r) for r in cursor.fetchall()]

        # Sessions last active beyond the reengagement threshold, not opted out,
        # not in a terminal state
        cursor.execute(
            f"""
            SELECT phone_number, first_name, last_name,
                   assigned_salesperson_id, opt_out, status
            FROM sessions
            WHERE last_activity < datetime('now', '-{self.REENGAGEMENT_DAYS} days')
              AND opt_out = 0
              AND status NOT IN (
                  'APPOINTMENT_BOOKED', 'CLOSED',
                  'SKIPPED_NOT_MY_LEAD'
              )
            """
        )
        eligible = [dict(r) for r in cursor.fetchall()]
        conn.close()

        if not eligible:
            return

        for user in users:
            uid   = user["id"]
            sp_id = (user.get("salesperson_id") or "").strip()
            auto  = bool(user.get("auto_send_emails", 0))

            for sess in eligible:
                phone    = sess["phone_number"]
                assigned = (sess.get("assigned_salesperson_id") or "").strip()

                # Salesperson guardrail
                if sp_id and assigned and assigned != sp_id:
                    continue

                # Dedupe: skip if already has a pending draft
                if EmailQueueManager.has_pending_draft(uid, phone):
                    continue

                customer_name = (
                    f"{sess['first_name']} {sess['last_name']}".strip()
                    or phone
                )
                result = generate_reengagement_email(phone, customer_name)

                draft_id = EmailQueueManager.create_draft(
                    user_id=uid,
                    phone_number=phone,
                    customer_name=customer_name,
                    summary=result["summary"],
                    subject=result["subject"],
                    body=result["body"],
                )
                print(
                    f"[EMAIL DRAFT] Generated for {customer_name} ({phone})"
                    f" — draft #{draft_id}"
                )

                if auto:
                    EmailQueueManager.update_status(draft_id, uid, "sent")
                    print(f"[EMAIL AUTO-SENT] Draft #{draft_id} -> {customer_name}")


# =====================================================================
# HTTP SERVER ROUTER & HANDLER
# =====================================================================
# =====================================================================
# MOSES AUTO GROUP INVENTORY SCRAPER
# =====================================================================

class _VehicleHTMLParser(html.parser.HTMLParser):
    """Extract vehicle entries from dealer HTML using data-vin attributes
    and common dealership card class names (.srp-vehicle-card, .vehicle-card,
    .inventory-item, etc.).

    Phase 2: explicitly skips <script>/<style>/<header>/<footer>/<nav> noise
    before capturing card text for inventory_parser regex sanitization.
    """

    _VOID = frozenset({'area','base','br','col','embed','hr','img','input',
                       'link','meta','param','source','track','wbr'})
    _NOISE = frozenset({'script', 'style', 'noscript', 'svg', 'iframe',
                        'template', 'header', 'footer', 'nav', 'aside'})
    _CARD_CLASS_RE = re.compile(
        r'(?:^|[\s_-])(?:srp-vehicle-card|vehicle-card|inventory-item|'
        r'inventory-card|vehicle-listing|srp-card|listing-card)(?:$|[\s_-])',
        re.IGNORECASE,
    )
    _VIN_RE = re.compile(r'\b([A-HJ-NPR-Z0-9]{17})\b')

    def __init__(self):
        super().__init__()
        self.vehicles: list[dict] = []
        self._depth = 0
        self._skip_depth = 0
        self._cur: dict | None = None
        self._cur_depth = -1
        self._capture_text = False
        self._text_buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        low = (tag or '').lower()
        if self._skip_depth:
            if low not in self._VOID:
                self._skip_depth += 1
            return
        if low in self._NOISE:
            if low not in self._VOID:
                self._skip_depth = 1
            return

        self._depth += 1
        d = dict(attrs)
        vin = d.get('data-vin', '')
        class_attr = d.get('class', '') or ''
        looks_like_card = bool(vin) or bool(self._CARD_CLASS_RE.search(class_attr))
        if looks_like_card and self._cur is None:
            self._cur = {
                'vin':            vin,
                'stock_number':   (d.get('data-stock-number') or
                                   d.get('data-stocknumber') or
                                   d.get('data-stock-no') or
                                   d.get('data-stockno') or
                                   d.get('data-stock') or
                                   d.get('data-vehicle-stock') or
                                   d.get('data-stocknum') or ''),
                'year':           d.get('data-year', '0'),
                'make':           d.get('data-make', ''),
                'model':          d.get('data-model', ''),
                'trim':           d.get('data-trim', ''),
                'mileage':        d.get('data-mileage') or d.get('data-miles', '0'),
                'price':          (d.get('data-price') or d.get('data-internet-price') or
                                   d.get('data-internetprice', '0')),
                'exterior_color': (d.get('data-exterior-color') or
                                   d.get('data-exteriorcolor') or d.get('data-color', '')),
                'interior_color': d.get('data-interior-color') or d.get('data-interiorcolor', ''),
                'image_url':      '',
                # Location / dealership store name — try every common attribute variant,
                # then canonicalize to one of the five Moses group names when possible.
                'location':       _canonicalize_location(
                    d.get('data-location') or
                    d.get('data-dealer-name') or
                    d.get('data-dealername') or
                    d.get('data-rooftop-name') or
                    d.get('data-rooftopname') or
                    d.get('data-site-name') or
                    d.get('data-store') or
                    d.get('data-store-name') or
                    d.get('data-lot') or
                    d.get('data-franchise') or
                    d.get('data-city') or
                    ''
                ),
            }
            self._cur_depth = self._depth
            # Always capture card text so inventory_parser can fill gaps.
            self._capture_text = True
            self._text_buf = []
        if self._cur and low == 'img':
            src = d.get('src') or d.get('data-src') or d.get('data-lazy', '')
            if src and not src.startswith('data:') and not self._cur.get('image_url'):
                self._cur['image_url'] = src
        if low in self._VOID:
            self._depth -= 1

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._cur and self._capture_text and data and data.strip():
            self._text_buf.append(data.strip())

    def handle_endtag(self, tag):
        low = (tag or '').lower()
        if self._skip_depth:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if low in self._NOISE or low in self._VOID:
            return
        if self._cur and self._depth == self._cur_depth:
            blob = ' '.join(self._text_buf)
            if not self._cur.get('vin') and blob:
                m = self._VIN_RE.search(blob)
                if m:
                    self._cur['vin'] = m.group(1).upper()
            if blob:
                self._cur['raw_text'] = blob
            if self._cur.get('vin') and (self._cur.get('make') or len(self._cur['vin']) == 17):
                self.vehicles.append(dict(self._cur))
            self._cur = None
            self._cur_depth = -1
            self._capture_text = False
            self._text_buf = []
        self._depth -= 1


def _canonicalize_location(raw: str) -> str:
    """Map a raw dealer/location string to a canonical Moses group name.

    Checks each entry in MOSES_LOCATION_KEYWORDS (lowercased substring match).
    Falls through to the trimmed raw string when nothing matches so unexpected
    rooftops are preserved for future discovery — never silently dropped.
    """
    if not raw:
        return ''
    low = raw.strip().lower()
    for keywords, canonical in MOSES_LOCATION_KEYWORDS:
        if any(kw in low for kw in keywords):
            return canonical
    return raw.strip()


def _normalize_scraped(item: dict, condition: str) -> dict | None:
    """Coerce a raw scraped dict (varied key names) into the DB schema."""
    if not isinstance(item, dict):
        return None

    def _get(*keys: str):
        for k in keys:
            if k in item:
                return item[k]
            kl = k.lower().replace('-', '').replace('_', '')
            for ik, iv in item.items():
                if ik.lower().replace('-', '').replace('_', '') == kl:
                    return iv
        return None

    vin = str(_get('vin', 'VIN', 'Vin') or '').strip()
    if not vin or len(vin) < 10:
        return None

    # ── image: try scalar first, then first element of a photos/images array ──
    _raw_img = _get('imageUrl', 'image_url', 'photo', 'mainPhoto',
                    'primaryImageUrl', 'imageHref', 'Photo', 'MainPhoto')
    if not _raw_img:
        _photos = _get('photos', 'Photos', 'images', 'Images', 'vehicleImages')
        if isinstance(_photos, list) and _photos:
            first = _photos[0]
            if isinstance(first, dict):
                _raw_img = (first.get('url') or first.get('Url') or
                            first.get('href') or first.get('src') or
                            first.get('fullUrl') or first.get('FullUrl') or '')
            elif isinstance(first, str):
                _raw_img = first

    # ── vdp_url: vehicle detail page link ────────────────────────────────────
    _raw_link = str(_get(
        'link', 'Link', 'vdpUrl', 'vdp_url', 'vehicleUrl', 'VehicleUrl',
        'detailUrl', 'DetailUrl', 'detailPageUrl', 'vdpLink', 'vehicleLink',
        'vehicleDetailsUrl', 'vehicledetailsurl',
        # DealerOn widget API field name
        'pageUrl', 'PageUrl',
    ) or '').strip()

    # Multi-tag price fallbacks (internet -> sale -> final -> library -> MSRP)
    # plus "$77,965" / "Call for Price" cleansing via _int_safe.
    _ask, _retail = _extract_vehicle_price(item)

    _raw_loc = str(_get(
        'location', 'dealerName', 'dealer_name', 'rooftopName',
        'storeName', 'store_name', 'siteName', 'dealerLocation',
        'franchiseLocation', 'lot', 'DealerLocatedAtCity',
    ) or '')
    if _scraper_engine is not None:
        _loc, _group = _scraper_engine.resolve_vehicle_rooftop(
            card=item,
            vdp_url=_raw_link,
            fallback_location=_canonicalize_location(_raw_loc),
        )
    else:
        _loc = _canonicalize_location(_raw_loc)
        _group = str(_get('dealership_group', 'DealerName', 'dealerName') or '')

    # All numerics go through _int_safe so $, commas, 'mi', and em dashes
    # never reach PostgreSQL as empty / non-integer strings.
    return {
        'vin':            vin,
        'stock_number':   str(_get(
            'stockNumber', 'StockNumber', 'stock_number', 'stockNo',
            'StockNo', 'stock_no', 'StockNum', 'stockNum',
            'Stock', 'stock', 'stockId', 'StockId',
            'vehicleStockNumber', 'VehicleStockNumber',
            'stocknum', 'Stocknum',
        ) or ''),
        'condition':      condition,
        'year':           _int_safe(_get('year', 'Year', 'modelYear', 'ModelYear')),
        'make':           str(_get('make', 'Make', 'manufacturer', 'Manufacturer') or ''),
        'model':          str(_get('model', 'Model', 'modelName', 'ModelName') or ''),
        'trim':           str(_get('trim', 'Trim', 'trimLevel', 'TrimLevel',
                                   'trimName', 'TrimName', 'subModel') or ''),
        'mileage':        _int_safe(_get('mileage', 'miles', 'odometer', 'Mileage',
                                         'Odometer', 'mileageActual')),
        'price':          _ask,
        'msrp':           _retail,
        'retail_price':   _retail,
        'exterior_color': str(_get('exteriorColor', 'exterior_color', 'color',
                                   'ExteriorColor', 'extColor', 'ExtColor') or ''),
        'interior_color': str(_get('interiorColor', 'interior_color', 'InteriorColor',
                                   'intColor', 'IntColor') or ''),
        'image_url':      str(_raw_img or ''),
        'location':       _loc,
        'dealership_group': _group,
        'vdp_url':        _raw_link,
    }


def _extract_vehicles_recursive(data, condition: str, depth: int = 0) -> list[dict]:
    """Walk a JSON tree looking for a list of vehicle dicts."""
    if depth > 4:
        return []
    if isinstance(data, list) and data and isinstance(data[0], dict):
        keys = {k.lower() for k in data[0]}
        if any(k in keys for k in ('vin', 'make', 'model', 'stocknumber')):
            return [v for v in (_normalize_scraped(i, condition) for i in data) if v]
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, (dict, list)):
                result = _extract_vehicles_recursive(v, condition, depth + 1)
                if result:
                    return result
    return []


def _parse_json_inventory(html_text: str, condition: str) -> list[dict]:
    """Try to extract vehicle inventory from JSON embedded in page <script> blocks."""
    scripts = re.findall(r'<script[^>]*>([\s\S]*?)</script>', html_text)
    for script in scripts:
        if not any(k in script for k in ('vin', 'VIN', 'stockNumber', 'stock_number', 'make', 'model')):
            continue
        for m in re.finditer(r'(\[\s*\{[\s\S]{50,}\}\s*\])', script):
            try:
                data = json.loads(m.group(1))
                if not isinstance(data, list) or not data:
                    continue
                sample = data[0] if isinstance(data[0], dict) else {}
                if not any(k in {x.lower() for x in sample} for k in ('vin', 'make', 'model', 'stocknumber')):
                    continue
                vehicles = [v for v in (_normalize_scraped(i, condition) for i in data) if v]
                if vehicles:
                    return vehicles
            except (json.JSONDecodeError, Exception):
                pass
        for m in re.finditer(r'(?:window\.\w+|var \w+)\s*=\s*(\{[\s\S]{100,}\});', script):
            try:
                data = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
            except (json.JSONDecodeError, Exception):
                pass
    return []


def _parse_html_inventory(html_text: str, condition: str) -> list[dict]:
    """Parse vehicle data from HTML after DOM noise strip + card isolation.

    Phase 2 pipeline:
      1. dom_inventory.parse_inventory_html (strip script/style/header/footer/nav,
         isolate listing cards, run inventory_parser regex sanitization)
      2. Legacy _VehicleHTMLParser fallback (also noise-aware)
      3. Regex card-window fallback
    """
    # Preferred path — full DOM strip → card isolate → regex sanitize
    try:
        from dom_inventory import parse_inventory_html as _dom_parse
        dom_vehicles = _dom_parse(html_text, condition=condition)
        if dom_vehicles:
            vehicles = [v for v in (_normalize_scraped(r, condition) for r in dom_vehicles) if v]
            if vehicles:
                return vehicles
    except Exception as _dom_exc:
        print(f"[INVENTORY] dom_inventory parse skipped: {_dom_exc}")

    parser = _VehicleHTMLParser()
    try:
        parser.feed(html_text)
    except Exception:
        pass

    try:
        from inventory_parser import sanitize_vehicle_record as _sanitize_vehicle
    except ImportError:
        _sanitize_vehicle = None  # type: ignore[assignment]

    raw_rows = []
    for r in parser.vehicles:
        raw_text = r.pop('raw_text', '') if isinstance(r, dict) else ''
        if _sanitize_vehicle is not None:
            try:
                r = _sanitize_vehicle(r, raw_text)
            except Exception:
                pass
        raw_rows.append(r)

    vehicles = [v for v in (_normalize_scraped(r, condition) for r in raw_rows) if v]
    if vehicles:
        return vehicles

    # Regex fallback for cards that the streaming parser may miss
    card_re = re.compile(
        r'<(?:div|li|article|section)[^>]*(?:'
        r'data-vin=["\']([A-HJ-NPR-Z0-9]{17})["\']|'
        r'class=["\'][^"\']*(?:srp-vehicle-card|vehicle-card|inventory-item|'
        r'inventory-card|vehicle-listing)[^"\']*["\']'
        r')[^>]*>',
        re.IGNORECASE,
    )
    vin_re = re.compile(r'\b([A-HJ-NPR-Z0-9]{17})\b')
    results: list[dict] = []
    seen: set[str] = set()
    # Strip noise before window scans so header/footer text cannot pollute fields.
    try:
        from dom_inventory import strip_dom_noise as _strip_noise
        scan_html = _strip_noise(html_text)
    except Exception:
        scan_html = html_text
    for m in card_re.finditer(scan_html):
        start = m.start()
        chunk = scan_html[start: start + 2500]
        vin = (m.group(1) or '').upper()
        if not vin:
            vm = vin_re.search(chunk)
            if not vm:
                continue
            vin = vm.group(1).upper()
        if vin in seen:
            continue
        seen.add(vin)
        stock_m = re.search(
            r'data-stock(?:-number|-no|number|num)?=["\']([^"\']+)["\']',
            chunk, re.IGNORECASE,
        )
        year_m  = re.search(r'data-year=["\'](\d{4})["\']', chunk, re.IGNORECASE)
        make_m  = re.search(r'data-make=["\']([^"\']+)["\']', chunk, re.IGNORECASE)
        model_m = re.search(r'data-model=["\']([^"\']+)["\']', chunk, re.IGNORECASE)
        price_m = re.search(
            r'data-(?:internet-)?price=["\']([^"\']+)["\']', chunk, re.IGNORECASE
        )
        img_m   = re.search(r'<img[^>]+(?:src|data-src)=["\']([^"\']+)["\']', chunk, re.IGNORECASE)
        raw = {
            'vin': vin,
            'stock_number': stock_m.group(1) if stock_m else '',
            'year': year_m.group(1) if year_m else 0,
            'make': make_m.group(1) if make_m else '',
            'model': model_m.group(1) if model_m else '',
            'price': price_m.group(1) if price_m else 0,
            'image_url': img_m.group(1) if img_m else '',
        }
        if _sanitize_vehicle is not None:
            try:
                raw = _sanitize_vehicle(raw, chunk)
            except Exception:
                pass
        norm = _normalize_scraped(raw, condition)
        if norm:
            results.append(norm)
    return results


# ─────────────────────────────────────────────────────────────────────────────
# HYBRID INVENTORY PARSING ENGINE  (Method 2 + Method 3 merged)
# ─────────────────────────────────────────────────────────────────────────────
#
# Architecture — routes in priority order:
#   1. Platform router  (Method 3):
#        DealerOn  -> direct REST API (/api/Inventory/GetInventory, paginated)
#        Dealer.com -> accountId extraction + CDK widget API + embedded JSON
#        Sincro     -> embedded window.SRP_DATA / SERVER_DATA state blobs
#   2. Generic fallback chain (Method 2):
#        JSON arrays in <script> blocks  -> Schema.org JSON-LD ->
#        HTML data-vin attributes        -> structural text-block VIN+stock scan
#
# Safety contract enforced after every path:
#   • stock_number  = real extracted value  or  'N/A'
#                     (never empty, never VIN-derived, never auto-increment)
#   • condition     = locked to the URL-derived argument — never overridden by
#                     scraped data (new_inventory_url -> 'New', used -> 'Used')
# ─────────────────────────────────────────────────────────────────────────────

_PLATFORM_SIGS: dict[str, list[str]] = {
    # DealerOn check runs first — its API is the most reliable path
    'dealeron': [
        'dealeron', 'window.DealerOnSrpConfig', 'data-vehicle-id=',
        'DealerOnSrp', 'DealerOnInventory', 'KnockoutRoot',
        '/api/Inventory/', 'window.dealerOnConfig', 'dealeronwidgets',
    ],
    'dealerdotcom': [
        'static.dealer.com', 'cdn.dealer.com', 'dealer.com/js/',
        'window.DDC', 'DDC.PartialState', 'ddcCounterWidget',
        'data-ddc-widget', '"ddc":', "'ddc':", 'ddc-wrapper',
    ],
    'sincro': [
        'sincrodigital.com', 'cdn.sincrodigital', 'SincroDigital',
        'window.SRP_DATA', 'window.SERVER_DATA', 'sincro-srp',
        '__NEXT_DATA__', 'ansira',
    ],
    'dealerspike': [
        'dealerspike', 'window.vehicles', 'ds-inventory',
        'cdn.dealerspike', 'dealerspike.com', 'dsinv',
    ],
    # ── Extended platform signatures ──────────────────────────────────────────
    'edealer': [
        'edealer.ca', 'window.eDealer', 'window.inventoryData',
        'edealerca', 'edealer-srp', '"eDealer"',
    ],
    'homenet': [
        'homenet.com', 'homeNetSolutions', 'hn_inventory',
        'window.hn_', 'homeNetIMS',
    ],
    'vinsolutions': [
        'vinsolutions.com', 'vinmanager', 'CoxAutoVin',
        'vinconnect', 'window.__vin_', '"vinSolutions"',
    ],
    'autosoft': [
        'autosoft.com', 'AutosoftDMS', 'autosoftdms',
        'window.AutoSoftInventory',
    ],
    'tekion': [
        'tekion.com', 'tekioncloud', 'tekion-arc', 'window.TEKION_',
    ],
}

# URL-only DealerOn fingerprints — evaluated before any HTML is fetched so that
# JS-rendered DealerOn SRP pages (whose raw HTML is an empty shell with no
# platform markers) are still routed to the DealerOn parsers correctly.
# These patterns appear in the URL path or query string on every DealerOn SRP:
#   .aspx         -> SearchNew.aspx, SearchUsed.aspx, VehicleDetails.aspx, …
#   searchnew     -> /SearchNew, SearchNew.aspx?…, /searchnew?…
#   searchused    -> /SearchUsed, SearchUsed.aspx?…, /searchused?…
_PLATFORM_URL_SIGS: dict[str, list[str]] = {
    # .aspx      -> SearchNew.aspx / SearchUsed.aspx / VehicleDetails.aspx
    # searchnew  -> /SearchNew, SearchNew.aspx, /searchnew?…
    # searchused -> /SearchUsed, SearchUsed.aspx, /searchused?…
    # dlron.us   -> short-link / CDN domain used by some DealerOn dealer groups
    'dealeron':     ['.aspx', 'searchnew', 'searchused', 'dlron.us'],
    'dealerspike':  ['dealerspike'],
    'sincro':       ['sincro', 'ansira'],
    'edealer':      ['edealer.ca'],
    'homenet':      ['homenet.com'],
    'vinsolutions': ['vinsolutions.com', 'vinconnect.com'],
    'autosoft':     ['autosoft.com'],
    'tekion':       ['tekion.com'],
}


def _norm_condition(raw: str, fallback: str = 'Used') -> str:
    """Normalise any raw condition label to the canonical 'New' or 'Used'.

    Maps every variant used by DealerOn and other platforms:
      new / newvehicle / n                              -> 'New'
      used / preowned / certifiedpreowned / certified /
      cpo / u                                           -> 'Used'
      anything else                                     -> fallback
    """
    s = re.sub(r'[\s\-]+', '', str(raw or '').strip().lower())
    if s in ('new', 'newvehicle', 'n'):
        return 'New'
    if s in ('used', 'preowned', 'certifiedpreowned', 'certified', 'cpo', 'u'):
        return 'Used'
    return fallback


def _detect_platform(url: str, html: str) -> str | None:
    """Return 'dealeron', 'dealerdotcom', 'sincro', or None.

    URL-only signatures are checked first so that JS-shell DealerOn pages
    (whose raw static HTML contains no platform markers) are still routed to
    the DealerOn parsers rather than falling through to the generic chain.
    """
    url_l = url.lower()

    # ── 1. URL-only fast path (no HTML required) ──────────────────────────────
    for platform, sigs in _PLATFORM_URL_SIGS.items():
        for sig in sigs:
            if sig in url_l:
                return platform

    # ── 2. HTML + URL scan ────────────────────────────────────────────────────
    head = html[:80_000].lower()
    for platform, sigs in _PLATFORM_SIGS.items():
        for sig in sigs:
            sl = sig.lower()
            if sl in url_l or sl in head:
                return platform

    return None


def _decode_dealeron_price_library(raw) -> dict[str, int]:
    """Decode DealerOn ``VehiclePriceLibrary`` base64 blobs into {label: dollars}.

    Typical payload (after base64 decode):
      ``MSRP:37236.0;Internet Price:34488.0;Selling Price:34488.0;
        calc_INTERNET PRICE:35063.0;calc_Dealer Doc Fee:575.0``

    Ford Direct / OEM-suppressed SRPs zero out ``VehicleInternetPrice`` on the
    card while still shipping the real selling price inside this blob.
    """
    if not raw:
        return {}
    text = str(raw).strip()
    if len(text) < 8:
        return {}
    try:
        import base64
        decoded = base64.b64decode(text + '=' * (-len(text) % 4)).decode(
            'utf-8', 'replace'
        )
    except Exception:
        # Already plain text, or undecodable — try the raw string.
        decoded = text
    if ':' not in decoded:
        return {}
    out: dict[str, int] = {}
    for part in decoded.split(';'):
        label, _, value = part.partition(':')
        label = label.strip().lower()
        if not label or not value:
            continue
        dollars = _int_safe(value, 0)
        if dollars > 0:
            out[label] = dollars
    return out


def _price_from_html_snippet(html: str) -> int:
    """Pull the first featured dollar amount out of a PriceStak HTML snippet."""
    if not html:
        return 0
    # Prefer the featured / highlight amount dealers put in the SRP card.
    for pat in (
        r'vehiclePricingHighlightAmount[^>]*>\s*\$?\s*([\d,]+)',
        r'featuredPrice[^>]*>[\s\S]*?\$\s*([\d,]+)',
        r'data-(?:price|msrp|sale-price|internet-price)=["\']\$?([\d,]+)',
        r'\$\s*([\d,]{4,})',
    ):
        m = re.search(pat, html, re.I)
        if m:
            dollars = _int_safe(m.group(1), 0)
            if dollars > 0:
                return dollars
    return 0


def _extract_vehicle_price(*sources, prefer_retail: bool = False) -> tuple[int, int]:
    """Multi-source asking price + retail/MSRP extractor.

    Checks, in order, across every mapping / object provided:
      1. Nested ``pricing.*`` / ``Pricing.*`` objects
         (internetPrice, salePrice, finalPrice, retailPrice, msrp, …)
      2. DealerOn ``VehiclePriceLibrary`` base64 breakdown
         (internet / selling / calc_internet — the real UF asking price)
      3. PriceStak / featured-price HTML snippets ("University Ford Price")
      4. Flat asking fields (VehicleInternetPrice, salePrice, …)
         — excludes TaggingPrice, which DealerOn often sets to MSRP
      5. MSRP / retail / TaggingPrice as last-resort asking price

    Returns ``(asking_price, retail_price)`` — either may be 0 when genuinely
    unlisted ("Call for Price").
    """
    objs: list[dict] = []
    html_blobs: list[str] = []
    for src in sources:
        if isinstance(src, dict):
            objs.append(src)
        elif isinstance(src, str) and src.strip():
            html_blobs.append(src)

    # Nested pricing containers dealers embed beside the card.
    nested_keys = (
        'pricing', 'Pricing', 'prices', 'Prices',
        'vehiclePricing', 'VehiclePricing',
    )
    for obj in list(objs):
        for nk in nested_keys:
            nested = obj.get(nk)
            if isinstance(nested, dict):
                objs.append(nested)

    asking_fields = (
        'internetPrice', 'InternetPrice', 'VehicleInternetPrice',
        'sellingPrice', 'SellingPrice', 'salePrice', 'SalePrice',
        'finalPrice', 'FinalPrice', 'displayPrice', 'DisplayPrice',
        'askingPrice', 'AskingPrice', 'ePrice', 'EPrice',
        'price', 'Price', 'data-price', 'data-internet-price',
        'taggedPrice',  # not TaggingPrice — that is usually MSRP on DealerOn
    )
    retail_fields = (
        'msrp', 'MSRP', 'Msrp', 'VehicleMsrp',
        'retailPrice', 'RetailPrice', 'listPrice', 'ListPrice',
        'data-msrp', 'stickerPrice', 'StickerPrice',
        'TaggingPrice',  # DealerOn tagging = sticker/MSRP on Ford Direct SRPs
    )
    # Labels inside the decoded VehiclePriceLibrary blob (lowercase).
    # Prefer raw internet/selling (matches playwright_scraper) before the
    # calc_internet amount, which usually folds in dealer doc fees.
    library_asking_labels = (
        'internet price', 'selling price', 'sale price', 'final price',
        'e-price', 'eprice', 'university ford price', 'calc_internet price',
    )

    asking = 0
    retail = 0

    # 1. Retail/MSRP sweep first (needed for savings + last-resort asking)
    for obj in objs:
        if not retail:
            for f in retail_fields:
                dollars = _int_safe(obj.get(f), 0)
                if dollars > 0:
                    retail = dollars
                    break

    # 2. DealerOn price-library blob — real internet/selling for OEM-suppressed SRPs
    for obj in objs:
        for lib_key in ('VehiclePriceLibrary', 'priceLibrary', 'PriceLibrary'):
            library = _decode_dealeron_price_library(obj.get(lib_key))
            if not library:
                continue
            if not asking:
                for label in library_asking_labels:
                    if library.get(label):
                        asking = library[label]
                        break
            if not retail:
                retail = library.get('msrp', 0) or library.get('calc_msrp', 0)
            if asking and retail:
                break

    # 3. PriceStak HTML (featured "University Ford Price" on the SRP card)
    if not asking:
        for obj in objs:
            stak = (
                (obj.get('WasabiVehiclePricingPanelViewModel') or {})
                .get('PriceStakViewModel')
                if isinstance(obj.get('WasabiVehiclePricingPanelViewModel'), dict)
                else None
            )
            if isinstance(stak, dict):
                tabs = stak.get('PriceStakTabsModel') or {}
                for hk in ('BuyContent', 'PriceMainHtml', 'PricePreHtml',
                           'LeaseContent', 'FinanceContent'):
                    blob = str(stak.get(hk) or '') or str(tabs.get(hk) or '')
                    dollars = _price_from_html_snippet(blob)
                    if dollars > 0:
                        asking = dollars
                        break
            if asking:
                break
    if not asking:
        for html in html_blobs:
            dollars = _price_from_html_snippet(html)
            if dollars > 0:
                asking = dollars
                break

    # 4. Flat asking fields (skip zeros so OEM-suppressed 0.0 falls through)
    if not asking:
        for obj in objs:
            for f in asking_fields:
                dollars = _int_safe(obj.get(f), 0)
                if dollars > 0:
                    asking = dollars
                    break
            if asking:
                break

    # 5. Nested pricing.* dicts (widget / JSON-LD shapes)
    if not asking:
        for obj in objs:
            nested = obj.get('pricing') or obj.get('Pricing')
            if not isinstance(nested, dict):
                continue
            for f in asking_fields + ('internetPrice', 'salePrice', 'finalPrice',
                                      'retailPrice', 'msrp'):
                dollars = _int_safe(nested.get(f), 0)
                if dollars > 0:
                    asking = dollars
                    break
            if asking:
                break

    # 6. Last resort — publish MSRP/Tagging so the card isn't $0 when a sticker exists
    if not asking and retail:
        asking = retail

    if prefer_retail and retail:
        return retail, retail
    # Keep MSRP as retail when it exceeds the asking/internet price
    if retail and asking and retail <= asking:
        # Same number (or asking was MSRP) — still expose it as retail for UI
        if retail == asking:
            pass
        else:
            retail = 0
    return asking, retail


def _int_safe(raw, default: int = 0) -> int:
    """Coerce any scraper-sourced value to a plain Python int for DB insertion.

    Handles the common forms scrapers produce:
      • Already an int / float          -> int(value)
      • '$31,995'  / '31,995'           -> 31995   (dollar sign, commas)
      • '1,016 mi' / '52000 mi'         -> 1016 / 52000   (mileage suffix)
      • '2024'  / ' 2024 '              -> 2024   (year with whitespace)
      • '' / None / 'N/A' / '—' / '–'  -> default (0)  (em/en dashes)
      • 'Call for Price' / 'Request a Quote' -> default (0)
      • Any other non-numeric string    -> default (0)

    Never raises.  PostgreSQL and SQLite both reject empty strings for INTEGER
    columns; this function ensures only a proper int ever reaches the DB.
    """
    if raw is None:
        return default
    if isinstance(raw, bool):
        return default
    if isinstance(raw, (int, float)):
        try:
            return int(raw)
        except (ValueError, OverflowError):
            return default
    s = str(raw).strip()
    if not s:
        return default
    sl = s.lower()
    if sl in (
        'n/a', 'na', 'none', 'null', 'undefined',
        '-', '—', '–', '−', '--', '---', '.',
    ):
        return default
    # Unlisted / call-for-price style labels — store as 0 so the UI can flag them.
    if any(tok in sl for tok in (
        'call for', 'callfor', 'request a quote', 'request quote',
        'see dealer', 'contact dealer', 'price on request', 'por',
        'not priced', 'tbd', 'coming soon',
    )):
        return default
    # Strip common non-numeric decoration: $ , spaces, currency prefixes, mi/km
    s = re.sub(r'(?i)^(usd|cad|\$)+', '', s)
    s = re.sub(r'[,$\s]', '', s)               # remove dollar, comma, whitespace
    s = re.sub(r'(?i)(mi|km|miles?)$', '', s)  # remove mileage suffix
    # Keep only digits (handles "USD31995", "~2024", etc.)
    digits = re.sub(r'[^\d]', '', s.split('.')[0])
    if not digits:
        return default
    try:
        return int(digits)
    except (ValueError, OverflowError):
        return default


def _stock_safe(raw) -> str:
    """Return a sanitised stock number or 'N/A' — never empty, never VIN-derived.

    Blocks:
      • empty / None / placeholder strings
      • bare 17-char VINs passed as stock numbers
      • pure auto-increment integers ≥ 5 digits with no letter prefix
    """
    if not raw:
        return 'N/A'
    s = str(raw).strip()
    if not s or s.lower() in ('n/a', 'na', 'none', '0', '-', '—', 'null', 'undefined'):
        return 'N/A'
    if re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', s, re.I):
        return 'N/A'   # bare VIN
    if re.fullmatch(r'\d{5,}', s):
        return 'N/A'   # pure auto-increment integer
    return s


def _apply_safety(vehicles: list[dict], condition: str) -> list[dict]:
    """Post-parse safety sweep: coerce every field to its expected type and
    lock condition.

    Numeric fields (year, price, mileage, doc_fee, retail_price, savings) are
    coerced through _int_safe so that no empty string, text suffix, or None
    value survives to the DB INSERT and triggers a PostgreSQL type error.
    """
    out = []
    for v in vehicles:
        if not isinstance(v, dict):
            continue
        v = dict(v)
        v['stock_number']  = _stock_safe(v.get('stock_number'))
        v['condition']     = condition      # absolute lock — URL context wins
        v['year']          = _int_safe(v.get('year'),         0)
        v['price']         = _int_safe(v.get('price'),        0)
        v['mileage']       = _int_safe(v.get('mileage'),      0)
        v['doc_fee']       = _int_safe(v.get('doc_fee'),      0)
        v['retail_price']  = _int_safe(v.get('retail_price'), 0)
        v['savings']       = _int_safe(v.get('savings'),      0)
        # String fields — ensure they are str, never None
        for _k in ('make', 'model', 'trim', 'color', 'exterior_color',
                   'interior_color', 'image_url', 'location', 'vdp_url'):
            if v.get(_k) is None:
                v[_k] = ''
        out.append(v)
    return out


# ── Platform-specific parsers ─────────────────────────────────────────────────

def _parse_dealeron_html(url: str, html: str, condition: str) -> list[dict]:
    """Dedicated DealerOn HTML-fallback parser for when the REST API is unavailable.

    Tries three strategies in order:
      1. Embedded JS config objects — window.DealerOnSrpConfig, window.DealerOnSrp,
         window.dealerOnConfig, KnockoutRoot bindings — parsed recursively for
         vehicle arrays.
      2. HTML card data-* attributes — DealerOn renders SRP grid cards with
         data-vin, data-stock, data-year, data-make, data-model, data-trim,
         data-internet-price, data-mileage, and data-image-url on each card element.
      3. Generic window.* JSON sweep (last resort).
    """
    # ── Strategy 1: DealerOn embedded config / state blobs ────────────────────
    _do_patterns = [
        r'window\.DealerOnSrpConfig\s*=\s*(\{[\s\S]+?\})\s*;?\s*(?:window|var|let|const|//|</script>)',
        r'window\.DealerOnSrp\s*=\s*(\{[\s\S]+?\})\s*;?\s*(?:window|var|let|const|//|</script>)',
        r'window\.dealerOnConfig\s*=\s*(\{[\s\S]+?\})\s*;?\s*',
        r'window\.DealerOnInventory\s*=\s*(\{[\s\S]+?\})\s*;?\s*',
        r'ko\.applyBindings\s*\(\s*(\{[\s\S]{200,}\})\s*[,)]',
        r'DealerOn\s*\.\s*Data\s*=\s*(\{[\s\S]{100,}\})\s*;',
    ]
    for pat in _do_patterns:
        for m in re.finditer(pat, html, re.DOTALL | re.IGNORECASE):
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    print(f"[DEALERON-HTML] config blob ({condition}) "
                          f"-> {len(vehicles)} vehicles")
                    return vehicles
            except Exception:
                pass

    # ── Strategy 2: HTML data-* attributes on vehicle grid cards ─────────────
    # DealerOn SRP cards carry data-vin, data-stock, data-year, data-make,
    # data-model, data-trim, data-condition, data-internet-price, data-mileage,
    # data-image-url on each card element, and a VDP anchor nearby.
    card_re = re.compile(
        r'<(?:div|li|article|section)[^>]+data-vin=["\']([A-HJ-NPR-Z0-9]{17})["\'][^>]*>',
        re.IGNORECASE,
    )
    vehicles_html: list[dict] = []
    for cm in card_re.finditer(html):
        vin = cm.group(1).upper()
        tag = cm.group(0)

        def _da(name: str, _tag: str = tag) -> str:
            a = re.search(rf'data-{re.escape(name)}=["\']([^"\']*)["\']', _tag, re.I)
            return a.group(1).strip() if a else ''

        # ── VDP link: data-href / data-vdp-url on the card element,
        #             or the first qualifying <a href="…"> within the card ──
        vdp_raw = (_da('href') or _da('vdp-url') or _da('vdp') or
                   _da('vehicle-url') or _da('detail-url') or '')
        if not vdp_raw:
            # Scan up to 700 chars after the opening tag for a VDP anchor.
            # DealerOn cards typically wrap the vehicle image or title in an
            # <a href="/vdp/..."> link immediately inside the card element.
            scan_src = html[cm.end():min(cm.end() + 700, len(html))]
            am = re.search(
                r'<a\s[^>]*href=["\']'
                r'(/[^"\']*(?:/vdp/|/vehicle/|/inventory/|/used/|/new/|'
                r'[A-HJ-NPR-Z0-9]{17})[^"\']*)'
                r'["\']',
                scan_src, re.I,
            )
            if am:
                vdp_raw = am.group(1)

        year_s  = _da('year')
        price_s = (_da('internet-price') or _da('asking-price') or
                   _da('price') or _da('sale-price'))
        # DealerOn server HTML always writes data-price="0" (JS fills it later).
        # data-msrp carries the actual sticker price in static markup; use it as
        # the price fallback so SRP grid rows are never written with price=0.
        msrp_s  = _da('msrp')
        mile_s  = re.sub(r'[^\d]', '', _da('mileage') or '0')
        price_i = int(re.sub(r'[^\d]', '', price_s) or '0')
        msrp_i  = int(re.sub(r'[^\d]', '', msrp_s)  or '0')
        if price_i == 0 and msrp_i > 0:
            price_i = msrp_i
        make_v  = _da('make').title()
        model_v = _da('model').title()
        year_i  = int(year_s) if year_s.isdigit() else 0

        # Condition: normalise whatever DealerOn puts in data-condition
        # (values seen in the wild: "New", "Used", "PreOwned", "CPO", "new").
        # _apply_safety will re-lock to the URL-derived value anyway, but
        # capturing it explicitly avoids any 'condition' key from a config blob
        # accidentally overriding the result between here and that sweep.
        raw_cond  = _da('condition') or _da('type') or _da('vehicle-type')
        norm_cond = _norm_condition(raw_cond, fallback=condition) if raw_cond else condition

        # Title — prefer the dealer-assembled data-name attribute (e.g. "2026 GMC
        # Yukon XL AT4") which DealerOn always populates in server HTML.  Fall back
        # to joining individual year/make/model/trim fields.  In both cases collapse
        # any double-spaces that arise from URL "+" decoding.
        name_v = _da('name')
        if name_v:
            title = re.sub(r'\s+', ' ', name_v).strip()
        else:
            title = re.sub(r'\s+', ' ', ' '.join(filter(None, [
                str(year_i) if year_i else '',
                make_v,
                model_v,
                _da('trim'),
            ]))).strip()

        vehicles_html.append({
            'vin':            vin,
            # DealerOn VDP/SRP uses data-stocknum (no separator) as the primary
            # stock attribute; fall back through the hyphenated variants.
            'stock_number':   (_da('stocknum') or _da('stock') or
                               _da('stock-number') or _da('stock-num')),
            'condition':      norm_cond,
            'year':           year_i,
            'make':           make_v,
            'model':          model_v,
            'trim':           _da('trim'),
            'mileage':        int(mile_s) if mile_s else 0,
            'price':          price_i,
            'exterior_color': _da('color') or _da('exterior-color') or _da('ext-color'),
            'interior_color': _da('interior-color') or _da('int-color'),
            'image_url':      _da('image-url') or _da('image') or _da('photo'),
            'location':       '',
            'vdp_url':        vdp_raw,
            'title':          title,
        })
    if vehicles_html:
        print(f"[DEALERON-HTML] data-* cards ({condition}) "
              f"-> {len(vehicles_html)} vehicles")
        return vehicles_html

    # ── Strategy 3: generic window.* JSON sweep ───────────────────────────────
    for m in re.finditer(
        r'window\.[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(\{[\s\S]{200,}\})\s*;',
        html, re.DOTALL,
    ):
        try:
            data     = json.loads(m.group(1))
            vehicles = _extract_vehicles_recursive(data, condition)
            if vehicles:
                print(f"[DEALERON-HTML] window.* sweep ({condition}) "
                      f"-> {len(vehicles)} vehicles")
                return vehicles
        except Exception:
            pass

    return []


def _fetch_dealeron_srp_config(url: str) -> dict | None:
    """Extract DealerOn Cosmos API config from an SRP page's embedded JSON.

    DealerOn's modern Vue-based SRP embeds a ``<script id='dlron-srp-model'>``
    tag containing dealer IDs, page IDs, and base filters that the
    ``inventory-widget`` Vue component reads at runtime to build the API URL.

    Discovered via SRP bundle analysis:
        /resources/{dealerCode}/pages/searchResultsPage/…  -> dealerCode
        dlron-srp-model JSON: DealerId, PageId, BaseFilter

    Returns a dict with keys (dealer_code, dealer_id, page_id, base_filter,
    base_url) on success, or None if the page is not a DealerOn Cosmos site.
    """
    from urllib.parse import urlparse
    parsed   = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    hdrs = {**MOSES_SCRAPER_HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*'}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read(600_000).decode('utf-8', errors='replace')
    except Exception:
        return None

    # Dealer code: the path component unique to this dealer in all resource URLs
    # e.g.  /resources/vhcliaa/pages/searchResultsPage/…
    m = re.search(r'/resources/([a-z0-9]+)/pages/', html)
    if not m:
        return None
    dealer_code = m.group(1)

    # dlron-srp-model JSON script tag contains DealerId, PageId, BaseFilter
    m = re.search(
        r'<script[^>]+id=["\']dlron-srp-model["\'][^>]*>([\s\S]+?)</script>',
        html, re.I,
    )
    if not m:
        return None
    try:
        srp_model = json.loads(m.group(1))
    except (json.JSONDecodeError, ValueError):
        return None

    dealer_id   = srp_model.get('DealerId')
    page_id     = srp_model.get('PageId')
    base_filter = str(srp_model.get('BaseFilter') or '')

    if not dealer_id or not page_id:
        return None

    return {
        'dealer_code':  dealer_code,
        'dealer_id':    int(dealer_id),
        'page_id':      int(page_id),
        'base_filter':  base_filter,
        'base_url':     base_url,
    }


def _normalize_cosmos_vehicle_card(vc: dict, base_url: str, condition: str) -> dict | None:
    """Map a DealerOn Cosmos SRP ``VehicleCard`` to our standard vehicle schema.

    The VehicleCard is the value under ``DisplayCards[n].VehicleCard`` in the
    Cosmos SRP API response.  All identity, pricing, and media fields are flat
    top-level keys on the card (no nesting required for the main fields).

    Price notes
    -----------
    Ford Direct dealers often zero out ``VehicleInternetPrice`` on the card
    while still shipping the real selling price inside ``VehiclePriceLibrary``
    (base64) and the PriceStak featured HTML.  ``_extract_vehicle_price`` walks
    every known fallback so University Ford / similar rooftops land a numeric
    asking price instead of $0.
    """
    vin = str(vc.get('VehicleVin') or '').strip().upper()
    if not vin:
        # Fallback: VIN sometimes lives one level deeper in the image carousel
        vin = str(
            (vc.get('VehicleImageModel') or {})
            .get('VehicleImageCarouselModel', {})
            .get('Vin') or ''
        ).strip().upper()
    if not vin:
        return None

    year  = vc.get('VehicleYear')
    make  = str(vc.get('VehicleMake')  or '').strip()
    model = str(vc.get('VehicleModel') or '').strip()
    if not (year and make and model):
        return None

    price, retail_price = _extract_vehicle_price(vc)
    msrp_price = retail_price or _int_safe(vc.get('VehicleMsrp'), 0)

    # VDP URL — VehicleDetailUrl is already absolute on Cosmos cards
    vdp = str(vc.get('VehicleDetailUrl') or '').strip()
    if vdp and not vdp.startswith('http'):
        vdp = base_url.rstrip('/') + '/' + vdp.lstrip('/')

    # Primary photo — VehiclePhotoSrc is relative; resolve to absolute
    photo_src = str(
        (vc.get('VehicleImageModel') or {}).get('VehiclePhotoSrc') or ''
    ).strip()
    if photo_src and not photo_src.startswith('http'):
        photo_src = base_url.rstrip('/') + '/' + photo_src.lstrip('/')

    # Condition normalisation: VehicleCondition can be "Certified Pre-Owned",
    # "New", "Used", etc.  VehicleType is the compact lowercase form.
    raw_cond = str(vc.get('VehicleCondition') or vc.get('VehicleType') or '').lower()
    if 'new' in raw_cond:
        norm_cond = 'New'
    elif any(x in raw_cond for x in ('used', 'pre-owned', 'pre owned', 'certified')):
        norm_cond = 'Used'
    else:
        norm_cond = condition  # honour the caller's intended condition

    # Rooftop / dealership-group — prefer Cosmos city fields, then VDP slug,
    # then host defaults for single-location sites.
    if _scraper_engine is not None:
        location, dealership_group = _scraper_engine.resolve_vehicle_rooftop(
            card=vc, vdp_url=vdp, base_url=base_url,
        )
    else:
        location = _canonicalize_location(
            str(vc.get('DealerLocatedAtCity') or vc.get('VehicleLocation') or '')
        )
        dealership_group = str(vc.get('DealerName') or '').strip()

    return {
        'vin':            vin,
        'stock_number':   str(vc.get('VehicleStockNumber') or '').strip(),
        'year':           _int_safe(year, 0),
        'make':           make,
        'model':          model,
        'trim':           str(vc.get('VehicleTrim')            or '').strip(),
        'price':          price,
        'msrp':           msrp_price,
        'retail_price':   retail_price or msrp_price,
        'mileage':        _int_safe(vc.get('VehicleMileage'), 0),
        'exterior_color': str(vc.get('ExteriorColorLabel')      or '').strip(),
        'interior_color': str(vc.get('InteriorColorLabel')      or '').strip(),
        'vdp_url':        vdp,
        'image_url':      photo_src,
        'condition':      norm_cond,
        'location':       location,
        'dealership_group': dealership_group,
        'body_style':     str(vc.get('VehicleBodyStyle')        or '').strip(),
        'drivetrain':     str(vc.get('VehicleDriveTrain')       or '').strip(),
        'transmission':   str(vc.get('VehicleTransmission')     or '').strip(),
        'fuel_type':      str(vc.get('VehicleFuelType')         or '').strip(),
        'mpg_city':       _int_safe(vc.get('VehicleMpgCity'), 0),
        'mpg_hwy':        _int_safe(vc.get('VehicleMpgHwy'), 0),
    }


def _parse_dealeron_cosmos_api(
    url: str,
    condition: str,
    session_id: str | None = None,
) -> list[dict]:
    """Call DealerOn's Cosmos SRP REST API to retrieve inventory.

    Endpoint (discovered via SRP JS bundle analysis):
        GET /api/{dealerCode}/vehicle-pages/cosmos/srp/vehicles/{dealerId}/{pageId}
            ?baseFilter={base64(filter)}&pn={pageSize}&pt={pageNumber}

    Critical: DealerOn's Wasabi/Cosmos bundle maps query keys as
    ``PageSize="pn"`` and ``PageNumber="pt"``.  Passing ``pageSize`` /
    ``pageNumber`` is silently ignored — every request returns page 1 —
    which is why University Ford previously capped at ~24 vehicles.

    The three config values (dealerCode, dealerId, pageId) are extracted from
    the SRP page's embedded ``dlron-srp-model`` JSON script tag.  The
    ``baseFilter`` is also sourced from that JSON (e.g. ``"type='u'"`` for used
    vehicles) and must be base64-encoded per DealerOn's ``btoa()`` call in the
    SRP bundle.

    Page size note
    --------------
    ``pn=48`` is accepted by current Cosmos SRPs and cuts page count in half
    vs the dealer default of 24.  Larger values (100/500) are clamped back to
    12 by the API, so we stay at 48.  Remaining pages are fetched concurrently
    after page 1 reports ``TotalPages``.

    Cancellation
    ------------
    When ``session_id`` (or the thread-bound sync session) is marked
    ``cancelling``, pagination stops after the current page and returns
    whatever vehicles were already parsed so the caller can commit a partial
    inventory.
    """
    import base64
    import concurrent.futures
    from urllib.parse import urlparse

    COSMOS_PARALLEL_WORKERS = 10  # concurrent page fetches after page-1 probe
    _PER_REQUEST_TIMEOUT    = 15  # seconds per individual HTTP request
    # 48 is the largest pn Cosmos currently honours without clamping to 12.
    _REQUESTED_PAGE_SIZE    = 48

    def _cancelled() -> bool:
        if _scraper_engine is None:
            return False
        return _scraper_engine.should_stop(session_id)

    if _cancelled():
        return []

    config = _fetch_dealeron_srp_config(url)
    if not config:
        return []

    if _cancelled():
        return []

    base_url     = config['base_url']
    dealer_code  = config['dealer_code']
    dealer_id    = config['dealer_id']
    page_id      = config['page_id']
    base_filter  = config['base_filter']
    netloc       = urlparse(url).netloc

    # base64-encode the filter, replacing + with %2B (mirrors DealerOn JS)
    b64_filter = base64.b64encode(base_filter.encode()).decode().replace('+', '%2B')

    root_ep = (
        f"{base_url}/api/{dealer_code}"
        f"/vehicle-pages/cosmos/srp/vehicles/{dealer_id}/{page_id}"
    )
    hdrs = {
        **MOSES_SCRAPER_HEADERS,
        'Accept':           'application/json, text/plain, */*',
        'Referer':          url,
        'X-Requested-With': 'XMLHttpRequest',
    }

    def _fetch_page(page_num: int, page_size: int = _REQUESTED_PAGE_SIZE
                    ) -> tuple[list[dict], dict]:
        """Fetch one page; return (vehicles, paginationDataModel).

        Uses DealerOn's real query keys: ``pn`` (page size) and ``pt``
        (page number).  ``pageSize`` / ``pageNumber`` are dead aliases.
        """
        # Abort BEFORE opening the socket when Cancel Sync was pressed.
        if _scraper_engine is not None and _scraper_engine.should_stop(session_id):
            return [], {}
        ep = (
            f"{root_ep}?baseFilter={b64_filter}"
            f"&pn={int(page_size)}&pt={int(page_num)}"
        )
        req = urllib.request.Request(ep, headers=hdrs)
        with urllib.request.urlopen(req, timeout=_PER_REQUEST_TIMEOUT) as resp:
            ct  = resp.headers.get('Content-Type', '')
            raw = resp.read().decode('utf-8', errors='replace')
        if 'html' in ct.lower() or raw.lstrip().startswith('<'):
            return [], {}
        data  = json.loads(raw)
        cards = [
            c for c in (data.get('DisplayCards') or [])
            if not c.get('IsAdCard') and c.get('VehicleCard')
        ]
        batch = []
        for card in cards:
            v = _normalize_cosmos_vehicle_card(card['VehicleCard'], base_url, condition)
            if v:
                batch.append(v)
        paging_meta = (data.get('Paging') or {}).get('PaginationDataModel') or {}
        return batch, paging_meta

    # ── Phase 1: fetch page 1 to learn total page count ───────────────────────
    try:
        first_batch, paging_meta = _fetch_page(1)
    except Exception as exc:
        print(f"[DEALERON-COSMOS] ({condition}) page-1 fetch failed for {netloc}: {exc}")
        return []

    if not first_batch:
        return []

    if _scraper_engine is not None:
        _scraper_engine.bump_scraped_count(session_id, len(first_batch))

    total_pages = int(paging_meta.get('TotalPages') or 1)
    total_count = int(paging_meta.get('TotalCount') or len(first_batch))
    # Honour the page size Cosmos actually used (may differ from requested).
    actual_page_size = int(
        paging_meta.get('PageSize') or len(first_batch) or _REQUESTED_PAGE_SIZE
    )

    if total_pages <= 1 or _cancelled():
        print(
            f"[Scraper] Page 1: {len(first_batch)} vehicles found "
            f"({len(first_batch)}/{total_count} total) [{condition}] {netloc}"
        )
        print(
            f"[DEALERON-COSMOS] ({condition}) "
            f"-> {len(first_batch)} vehicles from {netloc} "
            f"(dealerId={dealer_id}, pageId={page_id}, pages=1"
            f"{', cancelled' if _cancelled() else ''})"
        )
        return first_batch

    # ── Phase 2: fetch remaining pages in parallel ────────────────────────────
    remaining_pages = list(range(2, total_pages + 1))
    all_vehicles: list[dict] = list(first_batch)  # start with page-1 results
    page_counts: dict[int, int] = {1: len(first_batch)}

    deadline = time.monotonic() + DEALERON_API_PROBE_BUDGET_SECS

    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=COSMOS_PARALLEL_WORKERS
        ) as pool:
            futures = {
                pool.submit(_fetch_page, pn, actual_page_size): pn
                for pn in remaining_pages
                if time.monotonic() < deadline and not _cancelled()
            }
            for fut in concurrent.futures.as_completed(
                futures, timeout=max(0.5, deadline - time.monotonic())
            ):
                if _cancelled():
                    for pending in futures:
                        pending.cancel()
                    break
                pn = futures[fut]
                try:
                    page_batch, _ = fut.result()
                    page_counts[pn] = len(page_batch)
                    all_vehicles.extend(page_batch)
                    if _scraper_engine is not None and page_batch:
                        _scraper_engine.bump_scraped_count(session_id, len(page_batch))
                except Exception as page_exc:
                    page_counts[pn] = 0
                    print(
                        f"[Scraper] Page {pn}: FAILED ({type(page_exc).__name__}: "
                        f"{page_exc}) [{condition}] {netloc}"
                    )
    except concurrent.futures.TimeoutError:
        print(
            f"[Scraper] Pagination budget exhausted after collecting "
            f"{len(all_vehicles)} vehicles [{condition}] {netloc}"
        )

    # Emit page logs in order so the terminal reads as a clean progression.
    running = 0
    for pn in sorted(page_counts):
        running += page_counts[pn]
        print(
            f"[Scraper] Page {pn}: {page_counts[pn]} vehicles found "
            f"({running}/{total_count} total) [{condition}] {netloc}"
        )

    # Deduplicate by VIN — parallel page fetches can yield the same vehicle
    # at page boundaries (e.g. a vehicle added/removed mid-crawl shifts the
    # page offsets, causing it to appear on two adjacent pages).
    _seen_vins: set[str] = set()
    _deduped:   list[dict] = []
    for _v in all_vehicles:
        _vkey = _v.get('vin', '').strip()
        if _vkey and _vkey not in _seen_vins:
            _seen_vins.add(_vkey)
            _deduped.append(_v)
        elif not _vkey:
            _deduped.append(_v)   # keep VIN-less rows (stock_number-only sources)
    all_vehicles = _deduped

    _cancel_note = ", cancelled" if _cancelled() else ""
    print(
        f"[DEALERON-COSMOS] ({condition}) "
        f"-> {len(all_vehicles)}/{total_count} vehicles from {netloc} "
        f"(dealerId={dealer_id}, pageId={page_id}, "
        f"pages={total_pages}, pn={actual_page_size}, "
        f"workers={COSMOS_PARALLEL_WORKERS}{_cancel_note})"
    )
    print(
        f"[Scraper] Combined: {len(all_vehicles)} unique vehicles "
        f"from {total_pages} page(s) [{condition}] {netloc}"
    )
    return all_vehicles


def _parse_dealeron_api(url: str, condition: str) -> list[dict]:
    """Call DealerOn's internal inventory REST API directly.

    /api/Inventory/GetInventory is the same endpoint the browser SRP calls —
    no auth required.  Handles pagination automatically.

    Time budget
    -----------
    The entire probe (both endpoint variants + all pagination) is bounded by
    DEALERON_API_PROBE_BUDGET_SECS (default 30 s).  Each individual HTTP
    request uses ``timeout = min(20, remaining_budget)`` so that a request
    starting near the deadline cannot overrun the budget by a full 20 s.

    This gives a hard wall-clock upper bound:
        total elapsed ≤ DEALERON_API_PROBE_BUDGET_SECS (30 s)
    for any number of pages or endpoint variants.
    """
    from urllib.parse import urlparse
    parsed   = urlparse(url)
    base     = f"{parsed.scheme}://{parsed.netloc}"
    is_new   = condition == 'New'
    hdrs     = {**MOSES_SCRAPER_HEADERS,
                'Accept': 'application/json, text/javascript, */*',
                'X-Requested-With': 'XMLHttpRequest'}

    endpoints = [
        (f"{base}/api/Inventory/GetInventory"
         f"?IsNew={str(is_new).lower()}&PageSize=200&IncludeFacets=false"),
        (f"{base}/api/Inventory/GetInventory"
         f"?condition={'new' if is_new else 'used'}&PageSize=200"),
    ]

    deadline = time.monotonic() + DEALERON_API_PROBE_BUDGET_SECS
    # Maximum per-request socket timeout when the full budget is available.
    _PER_REQUEST_MAX = 20

    for ep in endpoints:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break  # overall budget exhausted — fall through to HTML path

        all_vehicles: list[dict] = []
        page = 1
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Budget hit mid-pagination: return whatever we have so far
                    # rather than abandoning the results already fetched.
                    if all_vehicles:
                        print(f"[HYBRID] DealerOn API ({condition}) probe budget "
                              f"reached after {page - 1} page(s); "
                              f"returning {len(all_vehicles)} vehicles from "
                              f"{parsed.netloc}")
                        return all_vehicles
                    break  # nothing accumulated yet; try next endpoint or give up

                # Clamp the per-request socket timeout to the remaining budget
                # so a near-expired budget can never overrun by a full 20 s.
                req_timeout = min(_PER_REQUEST_MAX, remaining)
                req = urllib.request.Request(f"{ep}&PageNumber={page}", headers=hdrs)
                with urllib.request.urlopen(req, timeout=req_timeout) as resp:
                    ct = resp.headers.get('Content-Type', '')
                    if 'json' not in ct and 'javascript' not in ct:
                        break
                    data = json.loads(resp.read().decode('utf-8', errors='replace'))

                raw_list = (
                    data.get('inventory') or data.get('Inventory') or
                    data.get('vehicles')  or data.get('Vehicles')  or
                    (data if isinstance(data, list) else [])
                )
                if not raw_list:
                    break

                batch = [v for v in
                         (_normalize_scraped(i, condition) for i in raw_list)
                         if v]
                all_vehicles.extend(batch)

                total     = int(data.get('totalCount') or data.get('TotalCount') or 0)
                page_size = int(data.get('pageSize')   or data.get('PageSize')   or
                                len(raw_list))
                if not batch or page * page_size >= max(total, 1):
                    break
                page += 1

            if all_vehicles:
                print(f"[HYBRID] DealerOn API ({condition}) "
                      f"-> {len(all_vehicles)} vehicles from {parsed.netloc}")
                return all_vehicles
        except Exception:
            pass   # try the next endpoint variant

    return []


def _extract_ddc_inventory(html: str, condition: str, base_url: str = '') -> list[dict]:
    """Extract vehicles from the DDC.WS.state blob embedded in every Dealer.com page.

    Dealer.com (CDK v9) server-renders a full inventory state object into each
    SRP page's JavaScript for SEO and first-paint performance:

        DDC.WS.state['ws-inv-data']['inventory-data-bus*'] = {
            WIS: { inventory: [ {vin, stockNumber, make, model, trim,
                                  title, pricing, images, attributes, ...}, ... ]
            }
        }

    We parse that blob directly, avoiding the JS-only data-bus XHR entirely.
    """
    results: list[dict] = []
    seen:    set[str]   = set()

    for m in re.finditer(
        r"DDC\.WS\.state\['([^']+)'\]\['([^']+)'\]\s*=\s*\{",
        html,
    ):
        widget, inst = m.group(1), m.group(2)
        if 'inv-data' not in widget and 'inventory-data' not in inst:
            continue

        # Extract the JSON blob by counting brace depth
        blob_start = m.end() - 1
        depth = 0; pos = blob_start
        limit = min(blob_start + 700_000, len(html))
        while pos < limit:
            c = html[pos]
            if   c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    break
            pos += 1

        try:
            blob = json.loads(html[blob_start:pos + 1])
        except Exception:
            continue

        raw_vehicles = blob.get('WIS', {}).get('inventory', [])
        if not raw_vehicles:
            continue

        for item in raw_vehicles:
            if not isinstance(item, dict) or item.get('isPlaceholder'):
                continue

            vin = str(item.get('vin', '')).strip().upper()
            if not vin or len(vin) < 10 or vin in seen:
                continue

            # ── Year from title array (e.g. ["2026 Chevrolet", "Trax LT"]) ──
            year = 0
            title_parts = item.get('title', [])
            for tp in (title_parts if isinstance(title_parts, list) else []):
                ym = re.search(r'\b(20[012]\d|19[89]\d)\b', str(tp))
                if ym:
                    year = int(ym.group(1)); break

            # ── Price: final/internet price from dprice list ──────────────
            # Some dealers (e.g. Glockner) attach isFinalPrice:true to the
            # Doc Fee row (typeClass 'invoicePrice', value ~$398) when no
            # explicit internet-price entry exists.  Always skip fee/discount
            # entries regardless of isFinalPrice.
            _SKIP_PRICE_TYPES = {'invoicePrice', 'AsubBRule', 'SICRule'}
            price = 0
            for dp in item.get('pricing', {}).get('dprice', []):
                if not isinstance(dp, dict): continue
                if dp.get('isDiscount') or dp.get('typeClass') in _SKIP_PRICE_TYPES:
                    continue
                if dp.get('isFinalPrice') or dp.get('typeClass') == 'internetPrice':
                    val = re.sub(r'[^\d]', '', str(dp.get('value', '')))
                    if val:
                        price = int(val); break
            # Fallback: MSRP minus sum of all discount entries (AsubBRule)
            if not price:
                _msrp = _total_disc = 0
                for dp in item.get('pricing', {}).get('dprice', []):
                    if not isinstance(dp, dict): continue
                    tc  = dp.get('typeClass', '')
                    val = int(re.sub(r'[^\d]', '', str(dp.get('value', ''))) or 0)
                    if tc == 'msrp' and val:
                        _msrp = val
                    elif (dp.get('isDiscount') or tc == 'AsubBRule') and val:
                        _total_disc += val
                if _msrp:
                    price = max(_msrp - _total_disc, 0) or _msrp
            # Fallback: retailPrice string on the pricing object
            if not price:
                rp = item.get('pricing', {}).get('retailPrice', '')
                val = re.sub(r'[^\d]', '', str(rp))
                if val:
                    price = int(val)

            # ── Mileage ───────────────────────────────────────────────────────
            mileage = 0
            for mk in ('mileage', 'odometer', 'miles'):
                raw_mi = item.get(mk)
                if raw_mi is not None:
                    try:
                        mileage = int(str(raw_mi).replace(',', ''))
                    except Exception:
                        pass
                    if mileage:
                        break

            # ── Colors: check top-level keys, then attributes list ────────────
            ext_color = str(item.get('exteriorColor') or
                            item.get('exterior_color') or
                            item.get('color') or '')
            int_color = str(item.get('interiorColor') or
                            item.get('interior_color') or '')
            for attr in item.get('attributes', []):
                if not isinstance(attr, dict):
                    continue
                name = attr.get('name', '').lower()
                val  = str(attr.get('value', ''))
                if not ext_color and ('exterior' in name or name == 'color'):
                    ext_color = val
                elif not int_color and 'interior' in name:
                    int_color = val

            # ── Image: first uri from images array ────────────────────────────
            image_url = ''
            for img in item.get('images', []):
                if isinstance(img, dict):
                    image_url = img.get('uri', '') or img.get('url', '')
                elif isinstance(img, str):
                    image_url = img
                if image_url:
                    break

            # ── VDP URL: item.link is a root-relative path ────────────────
            raw_link = str(item.get('link', '') or '').strip()
            vdp_url  = (f"{base_url.rstrip('/')}{raw_link}"
                        if raw_link.startswith('/') and base_url
                        else raw_link)

            seen.add(vin)
            results.append({
                'vin':            vin,
                'stock_number':   str(item.get('stockNumber', '')).strip(),
                'condition':      condition,
                'year':           year,
                'make':           str(item.get('make', '')),
                'model':          str(item.get('model', '')),
                'trim':           str(item.get('trim', '')),
                'mileage':        mileage,
                'price':          price,
                'exterior_color': ext_color,
                'interior_color': int_color,
                'image_url':      image_url,
                'location':       '',
                'vdp_url':        vdp_url,
            })

        if results:
            print(f"[HYBRID] DDC.WS.state ({condition}) -> {len(results)} vehicles "
                  f"from {widget!r}[{inst!r}].WIS.inventory")
            return results

    return results


def _parse_dealerdotcom(url: str, html: str, condition: str) -> list[dict]:
    """Extract inventory from Dealer.com (CDK Global) pages.

    Priority:
    1. Locate accountId in HTML and try three CDK API endpoints
       (v2 JSON, legacy widget JS, v2 inventory).
    2. Embedded JSON blobs (DDC.PartialState, window.pageData, etc.).
    3. Sitemap-based VDP URL extraction (/sitemap-inventory.xml or /sitemap.xml).
    """
    from urllib.parse import urlparse
    parsed = urlparse(url)
    base   = f"{parsed.scheme}://{parsed.netloc}"

    # ── Step 1: extract accountId ─────────────────────────────────────────────
    account_id: str | None = None
    for acct_pat in (
        r'accountId["\s:=]+["\']([A-Za-z0-9_-]{3,30})["\']',
        r'data-ddc-widget-account=["\']([A-Za-z0-9_-]{3,30})["\']',
        r'"accountId"\s*:\s*"([A-Za-z0-9_-]{3,30})"',
        r"'accountId'\s*:\s*'([A-Za-z0-9_-]{3,30})'",
        r'DDC\s*\.\s*dataLayer[^;]*?id["\s]*:\s*["\']([A-Za-z0-9_-]{3,30})["\']',
    ):
        m = re.search(acct_pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            account_id = m.group(1)
            break

    # ── Step 0: DDC.WS.state server-rendered blob (most reliable for CDK v9) ──
    # Dealer.com embeds the full inventory into every SRP page's JS state for
    # SEO / first-paint — parse it directly before trying any XHR endpoint.
    # The blob contains only the first page (~24 vehicles).  After extracting
    # it we always merge with the sitemap so the full inventory is covered.
    vehicles = _extract_ddc_inventory(html, condition, base_url=base)
    sitemap_stubs = _parse_dealerdotcom_sitemap(base, condition)
    if sitemap_stubs:
        # Enrich stubs with data from the embedded page where we have a match
        # (match by vdp_url, which both sources now populate).
        rich_by_url = {v['vdp_url']: v for v in vehicles if v.get('vdp_url')}
        merged: list[dict] = list(vehicles)   # start with all rich records
        stub_urls_added: set[str] = {v.get('vdp_url', '') for v in vehicles}
        for stub in sitemap_stubs:
            su = stub.get('vdp_url', '')
            if su and su in rich_by_url:
                continue   # already have rich data for this VDP
            if su not in stub_urls_added:
                merged.append(stub)
                stub_urls_added.add(su)
        if merged:
            print(f"[HYBRID] Dealer.com ({condition}) -> {len(merged)} vehicles "
                  f"({len(vehicles)} rich + {len(merged)-len(vehicles)} sitemap stubs)")
            return merged
    if vehicles:
        return vehicles

    if account_id:
        inv_type  = 'new' if condition == 'New' else 'used'
        hdrs_json = {**MOSES_SCRAPER_HEADERS, 'Accept': 'application/json, */*',
                     'X-Requested-With': 'XMLHttpRequest'}
        api_candidates = [
            # v2 JSON endpoint (primary — most modern Dealer.com installs)
            (f"{base}/apis/widget/v2/inventory-results-as-json"
             f"?accountId={account_id}&type={inv_type}&pageSize=100"),
            # Legacy widget JS endpoint
            (f"{base}/apis/widget/WS.inventory.vehicle-listings.js/getInventory"
             f"?accountId={account_id}&widgetName=VehicleListing{condition}"
             f"&pageSize=100&inventoryType={inv_type}"),
            # Alternate v2 path
            (f"{base}/apis/widget/v2/inventory"
             f"?accountId={account_id}&inventoryType={inv_type}&pageSize=100"),
        ]
        for api_url in api_candidates:
            try:
                req = urllib.request.Request(api_url, headers=hdrs_json)
                with urllib.request.urlopen(req, timeout=20) as resp:
                    ct = resp.headers.get('Content-Type', '')
                    if 'html' in ct:
                        continue   # got a redirect to an HTML page — skip
                    data = json.loads(resp.read().decode('utf-8', errors='replace'))
                raw_list = (
                    data.get('vehicles') or data.get('inventory') or
                    data.get('listings') or data.get('results') or
                    (data if isinstance(data, list) else [])
                )
                batch = [v for v in
                         (_normalize_scraped(i, condition) for i in raw_list)
                         if v]
                if batch:
                    print(f"[HYBRID] Dealer.com API ({condition}) "
                          f"-> {len(batch)} vehicles via {api_url.split('?')[0]}")
                    return batch
            except Exception:
                pass

    # ── Step 2: embedded JSON blobs ───────────────────────────────────────────
    for pat in (
        r'DDC\.PartialState\s*=\s*(\{[\s\S]+?\});\s*(?:DDC|window|var|/[/*])',
        r'window\.pageData\s*=\s*(\{[\s\S]+?\});\s*',
        r'window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});\s*',
        r'<script[^>]+type=["\']application/json["\'][^>]*>([\s\S]+?)</script>',
    ):
        for m in re.finditer(pat, html, re.DOTALL | re.IGNORECASE):
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    print(f"[HYBRID] Dealer.com embedded JSON ({condition}) "
                          f"-> {len(vehicles)} vehicles")
                    return vehicles
            except Exception:
                pass

    # ── Step 3: sitemap-based VDP URL extraction ──────────────────────────────
    # Dealer.com sites expose /sitemap-inventory.xml (or /sitemap.xml) containing
    # VDP URLs from which we can extract VIN + condition + make/model/year.
    # This is the last resort when the JS-rendered SRP returns no in-page data.
    vehicles = _parse_dealerdotcom_sitemap(base, condition)
    if vehicles:
        return vehicles

    return []


def _parse_dealerdotcom_sitemap(base: str, condition: str) -> list[dict]:
    """Extract vehicle stubs from a Dealer.com sitemap XML file.

    Tries /sitemap-inventory.xml first, then /sitemap.xml.
    VDP URLs follow a predictable path scheme:
        /inventory/{new|used}/{make}/{model}/{VIN}.html
        /new/{make}-{model}-{year}-{VIN}.html
        /{condition}-{location}-{year}-{make}-{model}-{trim}-{VIN}  (DealerOn-style)
    Only returns records that contain a valid 17-char VIN.
    """
    from urllib.parse import urlparse

    sitemap_urls = [
        f"{base}/sitemap-inventory.xml",
        f"{base}/sitemap.xml",
    ]
    hdrs = {**MOSES_SCRAPER_HEADERS, 'Accept': 'application/xml, text/xml, */*'}

    for sm_url in sitemap_urls:
        try:
            req = urllib.request.Request(sm_url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=20) as resp:
                sm_xml = resp.read().decode('utf-8', errors='replace')
        except Exception:
            continue

        # Collect all <loc> entries
        locs = re.findall(r'<loc>\s*(https?://[^\s<]+)\s*</loc>', sm_xml)
        if not locs:
            continue

        seen:    set[str]   = set()
        results: list[dict] = []

        for loc in locs:
            loc_path = urlparse(loc).path

            # ── Format A: UUID-style Dealer.com VDP URLs ─────────────────
            # e.g. /new/Chevrolet/2026-Chevrolet-Trax-e4d6860eac180fc245f8f4d042d97be1.htm
            #      /used/Chevrolet/2022-Chevrolet-Blazer-6a81c3b8ac1835a65334a55ff5477fab.htm
            uuid_m = re.search(
                r'/(new|used|pre-owned)/([^/]+)/'
                r'(\d{4})-([^/]+?)-([0-9a-f]{28,36})\.htm',
                loc_path, re.I,
            )
            if uuid_m:
                raw_cond   = uuid_m.group(1).lower()
                url_cond   = 'New' if raw_cond == 'new' else 'Used'
                if url_cond != condition:
                    continue
                year_str    = uuid_m.group(3)
                slug4       = uuid_m.group(4)       # e.g. "Chevrolet-Equinox" or "Ford-F-150"
                make_prefix = uuid_m.group(2)        # directory segment, e.g. "Chevrolet"
                # Strip the leading make from the slug so model never duplicates it
                # ("Chevrolet-Equinox" -> "Equinox", "Ford-F-150" -> "F-150")
                if slug4.lower().startswith(make_prefix.lower() + '-'):
                    slug4 = slug4[len(make_prefix) + 1:]
                make_dir   = make_prefix.replace('-', ' ').title()
                model_slug = slug4.replace('-', ' ').title()
                uuid_key   = uuid_m.group(5)
                if uuid_key in seen:
                    continue
                seen.add(uuid_key)
                # Use the UUID as a synthetic VIN so each stub gets its own
                # row in the ON CONFLICT(user_id, vin) upsert.  It is 32 hex
                # chars — never confused with a real 17-char VIN.
                results.append({
                    'vin':            uuid_key,
                    'stock_number':   '',
                    'condition':      url_cond,
                    'year':           int(year_str),
                    'make':           make_dir,
                    'model':          model_slug,
                    'trim':           '',
                    'mileage':        0,
                    'price':          0,
                    'exterior_color': '',
                    'interior_color': '',
                    'image_url':      '',
                    'location':       '',
                    'vdp_url':        loc,
                })
                continue

            # ── Format B: VIN embedded in path (17-char alphanum, no I/O/Q) ──
            # e.g. /inventory/new/chevrolet/silverado-1500/1GCUKNELXJZ123456.html
            vin_m = re.search(r'\b([A-HJ-NPR-Z0-9]{17})\b', loc, re.I)
            if not vin_m:
                continue
            vin = vin_m.group(1).upper()
            if vin in seen:
                continue

            # Condition from URL path
            path_lower = loc_path.lower()
            if any(x in path_lower for x in ('/used/', '/pre-owned/', '/used-', '-used-')):
                url_cond = 'Used'
            elif any(x in path_lower for x in ('/new/', '/new-', '-new-')):
                url_cond = 'New'
            else:
                url_cond = condition

            if url_cond != condition:
                continue

            # Year from URL
            year = 0
            ym = re.search(r'[/-](20[012]\d|19[89]\d)[/-]', loc)
            if ym:
                year = int(ym.group(1))

            # Make & model from segments after the condition keyword
            segs = [s for s in path_lower.split('/') if s and vin_m.group(1).lower() not in s]
            make = model = ''
            for i, seg in enumerate(segs):
                if seg in ('new', 'used', 'inventory', 'pre-owned', 'certified'):
                    if i + 1 < len(segs):
                        make  = segs[i + 1].replace('-', ' ').title()
                    if i + 2 < len(segs):
                        model = segs[i + 2].replace('-', ' ').title()
                    break

            seen.add(vin)
            results.append({
                'vin':            vin,
                'stock_number':   '',
                'condition':      url_cond,
                'year':           year,
                'make':           make,
                'model':          model,
                'trim':           '',
                'mileage':        0,
                'price':          0,
                'exterior_color': '',
                'interior_color': '',
                'image_url':      '',
                'location':       '',
                'vdp_url':        loc,
            })

        if results:
            print(f"[HYBRID] Dealer.com sitemap ({condition}) "
                  f"-> {len(results)} vehicles from {sm_url}")
            return results

    return []


def _parse_sincro(url: str, html: str, condition: str) -> list[dict]:
    """Extract inventory from Sincro / Ansira (incl. Next.js __NEXT_DATA__) pages."""
    for pat in (
        r'window\.SRP_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
        r'window\.SERVER_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
        r'window\.initialState\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
        r'window\.__NEXT_DATA__\s*=\s*(\{[\s\S]+?\});\s*',
        r'<script[^>]*id=["\']__NEXT_DATA__["\'][^>]*>([\s\S]+?)</script>',
    ):
        for m in re.finditer(pat, html, re.DOTALL | re.IGNORECASE):
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    print(f"[HYBRID] Sincro/Ansira embedded state ({condition}) "
                          f"-> {len(vehicles)} vehicles")
                    return vehicles
            except Exception:
                pass
    return []


def _parse_dealerspike(url: str, html: str, condition: str) -> list[dict]:
    """Extract inventory from DealerSpike ``window.vehicles`` / inventory blobs."""
    for pat in (
        r'window\.vehicles\s*=\s*(\[[\s\S]+?\])\s*;',
        r'window\.vehicles\s*=\s*(\{[\s\S]+?\})\s*;',
        r'window\.DSInventory\s*=\s*(\{[\s\S]+?\})\s*;',
        r'var\s+vehicles\s*=\s*(\[[\s\S]+?\])\s*;',
    ):
        for m in re.finditer(pat, html, re.DOTALL | re.IGNORECASE):
            try:
                data = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    print(f"[HYBRID] DealerSpike embedded state ({condition}) "
                          f"-> {len(vehicles)} vehicles")
                    return vehicles
            except Exception:
                pass
    return []


# ── Fallback parsers (Method 2) ───────────────────────────────────────────────

def _parse_json_ld(html: str, condition: str) -> list[dict]:
    """Extract Schema.org Car/Vehicle objects from JSON-LD <script> blocks.

    Handles:
    - Direct Car/Vehicle/Product objects
    - @graph arrays containing typed nodes
    - ItemList / OfferCatalog wrapping a list of ListItem -> item
    """
    results: list[dict] = []

    def _ingest(item: dict) -> None:
        item_type = str(item.get('@type', '')).lower()
        if item_type not in ('car', 'vehicle', 'product', 'offer'):
            return
        brand   = item.get('brand', {})
        bname   = brand.get('name', '') if isinstance(brand, dict) else str(brand)
        mil_raw = item.get('mileageFromOdometer', {})
        mil_val = (mil_raw.get('value', 0)
                   if isinstance(mil_raw, dict) else mil_raw or 0)
        off_raw = item.get('offers', {})
        price   = (off_raw.get('price', 0) if isinstance(off_raw, dict) else 0)
        img     = item.get('image', '')
        img_url = img[0] if isinstance(img, list) else img
        # provider/seller can carry the dealership location name
        _provider = item.get('provider') or item.get('seller') or {}
        _location = (_provider.get('name', '')
                     if isinstance(_provider, dict) else '')
        raw = {
            'vin':           item.get('vehicleIdentificationNumber', ''),
            'stockNumber':   item.get('productID') or item.get('sku') or '',
            'year':          item.get('vehicleModelDate') or item.get('modelDate') or 0,
            'make':          bname,
            'model':         item.get('model', ''),
            'trim':          (item.get('vehicleConfiguration')
                              or item.get('bodyType') or ''),
            'mileage':       mil_val,
            'price':         price,
            'exteriorColor': item.get('color', ''),
            'image_url':     img_url,
            'location':      _location,
            'vdp_url':       item.get('url', ''),
        }
        v = _normalize_scraped(raw, condition)
        if v:
            results.append(v)

    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]+?)</script>',
        html, re.IGNORECASE,
    ):
        try:
            blob  = json.loads(m.group(1))
            items = blob if isinstance(blob, list) else [blob]
            for item in items:
                t = str(item.get('@type', '')).lower()
                # Direct vehicle object
                if t in ('car', 'vehicle', 'product'):
                    _ingest(item)
                # @graph — array of typed nodes (common on VDP pages)
                elif '@graph' in item:
                    for node in (item.get('@graph') or []):
                        if isinstance(node, dict):
                            _ingest(node)
                # ItemList / OfferCatalog wrapping ListItem -> item
                elif t in ('itemlist', 'offercatalog', 'breadcrumblist'):
                    for li in (item.get('itemListElement') or []):
                        if isinstance(li, dict):
                            inner = li.get('item') or li
                            if isinstance(inner, dict):
                                _ingest(inner)
                # Bare WebPage / ItemPage may contain a @graph
                elif t in ('webpage', 'itempage', 'website'):
                    for node in (item.get('@graph') or []):
                        if isinstance(node, dict):
                            _ingest(node)
        except Exception:
            pass
    return results


def _parse_text_blocks(html: str, condition: str) -> list[dict]:
    """Last-resort: scan stripped page text for VINs with nearby stock indicators.

    Used only when every structured-data path returns nothing.
    A vehicle entry is only emitted when a valid year is also found nearby —
    this avoids polluting the DB with partial records.
    """
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'&[a-z#0-9]+;', ' ', text)
    text = re.sub(r'\s+', ' ', text)

    seen:    set[str]   = set()
    results: list[dict] = []

    for vin_m in re.finditer(r'\b([A-HJ-NPR-Z0-9]{17})\b', text):
        vin = vin_m.group(1)
        if vin in seen:
            continue

        c_start = max(0, vin_m.start() - 400)
        c_end   = min(len(text), vin_m.end() + 400)
        ctx     = text[c_start:c_end]

        stock = ''
        for spat in (
            r'[Ss]tock\s*[#:]\s*([A-Za-z0-9]{2,15})',
            r'[Ss]tk\.?\s*[#:]?\s*([A-Za-z0-9]{2,15})',
            r'[Ss]tock\s*(?:[Nn]o\.?|[Nn]um(?:ber)?)\s*[:#]?\s*([A-Za-z0-9]{2,15})',
        ):
            sm = re.search(spat, ctx)
            if sm:
                stock = sm.group(1)
                break

        year = 0
        for ym in re.finditer(r'\b(20[012]\d|19[89]\d)\b', ctx):
            year = int(ym.group(1))
            break

        if vin and year:
            seen.add(vin)
            results.append({
                'vin':            vin,
                'stock_number':   stock,
                'condition':      condition,
                'year':           year,
                'make':           '',
                'model':          '',
                'trim':           '',
                'mileage':        0,
                'price':          0,
                'exterior_color': '',
                'interior_color': '',
                'image_url':      '',
                'location':       '',
            })

    if results:
        print(f"[HYBRID] Text-block scan ({condition}) -> {len(results)} VINs found")
    return results


# ─────────────────────────────────────────────────────────────────────────────
# UNIVERSAL SCRAPER ENGINE — HTTP retry, API discovery, new platforms, pagination
# ─────────────────────────────────────────────────────────────────────────────

# ── HTTP helper with exponential back-off ────────────────────────────────────
_HTTP_NO_RETRY: frozenset[int] = frozenset({400, 401, 403, 404, 405, 410})


def _http_get(
    url: str,
    headers: dict | None = None,
    timeout: int = 20,
    max_retries: int = 3,
) -> tuple[bytes, str]:
    """GET with exponential back-off.  Returns (body_bytes, content_type).

    Retries on network errors and HTTP 429 / 500 / 502 / 503 / 504.
    Raises immediately on permanent 4xx errors listed in _HTTP_NO_RETRY.
    Back-off schedule: 1 s, 2 s, 4 s (with ±0.5 s jitter).
    """
    hdrs = headers or MOSES_SCRAPER_HEADERS
    last_exc: Exception = RuntimeError("no attempts made")
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                ct   = resp.headers.get('Content-Type', '')
                body = resp.read()
            return body, ct
        except urllib.error.HTTPError as exc:
            if exc.code in _HTTP_NO_RETRY:
                raise
            last_exc = exc
        except (urllib.error.URLError, OSError, Exception) as exc:
            last_exc = exc
        if attempt < max_retries - 1:
            time.sleep((2 ** attempt) + random.uniform(0.0, 0.5))
    raise last_exc


# ── Generic inventory API endpoint probe ─────────────────────────────────────
# Tried in order against the origin of the configured URL.  Each probe is
# capped at 10 s; the entire function is budget-capped at 20 s total.
# Covers: custom REST backends, AutoSoft/PBS, HomeNet, WordPress inventory
# plugins, Tekion, Reynolds/ERA catalog endpoints, and misc JSON feeds.
_GENERIC_API_PROBE_PATHS: list[tuple[str, str]] = [
    # path                              label (for log)
    ('/api/inventory',                  'generic-REST'),
    ('/api/inventory/search',           'generic-REST'),
    ('/api/v1/inventory',               'generic-REST-v1'),
    ('/api/v2/inventory',               'generic-REST-v2'),
    ('/api/vehicles',                   'generic-vehicles'),
    ('/api/v1/vehicles',                'generic-vehicles-v1'),
    ('/api/used-vehicles',              'generic-used'),
    ('/api/new-vehicles',               'generic-new'),
    ('/searchused.action',              'autosoft-used'),
    ('/searchnew.action',               'autosoft-new'),
    ('/inventory/search',               'inv-search'),
    ('/getInventory',                   'generic-getInv'),
    ('/srp/inventory',                  'generic-srp'),
    ('/api/srp/vehicles',               'generic-srp-v2'),
    ('/api/catalog/search',             'cdk-catalog'),
    ('/feeds/inventory.json',           'feed-json'),
    ('/inventory.json',                 'feed-json2'),
    ('/vehicles.json',                  'feed-json3'),
    ('/wp-json/wp/v2/inventory',        'wp-inventory'),
    ('/wp-json/wp-inventory/v1/vehicles', 'wp-inv-plugin'),
]


def _probe_generic_api_endpoints(base_url: str, condition: str) -> list[dict]:
    """Probe common dealership inventory API paths against base_url's origin.

    Returns the first non-empty vehicle list found, or [].
    Budget: 20 s wall-clock total; 10 s per individual probe (no retry).
    """
    from urllib.parse import urlparse
    parsed  = urlparse(base_url)
    origin  = f"{parsed.scheme}://{parsed.netloc}"
    budget  = time.monotonic() + 20.0
    headers = {
        **MOSES_SCRAPER_HEADERS,
        'Accept':           'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
    }
    for path, label in _GENERIC_API_PROBE_PATHS:
        if time.monotonic() > budget:
            break
        probe_url = origin + path
        try:
            body, ct = _http_get(probe_url, headers=headers, timeout=10, max_retries=1)
        except Exception:
            continue
        # Accept only if Content-Type is JSON or body looks like JSON
        if 'json' not in ct.lower() and not body.lstrip()[:1] in (b'[', b'{'):
            continue
        try:
            data = json.loads(body)
        except Exception:
            continue
        vehicles = _extract_vehicles_recursive(data, condition)
        if vehicles:
            print(f"[API-PROBE] ({condition}) hit {label}: {probe_url} "
                  f"-> {len(vehicles)} vehicles")
            return vehicles
    return []


# ── eDealer.ca parser ─────────────────────────────────────────────────────────
def _parse_edealer(url: str, html: str, condition: str) -> list[dict]:
    """eDealer.ca SRP parser.

    Tries: window.inventoryData / window.eDealer JS state, then their
    REST API (/api/inventory?type=used|new).
    """
    from urllib.parse import urlparse
    for pat in (
        r'window\.inventoryData\s*=\s*(\[[\s\S]+?\])\s*;',
        r'window\.eDealer\s*=\s*(\{[\s\S]+?\})\s*;',
        r'"vehicles"\s*:\s*(\[[\s\S]+?\])',
    ):
        m = re.search(pat, html)
        if m:
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
            except Exception:
                pass
    parsed     = urlparse(url)
    origin     = f"{parsed.scheme}://{parsed.netloc}"
    cond_param = 'new' if condition == 'New' else 'used'
    for api_path in (
        f'/api/inventory?type={cond_param}',
        f'/inventory/api?condition={cond_param}',
    ):
        try:
            body, _ct = _http_get(origin + api_path, timeout=10, max_retries=1)
            if b'vin' in body.lower():
                data     = json.loads(body)
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
        except Exception:
            pass
    return []


# ── HomeNet / PBS / AutoGate parser ──────────────────────────────────────────
def _parse_homenet(url: str, html: str, condition: str) -> list[dict]:
    """HomeNet IMS / PBS Dealer / AutoGate SRP parser.

    Tries: window.hn_inventory JS state, then their REST endpoints.
    """
    from urllib.parse import urlparse
    for pat in (
        r'window\.hn_inventory\s*=\s*(\[[\s\S]+?\])\s*;',
        r'window\.HomeNetInventory\s*=\s*(\[[\s\S]+?\])\s*;',
        r'hn_inventory\s*:\s*(\[[\s\S]+?\])',
    ):
        m = re.search(pat, html)
        if m:
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
            except Exception:
                pass
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    cond_q = 'N' if condition == 'New' else 'U'
    for path in (
        f'/inventory/results.aspx?format=json&type={cond_q}',
        f'/InventoryListings/GetInventory?condition={cond_q}',
    ):
        try:
            body, _ct = _http_get(origin + path, timeout=10, max_retries=1)
            if b'vin' in body.lower():
                data     = json.loads(body)
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
        except Exception:
            pass
    return []


# ── VinSolutions / Cox Automotive parser ─────────────────────────────────────
def _parse_vinsolutions(url: str, html: str, condition: str) -> list[dict]:
    """VinSolutions / VinConnect / Cox Automotive SRP parser.

    Tries: window.__vin_data / window.VinConnectSRP JS state, then their
    /api/Vehicle/Search XHR endpoint.
    """
    from urllib.parse import urlparse
    for pat in (
        r'window\.__vin_data\s*=\s*(\{[\s\S]+?\})\s*;',
        r'window\.VinConnectSRP\s*=\s*(\{[\s\S]+?\})\s*;',
        r'"vehicles"\s*:\s*(\[[\s\S]{20,}\])',
    ):
        m = re.search(pat, html)
        if m:
            try:
                data     = json.loads(m.group(1))
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
            except Exception:
                pass
    parsed   = urlparse(url)
    origin   = f"{parsed.scheme}://{parsed.netloc}"
    cond_val = 'New' if condition == 'New' else 'Used'
    headers  = {
        **MOSES_SCRAPER_HEADERS,
        'Accept':           'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    }
    for path in (
        f'/api/Vehicle/Search?Condition={cond_val}&PageSize=500',
        f'/api/Inventory/Search?type={cond_val.lower()}&limit=500',
    ):
        try:
            body, _ct = _http_get(origin + path, headers=headers,
                                  timeout=12, max_retries=1)
            if b'vin' in body.lower():
                data     = json.loads(body)
                vehicles = _extract_vehicles_recursive(data, condition)
                if vehicles:
                    return vehicles
        except Exception:
            pass
    return []


# ── Generic SRP pagination follower ──────────────────────────────────────────
_MAX_SRP_PAGES   = 50   # hard cap — no site should need more
_STALE_PAGE_STOP = 2    # consecutive pages with 0 new VINs -> stop early

# Query-parameter names that carry a page number across common DMS platforms
_PAGE_PARAMS = (
    'page', 'p', 'pg', 'pn', 'pagenumber', 'pagenum', 'pageno',
    'PageNo', 'PageNumber', 'page_num', 'start',
)


def _extract_next_page_url(html: str, current_url: str, page_num: int) -> str | None:
    """Return the URL for the next SRP page, or None when none is found.

    Strategy order:
      1. <link rel="next" href="…">
      2. <a rel="next" href="…">
      3. Anchor whose visible text is 'Next' / '>' / '»'
      4. Increment a known page-number query param in the current URL
    """
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse, urljoin

    # 1. <link rel="next">
    m = re.search(
        r'<link[^>]+rel=["\']next["\'][^>]+href=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    )
    if m:
        return urljoin(current_url, m.group(1))

    # 2. <a rel="next">  (attribute order variants)
    for pat in (
        r'<a[^>]+rel=["\']next["\'][^>]+href=["\']([^"\']+)["\']',
        r'<a[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\']next["\']',
    ):
        m = re.search(pat, html, re.IGNORECASE)
        if m:
            return urljoin(current_url, m.group(1))

    # 3. Anchor text "Next" / ">" / "»" / "›"
    for pat in (
        r'<a[^>]+href=["\']([^"\'#][^"\']*)["\'][^>]*>\s*(?:Next|&gt;|»|›|next\s+page)\s*</a>',
        r'<a[^>]+href=["\']([^"\'#][^"\']*)["\'][^>]*>[^<]*\bNext\b[^<]*</a>',
    ):
        m = re.search(pat, html, re.IGNORECASE | re.DOTALL)
        if m:
            candidate = m.group(1).strip()
            if candidate and not candidate.lower().startswith('javascript'):
                return urljoin(current_url, candidate)

    # 4. Increment known page param already present on the URL
    parsed = urlparse(current_url)
    qs     = parse_qs(parsed.query, keep_blank_values=True)
    for param in _PAGE_PARAMS:
        if param in qs:
            try:
                new_val = str(int(qs[param][0]) + 1)
            except (ValueError, IndexError):
                continue
            qs[param] = [new_val]
            new_query = urlencode({k: v[0] for k, v in qs.items()})
            return urlunparse(parsed._replace(query=new_query))

    # 5. Platform-agnostic fallback — invent ?page=N when no next link / param
    #    exists. Stale-page stop in _paginate_srp ends the loop if the site
    #    ignores the parameter.
    qs['page'] = [str(page_num)]
    new_query = urlencode({k: v[0] for k, v in qs.items()})
    return urlunparse(parsed._replace(query=new_query))


def _paginate_srp(
    first_url:      str,
    condition:      str,
    first_vehicles: list[dict],
    first_html:     str,
) -> list[dict]:
    """Follow SRP pagination from page 2 onward, collecting all unique VINs.

    Returns the COMPLETE deduplicated vehicle list (page 1 + all subsequent pages).
    Stops when:
      • No next-page URL can be detected
      • _MAX_SRP_PAGES pages have been collected (hard cap)
      • _STALE_PAGE_STOP consecutive pages add zero new VINs (loop guard)
    """
    all_vehicles: list[dict] = list(first_vehicles)
    seen_vins:    set[str]   = {v['vin'] for v in first_vehicles if v.get('vin')}
    current_url   = first_url
    current_html  = first_html
    stale_streak  = 0

    for page_num in range(2, _MAX_SRP_PAGES + 1):
        next_url = _extract_next_page_url(current_html, current_url, page_num)
        if not next_url or next_url == current_url:
            break
        try:
            body, _ct   = _http_get(next_url, timeout=20, max_retries=2)
            current_html = body.decode('utf-8', errors='replace')
        except Exception as exc:
            print(f"[PAGINATE] p{page_num} fetch error {next_url!r}: {exc}")
            break

        page_vehicles = (
            _parse_json_inventory(current_html, condition) or
            _parse_json_ld(current_html, condition)        or
            _parse_html_inventory(current_html, condition) or
            _parse_text_blocks(current_html, condition)
        )

        new_count = 0
        for v in _apply_safety(page_vehicles, condition):
            vin = v.get('vin', '')
            if vin and vin in seen_vins:
                continue
            if vin:
                seen_vins.add(vin)
            all_vehicles.append(v)
            new_count += 1

        current_url = next_url
        if new_count == 0:
            stale_streak += 1
            if stale_streak >= _STALE_PAGE_STOP:
                break
        else:
            stale_streak = 0

    total_pages = page_num - 1
    if total_pages > 1:
        print(f"[PAGINATE] ({condition}) {first_url!r} -> "
              f"{len(all_vehicles)} vehicles across {total_pages} pages")
    return all_vehicles


# ── Engine entry point ────────────────────────────────────────────────────────

def _fetch_dealer_page(
    url: str,
    condition: str,
    session_id: str | None = None,
) -> list[dict]:
    """Universal inventory parsing engine — routes to the most reliable strategy.

    Route order
    -----------
    0a. DealerOn Cosmos REST API  (URL-fingerprinted DealerOn sites only)
    0b. DealerOn internal /api/Inventory/GetInventory  (speculative, every URL)
    0c. Generic JSON API probe (~20 common paths)  (non-DealerOn, non-Moses)
    1.  Fetch raw HTML with retry  (up to 2 attempts, 25 s each)
    2.  Platform fingerprinting  (URL + HTML head)
    3.  Platform-specific parsers:
            DealerOn    -> HTML fallback (API already tried in 0a/0b)
            Dealer.com  -> CDK widget API + embedded DDC state
            Sincro      -> window.SRP_DATA / SERVER_DATA
            eDealer     -> window.inventoryData + REST API
            HomeNet     -> window.hn_inventory + REST API
            VinSolutions-> window.__vin_data + REST API
            AutoSoft / Tekion -> generic fallback chain
    4.  Generic fallback chain (platform unknown or platform path returned []):
            JSON in <script>  ->  Schema.org JSON-LD  ->
            HTML data-vin     ->  text-block VIN+stock scan
    5.  Pagination  (non-DealerOn/Dealer.com platforms only, via _paginate_srp)
    6.  JSON-LD stock-number enrichment  (back-fill missing stock numbers)
    7.  Safety sweep  (always last — locks condition, sanitises stock_number)

    Time budgets
    ------------
    Step 0a/0b (DealerOn):  DEALERON_API_PROBE_BUDGET_SECS (30 s) wall-clock cap
    Step 0c (generic probe): 20 s wall-clock cap across all paths
    Step 1  (HTML fetch):    25 s socket timeout per attempt, up to 2 retries
    Worst-case total: ≈ 30 + 20 + 25 = 75 s (non-DealerOn, generic miss)
    """
    if _scraper_engine is not None and _scraper_engine.should_stop(session_id):
        return []

    _url_l           = url.lower()
    _is_dealeron_url = any(sig in _url_l for sig in _PLATFORM_URL_SIGS.get('dealeron', []))
    _is_moses        = 'mosescars.com' in _url_l

    # ── Step 0a: DealerOn Cosmos SRP REST API ────────────────────────────────
    if _is_dealeron_url:
        vehicles = _parse_dealeron_cosmos_api(url, condition, session_id=session_id)
        if vehicles:
            return _apply_safety(vehicles, condition)

    # ── Step 0b: DealerOn internal REST API (speculative for every URL) ──────
    vehicles = _parse_dealeron_api(url, condition)
    if vehicles:
        return _apply_safety(vehicles, condition)

    # ── Step 0c: Generic inventory API probe (non-Moses, non-DealerOn) ───────
    # Moses has its own dedicated sitemap path and doesn't expose these generic
    # endpoints.  DealerOn was already probed above and returned nothing.
    if not _is_dealeron_url and not _is_moses:
        vehicles = _probe_generic_api_endpoints(url, condition)
        if vehicles:
            return _apply_safety(vehicles, condition)

    # ── Step 1: Fetch raw HTML with retry ────────────────────────────────────
    try:
        raw, _ct = _http_get(url, timeout=25, max_retries=2)
        html     = raw.decode('utf-8', errors='replace')
    except Exception as err:
        print(f"WARNING dealer page fetch ({condition}) {url!r}: {err}")
        return []

    platform = _detect_platform(url, html)
    vehicles: list[dict] = []

    # ── Steps 2–4: Platform-specific and generic parsing ─────────────────────
    if platform == 'dealeron':
        # API probed in 0a/0b — fall back to dedicated DealerOn HTML parser
        vehicles = (
            _parse_dealeron_html(url, html, condition) or
            _parse_json_inventory(html, condition)     or
            _parse_html_inventory(html, condition)
        )

    elif platform == 'dealerdotcom':
        vehicles = _parse_dealerdotcom(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    elif platform == 'sincro':
        vehicles = _parse_sincro(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    elif platform == 'dealerspike':
        vehicles = _parse_dealerspike(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_ld(html, condition) or
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    elif platform == 'edealer':
        vehicles = _parse_edealer(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    elif platform == 'homenet':
        vehicles = _parse_homenet(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    elif platform == 'vinsolutions':
        vehicles = _parse_vinsolutions(url, html, condition)
        if not vehicles:
            vehicles = (
                _parse_json_inventory(html, condition) or
                _parse_html_inventory(html, condition)
            )

    else:
        # Unknown platform — full generic fallback chain
        vehicles = (
            _parse_json_inventory(html, condition) or
            _parse_json_ld(html, condition)         or
            _parse_html_inventory(html, condition)  or
            _parse_text_blocks(html, condition)
        )

    # ── Step 5: Generic pagination ───────────────────────────────────────────
    # DealerOn and Dealer.com handle their own pagination inside their API
    # callers.  All other platforms (including unknown) get the generic
    # VIN-stale-stop pagination loop here.
    if vehicles and platform not in ('dealeron', 'dealerdotcom', 'sincro'):
        vehicles = _paginate_srp(url, condition, vehicles, html)

    # ── Step 6: JSON-LD stock-number enrichment ───────────────────────────────
    if vehicles and any(not v.get('stock_number') for v in vehicles):
        ld_hits = {
            v['vin']: v
            for v in _parse_json_ld(html, condition)
            if v.get('vin') and _stock_safe(v.get('stock_number')) != 'N/A'
        }
        if ld_hits:
            for v in vehicles:
                if v.get('vin') in ld_hits and not v.get('stock_number'):
                    v['stock_number'] = ld_hits[v['vin']]['stock_number']

    # ── Step 7: Safety sweep ─────────────────────────────────────────────────
    return _apply_safety(vehicles, condition)


def _fetch_dealer_page_js(url: str, condition: str) -> list[dict]:
    """Playwright headless-browser fallback for SPA / dynamically-loaded inventory.

    Called when the static scrape path (_fetch_dealer_page) returns 0 vehicles
    and the site is suspected to require JavaScript execution.

    Delegates entirely to playwright_scraper.fetch_with_playwright which:
      • Launches Chromium (system binary — NixOS compatible)
      • Intercepts all XHR/fetch responses, capturing raw JSON inventory payloads
      • Evaluates window.__NEXT_DATA__ / window.inventoryData / 15+ other
        common server-state blobs injected by React / Vue / Next.js apps
      • Parses the fully-rendered DOM as a final fallback
      • Follows pagination (Next-button clicks) and infinite scroll
        until no new VINs appear (up to 30 pages / 85 s budget)
      • Returns a VIN-deduplicated, condition-locked vehicle list

    The Playwright path replaces the old subprocess --dump-dom approach, which
    gave Chromium only an 8 s virtual-time budget and could not intercept
    background XHRs or click pagination controls.
    """
    try:
        from playwright_scraper import fetch_with_playwright
    except ImportError:
        print(f'[PW] playwright_scraper not available — skipping JS fallback '
              f'for {url!r}')
        return []

    return fetch_with_playwright(url, condition)


# ─────────────────────────────────────────────────────────────────────────────
# FULL SITE CRAWL — sitemap-based discovery + parallel VDP enrichment
# ─────────────────────────────────────────────────────────────────────────────

def _parse_vdp_url(raw_url: str) -> dict | None:
    """Extract vehicle metadata from a DealerOn VDP sitemap URL.

    URL format (after HTML-entity decode):
        /condition-Location-Year-Make-Model-Trim-VIN
    e.g. /new-St+Albans-2026-Nissan-Rogue-Dark+Armor-5N1BT3BB7TC835320

    Returns a partial vehicle dict with '_vdp_url' set to the decoded URL
    for use in Phase 2 VDP enrichment.  Returns None if the URL can't be
    parsed as a VDP page.
    """
    import html as _html
    decoded = _html.unescape(raw_url)
    path    = decoded.rsplit('/', 1)[-1]

    # Must end with a 17-char VIN
    vin_m = re.search(r'-([A-HJ-NPR-Z0-9]{17})$', path)
    if not vin_m:
        return None
    vin = vin_m.group(1)

    # ── Condition: derived strictly from the URL path ──────────────────────────
    condition = _condition_from_url(decoded)
    # DealerOn path segments always start with the condition prefix:
    #   new-<Location>-<Year>-... or used-<Location>-<Year>-...
    # len('New')+1 = 4  -> strips "new-"
    # len('Used')+1 = 5 -> strips "used-"
    remainder = path[len(condition) + 1:]   # drop "new-" / "used-" prefix
    remainder = remainder[:-(len(vin) + 1)] # drop "-VIN" suffix

    # Year is the first 4-digit run surrounded by hyphens
    year_m = re.search(r'-(\d{4})-', remainder)
    if not year_m:
        return None
    year        = int(year_m.group(1))
    # Collapse sequences of multiple spaces that arise when a URL path segment
    # encodes a special character as nothing (e.g. "Town++Country" -> "Town  Country"
    # after "+" -> " " substitution).  A single re.sub is enough; the path is
    # ASCII-only at this point so Unicode normalisation is not required.
    def _url_seg(s: str) -> str:
        return re.sub(r' {2,}', ' ', s.replace('+', ' ')).strip()

    loc_raw     = _url_seg(remainder[:year_m.start()])
    after_year  = remainder[year_m.end():]

    # Make is everything before the first hyphen
    mk_parts = after_year.split('-', 1)
    make          = _url_seg(mk_parts[0])
    model_trim_raw = _url_seg(mk_parts[1]) if len(mk_parts) > 1 else ''

    # Model / trim split: keep accumulating hyphen-segments as part of the
    # model until we have ≥ 3 characters (handles "F-150", "CR-V", etc.).
    mt = model_trim_raw.split('-')
    model_segs: list[str] = [mt[0]] if mt else ['']
    trim = ''
    for i, seg in enumerate(mt[1:], 1):
        if len(''.join(model_segs).replace(' ', '')) < 3:
            model_segs.append(seg)
        else:
            trim = ' '.join(mt[i:])
            break
    model = ' '.join(model_segs)

    # Platform-agnostic photo URL: derive host from the VDP URL when absolute;
    # leave blank otherwise so Phase 2 enrichment can fill the real image.
    # Never hard-code a single dealership CDN host.
    image_url = ''
    try:
        from urllib.parse import urlparse as _urlparse
        _abs = decoded if decoded.startswith('http') else ''
        _host = _urlparse(_abs).netloc if _abs else ''
        if _host:
            image_url = f"https://{_host}/inventoryphotos/{vin.lower()}/ip/1.jpg"
    except Exception:
        image_url = ''

    # Prefer franchise-mapped location for new inventory when keywords match;
    # otherwise keep the path-derived rooftop string as-is.
    base_location = _canonicalize_location(loc_raw) or loc_raw.strip() or ''
    if condition == 'New' and make:
        location = MAKE_TO_LOCATION_NEW.get(make, base_location)
    else:
        location = base_location

    return {
        'vin':            vin,
        'condition':      condition,
        'year':           year,
        'make':           make,
        'model':          model,
        'trim':           trim,
        'location':       location,
        'image_url':      image_url,
        'stock_number':   '',
        'mileage':        0,
        'price':          0,
        'exterior_color': '',
        'interior_color': '',
        'vdp_url':        decoded,   # persisted to DB for condition reclassification
        '_vdp_url':       decoded,   # alias kept for Phase 2 enrichment callers
    }


def _condition_from_url(url: str) -> str:
    """Determine vehicle condition strictly from the URL path.

    Rules (evaluated in order; first match wins):

    Used  — path contains /used/, /pre-owned/, /certified/, /used-inventory/,
             /used-vehicles/, or /certified-
    New   — path contains /new/, /new-inventory/, or /new-vehicles/
    Used  — path segment starts with 'used-', 'certified-', or 'pre-owned-'
    New   — path segment starts with 'new-'
    Used  — fallback (safe default; never guess New without explicit evidence)

    The function is intentionally conservative: anything ambiguous becomes Used.
    """
    # Strip query string and fragment before comparing
    path_part = url.lower().split('?')[0].split('#')[0]

    # ── Used indicators (checked first — used overrides ambiguous new signals) ─
    if ('/used/'              in path_part
            or '/pre-owned'       in path_part   # /pre-owned/ and /pre-owned-
            or '/certified/'      in path_part
            or '/certified-'      in path_part
            or '/used-inventory'  in path_part
            or '/used-vehicles'   in path_part):
        return 'Used'

    # ── New indicators ────────────────────────────────────────────────────────
    if ('/new/'               in path_part
            or '/new-inventory'   in path_part
            or '/new-vehicles'    in path_part):
        return 'New'

    # ── Segment-level prefix (DealerOn VDP path format) ──────────────────────
    seg = path_part.rsplit('/', 1)[-1]
    if re.match(r'^new-', seg):
        return 'New'
    if re.match(r'^(used|certified|pre-owned)-', seg):
        return 'Used'

    return 'Used'   # safe fallback — never assume New without URL evidence


def _reclassify_conditions_from_url(user_id: int | None = None) -> dict:
    """Re-classify condition for all marketplace_inventory rows that have a
    stored vdp_url, correcting any rows whose condition field doesn't match
    what _condition_from_url() derives from that URL.

    Args:
        user_id: if given, restrict to that tenant; None = all users.

    Returns a dict: {'updated': int, 'to_new': int, 'to_used': int}
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        q = "SELECT id, vdp_url, condition FROM marketplace_inventory WHERE vdp_url != '' AND status='ACTIVE'"
        params: list = []
        if user_id is not None:
            q += " AND user_id=?"
            params.append(user_id)
        cursor.execute(q, params)
        rows = cursor.fetchall()
        to_new = to_used = 0
        for row in rows:
            correct = _condition_from_url(row['vdp_url'])
            if correct != row['condition']:
                cursor.execute(
                    "UPDATE marketplace_inventory SET condition=? WHERE id=?",
                    (correct, row['id']),
                )
                if correct == 'New':
                    to_new += 1
                else:
                    to_used += 1
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()
    return {'updated': to_new + to_used, 'to_new': to_new, 'to_used': to_used}


def _startup_condition_cleanup() -> None:
    """One-time startup pass: re-derive condition from the live sitemap for all
    active inventory rows, then correct any mis-classified records in the DB.

    This handles existing rows that pre-date the vdp_url column.  It is safe to
    re-run on every startup — it only writes rows whose condition actually changed.
    """
    try:
        sitemap_vehicles = _fetch_moses_sitemap_vehicles()
        if not sitemap_vehicles:
            return
        vin_to = {v['vin']: (v['condition'], v['_vdp_url']) for v in sitemap_vehicles}
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, vin, condition, vdp_url FROM marketplace_inventory WHERE status='ACTIVE'"
            )
            rows = cursor.fetchall()
            updated = 0
            for row_id, vin, cur_cond, cur_url in rows:
                if vin not in vin_to:
                    continue
                correct_cond, correct_url = vin_to[vin]
                needs_update = (correct_cond != cur_cond) or (cur_url == '' and correct_url)
                if needs_update:
                    cursor.execute(
                        """UPDATE marketplace_inventory
                              SET condition = ?,
                                  vdp_url   = CASE WHEN vdp_url = '' THEN ? ELSE vdp_url END
                            WHERE id = ?""",
                        (correct_cond, correct_url, row_id),
                    )
                    updated += cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        if updated:
            print(f"[INIT] Condition cleanup: reclassified {updated} vehicle(s) from sitemap URLs.")
    except Exception as err:
        print(f"[INIT] Condition cleanup skipped (will retry on next sync): {err}")


def _fetch_moses_sitemap_vehicles() -> list[dict]:
    """Fetch mosescars.com sitemap.xml and parse every VDP URL into a vehicle record.

    Returns a list of partial vehicle dicts.  Each entry includes a '_vdp_url'
    key (the original decoded page URL) for use in Phase 2 enrichment.
    """
    req = urllib.request.Request(
        "https://www.mosescars.com/sitemap.xml",
        headers=MOSES_SCRAPER_HEADERS,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml = resp.read().decode('utf-8', errors='replace')
    except Exception as err:
        print(f"WARNING sitemap fetch: {err}")
        return []

    vehicles = []
    for raw_url in re.findall(r'<loc>([^<]+)</loc>', xml):
        v = _parse_vdp_url(raw_url)
        if v:
            vehicles.append(v)
    return vehicles


def _enrich_from_vdp(vdp_url: str) -> dict:
    """Fetch one VDP page and extract price, stock number, colors, mileage, location.

    Returns a (possibly empty) dict of fields to merge into the inventory row.
    Best-effort — exceptions are swallowed so the caller never crashes.
    """
    result: dict = {}
    try:
        req = urllib.request.Request(vdp_url, headers=MOSES_SCRAPER_HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            html_text = resp.read().decode('utf-8', errors='replace')

        # Price — data-price is always initialised to 0 in DealerOn server HTML
        # (the real value is injected via JavaScript after page load).  Only
        # accept it when it is explicitly non-zero.
        m = re.search(r'data-price=["\'](\d+)["\']', html_text)
        if m and int(m.group(1)) > 0:
            result['price'] = int(m.group(1))

        # DealerOn VDP server HTML: data-msrp carries the sticker/retail price
        # in the static markup even when data-price is still 0.  Store it as
        # retail_price; the vehiclePricingHighlight block below will provide the
        # internet/selling price separately.
        m = re.search(r'data-msrp=["\'](\d+)["\']', html_text)
        if m and int(m.group(1)) > 0:
            result.setdefault('retail_price', int(m.group(1)))

        # DealerOn VDP: data-name holds the dealer-assembled full vehicle title
        # (e.g. "2026 GMC Yukon XL AT4").  Stash it so the DB upsert can fill
        # any individual components that were empty after URL-path parsing.
        m = re.search(r'data-name=["\']([^"\']{5,80})["\']', html_text)
        if m:
            result['_vdp_name'] = re.sub(r'\s+', ' ', m.group(1)).strip()

        # Stock number — try HTML data attributes first, then JSON keys, then
        # loose text patterns.  Stop at the first match so a later, weaker
        # pattern can't clobber a clean one found earlier.
        for pat in (
            # HTML data-attribute variants (most reliable)
            # DealerOn VDP uses data-stocknum (no separator) — check it first
            r'data-stocknum=["\']([^"\']{2,20})["\']',
            r'data-stock-number=["\']([^"\']{2,20})["\']',
            r'data-stocknumber=["\']([^"\']{2,20})["\']',
            r'data-stock-no=["\']([^"\']{2,20})["\']',
            r'data-stockno=["\']([^"\']{2,20})["\']',
            r'data-vehicle-stock=["\']([^"\']{2,20})["\']',
            r'data-stock=["\']([^"\']{2,20})["\']',
            # JSON key patterns (camelCase and snake_case variants)
            r'"stockNumber"\s*:\s*"([^"]{2,20})"',
            r'"StockNumber"\s*:\s*"([^"]{2,20})"',
            r'"stock_number"\s*:\s*"([^"]{2,20})"',
            r'"stockNo"\s*:\s*"([^"]{2,20})"',
            r'"StockNo"\s*:\s*"([^"]{2,20})"',
            r'"stock_no"\s*:\s*"([^"]{2,20})"',
            r'"stockNum"\s*:\s*"([^"]{2,20})"',
            r'"vehicleStockNumber"\s*:\s*"([^"]{2,20})"',
            # Loose text fallback: "Stock # P12345" / "Stock No: P12345"
            r'[Ss]tock\s*(?:#|No\.?|Num(?:ber)?)\s*:?\s*([A-Za-z0-9]{2,20})\b',
        ):
            m = re.search(pat, html_text)
            if m:
                result['stock_number'] = m.group(1).strip()
                break

        # Colors
        m = re.search(r'data-exterior-color=["\']([^"\']+)["\']', html_text)
        if m:
            result['exterior_color'] = m.group(1).strip()
        m = re.search(r'data-interior-color=["\']([^"\']+)["\']', html_text)
        if m:
            result['interior_color'] = m.group(1).strip()

        # Fallback color from JSON-LD (Product schema)
        if not result.get('exterior_color'):
            m = re.search(r'"color"\s*:\s*"([^"]{3,40})"', html_text)
            if m:
                result['exterior_color'] = m.group(1).strip()

        # Mileage (used vehicles)
        for pat in (
            r'data-mileage=["\'](\d[\d,]*)["\']',
            r'data-miles=["\'](\d[\d,]*)["\']',
            r'"mileageFromOdometer"\s*:\s*"([\d,]+)"',
        ):
            m = re.search(pat, html_text)
            if m:
                try:
                    result['mileage'] = int(m.group(1).replace(',', ''))
                    break
                except ValueError:
                    pass

        # Pricing breakdown — DealerOn priceBlocItem pattern + generic fallbacks
        _bloc = _extract_price_bloc(html_text)
        if not result.get('price') and _bloc.get('internet_price'):
            result['price'] = _bloc['internet_price']
        if _bloc.get('retail_price'):
            result.setdefault('retail_price', _bloc['retail_price'])
        if _bloc.get('doc_fee'):
            result.setdefault('doc_fee', _bloc['doc_fee'])
        if _bloc.get('savings'):
            result.setdefault('savings', _bloc['savings'])

        # Location from data attributes
        for pat in (
            r'data-location=["\']([^"\']+)["\']',
            r'data-dealer-name=["\']([^"\']+)["\']',
            r'data-dealername=["\']([^"\']+)["\']',
            r'data-rooftop-name=["\']([^"\']+)["\']',
            r'data-store=["\']([^"\']+)["\']',
        ):
            m = re.search(pat, html_text)
            if m:
                loc = _canonicalize_location(m.group(1).strip())
                if loc:
                    result['location'] = loc
                break

    except Exception:
        pass   # enrichment is always best-effort

    return result


def _sync_full_crawl(user_id: int, session_id: str | None = None) -> None:
    """Background full-site crawl for one user — two phases:

    Phase 1 — Sitemap (fast, ~2-5 s):
        Fetch sitemap.xml, parse 2 000+ VDP URLs, upsert all vehicles with
        basic metadata (year/make/model/image).  Price and colour are 0 / ''
        until Phase 2 fills them in.

    Phase 2 — Parallel VDP enrichment (~3-6 min for a full Moses group):
        Fetch individual VDP pages in batches of 20 concurrent threads.
        Extracts price, stock_number, exterior/interior colour, mileage, and
        the authoritative rooftop location.

    Progress is written into _SYNC_JOBS[user_id] for the sync-status endpoint.
    ``session_id`` ties the crawl to ``sync_sessions`` so Cancel Sync can
    cooperatively stop pagination / enrichment.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if _scraper_engine is not None:
        if not session_id:
            session_id = _scraper_engine.start_session(user_id)
        else:
            _scraper_engine.bind_session(session_id, user_id)
            _scraper_engine.ensure_session_running(session_id, user_id)
            _scraper_engine.set_cancel_sync_requested(
                False, session_id=session_id, user_id=user_id,
            )

    job = _SYNC_JOBS.setdefault(user_id, {})
    job.update({
        'syncing': True, 'phase': 'discovering',
        'synced': 0, 'total': 0, 'enriched': 0,
        'done': False, 'error': '',
        'session_id': session_id or '',
        'cancel_status': 'running',
    })

    def _stop() -> bool:
        return bool(_scraper_engine and _scraper_engine.should_stop(session_id))

    try:
        # ── Guard: skip Moses sitemap for users with non-Moses URLs ───────────
        # The Moses sitemap (mosescars.com/sitemap.xml) is only meaningful for
        # the master-admin demo account.  Any user with custom inventory URLs
        # should be scraped via their own SRP pages, not the Moses sitemap.
        _crawl_settings = UserManager.get_settings_by_id(user_id)
        _crawl_used = _crawl_settings.get('inventory_url_used', '').strip()
        _crawl_new  = _crawl_settings.get('inventory_url_new',  '').strip()
        _has_custom = bool(_crawl_used or _crawl_new)
        _is_moses   = (
            'mosescars.com' in (_crawl_used  or MOSES_USED_URL).lower() or
            'mosescars.com' in (_crawl_new   or MOSES_NEW_URL).lower()
        )
        if _has_custom and not _is_moses:
            print(f"[CRAWL u{user_id}] Non-Moses URLs — skipping sitemap, "
                  f"falling back to SRP scrape.")
            _srp = _sync_user_inventory(
                user_id, _crawl_used, _crawl_new, session_id=session_id,
            )
            _cancelled = bool(_srp.get('cancelled'))
            if _cancelled and _scraper_engine is not None:
                _scraper_engine.mark_cancelled(session_id, _srp.get('synced', 0))
            elif _scraper_engine is not None:
                _scraper_engine.mark_completed(session_id, _srp.get('synced', 0))
            job.update({
                'phase': 'cancelled' if _cancelled else 'done',
                'synced': _srp['synced'],
                'total': _srp['synced'], 'done': True, 'syncing': False,
                'reason': 'cancelled' if _cancelled else _srp.get('reason', 'ok'),
                'cancel_status': 'cancelled' if _cancelled else 'completed',
                'session_id': session_id or '',
            })
            return

        if _stop():
            if _scraper_engine is not None:
                _scraper_engine.mark_cancelled(session_id, 0)
            job.update({
                'phase': 'cancelled', 'synced': 0, 'total': 0,
                'done': True, 'syncing': False, 'reason': 'cancelled',
                'cancel_status': 'cancelled', 'session_id': session_id or '',
            })
            return

        # ── Phase 1: sitemap discovery ────────────────────────────────────────
        print(f"[CRAWL u{user_id}] Phase 1 — fetching sitemap…")
        sitemap_vehicles = _fetch_moses_sitemap_vehicles()

        if not sitemap_vehicles:
            print(f"[CRAWL u{user_id}] Sitemap returned nothing; trying legacy SRP scrape.")
            # fall back to existing single-page scraper
            settings  = UserManager.get_settings_by_id(user_id)
            url_used  = settings.get('inventory_url_used', '') or MOSES_USED_URL
            url_new   = settings.get('inventory_url_new',  '') or MOSES_NEW_URL
            result    = _sync_user_inventory(
                user_id, url_used, url_new, session_id=session_id,
            )
            _cancelled = bool(result.get('cancelled'))
            if _cancelled and _scraper_engine is not None:
                _scraper_engine.mark_cancelled(session_id, result.get('synced', 0))
            elif _scraper_engine is not None:
                _scraper_engine.mark_completed(session_id, result.get('synced', 0))
            job.update({
                'phase': 'cancelled' if _cancelled else 'done',
                'synced': result['synced'],
                'total': result['synced'], 'done': True, 'syncing': False,
                'reason': 'cancelled' if _cancelled else result.get('reason', 'ok'),
                'cancel_status': 'cancelled' if _cancelled else 'completed',
                'session_id': session_id or '',
            })
            return

        total = len(sitemap_vehicles)
        job['total'] = total
        print(f"[CRAWL u{user_id}] Found {total} vehicles in sitemap.")

        # Discover + filter by enabled locations
        found_locs = {v['location'] for v in sitemap_vehicles if v.get('location')}
        if found_locs:
            LocationDB.discover_locations(user_id, found_locs)

        enabled = LocationDB.get_enabled_locations(user_id)
        if enabled is not None:
            before           = len(sitemap_vehicles)
            sitemap_vehicles = [
                v for v in sitemap_vehicles
                if not v.get('location') or v['location'] in enabled
            ]
            skipped = before - len(sitemap_vehicles)
            if skipped:
                print(f"[CRAWL u{user_id}] Skipped {skipped} vehicles (disabled locations).")

        # Upsert Phase 1 records (price=0 is acceptable at this point)
        MarketplaceDB.upsert_vehicles(sitemap_vehicles, user_id)
        new_vins  = {v['vin'] for v in sitemap_vehicles if v['condition'] == 'New'}
        used_vins = {v['vin'] for v in sitemap_vehicles if v['condition'] == 'Used'}
        if not _stop():
            MarketplaceDB.mark_sold_by_condition('New',  new_vins,  user_id)
            MarketplaceDB.mark_sold_by_condition('Used', used_vins, user_id)

        job.update({'phase': 'enriching', 'synced': len(sitemap_vehicles)})
        if _scraper_engine is not None:
            _scraper_engine.set_scraped_count(session_id, len(sitemap_vehicles))
        print(f"[CRAWL u{user_id}] Phase 1 done — {len(sitemap_vehicles)} upserted.")

        if _stop():
            if _scraper_engine is not None:
                _scraper_engine.mark_cancelled(session_id, len(sitemap_vehicles))
            job.update({
                'phase': 'cancelled', 'done': True, 'syncing': False,
                'reason': 'cancelled', 'cancel_status': 'cancelled',
                'session_id': session_id or '',
            })
            return

        # ── Phase 2: VDP enrichment ───────────────────────────────────────────
        # Only enrich vehicles that still have price=0 in the DB.
        conn = sqlite3.connect(DB_FILE)
        cur  = conn.cursor()
        cur.execute(
            "SELECT vin FROM marketplace_inventory "
            "WHERE user_id=? AND (price IS NULL OR price=0) AND status='ACTIVE'",
            (user_id,),
        )
        unpriced = {r[0] for r in cur.fetchall()}
        conn.close()

        to_enrich = [v for v in sitemap_vehicles if v['vin'] in unpriced]
        print(f"[CRAWL u{user_id}] Phase 2 — enriching {len(to_enrich)} VDPs (20 threads)…")

        enriched  = 0
        BATCH     = 20

        def _do_enrich(v: dict):
            data = _enrich_from_vdp(v['_vdp_url'])
            return v['vin'], data

        for start in range(0, len(to_enrich), BATCH):
            if _stop():
                break
            batch = to_enrich[start:start + BATCH]
            with ThreadPoolExecutor(max_workers=len(batch)) as pool:
                futures = {pool.submit(_do_enrich, v): v for v in batch}
                for fut in as_completed(futures, timeout=30):
                    try:
                        vin, data = fut.result()
                    except Exception:
                        continue
                    if not data:
                        continue

                    sets, vals = [], []
                    for col in ('price', 'stock_number', 'exterior_color',
                                'interior_color', 'mileage', 'location'):
                        if data.get(col) not in (None, '', 0):
                            sets.append(f"{col}=?")
                            vals.append(data[col])
                    if sets:
                        conn2 = sqlite3.connect(DB_FILE)
                        try:
                            conn2.execute(
                                f"UPDATE marketplace_inventory SET {', '.join(sets)} "
                                f"WHERE user_id=? AND vin=?",
                                vals + [user_id, vin],
                            )
                            conn2.commit()
                        except Exception:
                            try:
                                conn2.rollback()
                            except Exception:
                                pass
                            raise
                        finally:
                            conn2.close()
                        enriched += 1

            job['enriched'] = enriched

        _was_cancelled = _stop()
        if _was_cancelled and _scraper_engine is not None:
            _scraper_engine.mark_cancelled(session_id, job.get('synced', 0))
        elif _scraper_engine is not None:
            _scraper_engine.mark_completed(session_id, job.get('synced', 0))
        job.update({
            'phase': 'cancelled' if _was_cancelled else 'done',
            'enriched': enriched,
            'done': True, 'syncing': False,
            'reason': 'cancelled' if _was_cancelled else job.get('reason', 'ok'),
            'cancel_status': 'cancelled' if _was_cancelled else 'completed',
            'session_id': session_id or '',
        })
        print(
            f"[CRAWL u{user_id}] "
            f"{'Cancelled' if _was_cancelled else 'Complete'} — "
            f"{enriched} vehicles enriched."
        )

    except Exception as err:
        import traceback
        traceback.print_exc()
        # Network timeouts / parse failures are errors — never surface as
        # "Sync stopped by user".
        if _scraper_engine is not None and session_id:
            try:
                if _stop():
                    _scraper_engine.mark_cancelled(session_id, job.get('synced', 0))
                    job.update({
                        'phase': 'cancelled', 'error': str(err),
                        'done': True, 'syncing': False,
                        'reason': 'cancelled',
                        'cancel_status': 'cancelled',
                        'session_id': session_id or '',
                    })
                else:
                    _scraper_engine.mark_failed(session_id, job.get('synced', 0))
                    job.update({
                        'phase': 'error', 'error': str(err),
                        'done': True, 'syncing': False,
                        'reason': 'scrape_error',
                        'cancel_status': 'completed',
                        'session_id': session_id or '',
                    })
            except Exception:
                job.update({
                    'phase': 'error', 'error': str(err),
                    'done': True, 'syncing': False,
                    'reason': 'scrape_error',
                    'session_id': session_id or '',
                })
        else:
            job.update({
                'phase': 'error', 'error': str(err),
                'done': True, 'syncing': False,
                'reason': 'scrape_error',
                'session_id': session_id or '',
            })


def run_inventory_scraper(
    user_id: int,
    url_used: str = '',
    url_new: str = '',
    session_id: str | None = None,
) -> dict:
    """Public entry point for a cancellable inventory scrape.

    Creates / binds a ``sync_sessions`` row, then delegates to
    ``_sync_user_inventory``.  Prefer this from HTTP handlers so every
    account (mdemoss, jdemoss, new users) gets a cancellable session.
    """
    if _scraper_engine is not None:
        if not session_id:
            session_id = _scraper_engine.start_session(user_id)
        else:
            _scraper_engine.bind_session(session_id, user_id)
    return _sync_user_inventory(
        user_id, url_used, url_new, session_id=session_id,
    )


def _sync_user_inventory(
    user_id: int,
    url_used: str = '',
    url_new: str = '',
    session_id: str | None = None,
) -> dict:
    """Scrape inventory for one user using their configured URLs.

    Steps:
    1. Fetch raw vehicle lists from the used + new inventory pages.
    2. Collect every non-blank location label from the scraped vehicles
       and register any newly discovered ones in ``user_locations``
       (with ``enabled=1`` by default, so nothing is hidden unless the
       user explicitly deselects a location later).
    3. Filter the vehicle list to only include vehicles whose location is
       enabled — or vehicles with no location label (always pass through).
    4. Upsert the filtered list and mark missing vehicles as SOLD.
    5. Fall back to seeding demo inventory when live scraping returns nothing
       and the user's DB is completely empty.

    When ``session_id`` is marked ``cancelling``, the loop breaks after the
    current page/condition, commits whatever was parsed, and returns with
    ``cancelled=True`` (without marking unseen VINs as SOLD).
    """
    if _scraper_engine is not None and session_id:
        _scraper_engine.bind_session(session_id, user_id)

    def _stop() -> bool:
        return bool(_scraper_engine and _scraper_engine.should_stop(session_id))

    cancelled = False

    # Resolve multi-location configs (preferred) or legacy single used/new URLs.
    _settings = UserManager.get_settings_by_id(user_id)
    if _scraper_engine is not None:
        _locations = _scraper_engine.resolve_scrape_locations(
            _settings, url_used=url_used, url_new=url_new,
        )
    else:
        _u = (url_used or _settings.get('inventory_url_used') or '').strip()
        _n = (url_new or _settings.get('inventory_url_new') or '').strip()
        _locations = ([{
            'location_name': (_settings.get('dealer_name') or 'Main Lot').strip() or 'Main Lot',
            'inventory_url_new': _n,
            'inventory_url_used': _u,
        }] if (_u or _n) else [])

    # Track whether the caller / settings supplied explicit custom URLs.  When
    # they did, we must NOT fall back to Moses demo inventory if the scrape
    # returns empty (the target site may require JavaScript — leave the DB
    # clean instead).
    _all_urls = []
    for _loc in _locations:
        for _uk in ('inventory_url_used', 'inventory_url_new'):
            _uv = (_loc.get(_uk) or '').strip()
            if _uv:
                _all_urls.append(_uv)
    _has_custom_urls = bool(_all_urls)

    # When the user has custom URLs, only scrape the URLs they actually
    # provided — never fall back to Moses for the missing condition.  Falling
    # back would silently plant Moses vehicles into a non-Moses account and then
    # mark them all SOLD on the next delta comparison.
    if _has_custom_urls:
        effective_used = next(
            ((_loc.get('inventory_url_used') or '').strip() for _loc in _locations
             if (_loc.get('inventory_url_used') or '').strip()),
            '',
        )
        effective_new = next(
            ((_loc.get('inventory_url_new') or '').strip() for _loc in _locations
             if (_loc.get('inventory_url_new') or '').strip()),
            '',
        )
    else:
        # No multi-location / custom URLs — scrape Moses defaults as one lot.
        effective_used = MOSES_USED_URL
        effective_new  = MOSES_NEW_URL
        _locations = [{
            'location_name': 'Main Lot',
            'inventory_url_new': effective_new,
            'inventory_url_used': effective_used,
        }]

    # Identify whether this is a Moses-domain sync so we can keep delta-sync
    # for Moses and use replace-sync for every other dealer.
    _is_moses_source = any('mosescars.com' in u.lower() for u in _all_urls) if _all_urls else (
        'mosescars.com' in effective_used.lower() or
        'mosescars.com' in effective_new.lower()
    )

    # ── Pre-sync purge for non-Moses dealers ──────────────────────────────────
    # Moses uses a delta/upsert strategy (VINs persist across syncs so posted
    # status is preserved).  Every other dealer gets a full replace: wipe the
    # user's inventory table first so no historical rows from a different source
    # can bleed into the new sync or be mis-flagged as SOLD by the delta check.
    #
    # IMPORTANT: rows with posted_status='posted' are intentionally excluded
    # from the purge.  Managers may have live Facebook/Marketplace listings for
    # those vehicles; deleting them loses the audit trail.  After the re-sync,
    # mark_sold_by_condition will flip any surviving posted row to SOLD if the
    # VIN does not appear in the new source, giving the manager a clear
    # "previously posted, now removed from feed" indicator in the UI.
    if _has_custom_urls and not _is_moses_source:
        try:
            _pre_conn = sqlite3.connect(DB_FILE)
            _pre_conn.execute(
                "DELETE FROM marketplace_inventory "
                "WHERE user_id = ? AND posted_status != 'posted'",
                (user_id,),
            )
            _pre_conn.commit()
            _pre_conn.close()
            print(f"[SYNC u{user_id}] Pre-sync purge: cleared non-posted "
                  f"inventory rows for clean import from custom dealer URLs "
                  f"(posted vehicles preserved to maintain feed audit trail).")
        except Exception as _pre_err:
            print(f"[SYNC u{user_id}] Pre-sync purge warning (non-fatal): "
                  f"{_pre_err}")

    total_synced  = 0
    total_sold    = 0
    any_live      = False
    new_locations = 0

    # ── Scrape engine selection ───────────────────────────────────────────────
    # Moses -> static engine (sitemap-based crawl; no pagination needed)
    # Custom non-Moses -> Playwright always.
    #
    # Why Playwright always for custom URLs:
    #   Modern DMS platforms (DealerOn, Dealer.com, Dealer Inspire, CDK, eDealer,
    #   HomeNet, VinSolutions) serve only page 1 (~24 vehicles) in raw HTML.
    #   The rest load via AJAX / infinite scroll / Next-button pagination.
    #   Running static first and only falling back to Playwright when static
    #   returns 0 breaks silently on any site whose first page is non-empty:
    #   the 24-vehicle page-1 result satisfies the "any_live" guard, Playwright
    #   never fires, and pages 2–N are never fetched.
    #
    #   Playwright's network-interception path captures the same raw JSON API
    #   payloads that the static engine's API probes (DealerOn Cosmos, generic
    #   endpoint probe) would capture — plus it paginates until no new VINs
    #   appear, intercepts background XHRs on every page, evaluates window
    #   state blobs (window.__NEXT_DATA__, window.inventoryData, etc.), and
    #   falls back to full DOM parsing.  Nothing is lost by skipping the static
    #   pass for custom URLs.
    #
    #   Moses keeps the static engine because its source of truth is a sitemap
    #   (not a browser-rendered SRP), the sitemap path runs in parallel workers,
    #   and Moses inventory is too large (1,000+ VINs) to paginate interactively.
    _use_playwright = _has_custom_urls and not _is_moses_source

    def _scrape_one(url: str, condition: str) -> list[dict]:
        """Scrape a single SRP URL, choosing engine based on source type.

        DealerOn / Cosmos SRPs (``.aspx``, ``searchused``, ``searchnew``) go
        through the static Cosmos REST API first — that path paginates with
        the real ``pt``/``pn`` query keys and returns the full inventory in
        seconds.  Playwright is the fallback when Cosmos is unavailable.

        Other custom non-Moses URLs still prefer Playwright (full pagination
        + XHR capture), falling back to the static engine when Playwright is
        unavailable or returns empty.

        Moses never uses a Playwright SRP fallback here: a single DealerOn page
        only yields ~12–60 VINs and would falsely mark the rest of the 2 000+
        vehicle fleet as SOLD.  Moses empty SRPs fall through to the sitemap.
        """
        if _stop():
            return []

        _url_l = url.lower()
        _is_dealeron = any(
            sig in _url_l for sig in _PLATFORM_URL_SIGS.get('dealeron', [])
        )

        # DealerOn Cosmos: static API first (correct multi-page pt/pn).
        if _is_dealeron:
            vehicles = _fetch_dealer_page(url, condition, session_id=session_id)
            if vehicles:
                return vehicles
            if _use_playwright and not _stop():
                print(f"[SYNC u{user_id}] DealerOn static/Cosmos returned 0 for "
                      f"{url!r} — falling back to Playwright.")
                return _fetch_dealer_page_js(url, condition)
            return []

        if _use_playwright and not _stop():
            vehicles = _fetch_dealer_page_js(url, condition)
            if vehicles:
                return vehicles
            print(f"[SYNC u{user_id}] Playwright returned 0 for {url!r} "
                  f"— falling back to static scrape engine.")
            return _fetch_dealer_page(url, condition, session_id=session_id)

        vehicles = _fetch_dealer_page(url, condition, session_id=session_id)
        if vehicles:
            return vehicles

        if _is_moses_source:
            print(f"[SYNC u{user_id}] Static SRP empty for {condition} — "
                  f"loading Moses sitemap.xml")
            try:
                sm = _fetch_moses_sitemap_vehicles()
                matched = [v for v in sm if v.get('condition') == condition]
                print(f"[SYNC u{user_id}] Sitemap yielded {len(matched)} "
                      f"{condition} vehicle(s)")
                return matched
            except Exception as sm_err:
                print(f"[SYNC u{user_id}] Sitemap fallback failed: {sm_err}")
                return []
        return []

    # Set when a scrape raised instead of returning cleanly (connection refused,
    # TLS failure, bot wall, Playwright crash).  Drives the hard-fallback path.
    scrape_error: str = ''

    # Accumulate VINs per condition across all locations so mark_sold runs once
    # with the full union (avoids prematurely selling rooftop-A inventory when
    # rooftop-B is scraped next).
    seen_vins_by_condition: dict[str, set[str]] = {'New': set(), 'Used': set()}

    for loc in _locations:
        loc_name = (loc.get('location_name') or 'Main Lot').strip() or 'Main Lot'
        for condition, url in (
            ('New', (loc.get('inventory_url_new') or '').strip()),
            ('Used', (loc.get('inventory_url_used') or '').strip()),
        ):
            if not url:
                continue  # this condition was not configured — skip entirely

            if _stop():
                cancelled = True
                print(f"[SYNC u{user_id}] Cancel requested — stopping before "
                      f"{loc_name} / {condition} scrape.")
                break

            # Never let a hostile site take the whole sync down: any exception
            # here is recorded and the loop continues, so the guaranteed-seed
            # path below still runs.
            try:
                vehicles = _scrape_one(url, condition)
            except Exception as scrape_exc:
                scrape_error = f"{type(scrape_exc).__name__}: {scrape_exc}"
                print(f"[SYNC u{user_id}] ({loc_name}/{condition}) Scrape FAILED "
                      f"for {url!r} — {scrape_error}")
                vehicles = []

            if _stop():
                cancelled = True

            if not vehicles:
                print(f"[SYNC u{user_id}] ({loc_name}/{condition}) 0 vehicles "
                      f"from {url!r} — site may use bot-protection, require "
                      f"authentication, or the URL may be incorrect.")
                if cancelled:
                    break
                continue
            any_live = True

            # Force-stamp the configured location name onto every vehicle so the
            # Hub Location filter and DB rows match the Scraper Setup labels.
            if _scraper_engine is not None:
                vehicles = _scraper_engine.stamp_vehicle_location(vehicles, loc_name)
            else:
                for _v in vehicles:
                    if isinstance(_v, dict):
                        _v['location'] = loc_name

            # ── Step 2: discover locations ────────────────────────────────
            found_locs = {
                v['location'].strip()
                for v in vehicles
                if v.get('location', '').strip()
            }
            if found_locs:
                added = LocationDB.discover_locations(user_id, found_locs)
                new_locations += added
                if added:
                    print(f"[SYNC u{user_id}] New location(s) discovered: "
                          f"{sorted(found_locs)}")

            # ── Step 3: filter by enabled locations ───────────────────────
            enabled = LocationDB.get_enabled_locations(user_id)
            if enabled is not None:
                before = len(vehicles)
                vehicles = [
                    v for v in vehicles
                    if not v.get('location', '').strip()
                    or v['location'].strip() in enabled
                ]
                skipped = before - len(vehicles)
                if skipped:
                    print(f"[SYNC u{user_id}] Skipped {skipped} vehicle(s) "
                          f"from disabled location(s).")

            # Commit whatever was parsed so far (including partial cancel).
            total_synced += MarketplaceDB.upsert_vehicles(vehicles, user_id)
            job = _SYNC_JOBS.setdefault(user_id, {})
            job['synced'] = total_synced
            job['phase'] = 'fetching'
            if _scraper_engine is not None:
                _scraper_engine.set_scraped_count(session_id, total_synced)

            seen_vins_by_condition[condition].update(
                v['vin'] for v in vehicles if v.get('vin')
            )

            # Skip further fetches when cancelled — a partial VIN set would
            # incorrectly mark the rest of that condition as sold.
            if cancelled or _stop():
                cancelled = True
                print(f"[SYNC u{user_id}] Cancelled after {loc_name}/{condition} — "
                      f"saved {len(vehicles)} vehicle(s), skipping SOLD delta.")
                break

        if cancelled:
            break

    # Mark SOLD once per condition using the union of all location scrapes.
    if not cancelled:
        for condition, vins in seen_vins_by_condition.items():
            if not vins:
                continue
            total_sold += MarketplaceDB.mark_sold_by_condition(condition, vins, user_id)

    # Backfill blank rooftop fields from VDP slugs / host defaults so the
    # Location filter works even for rows scraped before this column existed.
    if _scraper_engine is not None:
        try:
            _bf = _scraper_engine.backfill_inventory_rooftops(user_id)
            if _bf:
                print(f"[SYNC u{user_id}] Backfilled rooftop on {_bf} row(s).")
        except Exception as _bf_err:
            print(f"[SYNC u{user_id}] Rooftop backfill skipped: {_bf_err}")

    # ── Reason code ───────────────────────────────────────────────────────────
    # Possible values:
    #   'ok'                 — vehicles were synced successfully (non-zero)
    #   'demo'               — no live data; fell back to sample/demo inventory
    #   'parse_empty'        — static scrape returned 0 vehicles
    #   'js_render_empty'    — Playwright returned 0 vehicles (bot-protection,
    #                          auth required, or incorrect URL)
    #   'no_urls_configured' — no custom URLs set and Moses defaults also empty
    #   'scrape_error'       — the scrape raised (blocked / unreachable site)
    #   'cancelled'          — user hit Cancel Sync mid-run
    reason = 'cancelled' if cancelled else ('ok' if total_synced > 0 else '')

    if cancelled:
        if _scraper_engine is not None:
            _scraper_engine.mark_cancelled(session_id, total_synced)
        return {
            'synced': total_synced,
            'sold':   total_sold,
            'new_locations': new_locations,
            'reason': 'cancelled',
            'scrape_error': scrape_error,
            'cancelled': True,
            'session_id': session_id or '',
        }

    if not any_live and _has_custom_urls and not _is_moses_source:
        if scrape_error:
            reason = 'scrape_error'
        else:
            reason = 'js_render_empty' if _use_playwright else 'parse_empty'
        print(f"[SYNC u{user_id}] Scrape returned 0 vehicles from all custom "
              f"URLs. Site may use bot-protection, require authentication, "
              f"or the configured URL is incorrect.")

    # ── Guaranteed data population ────────────────────────────────────────────
    # When the live scrape produced nothing AND the user would be left with an
    # empty showroom, fall back to seeded inventory rather than an empty grid.
    #
    # Two tiers:
    #   • Moses-default / no-custom-URL accounts get the full demo fleet, which
    #     matches the rooftop those defaults point at.
    #   • Everything else gets the five-unit hard fallback, so a blocked custom
    #     dealer site still yields a populated dashboard.
    #
    # Safety rail: on production Postgres a live custom-dealer rooftop is only
    # seeded when it has zero ACTIVE rows, so demo cars can never dilute a real
    # feed that is already working.  Set INVENTORY_FALLBACK_SEED=0 to opt out.
    _seed_enabled = os.environ.get(
        'INVENTORY_FALLBACK_SEED', '1'
    ).strip().lower() not in ('0', 'false', 'no')

    _active_now = MarketplaceDB.count(user_id).get('ACTIVE', 0)
    if not any_live and _active_now == 0:
        if not _seed_enabled:
            print(f"[SYNC u{user_id}] No live data and fallback seeding is "
                  f"disabled (INVENTORY_FALLBACK_SEED=0) — leaving DB empty.")
            if not reason:
                reason = 'parse_empty'
        elif not _has_custom_urls or _is_moses_source:
            print(f"[SYNC u{user_id}] No live data — seeding sample inventory "
                  f"(F-150 / Audi A6 / Bronco + demo fleet).")
            total_synced = seed_sample_inventory(user_id)
            reason = 'demo'
        else:
            print(f"[SYNC u{user_id}] No live data from custom URL(s) — "
                  f"invoking hard fallback seed.")
            total_synced = seed_fallback_vehicles(user_id)
            reason = 'demo'
    elif not any_live and not _has_custom_urls and total_synced == 0:
        reason = 'no_urls_configured'

    return {
        'synced': total_synced,
        'sold':   total_sold,
        'new_locations': new_locations,
        'reason': reason or 'ok',
        'scrape_error': scrape_error,
        'cancelled': False,
        'session_id': session_id or '',
    }


def seed_sample_inventory(user_id: int, vehicles: list[dict] | None = None) -> int:
    """Insert realistic sample vehicles into ``marketplace_inventory``.

    Called when a live URL scrape returns 0 items during local testing so the
    dashboard KPIs (Active Scrape Count, Live Scraped Showroom Inventory) still
    have data to render.  Includes Ford F-150, Audi A6, and Ford Bronco units
    with populated VINs, prices, stock numbers, and image URLs.
    """
    fleet = list(vehicles) if vehicles else list(SAMPLE_SEED_INVENTORY)
    print(f"[SEED] Upserting {len(fleet)} sample vehicle(s) for user {user_id}")
    return MarketplaceDB.upsert_vehicles(fleet, user_id)


def seed_fallback_vehicles(user_id: int = 1) -> int:
    """Guaranteed inventory backup — never leaves the showroom empty.

    Invoked whenever a live scrape is blocked (connection refused, bot wall,
    Playwright unavailable) or completes with zero vehicles.  Connects to the
    configured database, clears unusable placeholder rows, then inserts the five
    high-detail hard-fallback units from FALLBACK_SEED_INVENTORY.

    "Clearing empty state" is deliberately narrow: only rows that can never
    render (no valid 17-character VIN, or a blank make/model) are removed, and
    rows the manager has already pushed to a marketplace feed
    (``posted_status='posted'``) are always preserved.  Legitimate sitemap stubs
    that merely lack a price are left untouched.

    Returns the number of rows inserted or refreshed.
    """
    print(f"[FALLBACK] Guaranteed seeding for user {user_id} — "
          f"{len(FALLBACK_SEED_INVENTORY)} hard-fallback vehicle(s)")

    # ── Step 1: clear unusable placeholder rows ───────────────────────────────
    try:
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        cur.execute(
            """
            DELETE FROM marketplace_inventory
             WHERE user_id = ?
               AND posted_status != 'posted'
               AND (vin IS NULL
                    OR LENGTH(TRIM(vin)) < 17
                    OR TRIM(COALESCE(make, '')) = ''
                    OR TRIM(COALESCE(model, '')) = '')
            """,
            (user_id,),
        )
        purged = cur.rowcount or 0
        conn.commit()
        conn.close()
        if purged:
            print(f"[FALLBACK] Cleared {purged} unrenderable placeholder row(s)")
    except Exception as purge_err:
        print(f"[FALLBACK] Placeholder cleanup skipped (non-fatal): {purge_err}")

    # ── Step 2: insert the guaranteed fleet ───────────────────────────────────
    inserted = MarketplaceDB.upsert_vehicles(
        list(FALLBACK_SEED_INVENTORY), user_id
    )
    active = MarketplaceDB.count(user_id).get('ACTIVE', 0)
    print(f"[FALLBACK] Seeded {inserted} vehicle(s) — "
          f"{active} ACTIVE row(s) now available for user {user_id}")
    return inserted


class MarketplaceDB:
    """Per-user CRUD layer for marketplace_inventory."""

    @staticmethod
    def upsert_vehicles(vehicles: list[dict], user_id: int) -> int:
        if not vehicles:
            return 0
        try:
            from inventory_parser import sanitize_vehicle_record as _sanitize_vehicle
        except ImportError:
            _sanitize_vehicle = None  # type: ignore[assignment]
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            count = 0
            for v in vehicles:
                if _sanitize_vehicle is not None:
                    try:
                        v = _sanitize_vehicle(v)
                    except Exception as _san_exc:
                        print(f"[INVENTORY] sanitize skipped: {_san_exc}")
                if not (v.get("vin") or "").strip():
                    continue
                cursor.execute(
                    """
                    INSERT INTO marketplace_inventory
                        (user_id, vin, stock_number, condition, year, make, model, trim,
                         mileage, price, exterior_color, interior_color, image_url,
                         location, dealership_group, vdp_url, doc_fee, retail_price, savings,
                         status, posted_status, last_seen)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE','not_posted',CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, vin) DO UPDATE SET
                        stock_number   = excluded.stock_number,
                        condition      = excluded.condition,
                        year           = excluded.year,
                        make           = excluded.make,
                        model          = excluded.model,
                        trim           = excluded.trim,
                        mileage        = excluded.mileage,
                        price          = excluded.price,
                        exterior_color = excluded.exterior_color,
                        interior_color = excluded.interior_color,
                        image_url      = CASE WHEN excluded.image_url != ''
                                             THEN excluded.image_url
                                             ELSE marketplace_inventory.image_url END,
                        location       = CASE WHEN excluded.location != ''
                                             THEN excluded.location
                                             ELSE marketplace_inventory.location END,
                        dealership_group = CASE WHEN excluded.dealership_group != ''
                                             THEN excluded.dealership_group
                                             ELSE marketplace_inventory.dealership_group END,
                        vdp_url        = CASE WHEN excluded.vdp_url != ''
                                             THEN excluded.vdp_url
                                             ELSE marketplace_inventory.vdp_url END,
                        doc_fee        = CASE WHEN excluded.doc_fee > 0
                                             THEN excluded.doc_fee
                                             ELSE marketplace_inventory.doc_fee END,
                        retail_price   = CASE WHEN excluded.retail_price > 0
                                             THEN excluded.retail_price
                                             ELSE marketplace_inventory.retail_price END,
                        savings        = CASE WHEN excluded.savings > 0
                                             THEN excluded.savings
                                             ELSE marketplace_inventory.savings END,
                        -- posted_status intentionally omitted: re-syncs must never
                        -- overwrite a manager's manual 'Add to Feed' choices.
                        status         = 'ACTIVE',
                        last_seen      = CURRENT_TIMESTAMP
                    """,
                    (user_id,
                     v['vin'],
                     v.get('stock_number') or '',
                     v.get('condition') or 'Used',
                     # Integer columns — coerce through _int_safe so an empty
                     # string or stray text suffix never triggers a PostgreSQL
                     # "invalid input syntax for type integer" crash.
                     _int_safe(v.get('year'),         0),
                     v.get('make')  or '',
                     v.get('model') or '',
                     v.get('trim')  or '',
                     _int_safe(v.get('mileage'),      0),
                     _int_safe(v.get('price'),        0),
                     v.get('exterior_color') or '',
                     v.get('interior_color') or '',
                     v.get('image_url')      or '',
                     v.get('location')       or '',
                     v.get('dealership_group') or '',
                     v.get('vdp_url')        or '',
                     _int_safe(v.get('doc_fee'),      0),
                     _int_safe(v.get('retail_price'), 0),
                     _int_safe(v.get('savings'),      0)),
                )
                count += cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return count

    @staticmethod
    def mark_sold_by_condition(condition: str, active_vins: set, user_id: int) -> int:
        if not active_vins:
            return 0
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT vin FROM marketplace_inventory "
                "WHERE user_id=? AND condition=? AND status='ACTIVE'",
                (user_id, condition),
            )
            gone = {r[0] for r in cursor.fetchall()} - active_vins
            if gone:
                ph = ','.join('?' * len(gone))
                cursor.execute(
                    f"UPDATE marketplace_inventory SET status='SOLD' "
                    f"WHERE user_id=? AND vin IN ({ph})",
                    [user_id] + list(gone),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return len(gone)

    @staticmethod
    def get_inventory(user_id: int, condition='', make='', min_price=0,
                      max_price=0, min_year=0, max_year=0, status='',
                      search='', posted_status='', location='',
                      model='',
                      enabled_locations: set | None = None) -> list[dict]:
        """Return inventory rows for user_id with optional filters.

        ``condition``       : strict exact match ('New' | 'Used') — case-sensitive.
        ``posted_status``   : '' = no filter | 'not_posted' | 'posted'.
        ``min_year/max_year``: inclusive year range; 0 = no bound.
        ``location``        : exact location string to filter by; '' = no filter.
        ``model``           : exact model string; '' = no filter.
        ``enabled_locations``:
          None  -> no location filter
          set   -> include rows whose location is in the set OR blank/unknown
        """
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        clauses: list = ["user_id=?"]
        params:  list = [user_id]
        if condition:      clauses.append("condition=?");       params.append(condition)
        if make:           clauses.append("make=?");            params.append(make)
        if model:          clauses.append("model=?");           params.append(model)
        if min_price:      clauses.append("price>=?");          params.append(min_price)
        if max_price:      clauses.append("price<=?");          params.append(max_price)
        if min_year:       clauses.append("year>=?");           params.append(min_year)
        if max_year:       clauses.append("year<=?");           params.append(max_year)
        if status:         clauses.append("status=?");          params.append(status)
        if posted_status:  clauses.append("posted_status=?");   params.append(posted_status)
        if location:       clauses.append("location=?");        params.append(location)
        if search:
            # Case-insensitive match (LOWER works in both SQLite and PostgreSQL).
            # Covers make, model, trim, vin, stock_number, and year (cast to text).
            _sl = f"%{search.lower()}%"
            clauses.append(
                "(LOWER(make) LIKE ? OR LOWER(model) LIKE ? OR LOWER(trim) LIKE ? "
                "OR LOWER(vin) LIKE ? OR LOWER(stock_number) LIKE ? "
                "OR CAST(year AS TEXT) LIKE ? OR LOWER(location) LIKE ?)"
            )
            params.extend([_sl, _sl, _sl, _sl, _sl, f"%{search}%", _sl])
        if enabled_locations is not None and len(enabled_locations) > 0:
            ph = ','.join('?' * len(enabled_locations))
            clauses.append(f"(location='' OR location IN ({ph}))")
            params.extend(sorted(enabled_locations))
        elif enabled_locations is not None and len(enabled_locations) == 0:
            # User has configured locations but enabled none — return nothing
            clauses.append("location=''")
        where = f"WHERE {' AND '.join(clauses)}"
        cursor.execute(
            f"SELECT * FROM marketplace_inventory {where} "
            "ORDER BY condition ASC, year DESC, price ASC",
            params,
        )
        rows = cursor.fetchall()
        conn.close()
        out = [dict(r) for r in rows]
        try:
            from inventory_parser import sanitize_inventory_list as _sanitize_list
            return _sanitize_list(out)
        except Exception:
            return out

    @staticmethod
    def get_years(user_id: int) -> list[int]:
        """Return sorted list of distinct model years in this user's inventory."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT DISTINCT year FROM marketplace_inventory "
            "WHERE user_id=? AND year > 0 ORDER BY year ASC",
            (user_id,),
        )
        years = [r[0] for r in cursor.fetchall()]
        conn.close()
        return years

    @staticmethod
    def get_makes(user_id: int, location: str = '', condition: str = '') -> list[str]:
        """Distinct makes, optionally scoped to a rooftop and/or condition."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        clauses = ["user_id=?", "make!=''", "status='ACTIVE'"]
        params: list = [user_id]
        if location:
            clauses.append("location=?")
            params.append(location)
        if condition:
            clauses.append("condition=?")
            params.append(condition)
        cursor.execute(
            f"SELECT DISTINCT make FROM marketplace_inventory "
            f"WHERE {' AND '.join(clauses)} ORDER BY make",
            params,
        )
        makes = [r[0] for r in cursor.fetchall()]
        conn.close()
        return makes

    @staticmethod
    def get_models(
        user_id: int,
        make: str = '',
        location: str = '',
        condition: str = '',
    ) -> list[str]:
        """Distinct models for the selected make / rooftop / condition."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        clauses = ["user_id=?", "model!=''", "status='ACTIVE'"]
        params: list = [user_id]
        if make:
            clauses.append("make=?")
            params.append(make)
        if location:
            clauses.append("location=?")
            params.append(location)
        if condition:
            clauses.append("condition=?")
            params.append(condition)
        cursor.execute(
            f"SELECT DISTINCT model FROM marketplace_inventory "
            f"WHERE {' AND '.join(clauses)} ORDER BY model",
            params,
        )
        models = [r[0] for r in cursor.fetchall()]
        conn.close()
        return models

    @staticmethod
    def get_distinct_locations(user_id: int) -> list[str]:
        """Return sorted list of distinct non-empty location strings in this user's inventory."""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT DISTINCT location FROM marketplace_inventory "
            "WHERE user_id=? AND location!='' ORDER BY location ASC",
            (user_id,),
        )
        locs = [r[0] for r in cursor.fetchall()]
        conn.close()
        return locs

    @staticmethod
    def get_last_sync(user_id: int) -> str:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT MAX(last_seen) FROM marketplace_inventory WHERE user_id=?",
            (user_id,),
        )
        row = cursor.fetchone()
        conn.close()
        return row[0] if row and row[0] else ''

    @staticmethod
    def count(user_id: int) -> dict:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT status, COUNT(*) FROM marketplace_inventory "
            "WHERE user_id=? GROUP BY status",
            (user_id,),
        )
        counts: dict = {'ACTIVE': 0, 'SOLD': 0, 'total': 0}
        for r in cursor.fetchall():
            counts[r[0]] = r[1]; counts['total'] += r[1]
        # Count vehicles currently in the catalog feed
        cursor.execute(
            "SELECT COUNT(*) FROM marketplace_inventory "
            "WHERE user_id=? AND posted_status='posted'",
            (user_id,),
        )
        counts['posted'] = cursor.fetchone()[0]
        conn.close()
        return counts

    @staticmethod
    def set_posting_status(user_id: int, vins: list[str], status: str) -> int:
        """Update posted_status for a list of VINs belonging to user_id.

        ``status`` must be one of: 'not_posted', 'posted'.
        Returns the number of rows actually updated.
        """
        if status not in ('not_posted', 'posted'):
            raise ValueError(f"Invalid posted_status: {status!r}")
        if not vins:
            return 0
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            ph = ','.join('?' * len(vins))
            cursor.execute(
                f"UPDATE marketplace_inventory "
                f"SET posted_status=? "
                f"WHERE user_id=? AND vin IN ({ph})",
                [status, user_id] + list(vins),
            )
            updated = cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return updated

    @staticmethod
    def get_by_vin(vin: str, user_id: int) -> dict | None:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM marketplace_inventory WHERE user_id=? AND vin=?",
            (user_id, vin),
        )
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None


# =====================================================================
# META CATALOG FEED — multi-tenant Automotive Inventory builder
# =====================================================================

# Generic HTTPS placeholder used only when a vehicle has no usable photo.
# Not dealer-specific — keeps Meta's image_link validator happy.
_META_IMAGE_FALLBACK = (
    'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf'
    '?auto=format&fit=crop&w=1200&q=80'
)

_META_FEED_COLUMNS = (
    'id', 'title', 'description', 'availability', 'condition', 'price',
    'link', 'image_link', 'make', 'model', 'year', 'mileage', 'vin',
)


class MetaCatalogFeed:
    """Build a Meta Commerce Manager Automotive Inventory feed for any tenant.

    Tenant resolution (first match wins):
      1. catalog_token / token query param
      2. commerce_catalog_id / catalog_id query param
      3. numeric user_id
      4. username (case-insensitive)
      5. authenticated session user (Bearer token)

    Dealer website base URL, dealership name, and VDP links are always read
    from the resolved user's DB row / inventory rows — never hardcoded.
    """

    @staticmethod
    def _valid_url(raw) -> bool:
        s = str(raw or '').strip()
        for pfx in ('https://', 'http://'):
            if s.startswith(pfx):
                rest = s[len(pfx):]
                return len(rest) >= 4 and '.' in rest
        return False

    @staticmethod
    def _https(url: str) -> str:
        """Prefer HTTPS for Meta image/link validators."""
        s = str(url or '').strip()
        if s.startswith('http://'):
            return 'https://' + s[len('http://'):]
        return s

    @staticmethod
    def _root_domain(raw: str) -> str:
        try:
            from urllib.parse import urlparse as _up
            p = _up(str(raw or '').strip())
            if p.scheme and p.netloc:
                return f"{p.scheme}://{p.netloc}"
        except Exception:
            pass
        return ''

    @staticmethod
    def _csv_q(val) -> str:
        return '"' + str(val if val is not None else '').replace('"', '""') + '"'

    @staticmethod
    def resolve_tenant(
        *,
        catalog_token: str = '',
        catalog_id: str = '',
        user_id: str = '',
        username: str = '',
        session_user_id: int | None = None,
    ) -> dict | None:
        """Return dealer profile + user_id for the requested tenant, or None."""
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        row = None
        try:
            if catalog_token:
                row = conn.execute(
                    "SELECT * FROM users WHERE catalog_token = ? AND catalog_token != ''",
                    (catalog_token.strip(),),
                ).fetchone()
            if row is None and catalog_id:
                cid = catalog_id.strip()
                row = conn.execute(
                    "SELECT * FROM users "
                    "WHERE commerce_catalog_id = ? AND commerce_catalog_id != ''",
                    (cid,),
                ).fetchone()
                if row is None and cid.isdigit():
                    row = conn.execute(
                        "SELECT * FROM users WHERE id = ?", (int(cid),)
                    ).fetchone()
            if row is None and user_id and str(user_id).strip().isdigit():
                row = conn.execute(
                    "SELECT * FROM users WHERE id = ?",
                    (int(str(user_id).strip()),),
                ).fetchone()
            if row is None and username:
                row = conn.execute(
                    "SELECT * FROM users WHERE LOWER(username) = ?",
                    (username.strip().lower(),),
                ).fetchone()
            if row is None and session_user_id is not None:
                row = conn.execute(
                    "SELECT * FROM users WHERE id = ?",
                    (int(session_user_id),),
                ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        d = dict(row)
        return {
            'user_id':            int(d['id']),
            'username':           str(d.get('username') or ''),
            'dealer_name':        str(d.get('dealer_name') or '').strip(),
            'dealer_city':        str(d.get('dealer_city') or '').strip(),
            'dealer_state':       str(d.get('dealer_state') or '').strip(),
            'dealer_address':     str(d.get('dealer_address_line1') or '').strip(),
            'dealer_zip':         str(d.get('dealer_zip') or '').strip(),
            'inventory_url_used': str(d.get('inventory_url_used') or '').strip(),
            'inventory_url_new':  str(d.get('inventory_url_new') or '').strip(),
            'commerce_catalog_id': str(d.get('commerce_catalog_id') or '').strip(),
            'catalog_token':      str(d.get('catalog_token') or '').strip(),
        }

    @classmethod
    def site_base_url(cls, tenant: dict) -> str:
        """Dealer live-site origin from configured inventory URLs (no hardcoding)."""
        for raw in (tenant.get('inventory_url_used'), tenant.get('inventory_url_new')):
            if cls._valid_url(raw):
                root = cls._root_domain(raw)
                if root:
                    return cls._https(root)
        return ''

    @classmethod
    def fetch_vehicles(cls, user_id: int) -> list[dict]:
        """Active inventory for the tenant.

        Prefer curated feed selections (posted_status='posted') when any exist;
        otherwise export all ACTIVE vehicles so a brand-new account still has a
        structurally valid feed.
        """
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            posted = conn.execute(
                "SELECT * FROM marketplace_inventory "
                "WHERE user_id = ? AND status = 'ACTIVE' AND posted_status = 'posted' "
                "ORDER BY year DESC, price ASC LIMIT 2000",
                (user_id,),
            ).fetchall()
            if posted:
                return [dict(r) for r in posted]
            rows = conn.execute(
                "SELECT * FROM marketplace_inventory "
                "WHERE user_id = ? AND status = 'ACTIVE' "
                "ORDER BY year DESC, price ASC LIMIT 2000",
                (user_id,),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    @classmethod
    def normalize_row(cls, vehicle: dict, tenant: dict) -> dict | None:
        """Map one inventory row to Meta Automotive feed fields with safe fallbacks."""
        vin_raw = str(vehicle.get('vin') or '').strip().upper()
        stock   = str(vehicle.get('stock_number') or '').strip()
        if stock.lower() in ('n/a', 'na', 'none', '-', '—'):
            stock = ''
        db_id = str(vehicle.get('id') or '').strip()
        real_vin = vin_raw if len(vin_raw) == 17 else ''
        item_id = real_vin or stock or (f"STOCK-{db_id}" if db_id else '')
        if not item_id:
            return None

        make  = str(vehicle.get('make')  or '').strip() or 'Vehicle'
        model = str(vehicle.get('model') or '').strip() or make
        trim  = str(vehicle.get('trim')  or '').strip()
        year_i = _int_safe(vehicle.get('year'), 0)
        year   = str(year_i) if 1900 <= year_i <= 2100 else ''

        title = ' '.join(p for p in (year, make, model, trim) if p) or make

        miles_i = _int_safe(vehicle.get('mileage'), 0)
        price_i = _int_safe(vehicle.get('price'), 0)
        if price_i <= 0:
            price_i = _int_safe(vehicle.get('retail_price'), 0)

        cond_raw = str(vehicle.get('condition') or '').strip().lower()
        condition = 'new' if cond_raw == 'new' else 'used'

        status_raw = str(vehicle.get('status') or 'ACTIVE').strip().upper()
        availability = 'in stock' if status_raw == 'ACTIVE' else 'out of stock'

        miles_label = f"{miles_i:,} miles" if miles_i > 0 else 'mileage unavailable'
        price_label = f"${price_i:,}" if price_i > 0 else 'price available on request'
        description = (
            f"{title} — {miles_label}, listed at {price_label}. "
            f"{'New' if condition == 'new' else 'Used'} inventory from "
            f"{tenant.get('dealer_name') or 'our dealership'}."
        )

        site = cls.site_base_url(tenant)
        vdp  = str(vehicle.get('vdp_url') or '').strip()
        if cls._valid_url(vdp):
            link = cls._https(vdp)
        elif site:
            link = site
        elif cls._valid_url(tenant.get('inventory_url_used')):
            link = cls._https(tenant['inventory_url_used'])
        elif cls._valid_url(tenant.get('inventory_url_new')):
            link = cls._https(tenant['inventory_url_new'])
        else:
            # Structural fallback — Meta requires a non-empty absolute URL.
            link = APP_BASE_URL or 'https://example.com'

        img_raw = str(vehicle.get('image_url') or '').strip()
        if cls._valid_url(img_raw):
            image_link = cls._https(img_raw)
        else:
            image_link = _META_IMAGE_FALLBACK

        # Meta expects "AMOUNT CURRENCY" — keep 0 USD rather than omit the column.
        price_str = f"{max(price_i, 0)} USD"

        return {
            'id':           item_id,
            'title':        title,
            'description':  description[:5000],
            'availability': availability,
            'condition':    condition,
            'price':        price_str,
            'link':         link,
            'image_link':   image_link,
            'make':         make,
            'model':        model,
            'year':         year or str(datetime.now().year),
            'mileage':      str(max(miles_i, 0)),
            'vin':          real_vin,
        }

    @classmethod
    def build_rows(cls, tenant: dict) -> list[dict]:
        rows: list[dict] = []
        seen: set[str] = set()
        for v in cls.fetch_vehicles(tenant['user_id']):
            item = cls.normalize_row(v, tenant)
            if not item:
                continue
            iid = item['id']
            if iid in seen:
                item['id'] = f"{iid}-{v.get('id', '')}"
            seen.add(item['id'])
            rows.append(item)
        return rows

    @classmethod
    def to_csv(cls, rows: list[dict]) -> str:
        lines = [','.join(_META_FEED_COLUMNS)]
        for r in rows:
            lines.append(','.join(cls._csv_q(r.get(c, '')) for c in _META_FEED_COLUMNS))
        return '\n'.join(lines) + '\n'

    @classmethod
    def to_xml(cls, rows: list[dict], tenant: dict) -> str:
        import html as _html
        dealer = _html.escape(tenant.get('dealer_name') or 'Dealership Inventory')
        site   = _html.escape(cls.site_base_url(tenant) or APP_BASE_URL or '')
        parts = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<listings>',
            f'  <title>{dealer}</title>',
            f'  <link>{site}</link>',
        ]
        for r in rows:
            parts.append('  <listing>')
            for col in _META_FEED_COLUMNS:
                val = _html.escape(str(r.get(col, '') or ''))
                parts.append(f'    <{col}>{val}</{col}>')
            parts.append('  </listing>')
        parts.append('</listings>')
        return '\n'.join(parts) + '\n'

    @classmethod
    def empty_csv(cls) -> str:
        """Header-only CSV — structurally valid for Meta when inventory is empty."""
        return ','.join(_META_FEED_COLUMNS) + '\n'

    @classmethod
    def empty_xml(cls, tenant: dict | None = None) -> str:
        dealer = (tenant or {}).get('dealer_name') or 'Dealership Inventory'
        site   = cls.site_base_url(tenant) if tenant else (APP_BASE_URL or '')
        import html as _html
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<listings>\n'
            f'  <title>{_html.escape(dealer)}</title>\n'
            f'  <link>{_html.escape(site)}</link>\n'
            '</listings>\n'
        )


# =====================================================================
# CUSTOMER MANAGER — persistent customer database for thank-you mail
# =====================================================================

class CustomerManager:
    """CRUD helpers for the customers table."""

    @staticmethod
    def list_customers(user_id: int) -> list[dict]:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def get_customer(user_id: int, customer_id: int) -> dict | None:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM customers WHERE id=? AND user_id=?",
            (customer_id, user_id),
        )
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def create_customer(user_id: int, data: dict) -> dict:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.cursor()
            cursor.execute(
                """INSERT INTO customers
                   (user_id, name, email, address_line1, address_line2,
                    city, state, zip, vehicle_purchased, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (user_id,
                 data.get('name', ''),       data.get('email', ''),
                 data.get('address_line1',''), data.get('address_line2',''),
                 data.get('city', ''),        data.get('state', ''),
                 data.get('zip', ''),         data.get('vehicle_purchased',''),
                 data.get('notes', '')),
            )
            new_id = cursor.lastrowid
            conn.commit()
            cursor.execute("SELECT * FROM customers WHERE id=?", (new_id,))
            row = cursor.fetchone()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return dict(row) if row else {}

    @staticmethod
    def update_customer(user_id: int, customer_id: int, data: dict) -> bool:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                """UPDATE customers SET
                   name=?, email=?, address_line1=?, address_line2=?,
                   city=?, state=?, zip=?, vehicle_purchased=?, notes=?
                   WHERE id=? AND user_id=?""",
                (data.get('name',''),         data.get('email',''),
                 data.get('address_line1',''), data.get('address_line2',''),
                 data.get('city',''),          data.get('state',''),
                 data.get('zip',''),           data.get('vehicle_purchased',''),
                 data.get('notes',''),
                 customer_id, user_id),
            )
            changed = cursor.rowcount > 0
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return changed

    @staticmethod
    def delete_customer(user_id: int, customer_id: int) -> bool:
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM customers WHERE id=? AND user_id=?",
                (customer_id, user_id),
            )
            changed = cursor.rowcount > 0
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return changed


# =====================================================================
# LOCATION MANAGER
# =====================================================================

class LocationDB:
    """Per-user location discovery and enable/disable management.

    Locations are auto-discovered during scrapes and stored with
    ``enabled=1`` by default so nothing is hidden until the user
    actively deselects a location.
    """

    @staticmethod
    def get_locations(user_id: int) -> list[dict]:
        """Return all known locations for *user_id* sorted alphabetically."""
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT location, enabled FROM user_locations "
            "WHERE user_id=? ORDER BY location",
            (user_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def discover_locations(user_id: int, locations: set) -> int:
        """Register newly discovered location names.

        Uses INSERT OR IGNORE so existing rows (and their enabled flag)
        are never overwritten — re-running on every scrape is safe.
        Returns the number of genuinely new locations added.
        """
        if not locations:
            return 0
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            count = 0
            for loc in sorted(locations):
                cursor.execute(
                    "INSERT OR IGNORE INTO user_locations "
                    "(user_id, location, enabled) VALUES (?,?,1)",
                    (user_id, loc),
                )
                count += cursor.rowcount
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return count

    @staticmethod
    def get_enabled_locations(user_id: int) -> set | None:
        """Return the set of *enabled* location names for filtering.

        Returns **None** when the user has no location config at all
        (meaning the scraper should pass every vehicle through unchanged).
        Returns an empty set when the user has configured locations but
        disabled all of them (nothing matches -> zero results).
        """
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT location, enabled FROM user_locations WHERE user_id=?",
            (user_id,),
        )
        rows = cursor.fetchall()
        conn.close()
        if not rows:
            return None  # no locations discovered yet — pass everything through
        return {r[0] for r in rows if r[1]}

    @staticmethod
    def set_locations(user_id: int, settings: dict) -> None:
        """Bulk-update enabled/disabled for each location.

        ``settings`` is a plain dict of ``{location_name: bool}``.
        Only updates rows that already exist — won't insert new ones.
        """
        if not settings:
            return
        conn = sqlite3.connect(DB_FILE)
        try:
            cursor = conn.cursor()
            for location, enabled in settings.items():
                cursor.execute(
                    "UPDATE user_locations SET enabled=? "
                    "WHERE user_id=? AND location=?",
                    (1 if enabled else 0, user_id, location),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()


class MosesScraperWorker(threading.Thread):
    """Background daemon: re-syncs each user's inventory every 6 hours."""

    def __init__(self):
        super().__init__()
        self.daemon = True

    def run(self):
        # Skip the immediate re-sync on startup — _startup_sync already runs
        # a full pass for every user right after the server starts.  Firing
        # again after only 12 seconds doubles the scrape work and causes the
        # pre-sync purge to wipe and re-insert thousands of rows unnecessarily.
        # The first periodic re-sync now happens 6 hours after startup.
        time.sleep(60 * 60 * 6)
        while True:
            try:
                users = UserManager.get_all_users()
                for u in users:
                    result = _sync_user_inventory(
                        u['id'],
                        u.get('inventory_url_used', ''),
                        u.get('inventory_url_new', ''),
                    )
                    print(f"[SYNC u{u['id']}] {result['synced']} synced, "
                          f"{result['sold']} sold.")
            except Exception as err:
                print(f"WARNING MosesScraperWorker: {err}")
            time.sleep(60 * 60 * 6)


def _run_csv_feeds_for_user(
    user_id: int,
    locations: list | None = None,
    location_name: str | None = None,
    csv_url: str | None = None,
    force: bool = False,
) -> dict:
    """Ingest CSV feeds for one user.

    - ``csv_url`` + ``location_name``: one-shot ingest (Sync CSV Now), even if
      the toggle is off.
    - ``location_name`` only: ingest that saved location when enabled (or when
      ``force=True`` and a csv_url is present).
    - otherwise: ingest every saved location with ``csv_enabled`` + ``csv_url``.
    """
    if _csv_engine is None:
        return {"ok": False, "synced": 0, "feeds": 0, "results": [],
                "error": "csv_engine unavailable"}

    # Direct one-shot from the UI (may include unsaved URL from the form).
    if csv_url and str(csv_url).strip():
        name = (location_name or "Main Lot").strip() or "Main Lot"
        r = _csv_engine.ingest_csv_inventory(
            str(csv_url).strip(),
            name,
            user_id=user_id,
            upsert_fn=MarketplaceDB.upsert_vehicles,
        )
        return {
            "ok": bool(r.get("ok")),
            "synced": int(r.get("synced") or 0),
            "feeds": 1,
            "results": [r],
            "error": r.get("error") or "",
        }

    if locations is None:
        settings = UserManager.get_settings_by_id(user_id)
        if _scraper_engine is not None:
            locations = _scraper_engine.normalize_inventory_locations(
                settings.get("inventory_locations")
            )
        else:
            locations = []

    if location_name:
        target = location_name.strip().lower()
        filtered = []
        for loc in locations or []:
            if str(loc.get("location_name") or "").strip().lower() != target:
                continue
            row = dict(loc)
            if force and (row.get("csv_url") or "").strip():
                row["csv_enabled"] = True
            filtered.append(row)
        locations = filtered

    return _csv_engine.ingest_enabled_locations(
        user_id,
        locations,
        upsert_fn=MarketplaceDB.upsert_vehicles,
    )


class CsvFeedWorker(threading.Thread):
    """Hourly daemon: ingest CSV feeds for every location with csv_enabled."""

    INTERVAL_SEC = 60 * 60

    def __init__(self):
        super().__init__(name="CsvFeedWorker")
        self.daemon = True

    def run(self):
        # Short delay so startup scrape + migrations settle first.
        time.sleep(75)
        while True:
            try:
                users = UserManager.get_all_users()
                for u in users:
                    uid = u["id"]
                    locs = []
                    if _scraper_engine is not None:
                        locs = _scraper_engine.normalize_inventory_locations(
                            u.get("inventory_locations")
                        )
                    enabled = [
                        loc for loc in locs
                        if loc.get("csv_enabled") and (loc.get("csv_url") or "").strip()
                    ]
                    if not enabled:
                        continue
                    result = _run_csv_feeds_for_user(uid, enabled)
                    print(
                        f"[CSV HOURLY u{uid}] feeds={result.get('feeds', 0)} "
                        f"synced={result.get('synced', 0)} ok={result.get('ok')}"
                    )
            except Exception as err:
                print(f"WARNING CsvFeedWorker: {err}")
            time.sleep(self.INTERVAL_SEC)


# =====================================================================
# POSTING QUEUE MANAGER
# =====================================================================

class PostingQueueManager:
    """Manages the daily Facebook Marketplace posting schedule (isolated per user).

    Rules:
      - Max 10 posts per day, randomly distributed 8 AM – 9 PM.
      - Cycle tracking: a VIN is not reused until every active inventory
        VIN has been posted at least once — tracked independently per user.
    """

    DAILY_LIMIT      = 10
    WINDOW_START_HR  = 8   # 8:00 AM
    WINDOW_END_HR    = 21  # 9:00 PM  (780 min window)

    @staticmethod
    def get_queue(user_id: int, date: str = '') -> list[dict]:
        target = date or datetime.now().strftime('%Y-%m-%d')
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM posting_queue WHERE user_id=? AND queue_date=? "
            "ORDER BY scheduled_time ASC",
            (user_id, target),
        )
        rows = cur.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def queue_stats(user_id: int, date: str = '') -> dict:
        target = date or datetime.now().strftime('%Y-%m-%d')
        conn = sqlite3.connect(DB_FILE)
        cur = conn.cursor()
        cur.execute(
            "SELECT status, COUNT(*) FROM posting_queue "
            "WHERE user_id=? AND queue_date=? GROUP BY status",
            (user_id, target),
        )
        stats: dict = {'Pending': 0, 'Posted': 0, 'Skipped': 0, 'total': 0, 'date': target}
        for row in cur.fetchall():
            stats[row[0]] = row[1]
            stats['total'] += row[1]
        conn.close()
        return stats

    @staticmethod
    def generate_queue(user_id: int, date: str = '', force: bool = False) -> dict:
        """Build the posting schedule for *user_id* on *date* (default: today)."""
        target = date or datetime.now().strftime('%Y-%m-%d')

        existing = PostingQueueManager.get_queue(user_id, target)
        if existing and not force:
            return {'generated': 0, 'total_existing': len(existing), 'skipped': True}

        if force:
            conn = sqlite3.connect(DB_FILE)
            try:
                conn.execute(
                    "DELETE FROM posting_queue WHERE user_id=? AND queue_date=?",
                    (user_id, target),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                conn.close()

        active = MarketplaceDB.get_inventory(user_id, status='ACTIVE')
        if not active:
            return {'generated': 0, 'total_existing': 0, 'skipped': False,
                    'reason': 'No active inventory to schedule'}

        active_vins = [v['vin'] for v in active]
        vin_map     = {v['vin']: v for v in active}

        # ── Cycle tracking: find VINs not yet posted this cycle ──────
        conn = sqlite3.connect(DB_FILE)
        cur  = conn.cursor()
        ph   = ','.join('?' * len(active_vins))
        cur.execute(
            f"SELECT vin FROM posting_cycle WHERE user_id=? AND vin IN ({ph})",
            [user_id] + active_vins,
        )
        cycled    = {r[0] for r in cur.fetchall()}
        conn.close()

        available = [v for v in active_vins if v not in cycled]

        # Full cycle complete -> reset rotation for this user
        if not available:
            conn = sqlite3.connect(DB_FILE)
            try:
                conn.execute("DELETE FROM posting_cycle WHERE user_id=?", (user_id,))
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                conn.close()
            available = list(active_vins)
            print(f"[QUEUE u{user_id}] Full cycle complete — resetting posting rotation.")

        # ── Select & schedule ─────────────────────────────────────────
        random.shuffle(available)
        selected = available[:PostingQueueManager.DAILY_LIMIT]

        window_min  = (PostingQueueManager.WINDOW_END_HR - PostingQueueManager.WINDOW_START_HR) * 60
        time_slots  = sorted(random.sample(range(window_min), len(selected)))

        conn = sqlite3.connect(DB_FILE)
        try:
            cur  = conn.cursor()
            for i, vin in enumerate(selected):
                v           = vin_map[vin]
                total_min   = PostingQueueManager.WINDOW_START_HR * 60 + time_slots[i]
                hh, mm      = divmod(total_min, 60)
                sched_time  = f"{hh:02d}:{mm:02d}"
                cur.execute(
                    """
                    INSERT OR IGNORE INTO posting_queue
                        (user_id, queue_date, vin, stock_number, year, make, model,
                         trim, scheduled_time, status)
                    VALUES (?,?,?,?,?,?,?,?,?,'Pending')
                    """,
                    (user_id, target, vin, v.get('stock_number', ''), v.get('year', 0),
                     v.get('make', ''), v.get('model', ''), v.get('trim', ''), sched_time),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()

        return {'generated': len(selected), 'total_existing': len(existing),
                'skipped': False, 'date': target}

    @staticmethod
    def update_status(item_id: int, status: str, user_id: int = 0) -> bool:
        """Set a queue item to Pending / Posted / Skipped.
        Marking Posted also records the VIN in posting_cycle for this user."""
        if status not in ('Pending', 'Posted', 'Skipped'):
            return False
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.cursor()
            if user_id:
                cur.execute(
                    "SELECT vin, user_id FROM posting_queue WHERE id=? AND user_id=?",
                    (item_id, user_id),
                )
            else:
                cur.execute("SELECT vin, user_id FROM posting_queue WHERE id=?", (item_id,))
            row = cur.fetchone()
            if not row:
                return False
            vin = row['vin']
            uid = row['user_id']
            if status == 'Posted':
                cur.execute(
                    "UPDATE posting_queue SET status='Posted', posted_at=CURRENT_TIMESTAMP WHERE id=?",
                    (item_id,),
                )
                cur.execute(
                    "INSERT OR REPLACE INTO posting_cycle (user_id, vin, posted_date) VALUES (?,?,?)",
                    (uid, vin, datetime.now().strftime('%Y-%m-%d')),
                )
            else:
                cur.execute(
                    "UPDATE posting_queue SET status=?, posted_at=NULL WHERE id=?",
                    (status, item_id),
                )
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
        return True


class PostingQueueWorker(threading.Thread):
    """Daemon thread: auto-generates each user's daily posting queue at startup and midnight."""

    def __init__(self):
        super().__init__()
        self.daemon = True
        self._last_generated: str | None = None

    def run(self):
        time.sleep(8)  # let DB settle on first boot
        while True:
            today = datetime.now().strftime('%Y-%m-%d')
            if self._last_generated != today:
                try:
                    users = UserManager.get_all_users()
                    for u in users:
                        result = PostingQueueManager.generate_queue(u['id'], today)
                        if not result.get('skipped'):
                            print(f"[QUEUE u{u['id']}] Scheduled "
                                  f"{result['generated']} posts for {today}.")
                except Exception as err:
                    print(f"WARNING PostingQueueWorker: {err}")
                self._last_generated = today
            time.sleep(60)


# =====================================================================
# TIKTOK TOKEN REFRESH DAEMON
# =====================================================================
class TikTokTokenRefreshWorker(threading.Thread):
    """Background daemon: proactively refreshes TikTok tokens before they expire.

    Wakes every 30 minutes and calls TikTokTokenManager.refresh_if_needed for
    every user whose access token expires within the next 2 hours. This prevents
    the first post of the day from incurring a refresh-token round-trip.
    """

    SCAN_INTERVAL = 30 * 60          # 30 minutes between sweeps
    REFRESH_AHEAD_SECS = 2 * 60 * 60  # refresh tokens expiring within 2 hours

    def __init__(self):
        super().__init__()
        self.daemon = True

    def run(self):
        time.sleep(20)  # let the main server and DB settle before first scan
        while True:
            try:
                self._refresh_expiring_tokens()
            except Exception as err:
                print(f"[TikTokRefreshWorker] Unhandled error: {err}")
            try:
                _expire_stale_tiktok_posts()
            except Exception as err:
                print(f"[TikTokRefreshWorker] Stale-post sweep error: {err}")
            time.sleep(self.SCAN_INTERVAL)

    def _refresh_expiring_tokens(self):
        """Find users with TikTok tokens expiring soon and refresh them."""
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT id, tiktok_access_token, tiktok_token_expires_at "
                "FROM users "
                "WHERE tiktok_access_token IS NOT NULL "
                "  AND tiktok_access_token != ''"
            ).fetchall()
        except Exception as err:
            print(f"[TikTokRefreshWorker] DB read error: {err}")
            conn.close()
            return
        conn.close()

        now = datetime.utcnow()
        threshold = now + timedelta(seconds=self.REFRESH_AHEAD_SECS)

        for row in rows:
            user_id = row["id"]
            expires_at_str = row["tiktok_token_expires_at"] or ""

            # Determine whether this token needs a proactive refresh.
            needs_refresh = False
            if not expires_at_str:
                needs_refresh = True  # no expiry recorded — refresh defensively
            else:
                try:
                    expires_dt = datetime.fromisoformat(expires_at_str)
                    if expires_dt <= threshold:
                        needs_refresh = True
                except (ValueError, TypeError):
                    needs_refresh = True  # unparseable — refresh defensively

            if not needs_refresh:
                continue

            try:
                _, was_refreshed = TikTokTokenManager.refresh_if_needed(user_id, force=True)
                if was_refreshed:
                    print(f"[TikTokRefreshWorker] Token proactively refreshed for user_id={user_id}.")
                else:
                    print(f"[TikTokRefreshWorker] Token still valid for user_id={user_id}, no refresh needed.")
            except TikTokTokenExpiredError as err:
                print(f"[TikTokRefreshWorker] Refresh failed for user_id={user_id}: {err}")
            except Exception as err:
                print(f"[TikTokRefreshWorker] Unexpected error for user_id={user_id}: {err}")


def _expire_stale_tiktok_posts() -> int:
    """Mark tiktok_posts rows stuck in PROCESSING as FAILED after a timeout.

    TikTok never sends a terminal status callback for silently-dropped publish
    jobs, so rows can remain in PROCESSING indefinitely.  This sweep ages them
    out to FAILED once they exceed TIKTOK_PROCESSING_TIMEOUT_HOURS, keeping the
    hub UI clean and the table free of phantom rows.

    Returns the number of rows updated (0 is the normal/happy path).
    """
    # Use the database's own clock and interval arithmetic to avoid any
    # Python-side timestamp formatting ambiguity (isoformat() uses 'T' as a
    # separator while PostgreSQL CURRENT_TIMESTAMP stores with a space ' ').
    # TIKTOK_PROCESSING_TIMEOUT_HOURS is a module-level integer constant so
    # direct interpolation into the SQL string is safe here.
    conn = sqlite3.connect(DB_FILE)
    try:
        cursor = conn.execute(
            "UPDATE tiktok_posts SET status = 'FAILED', failure_reason = 'timed_out' "
            "WHERE status = 'PROCESSING' "
            f"  AND posted_at < NOW() - INTERVAL '{TIKTOK_PROCESSING_TIMEOUT_HOURS} hours'",
        )
        conn.commit()
        updated = cursor.rowcount if cursor.rowcount is not None else 0
    except Exception as err:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"[TikTok] _expire_stale_tiktok_posts DB error: {err}")
        conn.close()
        return 0
    conn.close()

    if updated:
        print(
            f"[TikTok] Aged out {updated} stuck PROCESSING post(s) to FAILED "
            f"(timeout={TIKTOK_PROCESSING_TIMEOUT_HOURS}h)."
        )
    return updated


# =====================================================================
# FREE AI POST GENERATOR — public, no auth
# =====================================================================

def _extract_price_bloc(html_text: str) -> dict:
    """Extract a pricing breakdown from DealerOn / CDK / similar dealer VDP pages.

    Handles the DealerOn ``priceBlocItemPriceLabel`` / ``priceBlocItemPriceValue``
    pattern as well as generic CSS-class and text-label patterns for other sites.

    Returns a dict with any subset of:
        internet_price  — selling / internet / final / dealer price
        retail_price    — MSRP / retail / sticker price
        doc_fee         — documentation / dealer fee
        savings         — advertised savings / discount amount
    """
    def _parse_amount(raw: str) -> int | None:
        import html as _html_mod
        unescaped = _html_mod.unescape(raw)   # decode &#x2B; -> + before stripping
        cleaned = re.sub(r'[^\d]', '', unescaped)
        try:
            v = int(cleaned)
            return v if v > 0 else None
        except ValueError:
            return None

    result: dict = {}

    # ── Strategy A: DealerOn priceBlocItem label / value pairs ──────────────
    # DOM structure (DealerOn / Moses Cars):
    #   <ul class="list-unstyled priceBlock priceBlockResponsiveDesktop">
    #     <li class="priceBlockItem ...">
    #       <span class="priceBlocItemPriceLabel ">Retail Price:</span>
    #       <span class="priceBlocItemPriceValue ">$26,200</span>
    #     </li>
    #     ...
    #   </ul>
    #
    # IMPORTANT: scope to the <ul> container before extracting to avoid false
    # matches inside minified CSS/JS blobs that also reference those class names.
    # Parse label+value per <li> so pairing is always correct even when the page
    # renders two identical blocks (mobile + desktop).
    price_blocks = re.findall(
        r'<ul[^>]+priceBlock[^>]*>(.*?)</ul>',
        html_text, re.DOTALL | re.IGNORECASE,
    )
    seen_pairs: set = set()
    for block_html in price_blocks:
        for li_content in re.findall(r'<li[^>]*>(.*?)</li>', block_html, re.DOTALL | re.IGNORECASE):
            label_m = re.search(r'priceBlocItemPriceLabel[^>]*>([^<]+)<', li_content, re.IGNORECASE)
            value_m = re.search(r'priceBlocItemPriceValue[^>]*>([^<]+)<', li_content, re.IGNORECASE)
            # Newer DealerOn VDP layout (2024+) uses vehiclePricingHighlight*
            # class names instead of the legacy priceBlocItem* names.  Fall
            # back to those when the primary patterns don't match.
            if not label_m:
                label_m = re.search(
                    r'vehiclePricingHighlightLabel[^>]*>([^<]+)', li_content, re.I)
            if not value_m:
                value_m = re.search(
                    r'vehiclePricingHighlightAmount[^>]*>\s*\$?([\d,]+)', li_content, re.I)
            if not value_m:
                continue
            label_raw = label_m.group(1).strip() if label_m else ''
            val_raw   = value_m.group(1).strip()
            pair_key  = (label_raw.lower(), val_raw)
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            label  = label_raw.lower().rstrip(':').strip()
            amount = _parse_amount(val_raw)
            if amount is None:
                continue
            if any(k in label for k in ('retail', 'msrp', 'sticker', 'list price', 'book')):
                result.setdefault('retail_price', amount)
            elif any(k in label for k in ('doc fee', 'dealer fee', 'documentary', 'doc')):
                result.setdefault('doc_fee', amount)
            elif any(k in label for k in ('saving', 'you save', 'discount', 'rebate')):
                result.setdefault('savings', amount)
            else:
                # Moses Price / Internet Price / Sale Price / Your Price -> selling price
                result.setdefault('internet_price', amount)

    # ── Strategy B: generic CSS-class patterns for other dealer sites ────────
    _CLASS_PATTERNS: list[tuple[str, list[str]]] = [
        ('internet_price', [
            r'class=["\'][^"\']*internet[_-]?price[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*final[_-]?price[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*sale[_-]?price[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*your[_-]?price[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
        ]),
        ('retail_price', [
            r'class=["\'][^"\']*\bmsrp\b[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*retail[_-]?price[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{4,7})',
        ]),
        ('doc_fee', [
            r'class=["\'][^"\']*doc[_-]?fee[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{2,5})',
        ]),
        ('savings', [
            r'class=["\'][^"\']*\bsavings?\b[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{2,6})',
            r'class=["\'][^"\']*\bdiscount\b[^"\']*["\'][^>]*>\s*\$?\s*([\d,]{2,6})',
        ]),
    ]
    for field, patterns in _CLASS_PATTERNS:
        if field in result:
            continue
        for pat in patterns:
            m = re.search(pat, html_text, re.IGNORECASE)
            if m:
                v = _parse_amount(m.group(1))
                if v:
                    result[field] = v
                    break

    # ── Strategy C: text-label regex for plain non-structured sites ──────────
    _TEXT_PATTERNS: list[tuple[str, list[str]]] = [
        ('internet_price', [
            r'internet\s+price[^<\n]{0,40}\$\s*([\d,]{4,7})',
            r'sale\s+price[^<\n]{0,40}\$\s*([\d,]{4,7})',
            r'your\s+price[^<\n]{0,40}\$\s*([\d,]{4,7})',
        ]),
        ('retail_price', [
            r'retail\s+price[^<\n]{0,40}\$\s*([\d,]{4,7})',
            r'\bmsrp\b[^<\n]{0,40}\$\s*([\d,]{4,7})',
        ]),
        ('doc_fee', [
            r'doc(?:umentary)?\s+fee[^<\n]{0,40}\$\s*([\d,]{2,5})',
        ]),
        ('savings', [
            r'(?:you\s+save|savings)[^<\n]{0,40}\$\s*([\d,]{2,6})',
        ]),
    ]
    for field, patterns in _TEXT_PATTERNS:
        if field in result:
            continue
        for pat in patterns:
            m = re.search(pat, html_text, re.IGNORECASE)
            if m:
                v = _parse_amount(m.group(1))
                if v:
                    result[field] = v
                    break

    return result


def _db_lookup_by_vin(vin: str) -> dict:
    """Look up a vehicle in our local marketplace DB by VIN (any tenant).

    Returns a dict with price, mileage, exterior_color, doc_fee, retail_price,
    and savings if found, or {}.
    Used as the fastest / most accurate data source for mosescars.com URLs.
    """
    try:
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT price, mileage, exterior_color, doc_fee, retail_price, savings "
            "FROM marketplace_inventory "
            "WHERE vin=? AND status='ACTIVE' AND price>0 "
            "ORDER BY price DESC LIMIT 1",
            (vin,),
        )
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else {}
    except Exception:
        return {}


def _free_tool_parse(raw_url: str) -> dict:
    """Fetch a vehicle listing URL, extract specs, and generate Facebook
    Marketplace copy via AI.

    Extraction priority chain (each step only runs if data still missing):
      1. Internal DB lookup by VIN  — instant, most accurate for Moses URLs
      2. JSON-LD schema.org blocks  — structured data on compliant sites
      3. Embedded JS / JSON objects — look for internet/final/sale price keys
      4. Open Graph / <meta> tags   — title and description fallback
      5. schema.org microdata (itemprop) — price and mileageFromOdometer
      6. HTML data-* attributes     — data-price, data-mileage, etc.
      7. HTML class patterns        — .internetPrice, .salePrice, etc.
      8. Text label regex           — "Internet Price: $13,224"
      9. Text mileage regex         — "134,000 miles", "98000 mi"

    Raises ValueError if the URL is invalid or the page can't be fetched.
    """
    import html as _html

    # ── 1. Validate & fetch ─────────────────────────────────────────────────
    # Minimal validation: only enforce that the scheme is http/https so any
    # valid dealership or third-party listing URL is accepted regardless of
    # its path structure or file-extension conventions.
    try:
        parsed = urllib.parse.urlparse(raw_url)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError("URL must start with http:// or https://")
        if not parsed.netloc:
            raise ValueError("No domain found in that URL — make sure it starts with https://")
    except ValueError:
        raise
    except Exception:
        raise ValueError("Could not parse that URL — make sure it starts with https://")

    # Use realistic browser headers so dealership sites don't block the fetch.
    req = urllib.request.Request(raw_url, headers=FREE_TOOL_FETCH_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw_html = resp.read(900_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Page returned HTTP {exc.code}. Make sure the link is a public vehicle listing.")
    except Exception as exc:
        raise ValueError(f"Could not reach that page: {exc}")

    vehicle: dict = {}

    # ── Step 1: Internal DB lookup by VIN ────────────────────────────────────
    # DealerOn/Dealer.com sites (mosescars.com) render everything client-side,
    # so the static HTML contains no price or mileage.  If we already have this
    # vehicle in our inventory DB from a previous sync, use that data directly.
    vin_m = re.search(r'\b([A-HJ-NPR-Z0-9]{17})\b', raw_url)
    if vin_m:
        db_row = _db_lookup_by_vin(vin_m.group(1))
        if db_row.get('price'):
            vehicle['price'] = int(db_row['price'])
        if db_row.get('mileage'):
            vehicle['mileage_raw'] = str(int(db_row['mileage']))
        if db_row.get('exterior_color'):
            vehicle['color'] = db_row['exterior_color']
        if db_row.get('doc_fee'):
            vehicle['doc_fee'] = int(db_row['doc_fee'])
        if db_row.get('retail_price'):
            vehicle['retail_price'] = int(db_row['retail_price'])
        if db_row.get('savings'):
            vehicle['savings'] = int(db_row['savings'])

    # ── Step 1b: Price bloc extraction from static HTML ───────────────────────
    # DealerOn/CDK sites embed the full pricing stack (Retail Price, Doc Fee,
    # Savings, Moses/Internet Price) in static HTML inside priceBlocItem spans.
    # The price bloc is the most authoritative source for the breakdown fields,
    # so internet_price overrides whatever the DB stored (which may have been
    # a retail/MSRP figure captured before this extraction was in place).
    try:
        _bloc = _extract_price_bloc(raw_html)
    except Exception:
        _bloc = {}
    if _bloc.get('internet_price'):
        vehicle['price'] = _bloc['internet_price']   # definitive selling price
    if _bloc.get('retail_price'):
        vehicle['retail_price'] = _bloc['retail_price']
    if _bloc.get('doc_fee'):
        vehicle['doc_fee'] = _bloc['doc_fee']
    if _bloc.get('savings'):
        vehicle['savings'] = _bloc['savings']

    # ── Step 2: JSON-LD schema.org blocks ────────────────────────────────────
    for raw_block in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        raw_html,
        re.DOTALL | re.IGNORECASE,
    ):
        try:
            obj = json.loads(raw_block.strip())
        except json.JSONDecodeError:
            continue
        items = obj if isinstance(obj, list) else [obj]
        for item in items:
            t = str(item.get('@type', '')).lower()
            if t not in ('car', 'product', 'vehicle', 'autodealer'):
                continue

            vehicle['name'] = item.get('name') or vehicle.get('name', '')
            vehicle['description_raw'] = item.get('description') or vehicle.get('description_raw', '')
            vehicle['color']  = item.get('color')  or vehicle.get('color', '')
            vehicle['model']  = item.get('model')  or vehicle.get('model', '')
            vehicle['cond']   = item.get('itemCondition') or vehicle.get('cond', '')
            brand = item.get('brand') or {}
            vehicle['brand']  = (brand.get('name') if isinstance(brand, dict) else brand) or vehicle.get('brand', '')

            # Price from offers — prefer the selling/internet price in the offer object
            if not vehicle.get('price'):
                offers = item.get('offers') or item.get('Offers') or {}
                if isinstance(offers, list):
                    offers = offers[0] if offers else {}
                price_raw = (
                    offers.get('price') or offers.get('Price')
                    or item.get('price')
                )
                if price_raw:
                    try:
                        p = int(float(str(price_raw).replace(',', '').replace('$', '')))
                        if p > 500:
                            vehicle['price'] = p
                    except (ValueError, TypeError):
                        pass

            # mileageFromOdometer — handle both object {"value": "..."} and plain scalar
            if not vehicle.get('mileage_raw'):
                mfo = item.get('mileageFromOdometer') or {}
                if isinstance(mfo, dict):
                    mfo_val = str(mfo.get('value', '') or '')
                elif mfo:
                    mfo_val = str(mfo)
                else:
                    mfo_val = ''
                clean = mfo_val.replace(',', '').strip()
                if clean.isdigit() and int(clean) > 100:
                    vehicle['mileage_raw'] = clean
            break

    # ── Step 3: Embedded JS / JSON objects in <script> tags ──────────────────
    # Priority: internet/final/sale price keys >> msrp/retail
    if not vehicle.get('price') or not vehicle.get('mileage_raw'):
        for script_block in re.findall(r'<script[^>]*>(.*?)</script>', raw_html, re.DOTALL | re.IGNORECASE):
            if len(script_block) < 20:
                continue

            if not vehicle.get('price'):
                for price_key in [
                    'internetPrice', 'internet_price', 'finalPrice', 'final_price',
                    'salePrice', 'sale_price', 'sellingPrice', 'selling_price',
                    'yourPrice', 'askingPrice', 'discountedPrice', 'netPrice',
                ]:
                    m = re.search(
                        rf'["\']?{price_key}["\']?\s*:\s*["\']?([\d]{{4,7}}(?:[,.][\d]{{1,3}})*)["\']?',
                        script_block, re.IGNORECASE,
                    )
                    if m:
                        try:
                            p = int(float(m.group(1).replace(',', '')))
                            if p > 500:
                                vehicle['price'] = p
                                break
                        except ValueError:
                            pass

            if not vehicle.get('mileage_raw'):
                for mil_key in [
                    'mileageFromOdometer', 'mileage', 'odometer',
                    'odometerReading', 'miles', 'currentMileage',
                ]:
                    m = re.search(
                        rf'["\']?{mil_key}["\']?\s*:\s*["\']?([\d,]{{4,7}})["\']?',
                        script_block, re.IGNORECASE,
                    )
                    if m:
                        try:
                            mi = int(m.group(1).replace(',', ''))
                            if 100 < mi < 500_000:
                                vehicle['mileage_raw'] = str(mi)
                                break
                        except ValueError:
                            pass

    # ── Step 4: Open Graph / meta fallbacks ───────────────────────────────────
    def _meta(name: str) -> str:
        m = re.search(
            rf'<meta[^>]+(?:property|name)=["\'](?:og:)?{re.escape(name)}["\'][^>]*content=["\']([^"\']+)["\']',
            raw_html, re.IGNORECASE,
        ) or re.search(
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og:)?{re.escape(name)}["\']',
            raw_html, re.IGNORECASE,
        )
        return _html.unescape(m.group(1).strip()) if m else ''

    og_title = _meta('title') or _meta('og:title')
    if og_title and not vehicle.get('name'):
        vehicle['name'] = og_title

    og_desc = _meta('description') or _meta('og:description')
    if og_desc and not vehicle.get('description_raw'):
        vehicle['description_raw'] = og_desc

    # ── Step 5: schema.org microdata (itemprop attributes) ───────────────────
    if not vehicle.get('price'):
        m = re.search(
            r'itemprop=["\']price["\'][^>]*content=["\']([^"\']+)["\']',
            raw_html, re.IGNORECASE,
        ) or re.search(
            r'itemprop=["\']price["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            raw_html, re.IGNORECASE,
        )
        if m:
            try:
                p = int(float(m.group(1).replace(',', '').replace('$', '').strip()))
                if p > 500:
                    vehicle['price'] = p
            except (ValueError, TypeError):
                pass

    if not vehicle.get('mileage_raw'):
        m = re.search(
            r'itemprop=["\']mileageFromOdometer["\'][^>]*content=["\']([^"\']+)["\']',
            raw_html, re.IGNORECASE,
        ) or re.search(
            r'itemprop=["\']mileageFromOdometer["\'][^>]*>\s*([\d,]{4,7})',
            raw_html, re.IGNORECASE,
        )
        if m:
            try:
                mi = int(m.group(1).replace(',', '').strip())
                if 100 < mi < 500_000:
                    vehicle['mileage_raw'] = str(mi)
            except (ValueError, TypeError):
                pass

    # ── Step 6: HTML data-* attribute patterns ────────────────────────────────
    # Internet/final/sale price first; generic data-price last
    if not vehicle.get('price'):
        for attr_pat in [
            r'data-internet-price=["\'](\d[\d,]*)["\']',
            r'data-internetprice=["\'](\d[\d,]*)["\']',
            r'data-final-price=["\'](\d[\d,]*)["\']',
            r'data-finalprice=["\'](\d[\d,]*)["\']',
            r'data-sale-price=["\'](\d[\d,]*)["\']',
            r'data-asking-price=["\'](\d[\d,]*)["\']',
            r'data-price=["\'](\d[\d,]*)["\']',
        ]:
            m = re.search(attr_pat, raw_html, re.IGNORECASE)
            if m:
                try:
                    p = int(m.group(1).replace(',', ''))
                    if p > 500:
                        vehicle['price'] = p
                        break
                except ValueError:
                    pass

    if not vehicle.get('mileage_raw'):
        for attr_pat in [
            r'data-mileage=["\'](\d[\d,]*)["\']',
            r'data-miles=["\'](\d[\d,]*)["\']',
            r'data-odometer=["\'](\d[\d,]*)["\']',
        ]:
            m = re.search(attr_pat, raw_html, re.IGNORECASE)
            if m:
                try:
                    mi = int(m.group(1).replace(',', ''))
                    if 100 < mi < 500_000:
                        vehicle['mileage_raw'] = str(mi)
                        break
                except ValueError:
                    pass

    # ── Step 7: CSS class patterns for price ──────────────────────────────────
    if not vehicle.get('price'):
        for class_pat in [
            r'class=["\'][^"\']*internet[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*final[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*sale[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*asking[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*your[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
            r'class=["\'][^"\']*selling[_-]?price[^"\']*["\'][^>]*>\s*[\$]?\s*([\d,]{4,7})',
        ]:
            m = re.search(class_pat, raw_html, re.IGNORECASE)
            if m:
                try:
                    p = int(m.group(1).replace(',', ''))
                    if p > 500:
                        vehicle['price'] = p
                        break
                except ValueError:
                    pass

    if not vehicle.get('mileage_raw'):
        for class_pat in [
            r'class=["\'][^"\']*(?:mileage|odometer|miles)[^"\']*["\'][^>]*>\s*([\d,]{4,7})',
        ]:
            m = re.search(class_pat, raw_html, re.IGNORECASE)
            if m:
                try:
                    mi = int(m.group(1).replace(',', ''))
                    if 100 < mi < 500_000:
                        vehicle['mileage_raw'] = str(mi)
                        break
                except ValueError:
                    pass

    # ── Step 8: Text label patterns  ──────────────────────────────────────────
    # "Internet Price: $13,224"  or  "Final Price $13,224"
    # IMPORTANT: only look for labelled amounts — never grab the first bare $
    # to avoid picking up MSRP, savings, monthly payments, etc.
    if not vehicle.get('price'):
        for label in [
            r'internet\s+price', r'final\s+price', r'sale\s+price',
            r'your\s+price', r'asking\s+price', r'selling\s+price',
            r'special\s+price', r'discounted\s+price', r'net\s+price',
        ]:
            m = re.search(
                rf'{label}[^<\n]{{0,40}}[\$]?\s*([\d]{{3,6}}(?:,[\d]{{3}})?)',
                raw_html, re.IGNORECASE,
            )
            if m:
                try:
                    p = int(m.group(1).replace(',', ''))
                    if p > 500:
                        vehicle['price'] = p
                        break
                except ValueError:
                    pass

    # ── Step 9: Mileage text patterns ─────────────────────────────────────────
    if not vehicle.get('mileage_raw'):
        for mil_pat in (
            # Labelled: "Mileage: 134,000" or "Odometer: 98000"
            r'(?:mileage|odometer)\s*:?\s*([\d,]{4,7})',
            # "134,000 miles" — comma-formatted number (5-9 chars with comma)
            r'\b([\d]{1,3},[\d]{3})\s*(?:miles?|mi)\b',
            # "98000 miles" — plain digits 4-6 chars
            r'\b([\d]{4,6})\s*(?:miles?|mi)\b',
        ):
            mil_m = re.search(mil_pat, raw_html, re.IGNORECASE)
            if mil_m:
                raw_miles = mil_m.group(1).replace(',', '')
                try:
                    mi = int(raw_miles)
                    if 100 < mi < 500_000:
                        vehicle['mileage_raw'] = raw_miles
                        break
                except ValueError:
                    pass

    # ── Title tag fallback — last resort if all structured extraction found nothing
    if not vehicle.get('name'):
        try:
            _title_m = re.search(
                r'<title[^>]*>\s*([^<]{3,200}?)\s*</title>', raw_html, re.IGNORECASE
            )
            if _title_m:
                vehicle['name'] = _html.unescape(_title_m.group(1).strip())
        except Exception:
            pass

    # ── Build summary ─────────────────────────────────────────────────────────
    name = vehicle.get('name', '') or raw_url
    year_m = re.search(r'\b(19|20)\d{2}\b', name)
    year   = year_m.group(0) if year_m else ''

    vehicle_summary = (vehicle.get('name') or '').strip()
    if not vehicle_summary:
        vehicle_summary = "Vehicle (details extracted from page)"

    price_int = vehicle.get('price', 0)
    price_str = str(price_int) if price_int else ''
    color     = vehicle.get('color', '') or ''
    mileage   = vehicle.get('mileage_raw', '') or ''
    desc_raw  = vehicle.get('description_raw', '') or ''

    # ── 3. AI generation ────────────────────────────────────────────────────
    retail_price_int = vehicle.get('retail_price', 0)
    doc_fee_int      = vehicle.get('doc_fee', 0)
    savings_int      = vehicle.get('savings', 0)

    system_msg = (
        "You are an expert automotive Facebook Marketplace copywriter. "
        "Generate a high-converting listing for the vehicle below. "
        "Return ONLY valid JSON with these keys:\n"
        "  'title'       — attention-grabbing headline, max 80 chars, use 1-2 emojis\n"
        "  'features'    — list of 5-7 bullet strings starting with '• '\n"
        "  'description' — 140-180 word persuasive body, friendly tone, clear call to action, use emojis sparingly. "
        "If pricing breakdown is provided, naturally weave the internet price and savings into the copy.\n"
        "  'hashtags'    — single string of 5-6 relevant hashtags\n"
        "No markdown, no code fences, valid JSON only."
    )
    user_parts = [f"Vehicle: {vehicle_summary}"]
    if year:
        user_parts.append(f"Year: {year}")
    if price_int:
        user_parts.append(f"Internet Price: ${price_int:,}")
    if retail_price_int:
        user_parts.append(f"Retail Price (MSRP): ${retail_price_int:,}")
    if savings_int:
        user_parts.append(f"Savings vs. Retail: ${savings_int:,}")
    if doc_fee_int:
        user_parts.append(f"Doc Fee: ${doc_fee_int:,}")
    if color:
        user_parts.append(f"Color: {color}")
    if mileage:
        user_parts.append(f"Mileage: {mileage}")
    if desc_raw:
        user_parts.append(f"Page description: {desc_raw[:300]}")
    user_parts.append("Generate the Facebook Marketplace listing JSON now.")
    user_msg = "\n".join(user_parts)

    raw_ai = _call_openai_chat(
        [
            {'role': 'system', 'content': system_msg},
            {'role': 'user',   'content': user_msg},
        ],
        model="gpt-5.4-mini",
    )

    if raw_ai:
        cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw_ai.strip(), flags=re.DOTALL)
        try:
            post = json.loads(cleaned)
        except json.JSONDecodeError:
            post = {
                'title':       f"🚗 {vehicle_summary}" + (f" | ${price_int:,}" if price_int else ""),
                'features':    ['• See listing for full details'],
                'description': raw_ai,
                'hashtags':    "#CarForSale #ForSale #AutoDealer",
            }
    else:
        post = {
            'title':       f"🚗 {vehicle_summary}" + (f" — ${price_int:,}" if price_int else ""),
            'features':    [
                f"• {vehicle_summary}",
                "• Well maintained — see listing for full details",
                "• Financing options may be available",
                "• Contact seller to schedule a test drive",
            ],
            'description': (
                f"Check out this {vehicle_summary}! "
                + (f"Priced at ${price_int:,}. " if price_int else "")
                + "Contact us today to learn more and schedule a test drive. "
                "Don't miss this opportunity!"
            ),
            'hashtags': "#CarForSale #UsedCars #ForSale #AutoDealer",
        }

    return {
        'vehicle_summary': vehicle_summary,
        'price':           price_str,
        'miles':           mileage,
        'retail_price':    str(retail_price_int) if retail_price_int else '',
        'doc_fee':         str(doc_fee_int)      if doc_fee_int      else '',
        'savings':         str(savings_int)      if savings_int      else '',
        'title':           post.get('title', ''),
        'features':        post.get('features', []),
        'description':     post.get('description', ''),
        'hashtags':        post.get('hashtags', ''),
    }


def generate_customer_email(customer: dict, template_id: str) -> dict:
    """Generate a personalized customer thank-you / follow-up email via AI.

    Returns {'subject': str, 'body': str}.
    """
    name    = customer.get('name', 'Valued Customer')
    first   = name.split()[0] if name else 'there'
    vehicle = customer.get('vehicle_purchased', '') or 'your new vehicle'

    PROMPTS: dict[str, str] = {
        'thank_you': (
            f"Write a warm, professional thank you email from a car dealership sales team to "
            f"{name} who just purchased a {vehicle}. Thank them sincerely for their purchase "
            "and trust, express genuine excitement for them, mention we are here for any "
            "questions, and wish them many happy miles. Personal, friendly, under 150 words. "
            "No generic filler phrases. Do NOT include a subject line — output only the email body."
        ),
        'follow_up_30': (
            f"Write a friendly 30-day follow-up email from a car dealership to {name} who "
            f"purchased a {vehicle} about a month ago. Ask how they are enjoying it, offer to "
            "answer questions, gently mention that happy customers often refer friends and family, "
            "and remind them we are here for service needs. Warm, under 150 words, not salesy. "
            "Do NOT include a subject line — output only the email body."
        ),
        'referral': (
            f"Write a referral request email from a car dealership to {name} who purchased a "
            f"{vehicle}. Express genuine appreciation, ask if they know anyone looking for a "
            "vehicle, explain referrals receive VIP treatment, and offer a heartfelt thank-you "
            "for any referral that results in a sale. Genuine, friendly, under 150 words, "
            "low-pressure call to action. Do NOT include a subject line — output only the email body."
        ),
    }
    SUBJECTS: dict[str, str] = {
        'thank_you':    f"Thank You for Your Purchase, {first}! 🚗",
        'follow_up_30': f"How Are You Enjoying Your New Ride, {first}?",
        'referral':     f"A Quick Note from Us, {first}",
    }

    prompt  = PROMPTS.get(template_id, PROMPTS['thank_you'])
    subject = SUBJECTS.get(template_id, SUBJECTS['thank_you'])

    body = _call_openai_chat(
        [{'role': 'user', 'content': prompt}],
        model='gpt-5.4-mini',
    )
    if not body:
        body = (
            f"Dear {name},\n\n"
            f"Thank you so much for your purchase of {vehicle} with us. "
            "We truly appreciate your business and are here whenever you need us.\n\n"
            "Warm regards,\nMoses Auto Group"
        )
    return {'subject': subject, 'body': body.strip()}


# =====================================================================
class BDCRequestHandler(BaseHTTPRequestHandler):

    def log_message(self, format_str, *args):
        # Suppress default access logs; use print for important events only
        return

    def handle_one_request(self):
        """Override to guarantee every request returns valid JSON on exception.

        BaseHTTPRequestHandler's default generates an HTML 500 page when any
        ``do_*`` method raises — a reverse proxy forwards that raw HTML to the
        browser, which tries to JSON.parse it and surfaces an opaque
        "Unexpected token < in JSON" error.  This wrapper intercepts the
        exception before the TCPServer error handler can emit HTML, writes a
        structured JSON 500, then flushes the connection cleanly.
        """
        try:
            super().handle_one_request()
        except Exception as exc:
            import traceback as _tb
            _tb.print_exc()
            try:
                self._json(
                    {"error": "Internal server error.", "detail": str(exc)},
                    500,
                )
            except Exception:
                pass  # connection may already be broken — swallow silently

    def _json(self, payload, status=200, extra_headers=None):
        """Serialize payload and write a complete HTTP response with Content-Length.

        Content-Length is required so that a reverse proxy (and any other
        HTTP/1.0-aware intermediary) can deliver the body to the browser intact.
        Without it the proxy has no way to know where the body ends and may
        forward an empty response, causing `Unexpected end of JSON input` on the
        client even though the raw socket contains the data.
        """
        body = json.dumps(payload, cls=_DateTimeEncoder).encode("utf-8")
        self._write_json_body(body, status, extra_headers)

    def _write_json_body(self, body: bytes, status=200, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        _origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", _origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        for _extra_k, _extra_v in (extra_headers or []):
            self.send_header(_extra_k, _extra_v)
        self.end_headers()
        self.wfile.write(body)

    def _get_bearer_token(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip() or None
        # Prefer HttpOnly session cookie (bdc_session) when Bearer is absent.
        cookie = self.headers.get("Cookie", "") or ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("bdc_session="):
                val = part[len("bdc_session="):].strip()
                return val or None
        return None

    def _client_ip(self) -> str:
        xf = self.headers.get("X-Forwarded-For") or self.headers.get("x-forwarded-for") or ""
        if xf:
            return xf.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def _optional_username(self) -> str:
        """Best-effort username for public endpoints that want attribution.

        Returns an empty string when no usable token is present. Never writes a
        response, so callers stay unauthenticated-friendly.
        """
        token = self._get_bearer_token()
        if not token:
            return ""
        try:
            user = UserManager.get_user_by_token(token)
        except Exception:
            return ""
        if not user or user.get("_session_displaced"):
            return ""
        return str(user.get("username") or "")

    def _require_auth(self) -> dict | None:
        """Return the authenticated user dict, or write an error response and return None.

        Checks (in order):
          1. Bearer token present.
          2. Token resolves to a valid user.
          3. Session not displaced by a newer login.
          4. Account not suspended.
          5. Rate limit not exceeded on management endpoints (POST only).
          6. Request URL does not contain SQLi / XSS patterns.
        Master admin accounts (is_admin=1) are exempt from rate-limit and pattern checks.
        """
        token = self._get_bearer_token()
        if not token:
            self._json({"error": "Authorization required."}, 401)
            return None
        user = UserManager.get_user_by_token(token)
        if not user:
            self._json({"error": "Invalid or expired session token."}, 401)
            return None
        # ── Concurrent-login guard ────────────────────────────────────────────
        if user.get("_session_displaced"):
            _revoke_token(token)
            self._json(
                {
                    "error":   "session_displaced",
                    "message": "You have been logged out because this account "
                               "was signed in from another location or device.",
                },
                401,
            )
            return None
        # ── Suspension guard ──────────────────────────────────────────────────
        if user.get("is_suspended"):
            _revoke_token(token)
            self._json(
                {
                    "error":   "account_suspended",
                    "message": "Your account has been suspended due to a security "
                               "policy violation. Please contact support.",
                },
                403,
            )
            return None
        # ── Security checks (exempt for master admin) ─────────────────────────
        if not user.get("is_admin"):
            _uid = user["id"]
            # Rate-limit: track management POST requests per user per window
            if self.command == "POST" and any(
                self.path.startswith(p) for p in (
                    "/api/team/", "/api/billing/", "/api/admin/",
                    "/api/org/", "/api/settings/",
                )
            ):
                _now  = time.time()
                _hist = _RATE_LIMITER.get(_uid, [])
                _hist = [t for t in _hist if _now - t < _RATE_LIMIT_WINDOW]
                _hist.append(_now)
                _RATE_LIMITER[_uid] = _hist
                if len(_hist) > _RATE_LIMIT_MAX:
                    self._suspend_for_exploit(
                        user, token, "rate_abuse",
                        f"{len(_hist)} POST reqs/{int(_RATE_LIMIT_WINDOW)}s on mgmt endpoints",
                    )
                    return None
            # URL-level exploit scan (path + query string)
            _url = self.path
            if _SQLI_PATTERNS.search(_url):
                self._suspend_for_exploit(user, token, "sql_injection_url", _url[:300])
                return None
            if _XSS_PATTERNS.search(_url):
                self._suspend_for_exploit(user, token, "xss_injection_url", _url[:300])
                return None
        return user

    def _require_subscription(self, user: dict) -> bool:
        """Return True if the user is an admin or has an active subscription.
        Writes a 403 JSON error and returns False for unpaid users."""
        if user.get("is_admin") or user.get("subscription_status") == "active":
            return True
        self._json(
            {
                "error": "subscription_required",
                "message": "An active subscription is required to access this feature.",
            },
            403,
        )
        return False

    def _require_master_admin(self) -> dict | None:
        """Return the authenticated user dict only if the caller is the master admin.
        Writes 401/403 and returns None for any other caller."""
        user = self._require_auth()
        if not user:
            return None
        _admin_user  = os.environ.get('ADMIN_USER',  'mdemoss').strip().lower()
        _admin_email = os.environ.get('ADMIN_EMAIL', '').strip().lower()
        _uname = (user.get('username') or '').lower()
        _email = (user.get('email')    or '').lower()
        if _uname == _admin_user or (_admin_email and _email == _admin_email):
            return user
        self._json({"error": "Forbidden — master admin only."}, 403)
        return None

    # ── Security exploit response ─────────────────────────────────────────────

    def _suspend_for_exploit(
        self,
        user:           dict,
        token:          str,
        violation_type: str,
        snippet:        str,
    ) -> None:
        """Immediately suspend the account, revoke the session token, write an
        audit record, and return HTTP 403.  Called whenever the automated exploit
        detector fires on a non-admin user."""
        _uid   = user["id"]
        _uname = user.get("username") or str(_uid)
        _ip    = (
            self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or self.client_address[0]
        )
        # 1. Suspend in database
        try:
            _sc = sqlite3.connect(DB_FILE)
            _sc.execute("UPDATE users SET is_suspended = 1 WHERE id = ?", (_uid,))
            _sc.commit()
            _sc.close()
        except Exception as _se:
            print(f"[SECURITY] DB suspend error: {_se}")
        # 2. Revoke token so the session cannot retry
        _revoke_token(token)
        # 3. Audit log
        _log_security_event(_uid, _uname, _ip, self.path, violation_type, snippet)
        # 4. 403 response
        self._json(
            {
                "error":   "account_suspended",
                "message": "Account suspended due to security policy violation.",
            },
            403,
        )

    def _security_scan_body(
        self,
        user:      dict,
        token:     str,
        body_text: str,
    ) -> bool:
        """Scan a decoded request body string for SQLi, XSS, and path-traversal patterns.

        Returns True if a violation was detected (403 already sent; caller must return).
        Returns False when the body is clean.
        Master admin accounts are exempt.
        """
        if user.get("is_admin"):
            return False
        if _SQLI_PATTERNS.search(body_text):
            self._suspend_for_exploit(user, token, "sql_injection_body", body_text[:300])
            return True
        if _XSS_PATTERNS.search(body_text):
            self._suspend_for_exploit(user, token, "xss_injection_body", body_text[:300])
            return True
        if _PATH_TRAVERSAL_PATTERN.search(body_text):
            self._suspend_for_exploit(user, token, "path_traversal", body_text[:300])
            return True
        return False

    def do_OPTIONS(self):
        self._set_json_headers(204)

    def do_GET(self):
        path = self.path.split("?")[0]  # strip query string

        # ── TikTok URL Property Verification (signature files, no auth) ──
        if path.rstrip("/") in (
            "/tiktok-developers-site-verification.html",
            "/tiktok-developers-site-verification.txt",
            "/tiktok-developers-site-verification-kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7.txt",
            "/tiktok-developers-site-verification",
        ):
            _body = b"tiktok-developers-site-verification=kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7"
            _ctype = "text/html" if path.rstrip("/").lower().endswith(".html") else "text/plain"
            self.send_response(200)
            self.send_header("Content-Type", _ctype)
            self.send_header("Content-Length", str(len(_body)))
            self.end_headers()
            self.wfile.write(_body)
            return

        # ── TikTok explicit verification file (named route, no auth) ────
        if path in ("/tiktokoZoF3ekEa8cY5mr8gAPNIXDHRv0dvnLB.txt",
                    "/tiktokoZoF3ekEa8cY5mr8gAPNIXDHRv0dvnLB.txt/"):
            _body = b"tiktok-developers-site-verification=oZoF3ekEa8cY5mr8gAPNIXDHRv0dvnLB"
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(_body)))
            self.end_headers()
            self.wfile.write(_body)
            return

        # ── TikTok domain ownership / webhook verification files ─────
        # Matches any /tiktok*.txt or /tiktok*.html the TikTok developer
        # portal might request (including the legacy hardcoded path).
        # If a real file has been placed in the adjacent public/ directory
        # we serve it verbatim; otherwise we echo the filename stem, which
        # is exactly what TikTok embeds as the expected verification token.
        if re.match(r'^/tiktok[A-Za-z0-9_.%-]+\.(txt|html)$', path, re.IGNORECASE):
            _ctype  = 'text/html' if path.lower().endswith('.html') else 'text/plain'
            _pub    = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   'public', path.lstrip('/'))
            if os.path.isfile(_pub):
                with open(_pub, 'rb') as _pf:
                    _pbody = _pf.read()
            else:
                # Token == filename stem (no extension, no leading slash)
                _stem  = os.path.splitext(path.lstrip('/'))[0]
                _pbody = _stem.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', _ctype)
            self.send_header('Content-Length', str(len(_pbody)))
            self.end_headers()
            self.wfile.write(_pbody)
            return

        # ── Public endpoints ──────────────────────────────────────────
        if path in ("/api/healthz", "/api/health"):
            self._json({"status": "UP", "engine": "BDC Automation Engine V5"})
            return

        # ── Public: Meta Automotive Inventory feed (multi-tenant) ─────
        # Meta's crawler fetches this without a session cookie.
        # Tenant is resolved from query params and/or Bearer auth:
        #   /api/feeds/meta?format=csv&catalog_id=<commerce_catalog_id>
        #   /api/feeds/meta?format=xml&token=<catalog_token>
        #   /api/feeds/meta?format=csv&user_id=<id>
        #   /api/feeds/meta?format=csv   (Bearer token -> current user)
        if path == "/api/feeds/meta":
            _qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _q1(*keys: str, default: str = '') -> str:
                for k in keys:
                    vals = _qs.get(k)
                    if vals and str(vals[0]).strip():
                        return str(vals[0]).strip()
                return default

            _fmt = _q1('format', 'fmt', default='csv').lower()
            if _fmt not in ('csv', 'xml'):
                _fmt = 'csv'

            # Optional session user — lets logged-in dealers preview their feed
            _session_uid: int | None = None
            _bearer = self._get_bearer_token()
            if _bearer:
                _su = UserManager.get_user_by_token(_bearer)
                if _su and not _su.get('is_suspended'):
                    _session_uid = int(_su['id'])

            _tenant = MetaCatalogFeed.resolve_tenant(
                catalog_token=_q1('token', 'catalog_token'),
                catalog_id=_q1('catalog_id', 'id', 'commerce_catalog_id'),
                user_id=_q1('user_id', 'uid'),
                username=_q1('username', 'user'),
                session_user_id=_session_uid,
            )

            if _tenant is None:
                # Unresolvable tenant — still return a structurally valid empty feed
                # so Meta's scheduled fetch never hard-fails on format.
                if _fmt == 'xml':
                    _body = MetaCatalogFeed.empty_xml().encode('utf-8')
                    _ctype = 'application/xml; charset=utf-8'
                    _fname = 'meta-feed.xml'
                else:
                    _body = MetaCatalogFeed.empty_csv().encode('utf-8')
                    _ctype = 'text/csv; charset=utf-8'
                    _fname = 'meta-feed.csv'
                self.send_response(200)
                self.send_header('Content-Type', _ctype)
                self.send_header('Content-Disposition', f'inline; filename="{_fname}"')
                self.send_header('Content-Length', str(len(_body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(_body)
                return

            try:
                _rows = MetaCatalogFeed.build_rows(_tenant)
                if _fmt == 'xml':
                    _payload = (
                        MetaCatalogFeed.to_xml(_rows, _tenant)
                        if _rows else MetaCatalogFeed.empty_xml(_tenant)
                    )
                    _ctype = 'application/xml; charset=utf-8'
                    _fname = 'meta-feed.xml'
                else:
                    _payload = (
                        MetaCatalogFeed.to_csv(_rows)
                        if _rows else MetaCatalogFeed.empty_csv()
                    )
                    _ctype = 'text/csv; charset=utf-8'
                    _fname = 'meta-feed.csv'
                _body = _payload.encode('utf-8')
                print(
                    f"[META-FEED] user={_tenant['user_id']} "
                    f"dealer={_tenant.get('dealer_name')!r} "
                    f"format={_fmt} rows={len(_rows)}"
                )
            except Exception as _fe:
                print(f"[META-FEED] build error: {_fe}")
                _body = (
                    MetaCatalogFeed.empty_xml(_tenant).encode('utf-8')
                    if _fmt == 'xml'
                    else MetaCatalogFeed.empty_csv().encode('utf-8')
                )
                _ctype = (
                    'application/xml; charset=utf-8'
                    if _fmt == 'xml'
                    else 'text/csv; charset=utf-8'
                )
                _fname = 'meta-feed.xml' if _fmt == 'xml' else 'meta-feed.csv'

            self.send_response(200)
            self.send_header('Content-Type', _ctype)
            self.send_header('Content-Disposition', f'inline; filename="{_fname}"')
            self.send_header('Content-Length', str(len(_body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.end_headers()
            self.wfile.write(_body)
            return

        # ── Public: Meta Vehicle Inventory Data Feed (14-column) ─────
        # Completely unauthenticated — Meta's crawler bots fetch this
        # without any session cookie.
        #
        # URL shape: /api/v1/catalog/<id>.csv
        #   <id> is resolved in order:
        #     1. commerce_catalog_id column match (Meta-assigned catalog ID)
        #     2. numeric user_id match
        #     3. username match (case-insensitive)
        #   Unresolved IDs return a valid header + single dummy row (200)
        #   so Meta's parser never sees a malformed-format error.
        if path.startswith('/api/v1/catalog/') and path.endswith('.csv'):
            # ── Meta Automotive Vehicle Catalog — 16-column spec ─────────
            CATALOG_HEADER = (
                'vehicle_id,title,description,availability,state_of_vehicle,price,'
                'link,image,brand,make,model,year,vin,body_style,mileage,address'
            )
            CATALOG_MOCK_ROW = ','.join([
                '"DEMO-001"',
                '"2023 Ford F-150 Lariat"',
                '"Silver · 5,000 mi · Used · Lariat"',
                '"in stock"',
                '"USED"',
                '"35000 USD"',
                f'"{APP_BASE_URL or "https://example.com"}"',
                '"https://images.unsplash.com/photo-1533473359331-0135ef1b58bf"',
                '"Ford"', '"Ford"', '"F-150"', '"2023"', '""',
                '"TRUCK"', '"5000 miles"', '"US"',
            ])

            # ── Helpers ───────────────────────────────────────────────────
            # RFC 4180: wrap every field in double-quotes; escape internal quotes
            def _q(val) -> str:
                return '"' + str(val if val is not None else '').replace('"', '""') + '"'

            # Minimal URL validity check
            def _valid_url(raw) -> bool:
                s = str(raw or '').strip()
                for pfx in ('https://', 'http://'):
                    if s.startswith(pfx):
                        rest = s[len(pfx):]
                        return len(rest) >= 4 and '.' in rest
                return False

            # body_style keyword inference (case-insensitive substring match on
            # model + trim).  Evaluated in priority order: TRUCK -> SUV -> COUPE
            # -> SEDAN -> OTHER.
            _TRUCK_KW = {
                'silverado', 'f-150', 'f150', 'f 150', 'sierra', 'tacoma',
                'tundra', 'colorado', 'canyon', 'ranger', 'frontier', 'titan',
                'ridgeline', 'maverick', 'cybertruck', 'ram 1500', 'ram 2500',
                'ram 3500', 'ram pickup', '1500', '2500', '3500',
            }
            _SUV_KW = {
                'traverse', 'equinox', 'tahoe', 'suburban', 'blazer', 'trax',
                'trailblazer', 'acadia', 'terrain', 'escalade', 'yukon',
                'explorer', 'expedition', 'bronco', 'escape', 'edge',
                'pilot', 'passport', 'odyssey', 'ridgeline',
                'highlander', 'rav4', '4runner', 'sequoia', 'venza', 'sienna',
                'pathfinder', 'armada', 'rogue', 'murano', 'xterra',
                'cr-v', 'hr-v', 'pilot', 'ridgeline',
                'grand cherokee', 'cherokee', 'wrangler', 'compass', 'renegade',
                'durango', 'journey',
                'tucson', 'santa fe', 'palisade', 'kona', 'venue',
                'sorento', 'sportage', 'telluride',
                'navigator', 'mkx', 'nautilus', 'aviator', 'corsair',
                'envoy', 'envision', 'enclave', 'encore',
                'mdx', 'rdx', 'pilot',
                'rx', 'nx', 'tx', 'lx', 'gx', 'ux',
                'xt4', 'xt5', 'xt6', 'escalade',
                'x3', 'x5', 'x6', 'x7',
                'q3', 'q5', 'q7', 'q8',
                'glc', 'gle', 'gls', 'glb', 'gla',
                'range rover', 'discovery', 'defender',
                'cayenne', 'macan', 'taycan cross',
                'atlas', 'tiguan', 'touareg',
                'forester', 'outback', 'crosstrek', 'ascent',
                'model y', 'model x',
                'cx-5', 'cx-9', 'cx-30', 'cx-50',
            }
            _COUPE_KW = {
                'mustang', 'camaro', 'challenger', 'corvette',
                '4 series', '2 series', 'coupe',
            }
            _SEDAN_KW = {
                'malibu', 'camry', 'accord', 'civic', 'corolla',
                'altima', 'sentra', 'maxima',
                'elantra', 'sonata', 'accent',
                'optima', 'k5', 'forte',
                'fusion', 'taurus', 'fiesta',
                'lacrosse', 'impala', 'cruze', 'sonic',
                'charger', 'chrysler 300',
                'a4', 'a6', 'a8',
                '3 series', '5 series', '7 series',
                'c-class', 'e-class', 's-class',
                'tlx', 'ilx',
                'model 3', 'model s',
                'passat', 'jetta', 'golf',
                'prius', 'camry',
            }

            def _body_style_from(model_s: str, trim_s: str) -> str:
                hay = (model_s + ' ' + trim_s).lower()
                if any(k in hay for k in _TRUCK_KW):  return 'TRUCK'
                if any(k in hay for k in _SUV_KW):    return 'SUV'
                if any(k in hay for k in _COUPE_KW):  return 'COUPE'
                if any(k in hay for k in _SEDAN_KW):  return 'SEDAN'
                return 'OTHER'

            _IMAGE_FALLBACK = 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf'

            # ── Resolve owner user from the URL :id segment ───────────────
            _cat_id  = path[len('/api/v1/catalog/'):-len('.csv')].strip()
            _cat_uid: int | None = None
            try:
                _rc = sqlite3.connect(DB_FILE)
                _rc.row_factory = sqlite3.Row
                # 1. commerce_catalog_id (Meta-assigned catalog ID)
                _row = _rc.execute(
                    "SELECT id FROM users "
                    "WHERE commerce_catalog_id = ? AND commerce_catalog_id != ''",
                    (_cat_id,),
                ).fetchone()
                if _row:
                    _cat_uid = int(_row['id'])
                # 2. Numeric user_id
                if _cat_uid is None and _cat_id.isdigit():
                    _row = _rc.execute(
                        "SELECT id FROM users WHERE id = ?", (int(_cat_id),)
                    ).fetchone()
                    if _row:
                        _cat_uid = int(_row['id'])
                # 3. Username (case-insensitive)
                if _cat_uid is None:
                    _row = _rc.execute(
                        "SELECT id FROM users WHERE LOWER(username) = ?",
                        (_cat_id.lower(),),
                    ).fetchone()
                    if _row:
                        _cat_uid = int(_row['id'])
                _rc.close()
            except Exception as _re:
                print(f"[CATALOG] User-resolve error for id={_cat_id!r}: {_re}")

            # ── Fetch dealer profile for per-row fallbacks ────────────────
            _cat_city     = ''
            _cat_state    = ''
            _cat_addr1    = ''
            _cat_zip      = ''
            _cat_url_used = ''
            _cat_url_new  = ''
            if _cat_uid is not None:
                try:
                    _rc2 = sqlite3.connect(DB_FILE)
                    _rc2.row_factory = sqlite3.Row
                    _urow = _rc2.execute(
                        "SELECT dealer_city, dealer_state, dealer_address_line1, "
                        "dealer_zip, inventory_url_used, inventory_url_new "
                        "FROM users WHERE id = ?",
                        (_cat_uid,),
                    ).fetchone()
                    if _urow:
                        _cat_city     = str(_urow['dealer_city']           or '').strip()
                        _cat_state    = str(_urow['dealer_state']          or '').strip()
                        _cat_addr1    = str(_urow['dealer_address_line1']  or '').strip()
                        _cat_zip      = str(_urow['dealer_zip']            or '').strip()
                        _cat_url_used = str(_urow['inventory_url_used']    or '').strip()
                        _cat_url_new  = str(_urow['inventory_url_new']     or '').strip()
                    _rc2.close()
                except Exception as _ue:
                    print(f"[CATALOG] User-profile fetch error for uid={_cat_uid}: {_ue}")

            # ── Link fallback chain (fully dynamic — no hardcoded domains) ─
            # Priority: used_inventory_url -> new_inventory_url ->
            #           root domain of whichever URL is configured
            def _root_domain(raw: str) -> str:
                """Extract scheme://host from a URL string, e.g. https://dealer.com"""
                try:
                    from urllib.parse import urlparse as _up
                    _p = _up(raw)
                    return f"{_p.scheme}://{_p.netloc}" if _p.netloc else ''
                except Exception:
                    return ''

            _any_configured_url = _cat_url_used or _cat_url_new
            if _valid_url(_cat_url_used):
                _LINK_FALLBACK = _cat_url_used
            elif _valid_url(_cat_url_new):
                _LINK_FALLBACK = _cat_url_new
            else:
                # No full SRP URL saved — extract at least the root domain
                _root = _root_domain(_any_configured_url)
                _LINK_FALLBACK = _root if _root else ''

            # ── Fetch active inventory for the resolved user ───────────────
            _inv = []
            if _cat_uid is not None:
                try:
                    _conn = sqlite3.connect(DB_FILE)
                    _conn.row_factory = sqlite3.Row
                    _inv = _conn.execute(
                        "SELECT * FROM marketplace_inventory "
                        "WHERE user_id = ? AND status = 'ACTIVE' "
                        "ORDER BY year DESC, price ASC "
                        "LIMIT 500",
                        (_cat_uid,),
                    ).fetchall()
                    _conn.close()
                except Exception as _ie:
                    print(f"[CATALOG] Inventory fetch error for uid={_cat_uid}: {_ie}")
                    _inv = []

            # ── Build CSV rows ────────────────────────────────────────────
            if _inv:
                lines     = [CATALOG_HEADER]
                _seen_ids: set = set()

                for _v in _inv:
                    _v = dict(_v)

                    # ── Core string fields ────────────────────────────────
                    _make  = str(_v.get('make',  '') or '').strip() or 'Vehicle'
                    # model: required by Meta — fall back to make if blank
                    _model = str(_v.get('model', '') or '').strip() or _make
                    _trim  = str(_v.get('trim',  '') or '').strip()
                    _ext   = str(_v.get('exterior_color', '') or '').strip()
                    _vin   = str(_v.get('vin',          '') or '').strip()
                    _stk   = str(_v.get('stock_number', '') or '').strip()
                    _dbid  = str(_v.get('id', ''))

                    # year: Meta requires a valid 4-digit integer; suppress
                    # placeholder 0 values that come from sitemap-only stubs
                    _year_raw = int(str(_v.get('year', '') or '0').strip() or '0')
                    _year     = str(_year_raw) if _year_raw >= 1900 else ''

                    # ── vehicle_id: real 17-char VIN -> stock# -> DB id ─────
                    _real_vin  = _vin  if len(_vin) == 17 else ''
                    _stk_clean = _stk  if (_stk and _stk != 'N/A') else ''
                    _vid = _real_vin or _stk_clean or _dbid
                    if _vid in _seen_ids:
                        _vid = f"{_vid}-{_dbid}"
                    _seen_ids.add(_vid)

                    # ── state_of_vehicle: strictly "NEW" or "USED" ────────
                    _state_v = 'NEW' if str(_v.get('condition') or '').lower() == 'new' \
                               else 'USED'

                    # ── title: Year Make Model Trim ───────────────────────
                    _title = ' '.join(p for p in [_year, _make, _model, _trim] if p) \
                             or _make

                    # ── mileage: strictly "[N] miles" ─────────────────────
                    _miles_digits = re.sub(r'[^\d]', '', str(_v.get('mileage') or ''))
                    _miles_int    = int(_miles_digits) if _miles_digits else 0
                    _miles_desc   = f"{_miles_int:,} mi"   # description prose
                    _mileage_col  = f"{_miles_int} miles"  # Meta mileage column

                    # ── description: Color · Miles · State · Trim ─────────
                    _desc_parts = [p for p in [_ext, _miles_desc,
                                               _state_v.title(), _trim] if p]
                    _desc = ' · '.join(_desc_parts) if _desc_parts else \
                            f"{_state_v.title()} {_title}"

                    # ── price: strictly "[AMOUNT] USD" ────────────────────
                    # Primary: scraped internet price.
                    # Fallback: retail_price stored during scrape (MSRP - discounts).
                    _price_raw = int(re.sub(r'[^\d]', '',
                                            str(_v.get('price') or '')) or '0')
                    if _price_raw == 0:
                        _price_raw = int(re.sub(r'[^\d]', '',
                                                str(_v.get('retail_price') or '')) or '0')
                    _price_str = f"{_price_raw} USD"

                    # ── link: VDP URL -> user's SRP -> root domain (dynamic) ─
                    _raw_link = str(_v.get('vdp_url', '') or '').strip()
                    if _valid_url(_raw_link):
                        _link = _raw_link
                    elif _LINK_FALLBACK:
                        _link = _LINK_FALLBACK
                    else:
                        # Last resort: build a root URL from the vehicle's
                        # own location field if it looks like a domain
                        _loc_url = str(_v.get('location', '') or '').strip()
                        _link = _root_domain(_loc_url) if _loc_url else ''

                    # ── image: vehicle photo -> high-res generic placeholder ─
                    _raw_img = str(_v.get('image_url', '') or '').strip()
                    _img = _raw_img if _valid_url(_raw_img) else _IMAGE_FALLBACK

                    # ── body_style: TRUCK / SUV / COUPE / SEDAN / OTHER ───
                    _bs = _body_style_from(_model, _trim)

                    # ── address: assembled from dealer profile (dynamic) ───
                    # Full street address when available; city+state at minimum.
                    if _cat_city and _cat_state:
                        _addr_parts = [p for p in
                                       [_cat_addr1, _cat_city, _cat_state, _cat_zip]
                                       if p]
                        _address = ', '.join(_addr_parts) + ', US'
                    elif _cat_city:
                        _address = f"{_cat_city}, US"
                    else:
                        # Fall back to the vehicle's own location field
                        _loc_str = str(_v.get('location', '') or '').strip()
                        _address = f"{_loc_str}, US" if _loc_str else 'US'

                    # ── vin column: strictly real 17-char VINs (or blank) ──
                    # Synthetic 32-char UUIDs from sitemap stubs are NOT valid
                    # VINs and must not be passed to Meta's catalog validator.
                    _vin_col = _real_vin  # '' when synthetic or missing

                    # ── 16-column Meta Automotive Catalog row ─────────────
                    lines.append(','.join([
                        _q(_vid),           # vehicle_id      — VIN -> stock# -> row id
                        _q(_title),         # title           — Year Make Model Trim
                        _q(_desc),          # description     — Color · Mi · State · Trim
                        _q('in stock'),     # availability    — always "in stock"
                        _q(_state_v),       # state_of_vehicle — "NEW" or "USED"
                        _q(_price_str),     # price           — "[N] USD"
                        _q(_link),          # link            — VDP -> SRP -> root domain
                        _q(_img),           # image           — photo or placeholder
                        _q(_make),          # brand           — vehicle make
                        _q(_make),          # make            — vehicle make
                        _q(_model),         # model           — required; falls back to make
                        _q(_year),          # year            — 4-digit or blank
                        _q(_vin_col),       # vin             — real 17-char VIN only (blank for stubs)
                        _q(_bs),            # body_style      — TRUCK/SUV/COUPE/SEDAN/OTHER
                        _q(_mileage_col),   # mileage         — "N miles"
                        _q(_address),       # address         — "City, State, US"
                    ]))

                csv_output = '\n'.join(lines) + '\n'
            else:
                # Unresolved ID or empty inventory: return a structurally
                # valid CSV so Meta's parser never throws a format error.
                csv_output = CATALOG_HEADER + '\n' + CATALOG_MOCK_ROW + '\n'

            # ── Send response ─────────────────────────────────────────────
            _csv_bytes = csv_output.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/csv; charset=utf-8')
            self.send_header('Content-Disposition', 'inline; filename="catalog.csv"')
            self.send_header('Content-Length', str(len(_csv_bytes)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.send_header('Surrogate-Control', 'no-store')
            self.end_headers()
            self.wfile.write(_csv_bytes)
            return

        # ── Public (local preview): dynamic inventory without auth ─────
        # Lets developers verify scrape/seed results via /api/vehicles while
        # running against the on-disk SQLite DB.  Production still requires auth
        # (handled in the protected block below).
        if _IS_LOCAL_PREVIEW and path in (
            "/api/vehicles",
            "/api/inventory",
            "/api/v1/vehicles",
            "/api/v1/inventory",
        ):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _lqs(k, d=''):
                return qs.get(k, [d])[0]

            uid = 0
            try:
                uid = int(_lqs('user_id', '0') or 0)
            except ValueError:
                uid = 0
            bearer = self._get_bearer_token()
            if bearer:
                _lu = UserManager.get_user_by_token(bearer)
                if _lu:
                    uid = int(_lu['id'])
            # Resolve to the same account the Marketplace Hub reads and syncs.
            # Picking "whoever has the most ACTIVE rows" instead would serve a
            # different dealer's inventory here than the Hub shows.
            if not uid:
                uid = _local_settings_user_id() or 0
            if not uid:
                try:
                    _lc = sqlite3.connect(DB_FILE)
                    row = _lc.execute(
                        "SELECT user_id, COUNT(1) AS c FROM marketplace_inventory "
                        "WHERE status='ACTIVE' GROUP BY user_id "
                        "ORDER BY c DESC LIMIT 1"
                    ).fetchone()
                    _lc.close()
                    if row:
                        uid = int(row[0])
                except Exception:
                    uid = 0
            if not uid:
                self._json({
                    'vehicles': [], 'inventory': [], 'counts': {'ACTIVE': 0},
                    'active': 0, 'source': 'marketplace_inventory',
                    'message': 'No inventory rows found — run seed_inventory.py',
                })
                return
            status = _lqs('status', 'ACTIVE')
            inv = MarketplaceDB.get_inventory(uid, status=status, search=_lqs('search'))
            counts = MarketplaceDB.count(uid)
            self._json({
                'vehicles':  inv,
                'inventory': inv,
                'counts':    counts,
                'active':    counts.get('ACTIVE', 0),
                'user_id':   uid,
                'last_sync': MarketplaceDB.get_last_sync(uid),
                'source':    'marketplace_inventory',
            })
            return

        # ── Public: verify Stripe video-unlock checkout session ───────
        if path == "/api/v1/billing/verify-video-session":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            session_id = qs.get("session_id", [""])[0].strip()
            if not session_id:
                self._json({"error": "session_id is required"}, 400)
                return
            paid = BillingManager.verify_video_session(session_id)
            self._json({"paid": paid})
            return

        # ── Auth: current user ────────────────────────────────────────
        if path == "/api/auth/me":
            user = self._require_auth()
            if user:
                _role = (user.get("role") or user.get("rbac_role") or "").strip() or (
                    "Admin" if user.get("is_master_admin") or user.get("is_admin")
                    else "Reviewer"
                )
                _phone = ""
                try:
                    _pc = sqlite3.connect(DB_FILE)
                    _pc.row_factory = sqlite3.Row
                    _pr = _pc.execute(
                        "SELECT phone FROM users WHERE id = ?", (user["id"],)
                    ).fetchone()
                    _pc.close()
                    if _pr:
                        _phone = _pr["phone"] or ""
                except Exception:
                    pass
                self._json({
                    "id":                  user["id"],
                    "username":            user["username"],
                    "email":               user.get("email", ""),
                    "phone":               _phone,
                    "salesperson_id":      user.get("salesperson_id", ""),
                    "is_admin":            bool(user.get("is_admin", False)),
                    "is_master_admin":     bool(user.get("is_master_admin", False)),
                    "role":                _role,
                    "rbac_role":           _role,
                    "subscription_status": user.get("subscription_status", "inactive"),
                    "subscription_tier":   user.get("subscription_tier", ""),
                    "org_role":            user.get("org_role", ""),
                    "organization_id":     user.get("organization_id"),
                    # Admins are always treated as verified — belt-and-suspenders
                    # alongside the frontend isEmailVerified = is_admin || email_verified.
                    "email_verified":      bool(
                        user.get("email_verified", False) or user.get("is_admin", False)
                    ),
                    "is_suspended":        bool(user.get("is_suspended", False)),
                    "created_at":          user.get("created_at", ""),
                    "recovery_id":         user.get("recovery_id", ""),
                    "mock_role":           user.get("mock_role", ""),
                    "tiktok_connected":        bool(user.get("tiktok_open_id")),
                    "tiktok_token_expires_at": user.get("tiktok_token_expires_at", ""),
                    "tiktok_privacy_level":    user.get("tiktok_privacy_level", "SELF_ONLY"),
                })
            return

        # ── Profile: current user (GET) ───────────────────────────────
        if path == "/api/users/me":
            user = self._require_auth()
            if not user:
                return
            _role = (user.get("role") or user.get("rbac_role") or "").strip() or (
                "Admin" if user.get("is_master_admin") or user.get("is_admin")
                else "Reviewer"
            )
            _phone = ""
            try:
                _pc = sqlite3.connect(DB_FILE)
                _pc.row_factory = sqlite3.Row
                _pr = _pc.execute(
                    "SELECT phone FROM users WHERE id = ?", (user["id"],)
                ).fetchone()
                _pc.close()
                if _pr:
                    _phone = _pr["phone"] or ""
            except Exception:
                pass
            self._json({
                "success": True,
                "user": {
                    "id":                  user["id"],
                    "username":            user["username"],
                    "email":               user.get("email", ""),
                    "phone":               _phone,
                    "is_admin":            bool(user.get("is_admin", False)),
                    "is_master_admin":     bool(user.get("is_master_admin", False)),
                    "role":                _role,
                    "rbac_role":           _role,
                    "subscription_status": user.get("subscription_status", "inactive"),
                    "subscription_tier":   user.get("subscription_tier", ""),
                    "org_role":            user.get("org_role", ""),
                    "organization_id":     user.get("organization_id"),
                    "email_verified":      bool(
                        user.get("email_verified", False) or user.get("is_admin", False)
                    ),
                    "is_suspended":        bool(user.get("is_suspended", False)),
                    "created_at":          user.get("created_at", ""),
                    "recovery_id":         user.get("recovery_id", ""),
                },
                "phone": _phone,
            })
            return

        # ── Auth: verify email via one-time token (public — no session needed) ──
        # ── Security: Emergency email-change revocation (public — no auth needed) ──
        # URL: /api/security/revert-email?token=<emailRevertToken>
        # Reverts the user's email to their previous address, terminates all
        # active sessions, and redirects to /reset-password with a fresh token.
        if path == "/api/security/revert-email":
            _rr_qs    = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _rr_tok   = _rr_qs.get("token", [""])[0].strip()
            _app_url  = APP_BASE_URL

            def _revert_redirect(dest: str):
                self.send_response(302)
                self.send_header("Location", dest)
                self.send_header("Content-Length", "0")
                self.end_headers()

            if not _rr_tok:
                _revert_redirect(f"{_app_url}/reset-password?revert_error=1")
                return

            _rr_conn = sqlite3.connect(DB_FILE)
            _rr_conn.row_factory = sqlite3.Row
            _rr_row  = _rr_conn.execute(
                "SELECT id, email, old_email_history, email_revert_expires_at "
                "FROM users WHERE email_revert_token = ?",
                (_rr_tok,),
            ).fetchone()

            if not _rr_row:
                _rr_conn.close()
                _revert_redirect(f"{_app_url}/reset-password?revert_error=1")
                return

            # Check expiry
            try:
                if datetime.now() > datetime.fromisoformat(_rr_row["email_revert_expires_at"] or ""):
                    _rr_conn.close()
                    _revert_redirect(f"{_app_url}/reset-password?revert_error=expired")
                    return
            except (TypeError, ValueError):
                pass  # malformed timestamp — allow the revert to continue

            _target_id = _rr_row["id"]
            _old_email = (_rr_row["old_email_history"] or "").strip()

            try:
                # Revert email, clear revert columns, mark unverified
                _rr_conn.execute(
                    """UPDATE users
                       SET email = ?, old_email_history = '', email_revert_token = NULL,
                           email_revert_expires_at = NULL, email_verified = 0
                       WHERE id = ?""",
                    (_old_email, _target_id),
                )

                # Terminate all active sessions for this user
                _dead_tokens = [t for t, uid in _ACTIVE_SESSIONS.items() if uid == _target_id]
                for _dt in _dead_tokens:
                    del _ACTIVE_SESSIONS[_dt]
                _rr_conn.execute("DELETE FROM user_sessions WHERE user_id = ?", (_target_id,))

                # Issue a fresh password-reset token (1-hour window)
                _pr_token   = secrets.token_urlsafe(32)
                _pr_expires = (datetime.now() + timedelta(hours=1)).isoformat()
                _rr_conn.execute(
                    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
                    (_target_id, _pr_token, _pr_expires),
                )
                _rr_conn.commit()
            except Exception:
                try:
                    _rr_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _rr_conn.close()

            print(f"[SECURITY] Email revert completed — user id={_target_id}, restored to {_old_email!r}")
            _revert_redirect(f"{_app_url}/reset-password?token={_pr_token}&reverted=1")
            return

        if path == "/api/auth/verify-email":
            _qs    = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _vtok  = _qs.get("token", [""])[0].strip()
            if not _vtok:
                self._json({"error": "Verification token is missing."}, 400)
                return
            try:
                _ve_conn   = sqlite3.connect(DB_FILE)
                _ve_conn.row_factory = sqlite3.Row
                _ve_cursor = _ve_conn.cursor()
                _ve_cursor.execute(
                    "SELECT id, email_verified FROM users WHERE verification_token = ?",
                    (_vtok,),
                )
                _ve_row = _ve_cursor.fetchone()
                if not _ve_row:
                    _ve_conn.close()
                    self._json({"error": "Invalid or expired verification link."}, 400)
                    return
                if _ve_row["email_verified"]:
                    _ve_conn.close()
                    self._json({"status": "ok", "message": "Email already verified."})
                    return
                try:
                    _ve_cursor.execute(
                        "UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?",
                        (_ve_row["id"],),
                    )
                    _ve_conn.commit()
                except Exception:
                    try:
                        _ve_conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    _ve_conn.close()
                self._json({"status": "ok", "message": "Email successfully verified!"})
            except Exception as _ve_err:
                print(f"[AUTH] verify-email error: {_ve_err}")
                self._json({"error": "Verification failed due to a server error."}, 500)
            return

        if path == "/api/v1/trial-quota":
            _tq_user = self._require_auth()
            if not _tq_user:
                return
            today   = datetime.now().strftime('%Y-%m-%d')
            ai_key  = f"{_tq_user['id']}:ai_post:{today}"
            wl_key  = f"{_tq_user['id']}:wishlist_entry:{today}"
            is_pro  = bool(_tq_user.get('is_admin') or _tq_user.get('subscription_status') == 'active')

            # Compute trial day from created_at stored in user dict
            created_raw  = _tq_user.get('created_at', '') or ''
            try:
                created_date = datetime.strptime(created_raw[:10], '%Y-%m-%d')
                days_elapsed = (datetime.now() - created_date).days
            except Exception:
                days_elapsed = 0
            is_expired = not is_pro and days_elapsed >= TRIAL_MAX_DAYS
            trial_day  = min(days_elapsed + 1, TRIAL_MAX_DAYS)

            ai_used = _TRIAL_QUOTA.get(ai_key, 0)
            wl_used = _TRIAL_QUOTA.get(wl_key, 0)
            self._json({
                'is_pro':           is_pro,
                'is_trial_expired': is_expired,
                'trial_day':        trial_day,
                'trial_max_days':   TRIAL_MAX_DAYS,
                'daily_limit':      TRIAL_DAILY_LIMIT,
                'days_remaining':   max(0, TRIAL_MAX_DAYS - days_elapsed),
                'ai_post': {
                    'used':      ai_used,
                    'remaining': -1 if is_pro else max(0, TRIAL_DAILY_LIMIT - ai_used),
                },
                'wishlist_entry': {
                    'used':      wl_used,
                    'remaining': -1 if is_pro else max(0, TRIAL_DAILY_LIMIT - wl_used),
                },
            })
            return

        # ── Admin: user list (master admin only) ─────────────────────
        if path == "/api/admin/users":
            _adm = self._require_master_admin()
            if not _adm:
                return
            _adm_conn = sqlite3.connect(DB_FILE)
            _adm_conn.row_factory = sqlite3.Row
            _rows = _adm_conn.execute(
                "SELECT u.id, u.username, u.dealer_name AS full_name, u.email, "
                "u.subscription_status, u.subscription_tier, u.is_admin, "
                "u.is_suspended, u.email_verified, u.created_at, u.recovery_id, "
                "u.organization_id, u.org_role, u.role, "
                "o.name AS org_name, o.seat_limit AS org_max_seats "
                "FROM users u "
                "LEFT JOIN organizations o ON o.id = u.organization_id "
                "ORDER BY u.created_at DESC"
            ).fetchall()
            _adm_conn.close()
            self._json({
                "users": [
                    {
                        "id":                  r["id"],
                        "username":            r["username"],
                        "full_name":           r["full_name"] or "",
                        "email":               r["email"] or "",
                        "subscription_status": r["subscription_status"] or "inactive",
                        "subscription_tier":   r["subscription_tier"] or "",
                        "is_admin":            bool(r["is_admin"]),
                        "is_suspended":        bool(r["is_suspended"]),
                        "email_verified":      bool(r["email_verified"]),
                        "created_at":          r["created_at"] or "",
                        "recovery_id":         r["recovery_id"] or "",
                        "org_id":              r["organization_id"],
                        "org_role":            r["org_role"] or "",
                        "org_name":            r["org_name"] or "",
                        "org_max_seats":       r["org_max_seats"] or 10,
                        "role":                (r["role"] or "").strip() or (
                            "Admin" if r["is_admin"] else "Reviewer"
                        ),
                    }
                    for r in _rows
                ]
            })
            return

        # ── Admin: TikTok credential status (master admin only) ──────────────────
        if path == "/api/admin/tiktok-config":
            adm = self._require_master_admin()
            if not adm:
                return
            ck, _ = _tiktok_creds()
            # Determine source: DB entry wins over env var
            _src = "env"
            try:
                _ac = sqlite3.connect(DB_FILE)
                _ac.row_factory = sqlite3.Row
                _db_row = _ac.execute(
                    "SELECT value FROM system_settings WHERE key='tiktok_client_key'"
                ).fetchone()
                _ac.close()
                if _db_row and str(_db_row['value']).strip():
                    _src = "database"
            except Exception:
                pass
            self._json({
                "configured": bool(ck),
                "key_hint":   (ck[:4] + "…" + ck[-4:]) if len(ck) > 8 else ("***" if ck else ""),
                "source":     _src,
            })
            return

        # ── TikTok: config-status — public; tells the UI whether credentials exist ──
        if path == "/api/tiktok/config-status":
            _ck_cs, _cs_cs = _tiktok_creds()
            _missing = [k for k, v in [
                ("TIKTOK_CLIENT_KEY",    _ck_cs),
                ("TIKTOK_CLIENT_SECRET", _cs_cs),
            ] if not v]
            self._json({
                "configured": len(_missing) == 0,
                "missing":    _missing,
            })
            return

        # ── TikTok: OAuth callback — public; auth via HMAC-signed state token ──
        # Also handles webhook / domain-verification GET challenges from TikTok.
        if path in ("/api/tiktok/callback",       "/api/tiktok/oauth/callback",
                    "/api/tiktok/callback/",      "/api/tiktok/oauth/callback/"):
            # Accept trailing-slash variants and both the registered production
            # path (/api/tiktok/callback) and the legacy path so in-flight OAuth
            # flows survive deployments that rename the endpoint.
            _app_url2    = _tiktok_base_url(self.headers.get("Host", ""))
            _cb_redirect = _app_url2 + "/api/tiktok/callback"

            def _cb_fail(reason: str) -> None:
                self.send_response(302)
                self.send_header("Location", f"{_app_url2}/tiktok?tiktok=error&reason={reason}")
                self.send_header("Content-Length", "0")
                self.end_headers()

            _qs2 = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            # ── Webhook / developer-portal verification handshake ────────────
            # TikTok sends a GET with one of these params when verifying that
            # the callback URL is owned by the developer.  Echo the value back
            # as plain text with 200 — no OAuth logic should run for these.
            _verif = (
                _qs2.get("challenge",                            [""])[0]
                or _qs2.get("tiktok-developers-site-verification", [""])[0]
                or _qs2.get("echostr",                           [""])[0]
            )
            if _verif:
                _vb = _verif.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type",   "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(_vb)))
                self.end_headers()
                self.wfile.write(_vb)
                return

            # ── Standard OAuth code-exchange flow ────────────────────────────
            _code   = _qs2.get("code",  [""])[0]
            _state2 = _qs2.get("state", [""])[0]
            _err2   = _qs2.get("error", [""])[0]

            if _err2 or not _code or not _state2:
                _cb_fail("access_denied")
                return

            # Verify the HMAC-signed state and extract user_id.
            # No in-memory dict means this survives server restarts and
            # handles concurrent OAuth flows from every tenant at once.
            _cb_user_id = _tiktok_verify_state(_state2)
            if not _cb_user_id:
                _cb_fail("state_mismatch")
                return

            _ck_cb, _cs_cb = _tiktok_creds()
            _tok_payload = urllib.parse.urlencode({
                "client_key":    _ck_cb,
                "client_secret": _cs_cb,
                "code":          _code,
                "grant_type":    "authorization_code",
                "redirect_uri":  _cb_redirect,
            }).encode("utf-8")
            _tok_req = urllib.request.Request(
                TIKTOK_TOKEN_URL,
                data=_tok_payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(_tok_req, timeout=15) as _tokr:
                    _tokd = json.loads(_tokr.read().decode("utf-8"))
            except Exception as _toke:
                print(f"[TikTok] Token exchange error: {_toke}")
                _cb_fail("token_exchange")
                return

            _access  = _tokd.get("access_token", "")
            _refresh = _tokd.get("refresh_token", "")
            _open_id = _tokd.get("open_id", "")
            _exp_in  = int(_tokd.get("expires_in", 86400))
            _exp_at  = (datetime.utcnow() + timedelta(seconds=_exp_in)).isoformat()

            if not _access or not _open_id:
                _cb_fail("no_token")
                return

            # Store tokens isolated to this specific user — multi-tenant safe.
            _tdb = sqlite3.connect(DB_FILE)
            try:
                _tdb.execute(
                    "UPDATE users SET tiktok_access_token=?, tiktok_refresh_token=?, "
                    "tiktok_open_id=?, tiktok_token_expires_at=? WHERE id=?",
                    (_access, _refresh, _open_id, _exp_at, _cb_user_id),
                )
                _tdb.commit()
            except Exception:
                try:
                    _tdb.rollback()
                except Exception:
                    pass
                raise
            finally:
                _tdb.close()
            print(f"[TikTok] Connected user_id={_cb_user_id} open_id={_open_id!r}")

            # Redirect to the TikTok Hub (not /settings) so the frontend
            # useSearch() hook on the /tiktok page fires the success handler.
            self.send_response(302)
            self.send_header("Location", f"{_app_url2}/tiktok?tiktok=connected")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # ── Lead Center board (public/local) ──────────────────────────
        # Sits ABOVE the auth gate so the Lead Center loads without a session
        # token. Leads are dealership-wide operational data, not per-user.
        if path in ("/api/leads", "/api/v1/leads"):
            try:
                from leads_engine import get_leads as _get_leads
            except ImportError:
                self._json({"error": "leads_engine not available."}, 500)
                return
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _status   = (qs.get("status", [None])[0]) or None
            _source   = (qs.get("source", [None])[0]) or None
            _sla_only = (qs.get("sla_only", ["0"])[0]).lower() in ("1", "true", "yes")
            try:
                leads = _get_leads(
                    status=_status, source=_source,
                    sla_only=_sla_only, db_path=DB_FILE,
                )
                self._json({"leads": leads, "total": len(leads)})
            except Exception as exc:
                print(f"[LEADS] list error: {exc}")
                self._json({"error": "Failed to load leads."}, 500)
            return

        # ── Marketplace publisher queue (public/local) ────────────────
        if path in ("/api/marketplace/queue", "/api/v1/marketplace/publisher-queue"):
            try:
                from marketplace_engine import get_queue as _get_queue
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _mq_status = (qs.get("status", [None])[0]) or None
            try:
                _mq = _get_queue(status=_mq_status, db_path=DB_FILE)
                if isinstance(_mq, dict):
                    _mq.setdefault("success", True)
                    # Alias for clients that expect a top-level `queue` array.
                    if "queue" not in _mq and "items" in _mq:
                        _mq["queue"] = _mq["items"]
                self._json(_mq)
            except ValueError as exc:
                self._json({"success": False, "error": str(exc), "items": [], "queue": []}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] queue error: {exc}")
                self._json({
                    "success": False,
                    "error": "Failed to load marketplace queue.",
                    "items": [],
                    "queue": [],
                    "total": 0,
                    "counts": {"scheduled": 0, "posted": 0, "failed": 0, "paused": 0},
                }, 500)
            return

        # ── Scrape / sync progress (public/local, no token) ────────────
        if path in ("/api/sync/status", "/api/scrape/status",
                    "/api/v1/sync/status", "/api/v1/scrape/status"):
            _ss_uid = _local_settings_user_id(self._get_bearer_token())
            if not _ss_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return
            _ss_job = _SYNC_JOBS.get(_ss_uid, {})
            _ss_counts = MarketplaceDB.count(_ss_uid)
            _ss_session = _ss_job.get("session_id") or ""
            _ss_cancel = _ss_job.get("cancel_status") or ""
            if _scraper_engine is not None:
                _snap = (
                    _scraper_engine.session_snapshot(_ss_session)
                    if _ss_session
                    else _scraper_engine.active_session_for_user(_ss_uid)
                )
                if _snap:
                    _ss_session = _snap["session_id"]
                    _ss_cancel = _snap["status"]
                    if _snap["status"] == "cancelling" and _ss_job.get("syncing"):
                        _ss_job["phase"] = "cancelling"
            self._json({
                "syncing":       _ss_job.get("syncing", False),
                "phase":         _ss_job.get("phase", "idle"),
                "synced":        _ss_job.get("synced", 0),
                "total":         _ss_job.get("total", 0),
                "enriched":      _ss_job.get("enriched", 0),
                "done":          _ss_job.get("done", True),
                "error":         _ss_job.get("error", ""),
                "reason":        _ss_job.get("reason", ""),
                "last_sync":     MarketplaceDB.get_last_sync(_ss_uid),
                "vehicle_count": _ss_counts.get("ACTIVE", 0),
                "user_id":       _ss_uid,
                "session_id":    _ss_session,
                "cancel_status": _ss_cancel,
            })
            return

        # ── Cancel an in-flight inventory sync (public/local, no token) ─
        if path in ("/api/scrape/cancel", "/api/sync/cancel",
                    "/api/v1/scrape/cancel", "/api/v1/sync/cancel"):
            # Handled on POST below; GET returns a short usage hint.
            self._json({
                "error": "Use POST with session_id (or rely on active user context).",
            }, 405)
            return

        # ── Inventory list (public/local, no token) ────────────────────
        # Same payload/filters as /api/v1/marketplace so the Hub can reload
        # freshly scraped vehicles without a session token.
        if path == "/api/marketplace/inventory":
            _mi_uid = _local_settings_user_id(self._get_bearer_token())
            if not _mi_uid:
                self._json({
                    "success": True,
                    "inventory": [], "makes": [], "models": [], "years": [], "locations": [],
                    "counts": {"ACTIVE": 0, "SOLD": 0, "total": 0, "posted": 0},
                    "last_sync": "",
                })
                return
            _mi_qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _miq(k, d=''):
                return _mi_qs.get(k, [d])[0]

            def _mii(k):
                try:
                    return int(_miq(k, '0') or 0)
                except ValueError:
                    return 0

            self._json({
                "success": True,
                "inventory": MarketplaceDB.get_inventory(
                    _mi_uid,
                    condition=_miq('condition'),
                    make=_miq('make'),
                    model=_miq('model'),
                    min_price=_mii('min_price'),
                    max_price=_mii('max_price'),
                    min_year=_mii('min_year'),
                    max_year=_mii('max_year'),
                    status=_miq('status'),
                    search=_miq('search'),
                    posted_status=_miq('posted_status'),
                    location=_miq('location'),
                    enabled_locations=LocationDB.get_enabled_locations(_mi_uid),
                ),
                "makes": MarketplaceDB.get_makes(
                    _mi_uid,
                    location=_miq('location'),
                    condition=_miq('condition'),
                ),
                "models": MarketplaceDB.get_models(
                    _mi_uid,
                    make=_miq('make'),
                    location=_miq('location'),
                    condition=_miq('condition'),
                ),
                "years":     MarketplaceDB.get_years(_mi_uid),
                "locations": MarketplaceDB.get_distinct_locations(_mi_uid),
                "counts":    MarketplaceDB.count(_mi_uid),
                "last_sync": MarketplaceDB.get_last_sync(_mi_uid),
                "user_id":   _mi_uid,
            })
            return

        # ── Marketplace scraper/Meta settings (public/local, no token) ─
        if path == "/api/marketplace/settings":
            _ms_uid = _local_settings_user_id(self._get_bearer_token())
            if not _ms_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return
            _ms_conn = sqlite3.connect(DB_FILE)
            _ms_conn.row_factory = sqlite3.Row
            try:
                _ms_row = _ms_conn.execute(
                    """SELECT inventory_url_used, inventory_url_new, inventory_locations,
                              salesperson_filter, scraper_frequency, dealer_name,
                              facebook_business_manager_id, commerce_catalog_id,
                              meta_pixel_id
                       FROM users WHERE id = ?""",
                    (_ms_uid,),
                ).fetchone()
            finally:
                _ms_conn.close()
            _ms = dict(_ms_row) if _ms_row else {}
            if _scraper_engine is not None:
                _ms["inventory_locations"] = _scraper_engine.normalize_inventory_locations(
                    _ms.get("inventory_locations")
                )
            elif _ms.get("inventory_locations"):
                try:
                    _raw = _ms["inventory_locations"]
                    _ms["inventory_locations"] = (
                        json.loads(_raw) if isinstance(_raw, str) else (_raw or [])
                    )
                except Exception:
                    _ms["inventory_locations"] = []
            # Merge permanent dealer_config.json so refresh never blanks the form.
            if _dealer_config is not None:
                _ms = _dealer_config.merge_settings_with_disk(_ms)
            _ms_locs = _ms.get("inventory_locations") or []
            if _scraper_engine is not None:
                _ms_locs = _scraper_engine.normalize_inventory_locations(_ms_locs)
            # Legacy single-URL accounts: synthesize one location row for the UI.
            if not _ms_locs and (_ms.get("inventory_url_used") or _ms.get("inventory_url_new")):
                _ms_locs = [{
                    "location_name": (_ms.get("dealer_name") or "Main Lot").strip() or "Main Lot",
                    "inventory_url_new": _ms.get("inventory_url_new") or "",
                    "inventory_url_used": _ms.get("inventory_url_used") or "",
                    "csv_enabled": False,
                    "csv_url": "",
                }]
            self._json({
                "inventory_url_used":           _ms.get("inventory_url_used") or "",
                "inventory_url_new":            _ms.get("inventory_url_new") or "",
                "inventory_locations":          _ms_locs,
                "salesperson_filter":           _ms.get("salesperson_filter") or "",
                "scraper_frequency":            _ms.get("scraper_frequency") or "daily",
                "dealer_name":                  _ms.get("dealer_name") or "",
                "facebook_business_manager_id": _ms.get("facebook_business_manager_id") or "",
                "commerce_catalog_id":          _ms.get("commerce_catalog_id") or "",
                "meta_pixel_id":                _ms.get("meta_pixel_id") or "",
                "user_id":                      _ms_uid,
                "config_file":                  (
                    _dealer_config.config_path() if _dealer_config is not None else ""
                ),
            })
            return

        # ── Protected: require valid session ──────────────────────────
        user = self._require_auth()
        if not user:
            return

        if path == "/api/v1/appointments":
            appts = DBSessionManager.get_all_appointments()
            self._json({"appointments": appts})

        elif path == "/api/v1/sessions":
            sessions = DBSessionManager.get_all_sessions()
            self._json({"sessions": sessions})

        elif path == "/api/v1/analytics":
            analytics = DBSessionManager.get_desk_analytics(user_id=user['id'])
            self._json(analytics)

        elif path in (
            "/api/vehicles",
            "/api/inventory",
            "/api/v1/vehicles",
            "/api/v1/inventory",
        ):
            # Dynamic inventory from marketplace_inventory (ACTIVE by default).
            # Powers dashboard KPIs: Active Scrape Count + Live Scraped Showroom.
            uid = user['id']
            qs  = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _qs(k, d=''):
                return qs.get(k, [d])[0]

            status = _qs('status', 'ACTIVE')
            inv = MarketplaceDB.get_inventory(
                uid,
                condition=_qs('condition'),
                make=_qs('make'),
                min_price=int(_qs('min_price', '0') or 0),
                max_price=int(_qs('max_price', '0') or 0),
                status=status,
                search=_qs('search'),
                location=_qs('location'),
            )
            counts = MarketplaceDB.count(uid)
            self._json({
                'vehicles':  inv,
                'inventory': inv,
                'counts':    counts,
                'active':    counts.get('ACTIVE', 0),
                'last_sync': MarketplaceDB.get_last_sync(uid),
                'source':    'marketplace_inventory',
            })

        elif path == "/api/v1/billing/status":
            self._json(BillingManager.get_status(user["id"]))

        elif path == "/api/v1/marketplace/sync-status":
            # Read-only status — accessible to trial users so the page renders correctly
            uid = user['id']
            job = _SYNC_JOBS.get(uid, {})
            self._json({
                'syncing':  job.get('syncing', False),
                'phase':    job.get('phase', 'idle'),
                'synced':   job.get('synced', 0),
                'total':    job.get('total', 0),
                'enriched': job.get('enriched', 0),
                'done':     job.get('done', True),
                'error':    job.get('error', ''),
                'reason':   job.get('reason', ''),
            })

        elif path == "/api/v1/marketplace":
            # Read-only inventory list — accessible to trial users so the page loads
            uid = user['id']
            qs  = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            def _qs(k, d=''):
                return qs.get(k, [d])[0]
            mkt_locs = LocationDB.get_enabled_locations(uid)
            self._json({
                'inventory': MarketplaceDB.get_inventory(
                    uid,
                    condition=_qs('condition'),
                    make=_qs('make'),
                    model=_qs('model'),
                    min_price=int(_qs('min_price', '0') or 0),
                    max_price=int(_qs('max_price', '0') or 0),
                    min_year=int(_qs('min_year', '0') or 0),
                    max_year=int(_qs('max_year', '0') or 0),
                    status=_qs('status'),
                    search=_qs('search'),
                    posted_status=_qs('posted_status'),
                    location=_qs('location'),
                    enabled_locations=mkt_locs,
                ),
                'makes': MarketplaceDB.get_makes(
                    uid,
                    location=_qs('location'),
                    condition=_qs('condition'),
                ),
                'models': MarketplaceDB.get_models(
                    uid,
                    make=_qs('make'),
                    location=_qs('location'),
                    condition=_qs('condition'),
                ),
                'years':     MarketplaceDB.get_years(uid),
                'locations': MarketplaceDB.get_distinct_locations(uid),
                'counts':    MarketplaceDB.count(uid),
                'last_sync': MarketplaceDB.get_last_sync(uid),
            })

        elif path == "/api/v1/marketplace/queue":
            if not self._require_subscription(user):
                return
            uid  = user['id']
            date = urllib.parse.parse_qs(
                urllib.parse.urlparse(self.path).query
            ).get('date', [datetime.now().strftime('%Y-%m-%d')])[0]
            self._json({
                'queue': PostingQueueManager.get_queue(uid, date),
                'stats': PostingQueueManager.queue_stats(uid, date),
            })

        elif path == "/api/v1/settings":
            token = self._get_bearer_token()
            settings = UserManager.get_settings(token)

            def _mask(s: str) -> str:
                if not s:
                    return ""
                return ("*" * (len(s) - 4) + s[-4:]) if len(s) > 4 else "*" * len(s)

            self._json({
                # Account & recovery
                "email":                          settings.get("email", ""),
                "phone":                          settings.get("phone", ""),
                # Facebook / Meta
                "fb_page_id":                     settings.get("fb_page_id", ""),
                "fb_access_token_masked":         _mask(settings.get("fb_access_token", "")),
                # Meta Catalog & Marketplace integration IDs
                "facebook_business_manager_id":   settings.get("facebook_business_manager_id", ""),
                "commerce_catalog_id":            settings.get("commerce_catalog_id", ""),
                "meta_pixel_id":                  settings.get("meta_pixel_id", ""),
                # Catalog
                "catalog_token":                  settings.get("catalog_token", ""),
                # Inventory source
                "inventory_url_used":             settings.get("inventory_url_used", ""),
                "inventory_url_new":              settings.get("inventory_url_new", ""),
                "inventory_locations":            settings.get("inventory_locations") or [],
                "salesperson_filter":             settings.get("salesperson_filter", ""),
                # Scraper schedule
                "scraper_frequency":              settings.get("scraper_frequency", "daily"),
                # Identity
                "user_id":                        settings.get("user_id", 0),
                # CRM (retained for backwards-compat)
                "crm_provider":                   settings.get("crm_provider", "vinsolutions"),
                "salesperson_id":                 settings.get("salesperson_id", ""),
                "auto_send_emails":               bool(settings.get("auto_send_emails", 0)),
                # Dealership return address
                "dealer_name":                    settings.get("dealer_name", ""),
                "dealer_address_line1":           settings.get("dealer_address_line1", ""),
                "dealer_city":                    settings.get("dealer_city", ""),
                "dealer_state":                   settings.get("dealer_state", ""),
                "dealer_zip":                     settings.get("dealer_zip", ""),
                # Dealership contact & branding
                "dealer_phone":                   settings.get("dealer_phone", ""),
                "dealer_support_email":           settings.get("dealer_support_email", ""),
                "dealer_logo_url":                settings.get("dealer_logo_url", ""),
            })

        elif path == "/api/v1/email/queue":
            token = self._get_bearer_token()
            settings = UserManager.get_settings(token)
            queue = EmailQueueManager.get_queue(user["id"])
            self._json({
                "queue": queue,
                "auto_send_emails": bool(settings.get("auto_send_emails", 0)),
            })

        elif path == "/api/v1/locations":
            # ── Auto-discover locations from live inventory ───────────────────
            # The user_locations table is normally populated during scrapes, but
            # if a scrape ran before this user existed, or the scraper path was
            # bypassed, rows can be missing.  Always reconcile against the real
            # marketplace_inventory so Settings reflects truth instantly — no
            # extra sync needed.  discover_locations() uses INSERT OR IGNORE so
            # any existing enabled/disabled choices are never overwritten.
            _loc_uid = user['id']
            try:
                _loc_conn = sqlite3.connect(DB_FILE)
                _loc_conn.row_factory = sqlite3.Row
                _live_rows = _loc_conn.execute(
                    "SELECT DISTINCT location FROM marketplace_inventory "
                    "WHERE user_id=? AND location IS NOT NULL "
                    "  AND location != '' AND status='ACTIVE'",
                    (_loc_uid,),
                ).fetchall()
                _loc_conn.close()
                _live_locs = {r['location'] for r in _live_rows}
                if _live_locs:
                    LocationDB.discover_locations(_loc_uid, _live_locs)
            except Exception as _le:
                print(f"[LOCATIONS] auto-discover warning: {_le}")
            self._json({
                'locations': LocationDB.get_locations(_loc_uid)
            })

        elif path == "/api/v1/customers":
            self._json({'customers': CustomerManager.list_customers(user['id'])})

        elif path == "/api/v1/dealer-settings":
            s = UserManager.get_settings(self._get_bearer_token())
            self._json({
                'dealer_name':          s.get('dealer_name', ''),
                'dealer_address_line1': s.get('dealer_address_line1', ''),
                'dealer_city':          s.get('dealer_city', ''),
                'dealer_state':         s.get('dealer_state', ''),
                'dealer_zip':           s.get('dealer_zip', ''),
                'dealer_phone':         s.get('dealer_phone', ''),
                'dealer_support_email': s.get('dealer_support_email', ''),
                'dealer_logo_url':      s.get('dealer_logo_url', ''),
                'username':             user.get('username', ''),
            })

        elif path == "/api/v1/forms/draft":
            _fd = sqlite3.connect(DB_FILE)
            _fd.row_factory = sqlite3.Row
            _row = _fd.execute(
                "SELECT buyer_name, vin, stock_number, price, mileage, "
                "active_form, notes, updated_at FROM forms_drafts WHERE user_id = ?",
                (user['id'],),
            ).fetchone()
            _fd.close()
            if not _row:
                self._json({
                    'buyer_name': '', 'vin': '', 'stock_number': '',
                    'price': '', 'mileage': '', 'active_form': 'test_drive',
                    'notes': '', 'updated_at': None,
                })
            else:
                self._json(dict(_row))

        elif path == "/api/v1/wishlist":
            # ── List all wishlist entries + compute inventory matches ─────
            _conn = sqlite3.connect(DB_FILE)
            _conn.row_factory = sqlite3.Row
            _entries = _conn.execute(
                "SELECT * FROM wishlist WHERE user_id = ? AND status = 'Active'"
                " ORDER BY created_at DESC",
                (user['id'],)
            ).fetchall()

            def _wishlist_matches(entry_dict):
                """Return matching ACTIVE inventory for 1-3 vehicle choices; deduped by id."""
                seen_ids   = set()
                all_matches = []

                def _run_choice(sfx):
                    # For choices 2 & 3 skip if no meaningful criteria are set
                    if sfx:
                        has = (
                            str(entry_dict.get(f'make{sfx}',     '') or '').strip()
                            or str(entry_dict.get(f'model{sfx}',   '') or '').strip()
                            or str(entry_dict.get(f'keyword{sfx}', '') or '').strip()
                            or int(entry_dict.get(f'year_min{sfx}', 0) or 0) > 0
                            or int(entry_dict.get(f'year_max{sfx}', 0) or 0) > 0
                        )
                        if not has:
                            return
                    clauses = ["status = 'ACTIVE'", "user_id = ?"]
                    params  = [user['id']]
                    cond = str(entry_dict.get(f'condition{sfx}', 'Any') or 'Any').strip()
                    if cond and cond != 'Any':
                        clauses.append("LOWER(condition) = LOWER(?)")
                        params.append(cond)
                    make = str(entry_dict.get(f'make{sfx}', '') or '').strip()
                    if make:
                        clauses.append("LOWER(make) LIKE LOWER(?)")
                        params.append(f'%{make}%')
                    model = str(entry_dict.get(f'model{sfx}', '') or '').strip()
                    if model:
                        clauses.append("LOWER(model) LIKE LOWER(?)")
                        params.append(f'%{model}%')
                    keyword = str(entry_dict.get(f'keyword{sfx}', '') or '').strip()
                    if keyword:
                        kw = f'%{keyword}%'
                        clauses.append(
                            "(LOWER(make) LIKE LOWER(?) OR LOWER(model) LIKE LOWER(?)"
                            " OR LOWER(trim) LIKE LOWER(?) OR LOWER(stock_number) LIKE LOWER(?))"
                        )
                        params += [kw, kw, kw, kw]
                    year_min = int(entry_dict.get(f'year_min{sfx}', 0) or 0)
                    if year_min > 0:
                        clauses.append("year >= ?")
                        params.append(year_min)
                    year_max = int(entry_dict.get(f'year_max{sfx}', 0) or 0)
                    if year_max > 0:
                        clauses.append("year <= ?")
                        params.append(year_max)
                    max_mileage = int(entry_dict.get(f'max_mileage{sfx}', 0) or 0)
                    if max_mileage > 0:
                        clauses.append("(mileage <= ? OR mileage = 0)")
                        params.append(max_mileage)
                    max_budget = int(entry_dict.get(f'max_budget{sfx}', 0) or 0)
                    if max_budget > 0:
                        clauses.append("(price <= ? OR price = 0)")
                        params.append(max_budget)
                    where = ' AND '.join(clauses)
                    rows = _conn.execute(
                        "SELECT id, vin, stock_number, condition, year, make, model, trim,"
                        " mileage, price, exterior_color, image_url, vdp_url"
                        f" FROM marketplace_inventory WHERE {where}"
                        " ORDER BY year DESC, price ASC LIMIT 10",
                        params
                    ).fetchall()
                    for r in rows:
                        d = dict(r)
                        if d['id'] not in seen_ids:
                            seen_ids.add(d['id'])
                            all_matches.append(d)

                _run_choice('')   # Choice 1 — always runs
                _run_choice('2')  # Choice 2 — runs only if criteria set
                _run_choice('3')  # Choice 3 — runs only if criteria set
                return all_matches[:15]

            result_entries = []
            for _e in _entries:
                _d = dict(_e)
                _d['matches'] = _wishlist_matches(_d)
                result_entries.append(_d)
            _conn.close()
            # Entries with matches float to the top
            result_entries.sort(key=lambda x: len(x['matches']), reverse=True)
            self._json({'entries': result_entries})

        elif path == "/api/team":
            # ── Dealership Admin Console — GET team info ──────────────────
            _tu_id      = user["id"]
            _is_master  = bool(user.get("is_admin"))
            _mock_role  = (user.get("mock_role") or "")
            _preview_rp = _is_master and _mock_role == "rooftop_admin"
            _tc = sqlite3.connect(DB_FILE)
            _tc.row_factory = sqlite3.Row
            _tu_row = _tc.execute(
                "SELECT org_role, organization_id FROM users WHERE id = ?", (_tu_id,)
            ).fetchone()

            _app_url = APP_BASE_URL

            if _is_master and not _preview_rp:
                # Default master-admin global overview (no role preview).
                # Returns a structured `accounts` list that groups rooftop orgs
                # with their sub-accounts for the hierarchical UI, plus a flat
                # `members` list for backward-compat with existing code paths.
                _all_users_raw = _tc.execute(
                    "SELECT id, username, dealer_name, job_title, email, "
                    "       org_role, organization_id, is_admin, "
                    "       subscription_status, subscription_tier, created_at "
                    "FROM users ORDER BY created_at ASC"
                ).fetchall()
                _all_orgs_raw = _tc.execute(
                    "SELECT id, name, seat_limit FROM organizations"
                ).fetchall()
                _tc.close()

                _orgs_by_id: dict = {o["id"]: dict(o) for o in _all_orgs_raw}

                # Sort users into rooftop admins, members (sub-accounts), and personal
                _rooftop_admins: dict = {}   # org_id -> rooftop entry dict
                _sub_by_org:     dict = {}   # org_id -> list of sub-account dicts
                _personal_accts: list = []

                for _u in _all_users_raw:
                    _u_org_id   = _u["organization_id"]
                    _u_org_role = (_u["org_role"] or "").strip()
                    _u_is_adm   = bool(_u["is_admin"])

                    if _u_org_role == "admin" and _u_org_id:
                        _org_meta = _orgs_by_id.get(_u_org_id, {})
                        _rooftop_admins[_u_org_id] = {
                            "id":           _u["id"],
                            "username":     _u["username"],
                            "full_name":    _u["dealer_name"] or "",
                            "email":        _u["email"] or "",
                            "account_type": "rooftop",
                            "org_id":       _u_org_id,
                            "org_name":     _org_meta.get("name", ""),
                            "seat_limit":   _org_meta.get("seat_limit", 10),
                            "created_at":   str(_u["created_at"] or ""),
                            "sub_accounts": [],
                        }
                    elif _u_org_role == "member" and _u_org_id:
                        _sub_by_org.setdefault(_u_org_id, []).append({
                            "id":                  _u["id"],
                            "username":            _u["username"],
                            "full_name":           _u["dealer_name"] or "",
                            "job_title":           _u["job_title"] or "",
                            "org_role":            "member",
                            "subscription_status": _u["subscription_status"] or "",
                            "subscription_tier":   _u["subscription_tier"] or "",
                            "created_at":          str(_u["created_at"] or ""),
                        })
                    else:
                        _personal_accts.append({
                            "id":              _u["id"],
                            "username":        _u["username"],
                            "full_name":       _u["dealer_name"] or "",
                            "email":           _u["email"] or "",
                            "account_type":    "personal",
                            "is_master_admin": _u_is_adm,
                            "created_at":      str(_u["created_at"] or ""),
                        })

                # Attach sub-accounts and compute seat_used for each rooftop
                _accounts_list: list = []
                for _oid, _rt in sorted(_rooftop_admins.items()):
                    _subs = _sub_by_org.get(_oid, [])
                    _rt["sub_accounts"] = _subs
                    _rt["seat_used"]    = len(_subs) + 1   # +1 for the admin
                    _accounts_list.append(_rt)
                _accounts_list.extend(_personal_accts)

                # Flat members list — kept for backward compat with non-overview paths
                _flat_members = [
                    {
                        "id":         _u["id"],
                        "username":   _u["username"],
                        "full_name":  _u["dealer_name"] or "",
                        "job_title":  _u["job_title"] or "",
                        "email":      _u["email"] or "",
                        "org_role":   _u["org_role"] or "",
                        "created_at": str(_u["created_at"] or ""),
                    }
                    for _u in _all_users_raw
                ]

                _demo_code   = "MASTER-DEMO"
                _invite_link = f"{_app_url}/register?orgInvite={_demo_code}"
                self._json({
                    "org": {
                        "id":          0,
                        "name":        "BDC Manager Desk — Admin Overview",
                        "plan_tier":   "rooftop_lifetime",
                        "max_seats":   len(_all_users_raw),
                        "invite_code": _demo_code,
                    },
                    "seat_used":   len(_all_users_raw),
                    "max_seats":   len(_all_users_raw),
                    "invite_link": _invite_link,
                    "accounts":    _accounts_list,
                    "members":     _flat_members,
                })

            elif _preview_rp:
                # Master admin previewing "Rooftop Admin" — return the
                # testreviewer demo org so the frontend has a real org.id
                # and can exercise Add-Member / Remove controls end-to-end.
                _prev_row = _tc.execute(
                    "SELECT id, organization_id FROM users "
                    "WHERE username = 'testreviewer' LIMIT 1"
                ).fetchone()
                _prev_org_id = (_prev_row["organization_id"] if _prev_row else None)
                if not _prev_org_id:
                    _tc.close()
                    self._json({"error": "Preview org not found."}, 404)
                else:
                    _prev_org = _tc.execute(
                        "SELECT id, name, subscription_tier, seat_limit, invite_code "
                        "FROM organizations WHERE id = ?", (_prev_org_id,)
                    ).fetchone()
                    _prev_members = _tc.execute(
                        "SELECT id, username, dealer_name, job_title, "
                        "       email, org_role, subscription_status, subscription_tier, created_at "
                        "FROM users WHERE organization_id = ? ORDER BY created_at ASC",
                        (_prev_org_id,)
                    ).fetchall()
                    _tc.close()
                    self._json({
                        "org": {
                            "id":          _prev_org["id"],
                            "name":        _prev_org["name"],
                            "plan_tier":   _prev_org["subscription_tier"] or "",
                            "max_seats":   _prev_org["seat_limit"],
                            "invite_code": _prev_org["invite_code"] or "",
                        },
                        "seat_used":   len(_prev_members),
                        "max_seats":   _prev_org["seat_limit"],
                        "invite_link": f"{_app_url}/register",
                        "canManage":   True,
                        "members": [
                            {
                                "id":                  m["id"],
                                "username":            m["username"],
                                "full_name":           m["dealer_name"] or "",
                                "job_title":           m["job_title"] or "",
                                "email":               m["email"] or "",
                                "org_role":            m["org_role"] or "member",
                                "subscription_status": m["subscription_status"] or "",
                                "subscription_tier":   m["subscription_tier"] or "",
                                "created_at":          str(m["created_at"] or ""),
                            }
                            for m in _prev_members
                        ],
                    })

            elif not _tu_row or _tu_row["org_role"] != 'admin':
                _tc.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)

            else:
                _org_id = _tu_row["organization_id"]
                _org    = _tc.execute(
                    "SELECT id, name, subscription_tier, seat_limit, invite_code "
                    "FROM organizations WHERE id = ?",
                    (_org_id,),
                ).fetchone()

                if not _org:
                    _tc.close()
                    self._json({"error": "Organization not found."}, 404)
                else:
                    _members = _tc.execute(
                        "SELECT id, username, dealer_name, job_title, email, "
                        "       org_role, subscription_status, subscription_tier, created_at "
                        "FROM users WHERE organization_id = ? ORDER BY created_at ASC",
                        (_org_id,),
                    ).fetchall()
                    _tc.close()

                    _invite_link = f"{_app_url}/register?orgInvite={_org['invite_code']}"
                    self._json({
                        "org": {
                            "id":          _org["id"],
                            "name":        _org["name"],
                            "plan_tier":   _org["subscription_tier"] or "",
                            "max_seats":   _org["seat_limit"],
                            "invite_code": _org["invite_code"] or "",
                        },
                        "seat_used":   len(_members),
                        "max_seats":   _org["seat_limit"],
                        "invite_link": _invite_link,
                        "members": [
                            {
                                "id":                  m["id"],
                                "username":            m["username"],
                                "full_name":           m["dealer_name"] or "",
                                "job_title":           m["job_title"] or "",
                                "email":               m["email"] or "",
                                "org_role":            m["org_role"],
                                "subscription_status": m["subscription_status"] or "",
                                "subscription_tier":   m["subscription_tier"] or "",
                                "created_at":          str(m["created_at"] or ""),
                            }
                            for m in _members
                        ],
                    })

        elif path == "/api/v1/org/dashboard":
            # ── Rooftop Executive Dashboard — org-wide stats ──────────────
            _od_is_adm = bool(user.get("is_admin"))
            _odc = sqlite3.connect(DB_FILE)
            _odc.row_factory = sqlite3.Row
            _od_row = _odc.execute(
                "SELECT org_role, organization_id FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()
            if not _od_is_adm and (not _od_row or _od_row["org_role"] != "admin"):
                _odc.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)
            else:
                _org_id = (_od_row["organization_id"] if _od_row else None)
                if _od_is_adm and not _org_id:
                    # Master admin: aggregate across all users
                    _org_meta = {
                        "name": "Master Admin Console",
                        "subscription_tier": "pro_lifetime",
                        "seat_limit": 9999,
                    }
                    _members = _odc.execute(
                        "SELECT id, username, email, org_role "
                        "FROM users ORDER BY created_at ASC LIMIT 200"
                    ).fetchall()
                else:
                    _org_meta_row = _odc.execute(
                        "SELECT name, subscription_tier, seat_limit "
                        "FROM organizations WHERE id = ?", (_org_id,)
                    ).fetchone()
                    _org_meta = dict(_org_meta_row) if _org_meta_row else {
                        "name": "Your Dealership",
                        "subscription_tier": "",
                        "seat_limit": 10,
                    }
                    _members = _odc.execute(
                        "SELECT id, username, email, org_role "
                        "FROM users WHERE organization_id = ? "
                        "ORDER BY created_at ASC",
                        (_org_id,),
                    ).fetchall()

                _member_ids = [m["id"] for m in _members]
                _max_seats  = int(_org_meta.get("seat_limit") or 10)

                # Posts per member — last 7 days and last 30 days
                from datetime import datetime as _dt, timedelta as _td
                _week_ago  = (_dt.utcnow() - _td(days=7)).strftime('%Y-%m-%d %H:%M:%S')
                _month_ago = (_dt.utcnow() - _td(days=30)).strftime('%Y-%m-%d %H:%M:%S')
                _week_posts  = {}
                _month_posts = {}
                if _member_ids:
                    _ph = ",".join("?" * len(_member_ids))
                    for _r in _odc.execute(
                        f"SELECT user_id, COUNT(*) as cnt FROM posting_queue "
                        f"WHERE status='Posted' AND posted_at >= ? "
                        f"AND user_id IN ({_ph}) GROUP BY user_id",
                        [_week_ago] + _member_ids,
                    ).fetchall():
                        _week_posts[_r["user_id"]] = _r["cnt"]
                    for _r in _odc.execute(
                        f"SELECT user_id, COUNT(*) as cnt FROM posting_queue "
                        f"WHERE status='Posted' AND posted_at >= ? "
                        f"AND user_id IN ({_ph}) GROUP BY user_id",
                        [_month_ago] + _member_ids,
                    ).fetchall():
                        _month_posts[_r["user_id"]] = _r["cnt"]

                # Inventory totals across all org members
                _inv = {"total_active": 0, "posted_to_facebook": 0, "sold_still_posted": 0}
                if _member_ids:
                    _ph2 = ",".join("?" * len(_member_ids))
                    _ir = _odc.execute(
                        f"SELECT "
                        f" SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS ta, "
                        f" SUM(CASE WHEN status='ACTIVE' AND posted_status='posted' THEN 1 ELSE 0 END) AS pf, "
                        f" SUM(CASE WHEN status='SOLD'   AND posted_status='posted' THEN 1 ELSE 0 END) AS ss "
                        f"FROM marketplace_inventory WHERE user_id IN ({_ph2})",
                        _member_ids,
                    ).fetchone()
                    if _ir:
                        _inv = {
                            "total_active":       int(_ir["ta"] or 0),
                            "posted_to_facebook": int(_ir["pf"] or 0),
                            "sold_still_posted":  int(_ir["ss"] or 0),
                        }

                # Pending outreach letters across all org members
                _mail_count = 0
                if _member_ids:
                    _ph3 = ",".join("?" * len(_member_ids))
                    _mr = _odc.execute(
                        f"SELECT COUNT(*) AS cnt FROM email_queue "
                        f"WHERE status='pending_review' AND user_id IN ({_ph3})",
                        _member_ids,
                    ).fetchone()
                    _mail_count = int(_mr["cnt"] or 0) if _mr else 0

                _odc.close()

                _leaderboard = sorted(
                    [
                        {
                            "id":          m["id"],
                            "username":    m["username"],
                            "org_role":    m["org_role"] or "member",
                            "posts_week":  _week_posts.get(m["id"], 0),
                            "posts_month": _month_posts.get(m["id"], 0),
                        }
                        for m in _members
                    ],
                    key=lambda x: x["posts_week"],
                    reverse=True,
                )
                self._json({
                    "org":         {
                        "name":      _org_meta.get("name", "Your Dealership"),
                        "plan_tier": _org_meta.get("subscription_tier", ""),
                        "max_seats": _max_seats,
                    },
                    "seat_used":   len(_member_ids),
                    "max_seats":   _max_seats,
                    "mail_count":  _mail_count,
                    "inventory":   _inv,
                    "leaderboard": _leaderboard,
                })

        elif path == "/api/tiktok/oauth/start":
            # ── TikTok: generate OAuth auth URL ──────────────────────────
            user = self._require_auth()
            if not user:
                return
            _ck_os, _cs_os = _tiktok_creds()
            if not _ck_os or not _cs_os:
                _missing_keys = [k for k, v in [
                    ("TIKTOK_CLIENT_KEY",    _ck_os),
                    ("TIKTOK_CLIENT_SECRET", _cs_os),
                ] if not v]
                self._json({
                    "error":           "not_configured",
                    "message":         (
                        "TikTok API credentials are not configured. "
                        "A master admin can add them from the Admin Console -> TikTok Integration."
                    ),
                    "missing_secrets": _missing_keys,
                }, 503)
                return
            # Stateless HMAC-signed state token — survives server restarts,
            # no in-memory dict, works for every concurrent user at once.
            _state        = _tiktok_make_state(user["id"])
            _app_url      = _tiktok_base_url(self.headers.get("Host", ""))
            _redirect_uri = _app_url + "/api/tiktok/callback"
            _params = urllib.parse.urlencode({
                "client_key":    _ck_os,
                "response_type": "code",
                "scope":         "user.info.basic,video.list,user.info.stats",
                "redirect_uri":  _redirect_uri,
                "state":         _state,
            })
            self._json({"auth_url": f"{TIKTOK_AUTH_URL}?{_params}"})

        elif path == "/api/tiktok/publish/status":
            # ── TikTok: poll publish status ──────────────────────────────
            user = self._require_auth()
            if not user:
                return
            _qs_st = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _pub_id = _qs_st.get("publish_id", [""])[0].strip()
            if not _pub_id:
                self._json({"error": "publish_id required"}, 400)
                return
            try:
                _at2, _ = TikTokTokenManager.refresh_if_needed(user["id"])
            except TikTokRefreshExpiredError as _rfe2r:
                self._json({
                    "error":   "tiktok_refresh_expired",
                    "message": str(_rfe2r) or (
                        "Your TikTok authorization has fully expired. "
                        "Please reconnect your TikTok account."
                    ),
                }, 403)
                return
            except TikTokTokenExpiredError as _rfe2:
                self._json({
                    "error":   "tiktok_token_expired",
                    "message": str(_rfe2) or (
                        "Your TikTok session has expired. Please reconnect your TikTok account."
                    ),
                }, 403)
                return
            _st_payload = json.dumps({"publish_id": _pub_id}).encode("utf-8")
            _st_req = urllib.request.Request(
                f"{TIKTOK_API_BASE}/v2/post/publish/status/fetch/",
                data=_st_payload,
                headers={
                    "Authorization": f"Bearer {_at2}",
                    "Content-Type":  "application/json; charset=UTF-8",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(_st_req, timeout=15) as _str:
                    _std = json.loads(_str.read().decode("utf-8"))
                _pdata = _std.get("data", {})
                _resolved_status = _pdata.get("status", "UNKNOWN")
                # Persist terminal status back to tiktok_posts
                if _resolved_status in ("PUBLISH_COMPLETE", "FAILED"):
                    try:
                        _upc = sqlite3.connect(DB_FILE)
                        # Extract the live video URL when the post goes live
                        _vid_ids = _pdata.get("publicaly_available_post_id", [])
                        _video_url = (
                            f"https://www.tiktok.com/video/{_vid_ids[0]}"
                            if _resolved_status == "PUBLISH_COMPLETE" and _vid_ids
                            else ""
                        )
                        try:
                            _upc.execute(
                                "UPDATE tiktok_posts SET status = ?, video_url = ? "
                                "WHERE publish_id = ? AND user_id = ?",
                                (_resolved_status, _video_url, _pub_id, user["id"]),
                            )
                            _upc.commit()
                        except Exception:
                            try:
                                _upc.rollback()
                            except Exception:
                                pass
                            raise
                        finally:
                            _upc.close()
                    except Exception as _upe:
                        print(f"[TikTok] Failed to update tiktok_posts status: {_upe}")
                self._json({
                    "status":      _resolved_status,
                    "fail_reason": _pdata.get("fail_reason", ""),
                })
            except Exception as _ste:
                self._json({"error": str(_ste)}, 502)

        elif path == "/api/tiktok/posts":
            # ── TikTok: recent post history ──────────────────────────────
            user = self._require_auth()
            if not user:
                return
            _ph_conn = sqlite3.connect(DB_FILE)
            _ph_conn.row_factory = sqlite3.Row
            _ph_rows = _ph_conn.execute(
                "SELECT publish_id, title, posted_at, status, video_url, COALESCE(failure_reason, '') AS failure_reason "
                "FROM tiktok_posts WHERE user_id = ? "
                "ORDER BY posted_at DESC LIMIT 10",
                (user["id"],),
            ).fetchall()
            _ph_conn.close()

            # ── Auto-resolve stuck PROCESSING posts (max 5 re-checks) ────
            # Re-poll TikTok for any rows still in PROCESSING status so
            # posts that were interrupted mid-poll (tab closed, timeout)
            # get resolved the next time the user opens the hub.
            _processing_rows = [r for r in _ph_rows if r["status"] == "PROCESSING"]
            if _processing_rows:
                try:
                    _ar_token, _ = TikTokTokenManager.refresh_if_needed(user["id"])
                    _resolved_map: dict[str, str] = {}  # publish_id -> resolved status
                    for _ar_row in _processing_rows[:5]:
                        _ar_pub_id = _ar_row["publish_id"]
                        try:
                            _ar_payload = json.dumps({"publish_id": _ar_pub_id}).encode("utf-8")
                            _ar_req = urllib.request.Request(
                                f"{TIKTOK_API_BASE}/v2/post/publish/status/fetch/",
                                data=_ar_payload,
                                headers={
                                    "Authorization": f"Bearer {_ar_token}",
                                    "Content-Type":  "application/json; charset=UTF-8",
                                },
                                method="POST",
                            )
                            with urllib.request.urlopen(_ar_req, timeout=10) as _ar_resp:
                                _ar_data = json.loads(_ar_resp.read().decode("utf-8"))
                            _ar_pdata  = _ar_data.get("data", {})
                            _ar_status = _ar_pdata.get("status", "")
                            if _ar_status in ("PUBLISH_COMPLETE", "FAILED"):
                                _ar_vid_ids = _ar_pdata.get("publicaly_available_post_id", [])
                                _ar_video_url = (
                                    f"https://www.tiktok.com/video/{_ar_vid_ids[0]}"
                                    if _ar_status == "PUBLISH_COMPLETE" and _ar_vid_ids
                                    else ""
                                )
                                _resolved_map[_ar_pub_id] = (_ar_status, _ar_video_url)
                        except Exception as _ar_err:
                            print(f"[TikTok] Auto-resolve re-poll error for {_ar_pub_id}: {_ar_err}")
                    if _resolved_map:
                        _ar_upd = sqlite3.connect(DB_FILE)
                        try:
                            for _ar_pid, (_ar_st, _ar_vurl) in _resolved_map.items():
                                _ar_upd.execute(
                                    "UPDATE tiktok_posts SET status = ?, video_url = ? "
                                    "WHERE publish_id = ? AND user_id = ?",
                                    (_ar_st, _ar_vurl, _ar_pid, user["id"]),
                                )
                            _ar_upd.commit()
                        except Exception:
                            try:
                                _ar_upd.rollback()
                            except Exception:
                                pass
                            raise
                        finally:
                            _ar_upd.close()
                        print(f"[TikTok] Auto-resolved {len(_resolved_map)} PROCESSING post(s) for user_id={user['id']}")
                        # Re-fetch so the response reflects the updated statuses
                        _ph_conn2 = sqlite3.connect(DB_FILE)
                        _ph_conn2.row_factory = sqlite3.Row
                        _ph_rows = _ph_conn2.execute(
                            "SELECT publish_id, title, posted_at, status, video_url, COALESCE(failure_reason, '') AS failure_reason "
                            "FROM tiktok_posts WHERE user_id = ? "
                            "ORDER BY posted_at DESC LIMIT 10",
                            (user["id"],),
                        ).fetchall()
                        _ph_conn2.close()
                except (TikTokTokenExpiredError, TikTokRefreshExpiredError) as _ar_te:
                    # Token is gone — skip re-polling silently; the hub will
                    # show the reconnect banner via the normal auth flow.
                    print(f"[TikTok] Auto-resolve skipped (token issue): {_ar_te}")
                except Exception as _ar_ge:
                    print(f"[TikTok] Auto-resolve unexpected error: {_ar_ge}")

            self._json({
                "timeout_hours": TIKTOK_PROCESSING_TIMEOUT_HOURS,
                "posts": [
                    {
                        "publish_id":     r["publish_id"],
                        "title":          r["title"],
                        "posted_at":      r["posted_at"],
                        "status":         r["status"],
                        "video_url":      r["video_url"] or "",
                        "failure_reason": r["failure_reason"] if r["failure_reason"] else "",
                    }
                    for r in _ph_rows
                ]
            })

        elif path == "/api/tiktok/trial-status":
            # ── TikTok: return trial eligibility for the current user ─────
            user = self._require_auth()
            if not user:
                return
            self._json(_get_tiktok_trial_status(user))

        else:
            self._json({"error": "Endpoint not found"}, 404)

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)
        path = self.path.split("?")[0]

        try:
            payload = json.loads(post_data.decode("utf-8")) if content_length else {}
        except json.JSONDecodeError:
            payload = {}

        # ── Billing: Stripe webhook (public — needs raw bytes for sig verification) ──
        if path == "/api/v1/billing/webhook":
            sig_header = self.headers.get("Stripe-Signature", "")
            try:
                BillingManager.handle_webhook(post_data, sig_header)
                self._json({"received": True})
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[BILLING] webhook error: {exc}")
                self._json({"error": "Webhook processing error."}, 500)
            return

        # ── Billing: create checkout session (protected) ──────────────
        if path == "/api/v1/billing/create-checkout-session":
            user_for_billing = self._require_auth()
            if not user_for_billing:
                return
            tos_accepted = bool(payload.get("tos_accepted", False))
            if not tos_accepted:
                self._json(
                    {"error": "You must accept the Terms of Service before subscribing."},
                    400,
                )
                return
            success_url = payload.get("success_url", "").strip()
            cancel_url  = payload.get("cancel_url",  "").strip()
            if not success_url:
                self._json({"error": "success_url is required"}, 400)
                return
            # Record acceptance *before* redirecting to Stripe — this moment
            # is the legally significant event regardless of payment outcome.
            _ip = (
                self.headers.get('X-Forwarded-For', '')
                or self.headers.get('X-Real-IP', '')
                or self.client_address[0]
            ).split(',')[0].strip()
            _ua = self.headers.get('User-Agent', '')
            LegalAgreementDB.record(user_for_billing["id"], 'checkout', _ip, _ua)
            plan = payload.get("plan", "").strip()
            if not plan:
                # Derive from the billing cycle chosen at registration so the
                # first charge matches what the visitor selected on the landing page.
                _pbc  = (user_for_billing.get("pending_billing_cycle") or "monthly").strip()
                _tier = (user_for_billing.get("subscription_tier") or "").strip()
                _base = "rooftop" if _tier.startswith("rooftop") else "pro"
                plan  = f"{_base}_{_pbc}"
            if plan not in BillingManager._PLANS:
                plan = "pro_monthly"
            # For rooftop plans, honour extra_seats from request body first
            # (explicit override), then fall back to the user's pending_extra_seats
            # stored at registration so new Rooftop signups are always charged the
            # correct seat count without needing a second interaction.
            _billing_extra = int(payload.get("extra_seats", 0) or 0)
            if _billing_extra == 0 and plan.startswith("rooftop_"):
                _billing_extra = int(user_for_billing.get("pending_extra_seats", 0) or 0)
            try:
                checkout_url = BillingManager.create_checkout_session(
                    user_for_billing["id"],
                    user_for_billing["username"],
                    plan,
                    success_url,
                    cancel_url or success_url,
                    extra_seats=_billing_extra,
                )
                self._json({"url": checkout_url})
            except Exception as exc:
                print(f"[BILLING] checkout error: {exc}")
                self._json({"error": str(exc)}, 500)
            return

        # ── Billing: cancel subscription (sets cancel_at_period_end = True) ──
        if path == "/api/v1/billing/cancel":
            cancel_user = self._require_auth()
            if not cancel_user:
                return
            try:
                result = BillingManager.cancel_subscription(cancel_user["id"])
                self._json(result)
            except Exception as exc:
                print(f"[BILLING] cancel error: {exc}")
                self._json({"error": str(exc)}, 500)
            return

        # ── Billing: reactivate (clears cancel_at_period_end) ────────────
        if path == "/api/v1/billing/reactivate":
            react_user = self._require_auth()
            if not react_user:
                return
            try:
                result = BillingManager.reactivate_subscription(react_user["id"])
                self._json(result)
            except Exception as exc:
                print(f"[BILLING] reactivate error: {exc}")
                self._json({"error": str(exc)}, 500)
            return

        # ── Referrals: post a credit to the caller's Stripe customer balance ──────
        # Fetches the authenticated user's stripeCustomerId, creates a negative
        # balance transaction (credit), and syncs account_credit in the DB.
        # Default amount: $25.00 (2500 cents).  Pass amount_cents in the body
        # to override (useful for manual or partial credit grants).
        if path == "/api/referrals/apply-credit":
            _rac_user = self._require_auth()
            if not _rac_user:
                return
            _rac_uid  = _rac_user["id"]
            _rac_amt  = int(payload.get("amount_cents", 2500))
            _rac_desc = (payload.get("description") or "Referral reward bonus credit").strip()

            _rac_conn = sqlite3.connect(DB_FILE)
            _rac_conn.row_factory = sqlite3.Row
            _rac_row = _rac_conn.execute(
                "SELECT stripe_customer_id, account_credit FROM users WHERE id = ?",
                (_rac_uid,),
            ).fetchone()
            _rac_conn.close()

            if not _rac_row:
                self._json({"error": "User not found."}, 404)
                return

            _rac_cid = (_rac_row["stripe_customer_id"] or "").strip()
            if not _rac_cid:
                self._json(
                    {"error": "No Stripe customer ID on file. Subscribe to Pro first."}, 400
                )
                return

            if _stripe_module is None or not STRIPE_SECRET_KEY:
                self._json({"error": "Stripe is not configured on this server."}, 503)
                return

            try:
                _stripe_module.api_key = STRIPE_SECRET_KEY
                _rac_txn = _stripe_module.Customer.create_balance_transaction(
                    _rac_cid,
                    amount=-abs(_rac_amt),          # negative = credit on Stripe
                    currency="usd",
                    description=_rac_desc,
                )
                # Sync DB balance
                _rac_sync = sqlite3.connect(DB_FILE)
                try:
                    _rac_sync.execute(
                        "UPDATE users SET account_credit = account_credit + ? WHERE id = ?",
                        (_rac_amt / 100.0, _rac_uid),
                    )
                    _rac_sync.commit()
                except Exception:
                    try:
                        _rac_sync.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    _rac_sync.close()

                _log_billing_event(
                    _rac_uid,
                    "credit.applied",
                    credit_applied_cents=abs(_rac_amt),
                    description=_rac_desc,
                )
                print(
                    f"[BILLING] apply-credit — ${_rac_amt / 100:.2f} posted "
                    f"to Stripe customer {_rac_cid} (user {_rac_uid})"
                )
                self._json({
                    "success":              True,
                    "amount_cents":         abs(_rac_amt),
                    "amount_dollars":       abs(_rac_amt) / 100.0,
                    "stripe_transaction_id": _rac_txn.get("id", ""),
                    "description":          _rac_desc,
                })
            except Exception as _race:
                print(f"[BILLING] apply-credit error: {_race}")
                self._json({"error": str(_race)}, 500)
            return

        # ── Billing: $3 one-time video unlock checkout (public — no auth) ──
        if path == "/api/v1/billing/create-video-checkout":
            success_url = payload.get("success_url", "").strip()
            cancel_url  = payload.get("cancel_url",  "").strip()
            if not success_url:
                self._json({"error": "success_url is required"}, 400)
                return
            try:
                checkout_url = BillingManager.create_video_checkout_session(
                    success_url, cancel_url or success_url
                )
                self._json({"url": checkout_url})
            except Exception as exc:
                print(f"[BILLING] video-checkout error: {exc}")
                self._json({"error": str(exc)}, 500)
            return

        # ── Team: add seats — Rooftop admin, creates Stripe checkout ────────
        if path == "/api/team/add-seats-checkout":
            _as_user = self._require_auth()
            if not _as_user:
                return
            _as_conn = sqlite3.connect(DB_FILE)
            _as_conn.row_factory = sqlite3.Row
            _as_row  = _as_conn.execute(
                "SELECT org_role, organization_id FROM users WHERE id = ?",
                (_as_user["id"],),
            ).fetchone()
            _as_is_adm = bool(_as_user.get("is_admin"))
            if not _as_is_adm and (not _as_row or _as_row["org_role"] != 'admin'):
                _as_conn.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)
                return
            _as_org_id = int(_as_row["organization_id"]) if _as_row and _as_row["organization_id"] else 0
            _as_conn.close()

            _as_seats    = int(payload.get("seats", 1))
            _as_interval = payload.get("interval", "monthly")   # monthly | annual | lifetime
            if _as_seats < 1 or _as_seats > 100:
                self._json({"error": "Seat count must be between 1 and 100."}, 400)
                return
            if _stripe_module is None or not STRIPE_SECRET_KEY:
                self._json({"error": "Stripe is not configured on this server."}, 503)
                return

            _stripe_module.api_key = STRIPE_SECRET_KEY
            _as_app_url  = APP_BASE_URL
            _as_origin   = payload.get("origin", "").rstrip("/") or _as_app_url
            _as_base     = payload.get("base_url", "")
            _as_ok_url   = f"{_as_origin}{_as_base}/team?seats_added=1"
            _as_cancel   = f"{_as_origin}{_as_base}/team?seats_canceled=1"
            _as_meta     = {
                "type":        "seat_expansion",
                "user_id":     str(_as_user["id"]),
                "org_id":      str(_as_org_id),
                "extra_seats": str(_as_seats),
                "interval":    _as_interval,
            }
            try:
                if _as_interval == "monthly":
                    _as_sess = _stripe_module.checkout.Session.create(
                        mode="subscription",
                        line_items=[{
                            "price_data": {
                                "currency":     "usd",
                                "product_data": {
                                    "name": f"BDC Manager Desk — {_as_seats} Extra Seat{'s' if _as_seats > 1 else ''} (Monthly)",
                                },
                                "unit_amount":  3900,       # $39.00/seat/mo
                                "recurring":    {"interval": "month"},
                            },
                            "quantity": _as_seats,
                        }],
                        metadata=_as_meta,
                        success_url=_as_ok_url,
                        cancel_url=_as_cancel,
                    )
                elif _as_interval == "annual":
                    _as_sess = _stripe_module.checkout.Session.create(
                        mode="subscription",
                        line_items=[{
                            "price_data": {
                                "currency":     "usd",
                                "product_data": {
                                    "name": f"BDC Manager Desk — {_as_seats} Extra Seat{'s' if _as_seats > 1 else ''} (Annual)",
                                },
                                "unit_amount":  39000,      # $390.00/seat/yr
                                "recurring":    {"interval": "year"},
                            },
                            "quantity": _as_seats,
                        }],
                        metadata=_as_meta,
                        success_url=_as_ok_url,
                        cancel_url=_as_cancel,
                    )
                else:  # lifetime
                    # 5-seat bundle: $4,495 flat; otherwise $995/seat
                    if _as_seats == 5:
                        _lt_unit = 449500   # $4,495.00 bundle
                        _lt_qty  = 1
                        _lt_name = "BDC Manager Desk — 5-Seat Lifetime Bundle"
                    else:
                        _lt_unit = 99500    # $995.00/seat
                        _lt_qty  = _as_seats
                        _lt_name = f"BDC Manager Desk — {_as_seats} Extra Seat{'s' if _as_seats > 1 else ''} (Lifetime)"
                    _as_sess = _stripe_module.checkout.Session.create(
                        mode="payment",
                        line_items=[{
                            "price_data": {
                                "currency":     "usd",
                                "product_data": {"name": _lt_name},
                                "unit_amount":  _lt_unit,
                            },
                            "quantity": _lt_qty,
                        }],
                        metadata=_as_meta,
                        success_url=_as_ok_url,
                        cancel_url=_as_cancel,
                    )
                print(
                    f"[TEAM] add-seats-checkout: org {_as_org_id} +{_as_seats} seats "
                    f"({_as_interval}), user {_as_user['id']}."
                )
                self._json({"url": _as_sess["url"]})
            except Exception as _as_exc:
                print(f"[BILLING] add-seats-checkout error: {_as_exc}")
                self._json({"error": str(_as_exc)}, 500)
            return

        # ── Team: remove a member seat (admin only) ───────────────────────
        if path == "/api/team/remove-member":
            _rm_user = self._require_auth()
            if not _rm_user:
                return
            _rm_tc = sqlite3.connect(DB_FILE)
            _rm_tc.row_factory = sqlite3.Row
            _rm_u = _rm_tc.execute(
                "SELECT org_role, organization_id FROM users WHERE id = ?",
                (_rm_user["id"],),
            ).fetchone()
            if not _rm_u or _rm_u["org_role"] != 'admin':
                _rm_tc.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)
                return
            _rm_target_id = int(payload.get("user_id", 0) or 0)
            if not _rm_target_id:
                _rm_tc.close()
                self._json({"error": "user_id is required."}, 400)
                return
            if _rm_target_id == _rm_user["id"]:
                _rm_tc.close()
                self._json({"error": "You cannot remove yourself from the organization."}, 400)
                return
            _rm_target = _rm_tc.execute(
                "SELECT id, username, organization_id FROM users WHERE id = ?",
                (_rm_target_id,),
            ).fetchone()
            _rm_tc.close()
            if not _rm_target or _rm_target["organization_id"] != _rm_u["organization_id"]:
                self._json({"error": "User is not a member of your organization."}, 404)
                return
            _rm_conn = sqlite3.connect(DB_FILE)
            try:
                _rm_conn.execute(
                    "UPDATE users SET organization_id = NULL, org_role = '', "
                    "subscription_status = 'inactive', subscription_tier = '' WHERE id = ?",
                    (_rm_target_id,),
                )
                # Decrement the org's seat counter atomically with the user removal
                _rm_conn.execute(
                    "UPDATE organizations "
                    "SET used_seats = GREATEST(0, used_seats - 1) "
                    "WHERE id = ?",
                    (_rm_u["organization_id"],),
                )
                _rm_conn.commit()
            except Exception:
                try:
                    _rm_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _rm_conn.close()
            print(
                f"[TEAM] Admin {_rm_user['id']} removed user {_rm_target_id} "
                f"from org {_rm_u['organization_id']}"
            )
            self._json({"success": True, "removed_user_id": _rm_target_id})
            return

        if path == "/api/team/create-member":
            # ── Dealership Admin: directly create a new team member ───────────
            # Restricted to org admins (org_role='admin') or the master admin.
            # Does NOT send an invite link — the account is created immediately
            # with the supplied credentials and bound to the caller's org.
            _mc_caller = self._require_auth()
            if not _mc_caller:
                return
            _mc_db = sqlite3.connect(DB_FILE)
            _mc_db.row_factory = sqlite3.Row
            _mc_row = _mc_db.execute(
                "SELECT org_role, organization_id, is_admin FROM users WHERE id = ?",
                (_mc_caller["id"],),
            ).fetchone()
            _mc_is_admin = bool(_mc_caller.get("is_admin") or
                                (_mc_row and _mc_row["is_admin"]))
            _mc_is_org_admin = _mc_row and _mc_row["org_role"] == "admin"
            if not (_mc_is_admin or _mc_is_org_admin):
                _mc_db.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)
                return

            _mc_username  = str(payload.get("username",  "") or "").strip().lower()
            _mc_password  = str(payload.get("password",  "") or "").strip()
            _mc_full_name = str(payload.get("full_name", "") or "").strip()[:120]
            _mc_job_title = str(payload.get("job_title", "") or "").strip()[:60]

            # Basic field validation
            if not _mc_username:
                _mc_db.close()
                self._json({"error": "Username is required."}, 400); return
            if len(_mc_username) < 3:
                _mc_db.close()
                self._json({"error": "Username must be at least 3 characters."}, 400); return
            if not _mc_password:
                _mc_db.close()
                self._json({"error": "Password is required."}, 400); return
            if len(_mc_password) < 6:
                _mc_db.close()
                self._json({"error": "Password must be at least 6 characters."}, 400); return

            # Determine which org to enrol the new member into.
            # Org admins use their own org.
            # Master admin in rooftop_admin preview resolves the testreviewer
            # demo org so the preview UI can exercise member creation end-to-end.
            _mc_mock   = (_mc_caller.get("mock_role") or "")
            _mc_org_id = _mc_row["organization_id"] if _mc_row else None
            if not _mc_org_id and _mc_is_admin and _mc_mock == "rooftop_admin":
                _mc_prev = _mc_db.execute(
                    "SELECT organization_id FROM users "
                    "WHERE username = 'testreviewer' LIMIT 1"
                ).fetchone()
                _mc_org_id = _mc_prev["organization_id"] if _mc_prev else None
            if not _mc_org_id:
                _mc_db.close()
                self._json(
                    {"error": "You must be an org admin to create team members."},
                    403,
                )
                return

            # Seat capacity check
            _mc_org = _mc_db.execute(
                "SELECT id, seat_limit, subscription_tier FROM organizations WHERE id = ?",
                (_mc_org_id,),
            ).fetchone()
            if not _mc_org:
                _mc_db.close()
                self._json({"error": "Organization not found."}, 404); return
            _mc_used = int(_mc_db.execute(
                "SELECT COUNT(*) AS cnt FROM users WHERE organization_id = ?",
                (_mc_org_id,),
            ).fetchone()["cnt"])
            if _mc_used >= _mc_org["seat_limit"]:
                _mc_db.close()
                self._json(
                    {"error": f"All {_mc_org['seat_limit']} seats are already in use. "
                              "Purchase additional seats before adding more members."},
                    400,
                )
                return

            # Username uniqueness check
            if _mc_db.execute(
                "SELECT id FROM users WHERE LOWER(username) = ?", (_mc_username,)
            ).fetchone():
                _mc_db.close()
                self._json(
                    {"error": "username_taken",
                     "message": "That username is already taken."},
                    409,
                )
                return

            # Inherit the org's subscription tier for the new member
            _mc_tier = _mc_org["subscription_tier"] or "rooftop_monthly"

            # Create the account — email_verified=1 (no verification email needed
            # for admin-provisioned accounts), subscription_status='active'
            try:
                _mc_db.execute(
                    """INSERT INTO users
                           (username, password_hash, email,
                            dealer_name, job_title,
                            organization_id, org_role,
                            subscription_status, subscription_tier,
                            recovery_id, referral_code,
                            email_verified)
                       VALUES (?, ?, '', ?, ?, ?, 'member', 'active', ?, ?, ?, 1)""",
                    (
                        _mc_username,
                        _hash_password(_mc_password),
                        _mc_full_name,
                        _mc_job_title,
                        _mc_org_id,
                        _mc_tier,
                        _generate_recovery_id(),
                        _generate_referral_code(_mc_username),
                    ),
                )
                # Increment the org's seat counter in the same atomic commit
                _mc_db.execute(
                    "UPDATE organizations SET used_seats = used_seats + 1 WHERE id = ?",
                    (_mc_org_id,),
                )
                _mc_db.commit()
                _mc_new = _mc_db.execute(
                    "SELECT id, username, dealer_name, job_title, org_role, created_at "
                    "FROM users WHERE LOWER(username) = ?",
                    (_mc_username,),
                ).fetchone()
            except Exception as _mc_err:
                try: _mc_db.rollback()
                except Exception: pass
                _mc_db.close()
                _em = str(_mc_err).lower()
                if "unique" in _em or "duplicate" in _em:
                    self._json(
                        {"error": "username_taken",
                         "message": "That username is already taken."},
                        409,
                    )
                else:
                    self._json({"error": f"Failed to create member: {_mc_err}"}, 500)
                return

            _mc_db.close()
            print(
                f"[TEAM] Admin {_mc_caller['id']} created member "
                f"'{_mc_username}' in org {_mc_org_id}"
            )
            self._json({
                "success": True,
                "member": {
                    "id":         _mc_new["id"],
                    "username":   _mc_new["username"],
                    "full_name":  _mc_new["dealer_name"] or "",
                    "job_title":  _mc_new["job_title"] or "",
                    "email":      "",
                    "org_role":   "member",
                    "created_at": str(_mc_new["created_at"] or ""),
                },
            })
            return

        if path == "/api/team/reset-member-password":
            # ── Dealership Admin: reset a team member's password ──────────────
            # Restricted to org admins (org_role='admin').
            # No email is sent — org-provisioned accounts may have no email.
            _rmp_caller = self._require_auth()
            if not _rmp_caller:
                return
            _rmp_db = sqlite3.connect(DB_FILE)
            _rmp_db.row_factory = sqlite3.Row
            _rmp_row = _rmp_db.execute(
                "SELECT org_role, organization_id FROM users WHERE id = ?",
                (_rmp_caller["id"],),
            ).fetchone()
            if not _rmp_row or _rmp_row["org_role"] != "admin":
                _rmp_db.close()
                self._json({"error": "Access restricted to Dealership Admins."}, 403)
                return
            _rmp_target_id  = int(payload.get("user_id",      0)  or 0)
            _rmp_new_pw     = str(payload.get("new_password", "") or "").strip()
            if not _rmp_target_id:
                _rmp_db.close()
                self._json({"error": "user_id is required."}, 400)
                return
            if not _rmp_new_pw:
                _rmp_db.close()
                self._json({"error": "new_password is required."}, 400)
                return
            if len(_rmp_new_pw) < 6:
                _rmp_db.close()
                self._json({"error": "Password must be at least 6 characters."}, 400)
                return
            if _rmp_target_id == _rmp_caller["id"]:
                _rmp_db.close()
                self._json({"error": "Use the account settings page to change your own password."}, 400)
                return
            _rmp_target = _rmp_db.execute(
                "SELECT id, username, organization_id FROM users WHERE id = ?",
                (_rmp_target_id,),
            ).fetchone()
            _rmp_db.close()
            if not _rmp_target or _rmp_target["organization_id"] != _rmp_row["organization_id"]:
                self._json({"error": "User is not a member of your organization."}, 404)
                return
            _rmp_conn = sqlite3.connect(DB_FILE)
            try:
                _rmp_conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (_hash_password(_rmp_new_pw), _rmp_target_id),
                )
                _rmp_conn.commit()
            except Exception as _rmp_err:
                try:
                    _rmp_conn.rollback()
                except Exception:
                    pass
                _rmp_conn.close()
                self._json({"error": f"Failed to reset password: {_rmp_err}"}, 500)
                return
            finally:
                try:
                    _rmp_conn.close()
                except Exception:
                    pass
            print(
                f"[TEAM] Admin {_rmp_caller['id']} reset password for user "
                f"{_rmp_target_id} in org {_rmp_row['organization_id']}"
            )
            self._json({"success": True, "user_id": _rmp_target_id})
            return

        # ── Free AI Post Generator (public — no auth required) ───────
        if path == "/api/v1/free-tool/parse":
            raw_url = payload.get("url", "").strip()
            if not raw_url:
                self._json({"error": "url is required"}, 400); return

            # ── Check if an authenticated admin is making this request ─
            # Admin / moderator accounts bypass the IP rate limit entirely.
            _caller_is_admin = False
            _caller_token = self._get_bearer_token()
            if _caller_token:
                _caller_user = UserManager.get_user_by_token(_caller_token)
                if _caller_user and _caller_user.get("is_admin"):
                    _caller_is_admin = True

            # ── IP-based daily rate limit (skipped for admins) ────────
            _today    = datetime.utcnow().strftime('%Y-%m-%d')
            _ip       = (
                self.headers.get('X-Forwarded-For', '')
                or self.headers.get('X-Real-IP', '')
                or self.client_address[0]
            ).split(',')[0].strip()
            _rate_key = f"{_ip}:{_today}"
            _used     = _FREE_TOOL_RATE.get(_rate_key, 0)
            if not _caller_is_admin and _used >= FREE_TOOL_DAILY_LIMIT:
                self._json({
                    "error":   "rate_limit",
                    "used":    _used,
                    "limit":   FREE_TOOL_DAILY_LIMIT,
                    "message": (
                        f"You've used all {FREE_TOOL_DAILY_LIMIT} free generations for today. "
                        "Upgrade to BDC Manager Desk Pro for unlimited access."
                    ),
                }, 429)
                return
            if not _caller_is_admin:
                _FREE_TOOL_RATE[_rate_key] = _used + 1

            try:
                result = _free_tool_parse(raw_url)
                # Attach usage info so the UI can show remaining count
                _used_now = _FREE_TOOL_RATE.get(_rate_key, 0)
                result["_usage"] = {
                    "used":      _used_now,
                    "limit":     FREE_TOOL_DAILY_LIMIT,
                    "remaining": max(0, FREE_TOOL_DAILY_LIMIT - _used_now),
                }
                self._json(result)
            except ValueError as exc:
                self._json({"error": str(exc)}, 422)
            except Exception as exc:
                print(f"[FREE-TOOL] unexpected error: {exc}")
                # Return a graceful partial result rather than a hard 500 so
                # the user can still fill in pricing manually in Step 2.
                _used_fallback = _FREE_TOOL_RATE.get(_rate_key, 0)
                self._json({
                    "vehicle_summary": "",
                    "price": "", "miles": "",
                    "retail_price": "", "doc_fee": "", "savings": "",
                    "title": "", "features": [], "description": "", "hashtags": "",
                    "_partial": True,
                    "_error": str(exc),
                    "_usage": {
                        "used":      _used_fallback,
                        "limit":     FREE_TOOL_DAILY_LIMIT,
                        "remaining": max(0, FREE_TOOL_DAILY_LIMIT - _used_fallback),
                    },
                })
            return

        # ── Auth routes (public) ──────────────────────────────────────
        if path == "/api/auth/register":
            username     = payload.get("username", "").strip().lower()
            password     = payload.get("password", "")
            email        = payload.get("email",    "").strip().lower()
            tos_accepted = bool(payload.get("tos_accepted", False))
            if not tos_accepted:
                self._json(
                    {"error": "You must accept the Terms of Service to create an account."},
                    400,
                )
                return
            # ── IP-based registration rate limit ──────────────────────────
            # Extract IP once; reuse for both rate limiting and the audit record.
            _reg_ip = (
                self.headers.get('X-Forwarded-For', '')
                or self.headers.get('X-Real-IP', '')
                or self.client_address[0]
            ).split(',')[0].strip()
            _reg_today = datetime.now().strftime('%Y-%m-%d')
            _reg_key         = f"{_reg_ip}:{_reg_today}"
            # Org invite registrations bypass the IP rate limit — pre-authorised
            # by the dealership admin (e.g. 10 reps on one office network).
            _org_invite_code = payload.get("org_invite", "").strip()
            if not _org_invite_code and _REG_RATE.get(_reg_key, 0) >= REG_DAILY_LIMIT:
                self._json(
                    {
                        "error": (
                            "Registration limit reached for this network today. "
                            "Please try again tomorrow or contact support at "
                            "support.bdcmanager@gmail.com."
                        )
                    },
                    429,
                )
                return

            try:
                visitor_id      = payload.get("visitor_id",      "").strip()
                referral_code   = payload.get("referral_code",   "").strip()
                org_invite      = _org_invite_code   # already extracted for rate-limit bypass
                account_type    = payload.get("account_type",    "").strip()   # 'individual' | 'rooftop'
                dealership_name = payload.get("dealership_name", "").strip()
                if account_type not in ("", "individual", "rooftop"):
                    account_type = ""
                extra_seats   = max(0, int(payload.get("extra_seats", 0) or 0))
                billing_cycle = payload.get("billing_cycle", "monthly").strip().lower()
                if billing_cycle not in ("monthly", "annual", "lifetime"):
                    billing_cycle = "monthly"
                result = UserManager.register(
                    username, password, email,
                    visitor_id, referral_code, org_invite,
                    account_type, dealership_name, extra_seats, billing_cycle,
                )
                # Capture originating IP + UA for the legal audit record
                _ua = self.headers.get('User-Agent', '')
                LegalAgreementDB.record(result['id'], 'registration', _reg_ip, _ua)
                # Increment registration counter *after* success so failed
                # attempts (duplicate username, weak password, etc.) don't burn
                # the caller's daily quota.
                _REG_RATE[_reg_key] = _REG_RATE.get(_reg_key, 0) + 1

                # Pop any leftover verification token field before sending to the client
                result.pop("_verification_token", "")
                _uname = result.get('username', username)
                _app_url  = APP_BASE_URL

                # Welcome email — fire-and-forget (never blocks the response)
                _welcome_text = (
                    f"Hi {_uname},\n\n"
                    f"Welcome to BDC Manager Desk! Your account is live and your "
                    f"5-day free trial starts today. Your email is already verified — "
                    f"no further action is required.\n\n"
                    f"WHAT YOU GET DURING YOUR TRIAL\n"
                    f"  • 3 AI Post Generations per day — instant Facebook Marketplace copy\n"
                    f"  • 3 Wishlist Customer Entries per day — match buyers to inventory\n"
                    f"  • Full inventory view across your configured locations\n\n"
                    f"After 5 days, upgrade to BDC Manager Desk Pro ($75/mo) for "
                    f"unlimited access.\n\n"
                    f"Get started: {_app_url}/marketplace-hub\n\n"
                    f"Questions? Reply to this email — we read everything.\n"
                    f"— The BDC Manager Desk Team"
                )
                _welcome_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#f97316;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">
              Welcome to BDC Manager Desk
            </h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;">
              Hi <strong>{_uname}</strong>,
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#374151;">
              Your account is live and your <strong>5-day free trial</strong> starts today.
              Your email is already verified — no further action is required.
            </p>

            <h3 style="margin:0 0 12px;font-size:15px;color:#f97316;">
              What you get during your trial
            </h3>
            <ul style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:14px;line-height:1.9;">
              <li><strong>3 AI Post Generations per day</strong> — instant Facebook Marketplace copy for any vehicle</li>
              <li><strong>3 Wishlist Customer Entries per day</strong> — match buyers to inventory automatically</li>
              <li>Full inventory view across your configured locations</li>
            </ul>
            <p style="margin:0 0 24px;font-size:14px;color:#374151;">
              After 5 days, upgrade to <strong>BDC Manager Desk Pro ($75/mo)</strong>
              for unlimited access to everything.
            </p>
            <a href="{_app_url}/marketplace-hub"
               style="display:inline-block;background:#f97316;color:#fff;padding:13px 26px;
                      border-radius:7px;text-decoration:none;font-weight:700;font-size:14px;">
              Open Your Desk ->
            </a>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 20px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              Questions? Reply to this email — we read everything.<br>
              — The BDC Manager Desk Team
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
                _send_email(email, "Welcome to BDC Manager Desk", _welcome_text, _welcome_html)
                self._json(result, 201)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            return

        if path == "/api/auth/login":
            _ip = self._client_ip()
            _now = time.time()
            _hist = [t for t in _LOGIN_FAILS.get(_ip, []) if _now - t < _LOGIN_FAIL_WINDOW]
            if len(_hist) >= _LOGIN_FAIL_MAX:
                self._json({
                    "error": "Too many login attempts. Try again later.",
                    "retryAfterSec": int(_LOGIN_FAIL_WINDOW),
                }, 429)
                return
            username = payload.get("username", "").strip().lower()
            password = payload.get("password", "")
            try:
                result = UserManager.login(username, password)
                _LOGIN_FAILS[_ip] = []
                _secure = " Secure;" if (
                    (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"
                    or (APP_BASE_URL or "").startswith("https")
                ) else ""
                _cookie = (
                    f"bdc_session={result['token']}; HttpOnly; Path=/; "
                    f"SameSite=Strict; Max-Age={7 * 24 * 3600};{_secure}"
                )
                self._json(result, 200, extra_headers=[("Set-Cookie", _cookie)])
            except ValueError as exc:
                _hist.append(_now)
                _LOGIN_FAILS[_ip] = _hist
                self._json({"error": str(exc) or "Invalid credentials"}, 401)
            return

        # Local-development auto-login. 404s unless DEV_AUTOLOGIN is enabled,
        # which requires the on-disk SQLite preview DB (no DATABASE_URL).
        if path == "/api/auth/dev-login":
            if not DEV_AUTOLOGIN:
                self._json({"error": "Not found."}, 404)
                return
            try:
                requested = (payload.get("username") or DEV_LOGIN_USER)
                self._json(UserManager.dev_login(requested))
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            return

        if path == "/api/auth/logout":
            token = self._get_bearer_token()
            if token:
                UserManager.logout(token)
            _clear = "bdc_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0"
            self._json({"status": "logged_out"}, 200, extra_headers=[("Set-Cookie", _clear)])
            return

        # ── Password recovery (public — no auth token required) ───────
        if path == "/api/auth/forgot-password":
            email = payload.get("email", "").strip().lower()
            if not email or "@" not in email:
                self._json({"error": "A valid email address is required."}, 400)
                return
            try:
                # Verify SMTP credentials are present before doing anything
                _eu = os.environ.get('EMAIL_USER', '').strip()
                _ep = os.environ.get('EMAIL_PASS', '').strip()
                if not _eu or not _ep:
                    raise RuntimeError(
                        "EMAIL_USER / EMAIL_PASS are not configured in Secrets."
                    )

                token_val = UserManager.request_password_reset(email)
                if token_val:
                    # Build reset URL — APP_BASE_URL env var overrides the Host header
                    _host     = self.headers.get("Host", "localhost")
                    _base_url = APP_BASE_URL or f"https://{_host}"
                    reset_url = f"{_base_url}/reset-password?token={token_val}"

                    _reset_text = (
                        "Hi,\n\n"
                        "You requested a password reset for your BDC Manager Desk account.\n\n"
                        "Click the link below to set a new password (expires in 1 hour):\n\n"
                        f"  {reset_url}\n\n"
                        "If you didn't request this, you can safely ignore this email — "
                        "your password will not change.\n\n"
                        "— BDC Manager Desk"
                    )
                    _reset_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#1e293b;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Reset Your Password</h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;">
              You requested a password reset for your BDC Manager Desk account.
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#374151;">
              Click the button below to set a new password.
              This link expires in <strong>1 hour</strong>.
            </p>
            <a href="{reset_url}"
               style="display:inline-block;background:#1e293b;color:#fff;padding:13px 26px;
                      border-radius:7px;text-decoration:none;font-weight:700;font-size:14px;">
              Reset My Password ->
            </a>
            <p style="margin:24px 0 4px;font-size:12px;color:#9ca3af;">
              If the button doesn't work, paste this link into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:12px;">
              <a href="{reset_url}" style="color:#3b82f6;word-break:break-all;">{reset_url}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              If you didn't request this, you can safely ignore this email —
              your password won't change.<br><br>— BDC Manager Desk
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
                    import traceback as _tb
                    try:
                        sent = _send_email(
                            email,
                            "Reset your BDC Manager Desk password",
                            _reset_text,
                            _reset_html,
                        )
                    except Exception as smtp_err:
                        # Explicit sendMail exception logging (Nodemailer parity)
                        print(f"Forgot Password Email Error (sendMail): {smtp_err}")
                        print(_tb.format_exc())
                        raise RuntimeError(f"SMTP sendMail failed: {smtp_err}") from smtp_err

                    if not sent:
                        raise RuntimeError("SMTP delivery failed for the password-reset email.")

                # Enumeration-safe: same message whether the account exists or not
                self._json({"message": "If an account exists with that email, a reset link has been sent."})

            except Exception as err:
                print(f"Forgot Password Email Error: {err}")
                self._json(
                    {"error": "Failed to send reset email. Please verify SMTP credentials in Secrets."},
                    500,
                )
            return

        # ── Resend email verification (protected — must be logged in) ──
        if path == "/api/auth/resend-verification":
            _rv_user = self._require_auth()
            if not _rv_user:
                return
            if _rv_user.get("email_verified"):
                self._json({"status": "ok", "message": "Email is already verified."})
                return
            _rv_email = _rv_user.get("email", "").strip()
            if not _rv_email:
                self._json({"error": "No email address on file for this account."}, 400)
                return
            try:
                _eu = os.environ.get('EMAIL_USER', '').strip()
                _ep = os.environ.get('EMAIL_PASS', '').strip()
                if not _eu or not _ep:
                    raise RuntimeError("SMTP credentials not configured (EMAIL_USER / EMAIL_PASS missing).")
                # Generate a fresh token and persist it
                _new_vtok = secrets.token_urlsafe(32)
                _rvdb = sqlite3.connect(DB_FILE)
                try:
                    _rvdb.execute(
                        "UPDATE users SET verification_token = ? WHERE id = ?",
                        (_new_vtok, _rv_user["id"]),
                    )
                    _rvdb.commit()
                except Exception:
                    try:
                        _rvdb.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    _rvdb.close()
                _rv_app_url = APP_BASE_URL
                _rv_verify_url = f"{_rv_app_url}/verify-email?token={_new_vtok}"
                _rv_text = (
                    "Hi,\n\nHere is your BDC Manager Desk email verification link:\n\n"
                    f"  {_rv_verify_url}\n\n"
                    "This link can be used once. If you didn't request this, ignore this email.\n\n"
                    "— The BDC Manager Desk Team"
                )
                _rv_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;">
        <tr>
          <td style="background:#2563eb;padding:28px 32px;border-radius:10px 10px 0 0;">
            <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">Verify Your Email Address</h1>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
            <p style="margin:0 0 20px;font-size:15px;color:#374151;">
              Click the button below to verify your BDC Manager Desk email address.
            </p>
            <a href="{_rv_verify_url}"
               style="display:inline-block;background:#2563eb;color:#fff;padding:13px 26px;
                      border-radius:7px;text-decoration:none;font-weight:700;font-size:14px;">
              Verify My Email ->
            </a>
            <p style="margin:24px 0 4px;font-size:12px;color:#9ca3af;">
              If the button doesn't work, paste this link into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:12px;">
              <a href="{_rv_verify_url}" style="color:#2563eb;word-break:break-all;">{_rv_verify_url}</a>
            </p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 20px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">— BDC Manager Desk</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
                sent = _send_email(_rv_email, "Verify your BDC Manager Desk email", _rv_text, _rv_html)
                if not sent:
                    raise RuntimeError("SMTP delivery failed for the verification email.")
                self._json({"status": "ok", "message": "Verification email sent."})
            except Exception as _rv_err:
                print(f"[AUTH] resend-verification error: {_rv_err}")
                self._json(
                    {"error": "Failed to send verification email. Please check SMTP credentials in Secrets."},
                    500,
                )
            return

        if path == "/api/auth/reset-password":
            token_val    = payload.get("token", "").strip()
            new_password = payload.get("new_password", "")
            if not token_val:
                self._json({"error": "Reset token is required."}, 400)
                return
            try:
                UserManager.reset_password_with_token(token_val, new_password)
                self._json({"status": "ok"})
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            return

        # ── TikTok Hub: inventory-backed 3-style script generator (public/local) ──
        # Must live ABOVE the protected-routes gate so local VIN lookups work
        # without a Bearer token. Authenticated callers are still scoped to
        # their own marketplace_inventory rows.
        if path in (
            "/api/generate-tiktok-script",
            "/api/v1/generate-tiktok-script",
            "/api/tiktok/generate-script",
        ):
            try:
                from tiktok_engine import generate_tiktok_scripts_for_vin
            except ImportError:
                self._json({"error": "tiktok_engine module not available."}, 500)
                return

            vin = (payload.get("vin") or "").strip()
            if not vin:
                self._json({"error": "vin is required."}, 400)
                return

            scoped_user = None
            token = self._get_bearer_token()
            if token:
                scoped_user = UserManager.get_user_by_token(token)
                if scoped_user and scoped_user.get("_session_displaced"):
                    scoped_user = None

            try:
                uid = int(scoped_user["id"]) if scoped_user else None
                self._json(generate_tiktok_scripts_for_vin(vin, user_id=uid))
            except ValueError as exc:
                self._json({"error": str(exc)}, 404)
            except Exception as exc:
                print(f"[TIKTOK] generate-script error: {exc}")
                self._json({"error": "Script generation failed."}, 500)
            return

        # ── Lead Center: log-action + generate-reply (public/local) ─────────
        # Above the auth gate to match GET /api/leads — the Lead Center works
        # without a session token. An optional Bearer token is still read so
        # logged actions can be attributed to a named rep when available.
        if path in ("/api/leads/log-action", "/api/v1/leads/log-action"):
            try:
                from leads_engine import log_action as _log_action
            except ImportError:
                self._json({"error": "leads_engine not available."}, 500)
                return
            lead_id = payload.get("lead_id")
            if not lead_id:
                self._json({"error": "lead_id is required."}, 400)
                return
            try:
                result = _log_action(
                    lead_id=int(lead_id),
                    action_type=str(payload.get("action_type", "call")),
                    note=str(payload.get("note", "")),
                    actor=str(payload.get("actor") or self._optional_username()),
                    new_status=payload.get("new_status") or None,
                    db_path=DB_FILE,
                )
                self._json(result)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[LEADS] log-action error: {exc}")
                self._json({"error": "Failed to log action."}, 500)
            return

        if path in ("/api/leads/generate-reply", "/api/v1/leads/generate-reply"):
            try:
                from leads_engine import generate_reply as _generate_reply
            except ImportError:
                self._json({"error": "leads_engine not available."}, 500)
                return
            lead_id = payload.get("lead_id")
            if not lead_id:
                self._json({"error": "lead_id is required."}, 400)
                return
            try:
                result = _generate_reply(
                    lead_id=int(lead_id),
                    rep_name=str(payload.get("rep_name") or self._optional_username() or "your BDC team"),
                    db_path=DB_FILE,
                )
                self._json(result)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[LEADS] generate-reply error: {exc}")
                self._json({"error": "Reply generation failed."}, 500)
            return

        # ── Marketplace publisher: copy generation (public/local) ───────────
        if path in ("/api/marketplace/generate-copy", "/api/v1/marketplace/generate-copy"):
            try:
                from marketplace_engine import generate_copy as _generate_copy
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            vin = str(payload.get("vin", "")).strip()
            if not vin:
                self._json({"error": "vin is required."}, 400)
                return
            try:
                self._json(_generate_copy(vin, db_path=DB_FILE))
            except LookupError as exc:
                self._json({"error": str(exc)}, 404)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] generate-copy error: {exc}")
                self._json({"error": "Copy generation failed."}, 500)
            return

        # ── AI Vehicle Description Generator (structured Marketplace copy) ─
        if path in (
            "/api/generate-description",
            "/api/marketplace/generate-description",
            "/api/v1/generate-description",
            "/api/v1/marketplace/generate-description",
        ):
            try:
                from marketplace_engine import (
                    build_structured_description as _build_desc,
                    generate_copy as _generate_copy,
                )
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            try:
                # Prefer explicit field payload; fall back to VIN lookup.
                _has_fields = any(
                    payload.get(k)
                    for k in ("year", "Year", "make", "Make", "model", "Model",
                              "price", "Price", "mileage", "Mileage")
                )
                if _has_fields or not str(payload.get("vin") or "").strip():
                    result = _build_desc(payload, db_path=DB_FILE)
                else:
                    # VIN-only -> reuse generate_copy then wrap keys for the modal.
                    _gc = _generate_copy(str(payload.get("vin")).strip(), db_path=DB_FILE)
                    result = {
                        **_gc,
                        "description": _gc.get("ai_description", ""),
                    }
                self._json(result)
            except LookupError as exc:
                self._json({"error": str(exc)}, 404)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] generate-description error: {exc}")
                self._json({"error": "Description generation failed."}, 500)
            return

        # ── Save AI description onto the inventory row ─────────────────────
        if path in (
            "/api/marketplace/save-description",
            "/api/v1/marketplace/save-description",
            "/api/save-description",
        ):
            try:
                from marketplace_engine import save_vehicle_ai_description as _save_desc
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            _sd_vin = str(payload.get("vin") or "").strip()
            _sd_text = str(
                payload.get("ai_description")
                or payload.get("description")
                or ""
            ).strip()
            if not _sd_vin or not _sd_text:
                self._json({"error": "vin and description are required."}, 400)
                return
            _sd_uid = _local_settings_user_id(self._get_bearer_token())
            try:
                self._json(_save_desc(
                    _sd_vin, _sd_text, user_id=_sd_uid, db_path=DB_FILE,
                ))
            except LookupError as exc:
                self._json({"error": str(exc)}, 404)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] save-description error: {exc}")
                self._json({"error": "Failed to save description."}, 500)
            return

        # ── Marketplace publisher: schedule / instant publish (public/local) ─
        if path in ("/api/marketplace/schedule", "/api/v1/marketplace/schedule"):
            try:
                from marketplace_engine import schedule_vehicle as _schedule_vehicle
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            vin = str(payload.get("vin", "")).strip()
            if not vin:
                self._json({"error": "vin is required."}, 400)
                return
            _publish_now = bool(
                payload.get("publish_now")
                or payload.get("post_now")
                or payload.get("instant")
            )
            try:
                _sched = _schedule_vehicle(
                    vin=vin,
                    scheduled_time=payload.get("scheduled_time") or None,
                    publish_now=_publish_now,
                    ai_description=payload.get("ai_description"),
                    db_path=DB_FILE,
                )
                if isinstance(_sched, dict):
                    _sched.setdefault("success", True)
                self._json(_sched)
            except LookupError as exc:
                self._json({"success": False, "error": str(exc)}, 404)
            except PermissionError as exc:
                # Daily cap reached — surface quota so the UI can show the gauge.
                try:
                    from marketplace_engine import get_quota as _get_quota
                    _q = _get_quota(db_path=DB_FILE)
                except Exception:
                    _q = None
                self._json({"success": False, "error": str(exc), "quota": _q}, 429)
            except ValueError as exc:
                self._json({"success": False, "error": str(exc)}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] schedule error: {exc}")
                self._json({"success": False, "error": "Scheduling failed."}, 500)
            return

        # ── Marketplace publisher: pause / resume / mark failed (public/local) ─
        if path in ("/api/marketplace/queue/status", "/api/v1/marketplace/queue/status"):
            try:
                from marketplace_engine import set_status as _set_status
            except ImportError:
                self._json({"error": "marketplace_engine not available."}, 500)
                return
            _item_id = payload.get("id") or payload.get("item_id")
            _new_status = str(payload.get("status", "")).strip()
            if not _item_id or not _new_status:
                self._json({"error": "id and status are required."}, 400)
                return
            try:
                self._json(_set_status(
                    item_id=int(_item_id),
                    status=_new_status,
                    error_message=str(payload.get("error_message", "")),
                    db_path=DB_FILE,
                ))
            except LookupError as exc:
                self._json({"error": str(exc)}, 404)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                print(f"[MARKETPLACE] queue/status error: {exc}")
                self._json({"error": "Status update failed."}, 500)
            return

        # ── Cancel an in-flight inventory sync (public/local, no token) ───
        if path in ("/api/scrape/cancel", "/api/sync/cancel",
                    "/api/v1/scrape/cancel", "/api/v1/sync/cancel"):
            _cx_uid = _local_settings_user_id(self._get_bearer_token())
            if not _cx_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return
            # Cancellation is disabled — scrapes always run to completion.
            # Acknowledge the request so the UI can exit its cancelling state
            # without aborting the worker.
            if _scraper_engine is not None:
                try:
                    _scraper_engine.clear_all_cancel_flags_for_user(_cx_uid)
                    _scraper_engine.set_cancel_sync_requested(False, user_id=_cx_uid)
                except Exception:
                    pass
            _SYNC_JOBS.setdefault(_cx_uid, {}).update({
                "cancel_status": "running",
                "phase": _SYNC_JOBS.get(_cx_uid, {}).get("phase") or "fetching",
            })
            self._json({
                "status": "ignored",
                "message": "Sync cancellation is disabled — scrape will finish normally.",
                "user_id": _cx_uid,
                "cancel_sync_requested": False,
            })
            return

        # ── Inventory scrape / sync trigger (public/local, no token) ──────────
        # Runs the same full-crawl pipeline as /api/v1/marketplace/sync but
        # resolves the account locally, so "Sync All Inventory" works without a
        # session. Scrapes whatever Used/New URLs are configured for that user.
        if path in ("/api/scrape", "/api/sync",
                    "/api/v1/scrape", "/api/v1/sync"):
            _sc_uid = _local_settings_user_id(self._get_bearer_token())
            if not _sc_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return

            _sc_job = _SYNC_JOBS.get(_sc_uid, {})
            if _sc_job.get("syncing"):
                self._json({
                    "status":   "already_running",
                    "phase":    _sc_job.get("phase", "unknown"),
                    "count":    _sc_job.get("synced", 0),
                    "synced":   _sc_job.get("synced", 0),
                    "total":    _sc_job.get("total", 0),
                    "enriched": _sc_job.get("enriched", 0),
                    "message":  "A sync is already running.",
                    "user_id":  _sc_uid,
                    "session_id": _sc_job.get("session_id", ""),
                })
                return

            # Absolute beginning of a NEW sync: wipe leftover Cancel Sync flags
            # and force a clean slate BEFORE any scrape work starts.
            if _scraper_engine is not None:
                _scraper_engine.reset_sync_cancellation(_sc_uid)
                _scraper_engine.set_cancel_sync_requested(False, user_id=_sc_uid)

            _sc_settings = UserManager.get_settings_by_id(_sc_uid)
            _sc_used = (_sc_settings.get("inventory_url_used") or "").strip()
            _sc_new  = (_sc_settings.get("inventory_url_new")  or "").strip()
            if not (_sc_used or _sc_new):
                # Multi-location configs may only live in inventory_locations.
                if _scraper_engine is not None:
                    _sc_locs = _scraper_engine.normalize_inventory_locations(
                        _sc_settings.get("inventory_locations")
                    )
                    for _loc in _sc_locs:
                        _sc_used = _sc_used or (_loc.get("inventory_url_used") or "").strip()
                        _sc_new = _sc_new or (_loc.get("inventory_url_new") or "").strip()
            if not (_sc_used or _sc_new):
                self._json({
                    "status":  "error",
                    "count":   0,
                    "message": "No inventory URL configured. Add your Used or "
                               "New inventory URL in the setup panel first.",
                }, 400)
                return

            # Clear rows inherited from a previously configured dealer site so
            # the scrape repopulates from the current URLs only.
            _sc_hosts  = _dealer_hosts(_sc_used, _sc_new)
            _sc_purged = _purge_foreign_inventory(_sc_uid, _sc_hosts)

            _sc_session = ""
            if _scraper_engine is not None:
                _sc_session = _scraper_engine.start_session(_sc_uid)
                _scraper_engine.ensure_session_running(_sc_session, _sc_uid)
                _scraper_engine.set_cancel_sync_requested(
                    False, session_id=_sc_session, user_id=_sc_uid,
                )

            # Seed the job record synchronously so an immediate status poll
            # reports "syncing" instead of a stale idle/done state.
            _SYNC_JOBS.setdefault(_sc_uid, {}).update({
                "syncing": True, "phase": "starting", "synced": 0,
                "total": 0, "enriched": 0, "done": False, "error": "",
                "session_id": _sc_session,
                "cancel_status": "running",
                "reason": "",
            })
            print(f"[SCRAPE] Manual sync for user {_sc_uid} "
                  f"session={_sc_session!r} "
                  f"(used={_sc_used!r}, new={_sc_new!r}, purged={_sc_purged})")

            # /api/sync -> background + progress polling (drives the UI).
            # /api/scrape -> run inline and return the final vehicle count.
            if path in ("/api/sync", "/api/v1/sync"):
                threading.Thread(
                    target=_sync_full_crawl,
                    args=(_sc_uid, _sc_session or None),
                    daemon=True,
                ).start()
                self._json({
                    "status":     "started",
                    "message":    "Syncing inventory…",
                    "purged":     _sc_purged,
                    "user_id":    _sc_uid,
                    "session_id": _sc_session,
                    "url_used":   _sc_used,
                    "url_new":    _sc_new,
                    "timestamp":  datetime.now().isoformat(),
                })
                return

            try:
                _sync_full_crawl(_sc_uid, _sc_session or None)
                _sc_done  = _SYNC_JOBS.get(_sc_uid, {})
                _sc_count = (MarketplaceDB.count(_sc_uid) or {}).get("ACTIVE", 0)
                _sc_err   = _sc_done.get("error", "")
                if _sc_err and _sc_done.get("reason") != "cancelled":
                    self._json({
                        "status":  "error",
                        "count":   _sc_count,
                        "message": _sc_err,
                        "purged":  _sc_purged,
                        "session_id": _sc_session,
                    })
                    return
                _sc_cancelled = _sc_done.get("reason") == "cancelled"
                _sc_msg = (
                    "Sync stopped by user. Partial inventory saved."
                    if _sc_cancelled
                    else (
                        f"Sync complete. {_sc_count:,} vehicles loaded."
                        if _sc_count
                        else "Sync complete. No vehicles were found."
                    )
                )
                self._json({
                    "status":   "cancelled" if _sc_cancelled else "success",
                    "count":    _sc_count,
                    "message":  _sc_msg,
                    "purged":   _sc_purged,
                    "url_used": _sc_used,
                    "url_new":  _sc_new,
                    "session_id": _sc_session,
                })
            except Exception as exc:
                _SYNC_JOBS.setdefault(_sc_uid, {}).update({
                    "syncing": False, "done": True, "error": str(exc),
                    "reason": "scrape_error",
                    "cancel_status": "completed",
                })
                print(f"[SCRAPE] Inline scrape failed for user {_sc_uid}: {exc}")
                self._json({
                    "status":  "error",
                    "count":   (MarketplaceDB.count(_sc_uid) or {}).get("ACTIVE", 0),
                    "message": f"Scrape failed: {exc}",
                    "session_id": _sc_session,
                })
            return

        # ── Marketplace scraper/Meta settings save (public/local, no token) ───
        # Mirrors POST /api/v1/settings but resolves the account locally instead
        # of demanding a session, so the Hub's setup form always saves.
        if path == "/api/marketplace/settings":
            _mss_uid = _local_settings_user_id(self._get_bearer_token())
            if not _mss_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return

            _mss_used_raw = payload.get("inventory_url_used")
            _mss_new_raw  = payload.get("inventory_url_new")
            _mss_used = _mss_used_raw.strip() if isinstance(_mss_used_raw, str) else (
                None if _mss_used_raw is None else str(_mss_used_raw).strip()
            )
            _mss_new  = _mss_new_raw.strip()  if isinstance(_mss_new_raw, str) else (
                None if _mss_new_raw is None else str(_mss_new_raw).strip()
            )

            # Multi-location array — preferred over legacy single URL fields.
            _mss_locs_json = None
            _mss_locs_list: list[dict] = []
            if "inventory_locations" in payload:
                if _scraper_engine is not None:
                    _mss_locs_list = _scraper_engine.normalize_inventory_locations(
                        payload.get("inventory_locations")
                    )
                    _mss_locs_json = _scraper_engine.locations_to_json(_mss_locs_list)
                else:
                    _raw_locs = payload.get("inventory_locations") or []
                    _mss_locs_list = _raw_locs if isinstance(_raw_locs, list) else []
                    _mss_locs_json = json.dumps(_mss_locs_list, ensure_ascii=False)
                # Mirror first location into legacy columns for older workers.
                if _mss_locs_list:
                    if _mss_used is None:
                        _mss_used = _mss_locs_list[0].get("inventory_url_used") or ""
                    if _mss_new is None:
                        _mss_new = _mss_locs_list[0].get("inventory_url_new") or ""
                elif _mss_used is None and _mss_new is None:
                    _mss_used = ""
                    _mss_new = ""

            for _mss_label, _mss_url in (("Used inventory URL", _mss_used),
                                         ("New inventory URL",  _mss_new)):
                if _mss_url and not (_mss_url.startswith("http://") or
                                     _mss_url.startswith("https://")):
                    self._json(
                        {"error": f"{_mss_label} must start with http:// or https://"},
                        400,
                    )
                    return
            for _li, _loc in enumerate(_mss_locs_list):
                for _lk, _llabel in (
                    ("inventory_url_used", "Used Inventory URL"),
                    ("inventory_url_new", "New Inventory URL"),
                ):
                    _lu = (_loc.get(_lk) or "").strip()
                    if _lu and not (_lu.startswith("http://") or _lu.startswith("https://")):
                        self._json(
                            {"error": f"Location {_li + 1} {_llabel} must start with http:// or https://"},
                            400,
                        )
                        return
                _csv_u = (_loc.get("csv_url") or "").strip()
                if _loc.get("csv_enabled") and not _csv_u:
                    self._json(
                        {"error": f"Location {_li + 1}: CSV File URL is required when Automated CSV Feed is enabled"},
                        400,
                    )
                    return
                if _csv_u and not (
                    _csv_u.startswith("http://")
                    or _csv_u.startswith("https://")
                    or _csv_u.startswith("file://")
                    or len(_csv_u) > 1  # local path e.g. C:\... or /var/...
                ):
                    self._json(
                        {"error": f"Location {_li + 1}: CSV File URL / Remote Path is invalid"},
                        400,
                    )
                    return

            # Only persist keys the form actually sent — never blank a column
            # that wasn't part of this submission.
            _mss_fields = [
                ("inventory_url_used",           _mss_used),
                ("inventory_url_new",            _mss_new),
                ("inventory_locations",          _mss_locs_json),
                ("salesperson_filter",           payload.get("salesperson_filter")),
                ("scraper_frequency",            payload.get("scraper_frequency")),
                ("dealer_name",                  payload.get("dealer_name")),
                ("facebook_business_manager_id", payload.get("facebook_business_manager_id")),
                ("commerce_catalog_id",          payload.get("commerce_catalog_id")),
                ("meta_pixel_id",                payload.get("meta_pixel_id")),
            ]
            _mss_set = [(c, v) for c, v in _mss_fields if v is not None]
            try:
                if _mss_set:
                    _mss_conn = sqlite3.connect(DB_FILE)
                    try:
                        _mss_conn.execute(
                            "UPDATE users SET "
                            + ", ".join(f"{c} = ?" for c, _ in _mss_set)
                            + " WHERE id = ?",
                            [v for _, v in _mss_set] + [_mss_uid],
                        )
                        _mss_conn.commit()
                    finally:
                        _mss_conn.close()
                # Always dual-write to dealer_config.json so refresh survives
                # even if the users-row update is skipped or ambiguous.
                if _dealer_config is not None:
                    _disk_payload = {
                        "user_id": _mss_uid,
                        "inventory_locations": _mss_locs_list if "inventory_locations" in payload else None,
                        "inventory_url_used": _mss_used,
                        "inventory_url_new": _mss_new,
                        "salesperson_filter": payload.get("salesperson_filter"),
                        "scraper_frequency": payload.get("scraper_frequency"),
                        "dealer_name": payload.get("dealer_name"),
                        "facebook_business_manager_id": payload.get("facebook_business_manager_id"),
                        "commerce_catalog_id": payload.get("commerce_catalog_id"),
                        "meta_pixel_id": payload.get("meta_pixel_id"),
                    }
                    # If locations weren't in this POST, keep whatever is on disk / DB.
                    if _disk_payload["inventory_locations"] is None and _mss_locs_json is None:
                        _disk_payload.pop("inventory_locations", None)
                    _dealer_config.save_dealer_config(_disk_payload)
            except Exception as exc:
                print(f"[MARKETPLACE] settings save error: {exc}")
                self._json({"error": "Failed to save settings."}, 500)
                return

            _mss_has_urls = bool(
                (_mss_used or "")
                or (_mss_new or "")
                or any(
                    (l.get("inventory_url_used") or l.get("inventory_url_new"))
                    for l in _mss_locs_list
                )
            )
            self._json({
                "status":         "saved",
                "message":        "Settings Saved Successfully!",
                "sync_triggered": _mss_has_urls,
                "user_id":        _mss_uid,
                "config_file":    (
                    _dealer_config.config_path() if _dealer_config is not None else ""
                ),
            })

            # Post-save: drop stale non-posted inventory and re-scrape so the
            # showroom reflects the new source URLs.  'posted' rows survive to
            # preserve the Facebook listing audit trail.
            if _mss_has_urls:
                try:
                    _mss_pc = sqlite3.connect(DB_FILE)
                    _mss_pc.execute(
                        "DELETE FROM marketplace_inventory "
                        "WHERE user_id = ? AND posted_status != 'posted'",
                        (_mss_uid,),
                    )
                    _mss_pc.commit()
                    _mss_pc.close()
                    threading.Thread(
                        target=_sync_user_inventory,
                        args=(_mss_uid, _mss_used or "", _mss_new or ""),
                        daemon=True,
                    ).start()
                    print(f"[MARKETPLACE] settings saved + re-sync for user {_mss_uid}")
                except Exception as _mss_err:
                    print(f"[MARKETPLACE] post-save re-sync failed: {_mss_err}")
            # Also kick CSV feeds that were just enabled (non-blocking).
            if _mss_locs_list and any(
                loc.get("csv_enabled") and (loc.get("csv_url") or "").strip()
                for loc in _mss_locs_list
            ):
                try:
                    threading.Thread(
                        target=_run_csv_feeds_for_user,
                        args=(_mss_uid, _mss_locs_list),
                        daemon=True,
                    ).start()
                except Exception as _csv_kick_err:
                    print(f"[CSV] post-save ingest kick failed: {_csv_kick_err}")
            return

        # ── Marketplace CSV feed: Sync CSV Now (public/local) ─────────────
        if path in ("/api/marketplace/csv-sync", "/api/v1/marketplace/csv-sync"):
            _csv_uid = _local_settings_user_id(self._get_bearer_token())
            if not _csv_uid:
                self._json({"error": "No local account exists yet."}, 404)
                return
            if _csv_engine is None:
                self._json({"error": "CSV feed engine is unavailable."}, 500)
                return
            _csv_loc = str(payload.get("location_name") or "").strip()
            _csv_url = str(payload.get("csv_url") or "").strip()
            try:
                _csv_result = _run_csv_feeds_for_user(
                    _csv_uid,
                    location_name=_csv_loc or None,
                    csv_url=_csv_url or None,
                    force=True,
                )
            except Exception as _csv_exc:
                print(f"[CSV] sync-now failed for u{_csv_uid}: {_csv_exc}")
                self._json({"error": f"CSV sync failed: {_csv_exc}"}, 500)
                return
            if not _csv_result.get("feeds"):
                self._json({
                    "status": "empty",
                    "message": "No CSV feed configured for this location. Enable Automated CSV Feed and enter a CSV URL first.",
                    "synced": 0,
                    "results": _csv_result.get("results") or [],
                })
                return
            _first_err = next(
                (r.get("error") for r in (_csv_result.get("results") or []) if r.get("error")),
                "",
            )
            self._json({
                "status":  "ok" if _csv_result.get("ok") else "error",
                "message": (
                    f"CSV sync complete — {_csv_result.get('synced', 0)} vehicle(s) upserted."
                    if _csv_result.get("ok")
                    else (_first_err or "CSV sync failed.")
                ),
                "synced":  _csv_result.get("synced", 0),
                "feeds":   _csv_result.get("feeds", 0),
                "results": _csv_result.get("results") or [],
                "error":   _first_err,
            })
            return

        # ── Protected routes ──────────────────────────────────────────
        user = self._require_auth()
        if not user:
            return

        token = self._get_bearer_token()

        if path == "/api/auth/change-password":
            current_password = payload.get("current_password", "")
            new_password     = payload.get("new_password",     "")
            confirm_password = payload.get("confirm_password", "")
            if new_password != confirm_password:
                self._json({"error": "New passwords do not match."}, 400)
                return
            try:
                UserManager.change_password(user["id"], current_password, new_password)
                self._json({"status": "ok"})
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            return

        # ── Forms draft — persist shared master fields for paper templates ──
        if path == "/api/v1/forms/draft":
            _buyer  = str(payload.get("buyer_name",   "") or "")[:120]
            _vin    = str(payload.get("vin",          "") or "")[:17].upper()
            _stock  = str(payload.get("stock_number", "") or "")[:40]
            _price  = str(payload.get("price",        "") or "")[:40]
            _miles  = str(payload.get("mileage",      "") or "")[:40]
            _active = str(payload.get("active_form",  "test_drive") or "test_drive")
            if _active not in ("test_drive", "gate_pass", "delivery"):
                _active = "test_drive"
            _notes  = str(payload.get("notes", "") or "")[:2000]
            _fc = sqlite3.connect(DB_FILE)
            try:
                _fc.execute(
                    """INSERT INTO forms_drafts
                           (user_id, buyer_name, vin, stock_number, price,
                            mileage, active_form, notes, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                       ON CONFLICT(user_id) DO UPDATE SET
                           buyer_name   = EXCLUDED.buyer_name,
                           vin          = EXCLUDED.vin,
                           stock_number = EXCLUDED.stock_number,
                           price        = EXCLUDED.price,
                           mileage      = EXCLUDED.mileage,
                           active_form  = EXCLUDED.active_form,
                           notes        = EXCLUDED.notes,
                           updated_at   = CURRENT_TIMESTAMP""",
                    (user["id"], _buyer, _vin, _stock, _price, _miles, _active, _notes),
                )
                _fc.commit()
            except Exception as _fe:
                try:
                    _fc.rollback()
                except Exception:
                    pass
                self._json({"error": f"Failed to save draft: {_fe}"}, 500)
                return
            finally:
                _fc.close()
            self._json({"status": "ok"})
            return

        # ── Update email address (authenticated — requires current password) ──
        if path == "/api/user/update-email":
            _ue_new_email = payload.get("new_email", "").strip().lower()
            _ue_cur_pw    = payload.get("current_password", "")

            if not _ue_new_email or "@" not in _ue_new_email:
                self._json({"error": "A valid new email address is required.", "success": False}, 400)
                return
            if not _ue_cur_pw:
                self._json({"error": "Current password is required to confirm this change.", "success": False}, 400)
                return

            # Validate format / not webmail / not disposable
            try:
                _ue_new_email = _validate_email(_ue_new_email)
            except ValueError as _ue_exc:
                self._json({"error": str(_ue_exc), "success": False}, 400)
                return

            _ue_conn = sqlite3.connect(DB_FILE)
            _ue_conn.row_factory = sqlite3.Row
            _ue_row  = _ue_conn.execute(
                "SELECT id, email, password_hash FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()

            if not _ue_row or not _verify_password(_ue_cur_pw, _ue_row["password_hash"]):
                _ue_conn.close()
                self._json({"error": "Incorrect current password.", "success": False}, 400)
                return

            _ue_old_email = (_ue_row["email"] or "").strip().lower()

            if _ue_new_email == _ue_old_email:
                _ue_conn.close()
                self._json({"error": "New email address is the same as your current email.", "success": False}, 400)
                return

            # Reject if new email is already registered to a different account
            if _ue_conn.execute(
                "SELECT id FROM users WHERE email = ? AND email != '' AND id != ?",
                (_ue_new_email, user["id"]),
            ).fetchone():
                _ue_conn.close()
                self._json({"error": "That email address is already registered to another account.", "success": False}, 400)
                return

            # Generate 48-hour emergency revocation token. Email verification is
            # bypassed globally — keep email_verified = 1 after the address change.
            _ue_revert_tok  = secrets.token_urlsafe(32)
            _ue_revert_exp  = (datetime.now() + timedelta(hours=48)).isoformat()

            try:
                _ue_conn.execute(
                    """UPDATE users
                       SET email = ?, old_email_history = ?, email_revert_token = ?,
                           email_revert_expires_at = ?, email_verified = 1,
                           verification_token = NULL
                       WHERE id = ?""",
                    (_ue_new_email, _ue_old_email, _ue_revert_tok, _ue_revert_exp, user["id"]),
                )
                _ue_conn.commit()
            except Exception:
                try:
                    _ue_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _ue_conn.close()

            _notify = _dispatch_email_change_notifications(
                user_id=user["id"],
                new_email=_ue_new_email,
                old_email=_ue_old_email,
                revert_token=_ue_revert_tok,
            )
            print(f"[AUTH] Email updated for user id={user['id']} -> {_ue_new_email!r}")
            _ue_user_out = {
                "id": user["id"],
                "username": user["username"],
                "email": _ue_new_email,
                "email_verified": True,
            }
            if _notify.get("confirm_sent"):
                self._json({
                    "success": True,
                    "status": "ok",
                    "user": _ue_user_out,
                    "message": (
                        "Email updated. Check both inboxes — a security alert was sent "
                        "to your previous address."
                    ),
                })
            else:
                self._json({
                    "success": False,
                    "status": "ok",
                    "email_delivery_failed": True,
                    "error": _notify.get("error") or "Email notification failed.",
                    "user": _ue_user_out,
                    "message": (
                        "Your email address has been updated, but the confirmation "
                        f"email could not be delivered to {_ue_new_email}. "
                        "Check your spam folder or server logs."
                    ),
                }, 502)
            return

        # ── Unified profile update (phone and/or email) ────────────────
        if path in ("/api/users/me", "/api/users/update-profile"):
            _has_phone = "phone" in payload
            _has_email = bool(
                str(payload.get("new_email") or payload.get("email") or "").strip()
            )
            if not _has_phone and not _has_email:
                self._json(
                    {"error": "Provide phone and/or email fields to update.", "success": False},
                    400,
                )
                return

            if _has_phone:
                _up_phone = str(payload.get("phone") or "").strip()
                _up_conn = sqlite3.connect(DB_FILE)
                try:
                    _up_conn.execute(
                        "UPDATE users SET phone = ? WHERE id = ?",
                        (_up_phone, user["id"]),
                    )
                    _up_conn.commit()
                except Exception:
                    try:
                        _up_conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    _up_conn.close()

            _msg = "Phone number saved."
            _notify_err = ""
            if _has_email:
                # Reuse update-email logic via internal field remap
                payload = {
                    **payload,
                    "new_email": str(
                        payload.get("new_email") or payload.get("email") or ""
                    ).strip().lower(),
                }
                # Fall through by recursively handling email on this request:
                # call the same validation path by setting path temporarily.
                _ue_new_email = payload.get("new_email", "").strip().lower()
                _ue_cur_pw = payload.get("current_password", "")
                if not _ue_new_email or "@" not in _ue_new_email:
                    self._json({"error": "A valid new email address is required.", "success": False}, 400)
                    return
                if not _ue_cur_pw:
                    self._json(
                        {"error": "Current password is required to confirm this change.", "success": False},
                        400,
                    )
                    return
                try:
                    _ue_new_email = _validate_email(_ue_new_email)
                except ValueError as _ue_exc:
                    self._json({"error": str(_ue_exc), "success": False}, 400)
                    return
                _ue_conn = sqlite3.connect(DB_FILE)
                _ue_conn.row_factory = sqlite3.Row
                _ue_row = _ue_conn.execute(
                    "SELECT id, email, password_hash, phone FROM users WHERE id = ?",
                    (user["id"],),
                ).fetchone()
                if not _ue_row or not _verify_password(_ue_cur_pw, _ue_row["password_hash"]):
                    _ue_conn.close()
                    self._json({"error": "Incorrect current password.", "success": False}, 400)
                    return
                _ue_old_email = (_ue_row["email"] or "").strip().lower()
                if _ue_new_email == _ue_old_email:
                    _ue_conn.close()
                    self._json(
                        {"error": "New email address is the same as your current email.", "success": False},
                        400,
                    )
                    return
                if _ue_conn.execute(
                    "SELECT id FROM users WHERE email = ? AND email != '' AND id != ?",
                    (_ue_new_email, user["id"]),
                ).fetchone():
                    _ue_conn.close()
                    self._json(
                        {
                            "error": "That email address is already registered to another account.",
                            "success": False,
                        },
                        400,
                    )
                    return
                try:
                    _ue_revert_tok = secrets.token_urlsafe(32)
                    _ue_revert_exp = (datetime.now() + timedelta(hours=48)).isoformat()
                    _ue_conn.execute(
                        """UPDATE users
                           SET email = ?, old_email_history = ?, email_revert_token = ?,
                               email_revert_expires_at = ?, email_verified = 1,
                               verification_token = NULL
                           WHERE id = ?""",
                        (
                            _ue_new_email,
                            _ue_old_email,
                            _ue_revert_tok,
                            _ue_revert_exp,
                            user["id"],
                        ),
                    )
                    _ue_conn.commit()
                except Exception:
                    try:
                        _ue_conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    _ue_conn.close()

                _notify = _dispatch_email_change_notifications(
                    user_id=user["id"],
                    new_email=_ue_new_email,
                    old_email=_ue_old_email,
                    revert_token=_ue_revert_tok,
                )
                _notify_err = str(_notify.get("error") or "")
                if _notify.get("confirm_sent"):
                    _msg = (
                        "Email updated. A security alert was sent to your previous "
                        "address with an emergency revert link."
                    )
                else:
                    _msg = (
                        "Email updated, but confirmation delivery failed. "
                        "See error for SMTP details."
                    )
                print(
                    f"[AUTH] Profile email updated for user id={user['id']} "
                    f"-> {_ue_new_email!r} (alert={_notify.get('alert_sent')}, "
                    f"confirm={_notify.get('confirm_sent')})"
                )

            _out_conn = sqlite3.connect(DB_FILE)
            _out_conn.row_factory = sqlite3.Row
            _out = _out_conn.execute(
                "SELECT id, username, email, phone, is_admin, subscription_status, "
                "subscription_tier, org_role, organization_id, email_verified, "
                "is_suspended, created_at, recovery_id, role FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()
            _out_conn.close()
            _role = (_out["role"] or "").strip() or (
                "Admin" if user.get("is_master_admin") or _out["is_admin"] else "Reviewer"
            )
            _user_payload = {
                "id": _out["id"],
                "username": _out["username"],
                "email": _out["email"] or "",
                "phone": _out["phone"] or "",
                "is_admin": bool(_out["is_admin"]),
                "is_master_admin": bool(user.get("is_master_admin")),
                "role": _role,
                "rbac_role": _role,
                "subscription_status": _out["subscription_status"] or "inactive",
                "subscription_tier": _out["subscription_tier"] or "",
                "org_role": _out["org_role"] or "",
                "organization_id": _out["organization_id"],
                "email_verified": bool(_out["email_verified"]),
                "is_suspended": bool(_out["is_suspended"]),
                "created_at": _out["created_at"] or "",
                "recovery_id": _out["recovery_id"] or "",
            }
            if _has_email and locals().get("_notify_err"):
                self._json({
                    "success": False,
                    "status": "ok",
                    "email_delivery_failed": True,
                    "error": _notify_err,
                    "message": _msg,
                    "user": _user_payload,
                }, 502)
                return
            self._json({
                "success": True,
                "status": "ok",
                "message": _msg,
                "user": _user_payload,
            })
            return

        # ── Update phone number (authenticated) ───────────────────────────
        if path == "/api/user/update-phone":
            _up_phone = payload.get("phone", "").strip()
            _up_conn  = sqlite3.connect(DB_FILE)
            try:
                _up_conn.execute(
                    "UPDATE users SET phone = ? WHERE id = ?",
                    (_up_phone, user["id"]),
                )
                _up_conn.commit()
            except Exception:
                try:
                    _up_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _up_conn.close()
            print(f"[AUTH] Phone updated for user id={user['id']}")
            _out_conn = sqlite3.connect(DB_FILE)
            _out_conn.row_factory = sqlite3.Row
            _out = _out_conn.execute(
                "SELECT id, username, email, phone, is_admin, role, "
                "subscription_status, email_verified, recovery_id "
                "FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()
            _out_conn.close()
            _role = (_out["role"] or "").strip() or (
                "Admin" if user.get("is_master_admin") or _out["is_admin"] else "Reviewer"
            )
            self._json({
                "success": True,
                "status": "ok",
                "user": {
                    "id": _out["id"],
                    "username": _out["username"],
                    "email": _out["email"] or "",
                    "phone": _out["phone"] or "",
                    "is_admin": bool(_out["is_admin"]),
                    "is_master_admin": bool(user.get("is_master_admin")),
                    "role": _role,
                    "rbac_role": _role,
                    "subscription_status": _out["subscription_status"] or "inactive",
                    "email_verified": bool(_out["email_verified"]),
                    "recovery_id": _out["recovery_id"] or "",
                },
            })
            return

        # ── Regenerate own recovery ID ─────────────────────────────────────
        if path == "/api/user/recovery-id/regenerate":
            _new_rid = _generate_recovery_id()
            _rid_conn = sqlite3.connect(DB_FILE)
            try:
                _rid_conn.execute(
                    "UPDATE users SET recovery_id = ? WHERE id = ?",
                    (_new_rid, user["id"]),
                )
                _rid_conn.commit()
            except Exception:
                try:
                    _rid_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _rid_conn.close()
            print(f"[AUTH] Recovery ID regenerated for user id={user['id']}")
            self._json({"success": True, "status": "ok", "recovery_id": _new_rid})
            return

        if path in ["/api/v1/lead", "/api/v1/twilio/inbound"]:
            settings = UserManager.get_settings(token)
            crm_creds = {
                "crm_provider":       settings.get("crm_provider", "vinsolutions"),
                # VinSolutions
                "cox_client_id":      settings.get("cox_client_id", ""),
                "cox_client_secret":  settings.get("cox_client_secret", ""),
                "cox_dealer_id":      settings.get("cox_dealer_id", ""),
                # DealerPeak
                "dealerpeak_api_key":    settings.get("dealerpeak_api_key", ""),
                "dealerpeak_dealer_id":  settings.get("dealerpeak_dealer_id", ""),
            }
            res = handle_pipeline_lead(
                payload,
                crm_creds=crm_creds,
                user_id=user["id"],
                salesperson_id=settings.get("salesperson_id", ""),
            )
            self._json(res)

        elif path == "/api/v1/settings":
            # Hoist URL vars so the post-save cleanup block can read them.
            # Use None when a key is absent — update_settings skips None fields
            # so a partial save never wipes columns it didn't include.
            _inv_used_raw = payload.get("inventory_url_used")
            _inv_new_raw  = payload.get("inventory_url_new")
            _inv_used = _inv_used_raw.strip() if _inv_used_raw is not None else None
            _inv_new  = _inv_new_raw.strip()  if _inv_new_raw  is not None else None
            _inv_locs_json = None
            if "inventory_locations" in payload and _scraper_engine is not None:
                _inv_locs_list = _scraper_engine.normalize_inventory_locations(
                    payload.get("inventory_locations")
                )
                _inv_locs_json = _scraper_engine.locations_to_json(_inv_locs_list)
                if _inv_locs_list:
                    if _inv_used is None:
                        _inv_used = _inv_locs_list[0].get("inventory_url_used") or ""
                    if _inv_new is None:
                        _inv_new = _inv_locs_list[0].get("inventory_url_new") or ""
            _rs_uid   = _resolve_user_id(token)
            _saved_ok = False
            try:
                # Validate inventory URLs before persisting — reject non-HTTP
                # strings early so the scraper never receives a bare hostname
                # or path that would cause a urllib fetch error.
                for _label, _url in (("Used inventory URL", _inv_used),
                                     ("New inventory URL",  _inv_new)):
                    if _url and not (_url.startswith("http://") or
                                     _url.startswith("https://")):
                        self._json(
                            {"error": f"{_label} must start with http:// or https://"},
                            400,
                        )
                        return
                # Pass None for any key absent from the payload — those columns
                # will be skipped entirely in the UPDATE rather than blanked.
                BillingManager.update_settings(
                    token,
                    email=payload.get("email"),
                    phone=payload.get("phone"),
                    fb_page_id=payload.get("fb_page_id"),
                    fb_access_token=payload.get("fb_access_token"),
                    facebook_business_manager_id=payload.get("facebook_business_manager_id"),
                    commerce_catalog_id=payload.get("commerce_catalog_id"),
                    meta_pixel_id=payload.get("meta_pixel_id"),
                    catalog_token=payload.get("catalog_token"),
                    inventory_url_used=_inv_used,
                    inventory_url_new=_inv_new,
                    inventory_locations=_inv_locs_json,
                    salesperson_filter=payload.get("salesperson_filter"),
                    scraper_frequency=payload.get("scraper_frequency"),
                    dealer_name=payload.get("dealer_name"),
                    dealer_address_line1=payload.get("dealer_address_line1"),
                    dealer_city=payload.get("dealer_city"),
                    dealer_state=payload.get("dealer_state"),
                    dealer_zip=payload.get("dealer_zip"),
                    tiktok_privacy_level=payload.get("tiktok_privacy_level"),
                )
                _saved_ok = True
                self._json({
                    "status":         "saved",
                    "message":        "Settings saved. Inventory is being refreshed…",
                    "sync_triggered": bool(_inv_used or _inv_new),
                })
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except Exception as exc:
                import traceback as _tb
                print(f"[SETTINGS] save error: {exc}\n{_tb.format_exc()}")
                self._json(
                    {"error": "Failed to save settings.", "detail": str(exc)},
                    500,
                )
            # ── Post-save: purge stale inventory and trigger a fresh scrape ──────
            # Only runs when the save actually succeeded and inventory URLs exist.
            # Rows with posted_status='posted' are excluded from the purge: the
            # manager may have live Facebook listings for those vehicles and
            # deleting them destroys the audit trail.  After the re-sync those
            # VINs will be marked SOLD by mark_sold_by_condition if they no
            # longer appear in the new source, surfacing them as
            # "previously posted, now removed from feed" in the Marketplace Hub.
            if _saved_ok and _rs_uid and (_inv_used or _inv_new):
                try:
                    _rs_conn = sqlite3.connect(DB_FILE)
                    _rs_conn.execute(
                        "DELETE FROM marketplace_inventory "
                        "WHERE user_id = ? AND posted_status != 'posted'",
                        (_rs_uid,),
                    )
                    _rs_conn.commit()
                    _rs_conn.close()
                    threading.Thread(
                        target=_sync_user_inventory,
                        args=(_rs_uid, _inv_used, _inv_new),
                        daemon=True,
                    ).start()
                    print(
                        f"[SETTINGS] Inventory purged (non-posted rows) + "
                        f"re-sync triggered for user {_rs_uid} "
                        f"(used={_inv_used!r}, new={_inv_new!r})."
                    )
                except Exception as _rs_err:
                    print(f"[SETTINGS] Post-save sync trigger error: {_rs_err}")

        elif path == "/api/admin/impersonate":
            # ── Master admin role-preview switcher ───────────────────────────
            # Strictly gated: only the actual mdemoss / ADMIN_USER account may
            # call this.  All other callers receive 403.
            _imp_uid = _resolve_user_id(token)
            if not _imp_uid:
                self._json({"error": "Unauthenticated."}, 401)
                return
            _imp_conn = sqlite3.connect(DB_FILE)
            _imp_conn.row_factory = sqlite3.Row
            _imp_row  = _imp_conn.execute(
                "SELECT username, is_admin FROM users WHERE id = ?", (_imp_uid,)
            ).fetchone()
            _imp_conn.close()
            _mu_env = os.environ.get('ADMIN_USER', 'mdemoss').strip().lower()
            if (not _imp_row
                    or not _imp_row["is_admin"]
                    or (_imp_row["username"] or '').lower() != _mu_env):
                self._json({"error": "Forbidden — master admin only."}, 403)
                return
            _new_mock = payload.get("mock_role", "")
            if _new_mock not in ("", "master_admin", "rooftop_admin"):
                self._json({"error": "Invalid mock_role value."}, 400)
                return
            _imp_w = sqlite3.connect(DB_FILE)
            try:
                _imp_w.execute(
                    "UPDATE users SET mock_role = ? WHERE id = ?", (_new_mock, _imp_uid)
                )
                _imp_w.commit()
            except Exception:
                try:
                    _imp_w.rollback()
                except Exception:
                    pass
                raise
            finally:
                _imp_w.close()
            self._json({"status": "ok", "mock_role": _new_mock})

        elif path == "/api/v1/dealer-info":
            # ── Dedicated dealer profile update ─────────────────────────────
            # Only touches dealer-related columns; leaves all other user
            # settings (Facebook, inventory, billing) completely untouched.
            _diu = _resolve_user_id(token)
            if not _diu:
                self._json({"error": "Unauthenticated."}, 401)
                return
            _di_conn = sqlite3.connect(DB_FILE)
            try:
                _di_conn.execute(
                    """UPDATE users SET
                           dealer_name          = ?,
                           dealer_phone         = ?,
                           dealer_support_email = ?,
                           dealer_address_line1 = ?,
                           dealer_city          = ?,
                           dealer_state         = ?,
                           dealer_zip           = ?,
                           dealer_logo_url      = ?
                       WHERE id = ?""",
                    (
                        payload.get("dealer_name",          ""),
                        payload.get("dealer_phone",         ""),
                        payload.get("dealer_support_email", ""),
                        payload.get("dealer_address_line1", ""),
                        payload.get("dealer_city",          ""),
                        payload.get("dealer_state",         ""),
                        payload.get("dealer_zip",           ""),
                        payload.get("dealer_logo_url",      ""),
                        _diu,
                    ),
                )
                _di_conn.commit()
            except Exception:
                try:
                    _di_conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _di_conn.close()
            self._json({"status": "saved"})

        elif path == "/api/v1/settings/test":
            try:
                settings = UserManager.get_settings(token)
                crm_creds = {
                    "crm_provider":       settings.get("crm_provider", "vinsolutions"),
                    "cox_client_id":      settings.get("cox_client_id", ""),
                    "cox_client_secret":  settings.get("cox_client_secret", ""),
                    "cox_dealer_id":      settings.get("cox_dealer_id", ""),
                    "dealerpeak_api_key":    settings.get("dealerpeak_api_key", ""),
                    "dealerpeak_dealer_id":  settings.get("dealerpeak_dealer_id", ""),
                }
                ok, msg, simulated = CRMClient.test_connection(crm_creds)
                if ok:
                    self._json({"status": "ok", "message": msg, "simulation": simulated})
                else:
                    self._json({"status": "error", "message": msg, "simulation": False}, 400)
            except Exception as exc:
                import traceback as _tb
                print(f"[SETTINGS/TEST] error: {exc}\n{_tb.format_exc()}")
                self._json(
                    {"status": "error", "message": "Connection test failed.",
                     "detail": str(exc), "simulation": False},
                    500,
                )

        # ── AI Email Queue routes ─────────────────────────────────────
        elif path == "/api/v1/email/generate":
            phone = payload.get("phone_number", "").strip()
            if not phone:
                self._json({"error": "phone_number required"}, 400)
                return
            conn2 = sqlite3.connect(DB_FILE)
            conn2.row_factory = sqlite3.Row
            cur2 = conn2.cursor()
            cur2.execute(
                "SELECT first_name, last_name, opt_out FROM sessions WHERE phone_number = ?",
                (phone,),
            )
            sess_row = cur2.fetchone()
            conn2.close()
            if not sess_row:
                self._json({"error": "Session not found"}, 404)
                return
            if sess_row["opt_out"]:
                self._json({"error": "Customer has opted out of emails"}, 400)
                return
            customer_name = (
                f"{sess_row['first_name']} {sess_row['last_name']}".strip()
                or phone
            )
            result = generate_reengagement_email(phone, customer_name)
            draft_id = EmailQueueManager.create_draft(
                user_id=user["id"],
                phone_number=phone,
                customer_name=customer_name,
                summary=result["summary"],
                subject=result["subject"],
                body=result["body"],
            )
            self._json({"status": "created", "draft_id": draft_id, **result})

        elif path == "/api/v1/marketplace/sync":
            if not self._require_subscription(user):
                return
            uid = user['id']
            job = _SYNC_JOBS.get(uid, {})
            if job.get('syncing'):
                # Already running — return current progress
                self._json({
                    'status':  'already_running',
                    'phase':   job.get('phase', 'unknown'),
                    'synced':  job.get('synced', 0),
                    'total':   job.get('total', 0),
                    'enriched':job.get('enriched', 0),
                })
                return
            # Start full crawl in a background thread
            t = threading.Thread(
                target=_sync_full_crawl,
                args=(uid,),
                daemon=True,
            )
            t.start()
            self._json({
                'status':    'started',
                'timestamp': datetime.now().isoformat(),
            })

        elif path == "/api/v1/marketplace/generate-post":
            _trial_ok, _trial_err = _check_trial_access(user, 'ai_post')
            if not _trial_ok:
                self._json(_trial_err, 403); return
            vin = payload.get('vin', '').strip()
            if not vin:
                self._json({'error': 'vin required'}, 400); return
            v = MarketplaceDB.get_by_vin(vin, user['id'])
            if not v:
                self._json({'error': 'Vehicle not found'}, 404); return
            system_msg = (
                "You are an expert automotive Facebook Marketplace copywriter. "
                "Generate a high-converting listing. Return ONLY valid JSON with these keys: "
                "'title' (attention-grabbing, under 80 chars), "
                "'features' (list of 6-8 bullet strings starting with '• '), "
                "'description' (150-200 word persuasive body with a clear call to action), "
                "'hashtags' (single string of 5-6 relevant hashtags). "
                "No markdown, no code fences."
            )
            user_msg = (
                f"Vehicle: {v['year']} {v['make']} {v['model']} {v['trim']}\n"
                f"Condition: {v['condition']}\n"
                f"Mileage: {v['mileage']:,} miles\n"
                f"Price: ${v['price']:,}\n"
                f"Exterior: {v['exterior_color']}\n"
                f"Interior: {v['interior_color']}\n"
                f"Stock #: {v['stock_number']}\n"
                f"VIN: {v['vin']}\n"
                "Dealer: Moses Auto Group — Huntington, WV\n"
                "Generate the Facebook Marketplace listing JSON now."
            )
            raw = _call_openai_chat([
                {'role': 'system', 'content': system_msg},
                {'role': 'user',   'content': user_msg},
            ])
            if raw:
                try:
                    post = json.loads(raw)
                except json.JSONDecodeError:
                    post = {
                        'title':       f"{v['year']} {v['make']} {v['model']} {v['trim']} — Moses Auto Group",
                        'features':    ['• See dealer for full feature details'],
                        'description': raw,
                        'hashtags':    f"#{v['make']} #MosesAutoGroup #CarForSale",
                    }
            else:
                # Offline fallback
                post = {
                    'title':       f"🚗 {v['year']} {v['make']} {v['model']} {v['trim']} | ${v['price']:,}",
                    'features':    [
                        f"• {v['condition']} vehicle — {v['mileage']:,} miles",
                        f"• Exterior: {v['exterior_color']}",
                        f"• Interior: {v['interior_color']}",
                        f"• Stock #: {v['stock_number']}",
                        "• Moses Auto Group — Huntington, WV",
                        "• Financing available — ask for details!",
                    ],
                    'description': (
                        f"Looking for a reliable {v['year']} {v['make']} {v['model']}? "
                        f"Moses Auto Group in Huntington, WV has this {v['trim']} available now. "
                        f"This {v['condition'].lower()} vehicle has {v['mileage']:,} miles and is priced at "
                        f"${v['price']:,}. Stop by or call today — our team is ready to help you get "
                        "behind the wheel. Flexible financing options available for all credit types!"
                    ),
                    'hashtags': (
                        f"#{v['make']} #{v['model'].replace(' ','')} "
                        "#MosesAutoGroup #Huntington #CarForSale #WV"
                    ),
                }
            _consume_trial_quota(user, 'ai_post')
            self._json({'status': 'ok', 'post': post, 'vehicle': v})

        elif path == "/api/v1/marketplace/queue/generate":
            if not self._require_subscription(user):
                return
            force  = bool(payload.get('force', False))
            date   = payload.get('date', datetime.now().strftime('%Y-%m-%d'))
            result = PostingQueueManager.generate_queue(user['id'], date, force=force)
            self._json({'status': 'ok', **result})

        elif path == "/api/v1/marketplace/queue/update":
            if not self._require_subscription(user):
                return
            item_id = int(payload.get('id', 0))
            status  = payload.get('status', '')
            ok      = PostingQueueManager.update_status(item_id, status, user['id'])
            if ok:
                self._json({'status': 'ok'})
            else:
                self._json({'error': 'Invalid id or status'}, 400)

        elif path == "/api/v1/email/approve":
            email_id = payload.get("id")
            if email_id is None:
                self._json({"error": "id required"}, 400)
                return
            ok = EmailQueueManager.update_status(int(email_id), user["id"], "sent")
            if ok:
                self._json({"status": "sent"})
            else:
                self._json({"error": "Email not found"}, 404)

        elif path == "/api/v1/email/update":
            email_id = payload.get("id")
            if email_id is None:
                self._json({"error": "id required"}, 400)
                return
            ok = EmailQueueManager.update_body(
                int(email_id),
                user["id"],
                payload.get("email_subject", ""),
                payload.get("email_body", ""),
            )
            if ok:
                self._json({"status": "updated"})
            else:
                self._json({"error": "Email not found"}, 404)

        elif path == "/api/v1/email/skip":
            email_id = payload.get("id")
            if email_id is None:
                self._json({"error": "id required"}, 400)
                return
            ok = EmailQueueManager.update_status(int(email_id), user["id"], "skipped")
            if ok:
                self._json({"status": "skipped"})
            else:
                self._json({"error": "Email not found"}, 404)

        elif path == "/api/v1/email/settings":
            auto_send = bool(payload.get("auto_send_emails", False))
            conn3 = sqlite3.connect(DB_FILE)
            try:
                cur3 = conn3.cursor()
                cur3.execute(
                    "UPDATE users SET auto_send_emails = ? WHERE id = ?",
                    (1 if auto_send else 0, user["id"]),
                )
                conn3.commit()
            except Exception:
                try:
                    conn3.rollback()
                except Exception:
                    pass
                raise
            finally:
                conn3.close()
            self._json({"status": "saved", "auto_send_emails": auto_send})

        elif path == "/api/v1/marketplace/posting":
            if not self._require_subscription(user):
                return
            # Body: {"vins": ["VIN1", "VIN2", ...], "action": "post" | "unpost"}
            vins   = payload.get("vins", [])
            action = payload.get("action", "").strip()
            if not isinstance(vins, list) or not vins:
                self._json({"error": "vins must be a non-empty array"}, 400); return
            if action not in ("post", "unpost"):
                self._json({"error": "action must be 'post' or 'unpost'"}, 400); return
            new_status = "posted" if action == "post" else "not_posted"
            updated = MarketplaceDB.set_posting_status(user['id'], vins, new_status)
            self._json({"status": "ok", "updated": updated, "posted_status": new_status})

        elif path == "/api/v1/locations":
            # Body: {"locations": {"Barboursville / Huntington": true, "Morgantown": false, ...}}
            loc_map = payload.get("locations", {})
            if not isinstance(loc_map, dict):
                self._json({"error": "locations must be an object"}, 400)
                return
            LocationDB.set_locations(user['id'], loc_map)
            self._json({"status": "saved"})

        # ── Customer Cards & Mail ──────────────────────────────────────
        elif path == "/api/v1/customers":
            if not payload.get('name', '').strip():
                self._json({'error': 'name is required'}, 400); return
            customer = CustomerManager.create_customer(user['id'], payload)
            self._json({'customer': customer}, 201)

        elif path == "/api/v1/customers/update":
            cid = payload.get('id')
            if not cid:
                self._json({'error': 'id is required'}, 400); return
            ok = CustomerManager.update_customer(user['id'], int(cid), payload)
            self._json({'status': 'updated' if ok else 'not_found'})

        elif path == "/api/v1/customers/delete":
            cid = payload.get('id')
            if not cid:
                self._json({'error': 'id is required'}, 400); return
            ok = CustomerManager.delete_customer(user['id'], int(cid))
            self._json({'status': 'deleted' if ok else 'not_found'})

        elif path == "/api/v1/customers/generate-email":
            cid = payload.get('customer_id')
            template_id = payload.get('template_id', 'thank_you')
            if not cid:
                self._json({'error': 'customer_id is required'}, 400); return
            customer = CustomerManager.get_customer(user['id'], int(cid))
            if not customer:
                self._json({'error': 'Customer not found'}, 404); return
            result = generate_customer_email(customer, template_id)
            self._json(result)

        elif path == "/api/v1/wishlist":
            # ── Create a new wishlist entry ───────────────────────────────
            _trial_ok, _trial_err = _check_trial_access(user, 'wishlist_entry')
            if not _trial_ok:
                self._json(_trial_err, 403); return
            _cn  = str(payload.get('customer_name', '') or '').strip()
            if not _cn:
                self._json({'error': 'customer_name is required'}, 400); return
            _ph  = str(payload.get('phone',       '') or '').strip()
            _ci  = str(payload.get('city',        '') or '').strip()
            _st  = str(payload.get('state',       '') or '').strip()
            _nt  = str(payload.get('notes',       '') or '').strip()
            # Choice 1
            _cd  = str(payload.get('condition',   'Any') or 'Any').strip()
            _mk  = str(payload.get('make',        '') or '').strip()
            _mo  = str(payload.get('model',       '') or '').strip()
            _kw  = str(payload.get('keyword',     '') or '').strip()
            _ym  = int(payload.get('year_min',    0) or 0)
            _yx  = int(payload.get('year_max',    0) or 0)
            _mm  = int(payload.get('max_mileage', 0) or 0)
            _mb  = int(payload.get('max_budget',  0) or 0)
            # Choice 2
            _cd2 = str(payload.get('condition2',   'Any') or 'Any').strip()
            _mk2 = str(payload.get('make2',        '') or '').strip()
            _mo2 = str(payload.get('model2',       '') or '').strip()
            _kw2 = str(payload.get('keyword2',     '') or '').strip()
            _ym2 = int(payload.get('year_min2',    0) or 0)
            _yx2 = int(payload.get('year_max2',    0) or 0)
            _mm2 = int(payload.get('max_mileage2', 0) or 0)
            _mb2 = int(payload.get('max_budget2',  0) or 0)
            # Choice 3
            _cd3 = str(payload.get('condition3',   'Any') or 'Any').strip()
            _mk3 = str(payload.get('make3',        '') or '').strip()
            _mo3 = str(payload.get('model3',       '') or '').strip()
            _kw3 = str(payload.get('keyword3',     '') or '').strip()
            _ym3 = int(payload.get('year_min3',    0) or 0)
            _yx3 = int(payload.get('year_max3',    0) or 0)
            _mm3 = int(payload.get('max_mileage3', 0) or 0)
            _mb3 = int(payload.get('max_budget3',  0) or 0)
            _conn = sqlite3.connect(DB_FILE)
            _conn.row_factory = sqlite3.Row
            try:
                _conn.execute(
                    """INSERT INTO wishlist
                       (user_id, customer_name, phone, city, state, notes,
                        condition,  make,  model,  keyword,  year_min,  year_max,  max_mileage,  max_budget,
                        condition2, make2, model2, keyword2, year_min2, year_max2, max_mileage2, max_budget2,
                        condition3, make3, model3, keyword3, year_min3, year_max3, max_mileage3, max_budget3)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (user['id'], _cn, _ph, _ci, _st, _nt,
                     _cd, _mk, _mo, _kw, _ym, _yx, _mm, _mb,
                     _cd2,_mk2,_mo2,_kw2,_ym2,_yx2,_mm2,_mb2,
                     _cd3,_mk3,_mo3,_kw3,_ym3,_yx3,_mm3,_mb3)
                )
                _conn.commit()
                _new_id = _conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            except Exception:
                try:
                    _conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _conn.close()
            _consume_trial_quota(user, 'wishlist_entry')
            self._json({'id': _new_id, 'status': 'created'}, 201)

        elif path == "/api/v1/wishlist/update":
            # ── Edit an existing wishlist entry + re-run matching ─────────
            _wid = payload.get('id')
            if not _wid:
                self._json({'error': 'id is required'}, 400); return
            _cn  = str(payload.get('customer_name', '') or '').strip()
            if not _cn:
                self._json({'error': 'customer_name is required'}, 400); return
            _ph  = str(payload.get('phone',  '') or '').strip()
            _ci  = str(payload.get('city',   '') or '').strip()
            _st  = str(payload.get('state',  '') or '').strip()
            _nt  = str(payload.get('notes',  '') or '').strip()
            _cd  = str(payload.get('condition',  'Any') or 'Any').strip()
            _mk  = str(payload.get('make',   '') or '').strip()
            _mo  = str(payload.get('model',  '') or '').strip()
            _kw  = str(payload.get('keyword','') or '').strip()
            _ym  = int(payload.get('year_min',    0) or 0)
            _yx  = int(payload.get('year_max',    0) or 0)
            _mm  = int(payload.get('max_mileage', 0) or 0)
            _mb  = int(payload.get('max_budget',  0) or 0)
            _cd2 = str(payload.get('condition2',  'Any') or 'Any').strip()
            _mk2 = str(payload.get('make2',  '') or '').strip()
            _mo2 = str(payload.get('model2', '') or '').strip()
            _kw2 = str(payload.get('keyword2','') or '').strip()
            _ym2 = int(payload.get('year_min2',    0) or 0)
            _yx2 = int(payload.get('year_max2',    0) or 0)
            _mm2 = int(payload.get('max_mileage2', 0) or 0)
            _mb2 = int(payload.get('max_budget2',  0) or 0)
            _cd3 = str(payload.get('condition3',  'Any') or 'Any').strip()
            _mk3 = str(payload.get('make3',  '') or '').strip()
            _mo3 = str(payload.get('model3', '') or '').strip()
            _kw3 = str(payload.get('keyword3','') or '').strip()
            _ym3 = int(payload.get('year_min3',    0) or 0)
            _yx3 = int(payload.get('year_max3',    0) or 0)
            _mm3 = int(payload.get('max_mileage3', 0) or 0)
            _mb3 = int(payload.get('max_budget3',  0) or 0)
            _conn = sqlite3.connect(DB_FILE)
            _conn.row_factory = sqlite3.Row
            try:
                try:
                    _cur = _conn.execute(
                        """UPDATE wishlist SET
                           customer_name=?, phone=?, city=?, state=?, notes=?,
                           condition=?,  make=?,  model=?,  keyword=?,  year_min=?,  year_max=?,  max_mileage=?,  max_budget=?,
                           condition2=?, make2=?, model2=?, keyword2=?, year_min2=?, year_max2=?, max_mileage2=?, max_budget2=?,
                           condition3=?, make3=?, model3=?, keyword3=?, year_min3=?, year_max3=?, max_mileage3=?, max_budget3=?
                           WHERE id=? AND user_id=?""",
                        (_cn, _ph, _ci, _st, _nt,
                         _cd, _mk, _mo, _kw, _ym, _yx, _mm, _mb,
                         _cd2,_mk2,_mo2,_kw2,_ym2,_yx2,_mm2,_mb2,
                         _cd3,_mk3,_mo3,_kw3,_ym3,_yx3,_mm3,_mb3,
                         int(_wid), user['id'])
                    )
                    _conn.commit()
                except Exception:
                    try:
                        _conn.rollback()
                    except Exception:
                        pass
                    raise
                if _cur.rowcount == 0:
                    self._json({'error': 'Not found'}, 404); return
                # Re-fetch updated row and compute fresh matches
                _upd = dict(_conn.execute(
                    "SELECT * FROM wishlist WHERE id = ?", (int(_wid),)
                ).fetchone())
                # ── inline matching (same logic as GET) ──────────────────────
                _seen_ids   = set()
                _all_matches = []
                def _run_upd_choice(sfx):
                    if sfx:
                        has = (
                            str(_upd.get(f'make{sfx}', '') or '').strip()
                            or str(_upd.get(f'model{sfx}', '') or '').strip()
                            or str(_upd.get(f'keyword{sfx}', '') or '').strip()
                            or int(_upd.get(f'year_min{sfx}', 0) or 0) > 0
                            or int(_upd.get(f'year_max{sfx}', 0) or 0) > 0
                        )
                        if not has:
                            return
                    clauses = ["status = 'ACTIVE'", "user_id = ?"]
                    params  = [user['id']]
                    cond = str(_upd.get(f'condition{sfx}', 'Any') or 'Any').strip()
                    if cond and cond != 'Any':
                        clauses.append("LOWER(condition) = LOWER(?)"); params.append(cond)
                    make = str(_upd.get(f'make{sfx}', '') or '').strip()
                    if make:
                        clauses.append("LOWER(make) LIKE LOWER(?)"); params.append(f'%{make}%')
                    model = str(_upd.get(f'model{sfx}', '') or '').strip()
                    if model:
                        clauses.append("LOWER(model) LIKE LOWER(?)"); params.append(f'%{model}%')
                    kw = str(_upd.get(f'keyword{sfx}', '') or '').strip()
                    if kw:
                        kwp = f'%{kw}%'
                        clauses.append(
                            "(LOWER(make) LIKE LOWER(?) OR LOWER(model) LIKE LOWER(?)"
                            " OR LOWER(trim) LIKE LOWER(?) OR LOWER(stock_number) LIKE LOWER(?))"
                        )
                        params += [kwp, kwp, kwp, kwp]
                    ym = int(_upd.get(f'year_min{sfx}', 0) or 0)
                    if ym > 0: clauses.append("year >= ?"); params.append(ym)
                    yx = int(_upd.get(f'year_max{sfx}', 0) or 0)
                    if yx > 0: clauses.append("year <= ?"); params.append(yx)
                    mmi = int(_upd.get(f'max_mileage{sfx}', 0) or 0)
                    if mmi > 0: clauses.append("(mileage <= ? OR mileage = 0)"); params.append(mmi)
                    mbi = int(_upd.get(f'max_budget{sfx}', 0) or 0)
                    if mbi > 0: clauses.append("(price <= ? OR price = 0)"); params.append(mbi)
                    where = ' AND '.join(clauses)
                    rows = _conn.execute(
                        "SELECT id, vin, stock_number, condition, year, make, model, trim,"
                        " mileage, price, exterior_color, image_url, vdp_url"
                        f" FROM marketplace_inventory WHERE {where}"
                        " ORDER BY year DESC, price ASC LIMIT 10",
                        params
                    ).fetchall()
                    for r in rows:
                        d = dict(r)
                        if d['id'] not in _seen_ids:
                            _seen_ids.add(d['id']); _all_matches.append(d)
                _run_upd_choice(''); _run_upd_choice('2'); _run_upd_choice('3')
                _upd['matches'] = _all_matches[:15]
                self._json({'entry': _upd})
            finally:
                _conn.close()

        elif path == "/api/v1/wishlist/delete":
            # ── Delete a wishlist entry ───────────────────────────────────
            _wid = payload.get('id')
            if not _wid:
                self._json({'error': 'id is required'}, 400); return
            _conn = sqlite3.connect(DB_FILE)
            try:
                _cur = _conn.execute(
                    "DELETE FROM wishlist WHERE id = ? AND user_id = ?",
                    (int(_wid), user['id'])
                )
                _conn.commit()
            except Exception:
                try:
                    _conn.rollback()
                except Exception:
                    pass
                raise
            finally:
                _conn.close()
            if _cur.rowcount == 0:
                self._json({'error': 'Not found'}, 404)
            else:
                self._json({'deleted': int(_wid)})

        elif path == "/api/v1/help/chat":
            # ── AI Help Assistant Chat ────────────────────────────────────
            _msg = str(payload.get('message', '') or '').strip()
            _ctx = str(payload.get('context', '') or '').strip()
            _history = payload.get('history', [])  # list of {role, content}
            if not _msg:
                self._json({'error': 'message is required'}, 400); return

            _api_key  = os.environ.get('AI_INTEGRATIONS_OPENAI_API_KEY', '')
            _base_url = os.environ.get(
                'AI_INTEGRATIONS_OPENAI_BASE_URL', 'https://api.openai.com/v1'
            ).rstrip('/')

            _SYSTEM = (
                "You are the BDC AI Assistant embedded inside BDC Manager Desk — an automotive "
                "dealership sales automation platform used by BDC managers and salespeople.\n\n"
                "## Navigation & Role-Based Home Screen\n\n"
                "### Individual Sales Reps (Pro accounts)\n"
                "- After login, reps land directly on Marketplace Hub (/marketplace-hub) — "
                "no Dashboard step in the way, maximum speed to start posting.\n"
                "- The sidebar shows: Marketplace Hub, Wishlist, Customer Cards & Mail, "
                "Refer & Earn, TikTok Hub. No Dashboard item.\n\n"
                "### Rooftop Dealership Admins (org_role = 'admin')\n"
                "- After login, admins land on the Executive Dashboard (/dashboard) — "
                "a store-wide performance overview.\n"
                "- Dashboard shows: 4 KPI tiles (Active Inventory, Posted to FB, "
                "Pending Outreach, Sold Still Posted), a Team Activity Leaderboard "
                "(top posting reps this week and last 30 days), and a Seat Allocation "
                "panel (used vs. available seats with a link to Team & Seats).\n"
                "- The sidebar shows Dashboard first, then all other pages.\n"
                "- Reps trying to visit /dashboard directly are redirected to /marketplace-hub.\n\n"
                "## Features you know deeply:\n\n"
                "### TikTok AI Video Studio (/tiktok)\n"
                "- Connect via OAuth: click 'Connect TikTok Account' in the "
                "'⚙️ TikTok Connection & Account Setup' card, authorize the app in TikTok, "
                "and you are redirected back automatically.\n"
                "- Upload vehicle walkaround videos: MP4 or MOV, max 500 MB. Drag-and-drop or "
                "file picker. Video is chunked and uploaded directly from the browser to "
                "TikTok — BDC never stores it.\n"
                "- AI Catchphrase Generator: click 'Generate Catchphrase' to get an "
                "OpenAI-powered viral hook + hashtags. Edit before posting. First 150 chars "
                "become the TikTok video title. Max caption 2,200 characters.\n"
                "- Privacy Levels: Public (PUBLIC_TO_EVERYONE), Friends (MUTUAL_FOLLOW_FRIENDS), "
                "Private (SELF_ONLY). Set default in the Connection Setup card.\n"
                "- Trial limits: Free users get 3 posts/day for a max of 5 days. "
                "Pro users have unlimited daily posts with no expiry.\n"
                "- A trial status bar shows posts used today, days remaining, and a Pro upgrade link.\n"
                "- When trial expires the studio locks; upgrade to Pro to unlock it again.\n\n"
                "### Marketplace Hub & Inventory Scraper (/marketplace-hub)\n"
                "- Setup: expand '⚙️ Inventory Scraper & Source Setup' card at the top. "
                "Paste Used Inventory Page URL and/or New Inventory Page URL "
                "(must start with http:// or https://).\n"
                "- Salesperson ID (optional): filters inventory to vehicles assigned to that rep.\n"
                "- Auto-Sync Frequency options: Manual only, Hourly, Every 6 hours, Daily.\n"
                "- After saving, inventory syncs and exports as a Meta Catalog CSV at "
                "https://[domain]/api/v1/catalog/[user_id].csv.\n"
                "- Posting Queue: select vehicles -> Add to Queue -> vehicles post to "
                "Facebook Marketplace on schedule.\n\n"
                "### Team & Seats (Rooftop Admin)\n"
                "- Rooftop Admin accounts manage team seats from the admin console Team section.\n"
                "- Invite reps: share your unique referral link (found in Account / Profile). "
                "When a rep signs up via that link they join your rooftop team automatically.\n"
                "- Rooftop plans include up to 10 user seats. Admin console shows seats used / available.\n"
                "- Each rep has an isolated workspace (own inventory, wishlist, leads); "
                "admin sees centralized store-wide analytics.\n\n"
                "### Customer Cards & Mail (/customer-mail)\n"
                "- Store Branding Setup: expand '⚙️ Direct Mailer & Store Branding Setup' card. "
                "Enter dealership name, return address, logo URL, phone, support email.\n"
                "- These details auto-fill as the return address on printed envelopes and labels.\n"
                "- Thank-You Letters: click 'Generate Letter' on any customer card for an "
                "AI-written personalized letter using the customer's vehicle and purchase details.\n"
                "- Anniversary Letters: re-engage past customers using the same Generate Letter flow.\n\n"
                "### Inventory Wishlist (/wishlist)\n"
                "- Add customers with vehicle criteria: make, model, year range, max mileage, max budget.\n"
                "- Auto-matching runs on every sync and every 30 seconds.\n"
                "- Matched customers float to the top with a green MATCH FOUND badge.\n"
                "- Click View Match -> Text Customer to send a pre-filled SMS.\n"
                "- To match across multiple makes: select 'Any / All Makes' or create multiple entries.\n\n"
                "### Pricing (/pricing) and Login Screen Showcase\n"
                "Both the /pricing page and the login/register screen display plan pricing.\n\n"
                "**Free Trial** — $0 / 5 days (no credit card required)\n"
                "- 3 AI post generations/day, 3 wishlist entries/day, read-only inventory browsing, "
                "Marketplace Hub preview. No payment info needed.\n\n"
                "**Individual Pro Rep** — 1 seat\n"
                "- Monthly: $149/month\n"
                "- Yearly: $1,490/year ($124/mo equivalent — 2 months free vs monthly)\n"
                "- Lifetime: $4,995 one-time — pay once, never renews\n"
                "- Includes: unlimited AI post generation, DMS/inventory sync, unlimited wishlist "
                "customer entries & alerts, personal daily posting queue, Facebook & TikTok catalog "
                "feed URLs, direct mail follow-ups (customer cards), $25 referral billing credit per "
                "referred rep, private lead & appointment pipeline, desk analytics, AI assistant, "
                "email support.\n\n"
                "**Dealership Rooftop (Store License)** — base 10 seats, expandable\n"
                "- Monthly: $495/month (base, includes 10 seats)\n"
                "- Yearly: $4,950/year ($412/mo equivalent — 2 months free vs monthly)\n"
                "- Lifetime: $14,995 one-time — 10 seats, never renews\n"
                "- Includes: everything in Individual Pro Rep PLUS Executive Rooftop Dashboard, "
                "Team Activity Leaderboards, Seat Management & Rep Invitations "
                "(+$39/mo per extra seat beyond the base 10), Custom Store Logos on physical mail, "
                "shared dealership inventory workspace, centralized rooftop billing, "
                "priority store onboarding & support.\n\n"
                "**Seat Expansion (Rooftop only)**:\n"
                "- Base plan covers 10 seats.\n"
                "- To add more seats after signup: go to Team & Seats (/team) and click "
                "'➕ Add More Seats'. A modal lets the admin select how many seats to add "
                "and the billing interval, then checks out through Stripe.\n"
                "- Pricing: +$39/seat/month, or +$390/seat/year, or +$995/seat one-time. "
                "Special bundle: 5 seats lifetime = $4,495 (saves $480).\n"
                "- The org's seat_limit is automatically increased as soon as payment completes "
                "(Stripe webhook updates the database).\n"
                "- If a dealership needs more than 50 total seats (multi-location auto group), "
                "they are directed to contact Enterprise Sales at support.bdcmanager@gmail.com "
                "for volume pricing and custom onboarding.\n\n"
                "**Referral Program**: every Pro subscriber gets a unique referral link. "
                "When a new rep subscribes through that link, the referrer receives a "
                "$25 credit applied directly to their Stripe billing balance "
                "(reduces their next charge automatically — no coupon code needed).\n\n"
                "All plans are non-refundable. Payments processed securely by Stripe.\n\n"
                "### Meta Catalog Feed\n"
                "- Feed URL: https://[domain]/api/v1/catalog/[user_id].csv\n"
                "- Required fields: fb_page_id, vehicle_id, title, description, availability, "
                "condition, state_of_vehicle, price, link, image_link\n"
                "- Submit as a Scheduled Feed in Meta Commerce Manager -> Catalogs -> Data Sources.\n\n"
                "### Master Admin Tools (user: mdemoss)\n"
                "- The '⚡ AI Fix' button appears in the sidebar beside the Engine Status indicator "
                "and is visible ONLY to the master admin account (mdemoss / is_master_admin = true).\n"
                "- When clicked it opens a modal that shows captured browser console errors, "
                "runtime exceptions, and failed API requests from the current session.\n"
                "- The 'Analyze & Generate Fix Prompt' button sends all captured errors to "
                "the AI, which produces a structured, ready-to-paste debugging prompt.\n"
                "- The 'Copy Fix Prompt' button copies the generated prompt to the clipboard "
                "so the admin can paste it into their AI coding assistant to fix the issue.\n"
                "- The badge on the button shows the total number of captured issues in real time.\n\n"
                "### Test / Demo Accounts\n"
                "- 'testreviewer' is a fully configured Rooftop Dealership Admin account used for "
                "testing multi-seat management, referral links, and store-level configurations.\n"
                "- It has subscription_tier = 'rooftop_monthly', org_role = 'admin', and is "
                "associated with a provisioned Organization (Testreviewer's Dealership).\n"
                "- This account can access Team & Seats (/team), invite reps, manage rooftop-level "
                "settings, and exercise all Rooftop Admin features.\n"
                "- Credentials and rooftop status are force-synced on every server restart so they "
                "survive database resets and schema migrations.\n\n"
                "## Response Rules\n"
                "- Be concise. Use numbered steps for procedures, bullet points for lists.\n"
                "- Format with blank lines between steps for readability.\n"
                "- Always name the exact UI element (button label, card title, menu item) "
                "so users can find it instantly.\n"
                "- Never fabricate features that don't exist in the product.\n"
                "- If asked something unrelated to automotive/BDC, redirect politely."
            )

            _messages = [{'role': 'system', 'content': _SYSTEM}]
            if _ctx:
                _messages.append({
                    'role': 'system',
                    'content': f'The user is currently viewing the "{_ctx}" page.'
                })
            # Append conversation history (last 8 turns to stay within context)
            for _h in (_history or [])[-8:]:
                if isinstance(_h, dict) and _h.get('role') in ('user', 'assistant'):
                    _messages.append({'role': _h['role'], 'content': str(_h.get('content', ''))})
            _messages.append({'role': 'user', 'content': _msg})

            # ── Keyword-based smart fallback (used when AI key is absent or call fails)
            def _smart_fallback(msg: str) -> str:
                ml = msg.lower()

                # TikTok / walkaround / video posting
                if any(k in ml for k in (
                    'tiktok', 'tik tok', 'walkaround', 'video studio',
                    'post video', 'viral', 'catchphrase', 'post to tiktok',
                )):
                    return (
                        "Here's how to post a vehicle walkaround to TikTok:\n\n"
                        "1. Open TikTok AI Video Studio from the sidebar.\n"
                        "2. Expand the '⚙️ TikTok Connection & Account Setup' card and click "
                        "'Connect TikTok Account'. Authorize BDC Manager Desk — you return "
                        "to this page automatically.\n"
                        "3. Choose your Default Video Privacy "
                        "(Public recommended for maximum reach).\n"
                        "4. Drag-and-drop or click to upload your walkaround "
                        "(MP4 or MOV, max 500 MB).\n"
                        "5. Click 'Generate Catchphrase' for an AI-powered viral hook + "
                        "hashtags, or type your own caption.\n"
                        "6. Click 'Post to TikTok' — video chunks upload directly from "
                        "your browser to TikTok's servers.\n\n"
                        "Trial limits: Free users -> 3 posts/day for 5 days. "
                        "Pro users -> unlimited daily posts with no expiry."
                    )

                # Inventory scraper / sync setup
                if any(k in ml for k in (
                    'scraper', 'inventory url', 'sync frequency', 'inventory source',
                    'used url', 'new url', 'inventory sync', 'set up inventory',
                    'setup inventory',
                )):
                    return (
                        "Here's how to set up your inventory scraper:\n\n"
                        "1. Open Marketplace Hub from the sidebar.\n"
                        "2. Expand the '⚙️ Inventory Scraper & Source Setup' card at the top.\n"
                        "3. Paste your Used Inventory Page URL and/or New Inventory Page URL "
                        "(both must start with http:// or https://).\n"
                        "4. (Optional) Enter your Salesperson ID to filter inventory to only "
                        "your assigned vehicles.\n"
                        "5. Choose Auto-Sync Frequency: Manual only, Hourly, Every 6 hours, "
                        "or Daily.\n"
                        "6. Click 'Save Scraper Settings'.\n\n"
                        "Once synced, inventory exports automatically to your Meta Catalog "
                        "CSV feed for Facebook Marketplace and catalog ads."
                    )

                # Pro vs Free limits / pricing / trial / upgrade
                if any(k in ml for k in (
                    'pro vs free', 'pro limit', 'free limit', 'trial limit',
                    'upgrade', 'pricing', '$149', 'how much', 'cost', 'plan',
                    'posts per day', 'daily limit',
                )):
                    return (
                        "BDC Manager Desk trial & Pro plan limits:\n\n"
                        "Free Trial (5 days):\n"
                        "• TikTok posts: 3 per day (resets at midnight)\n"
                        "• AI listings (Free Generator): 3 per day\n"
                        "• All features unlocked during the trial window\n\n"
                        "Pro Plan ($149/month):\n"
                        "• Unlimited TikTok posts daily — no cap, no expiry lock\n"
                        "• Unlimited AI listing generation\n"
                        "• Full Inventory Wishlist, Meta Catalog Feed, Customer Mail\n\n"
                        "Rooftop Plan ($149+/month):\n"
                        "• Everything in Pro + up to 10 team seats\n"
                        "• Centralized admin console with store-wide analytics\n"
                        "• Invite reps via referral link\n\n"
                        "Upgrade at any time from the Pricing page in the sidebar."
                    )

                # Team / seats / rooftop / referral / invite reps
                if any(k in ml for k in (
                    'invite rep', 'add rep', 'team seat', 'rooftop', 'referral link',
                    'referral', 'team member', 'how many seats', 'manage team',
                )):
                    return (
                        "Here's how to manage your Rooftop team:\n\n"
                        "1. Rooftop Admin accounts see a Team section in the admin console.\n"
                        "2. Copy your referral link from your Account / Profile area and "
                        "share it with your salespeople.\n"
                        "3. When a rep signs up using your referral link, they are "
                        "automatically added to your rooftop team and use one seat.\n"
                        "4. Rooftop plans include up to 10 seats. The admin console shows "
                        "seats used vs. available.\n"
                        "5. Each rep has their own isolated workspace (inventory, wishlist, "
                        "leads). You see centralized store-wide analytics.\n\n"
                        "Need more than 10 seats? Contact support to discuss enterprise plans."
                    )

                # Meta / catalog / CSV / feed
                if any(k in ml for k in (
                    'meta', 'catalog', 'csv', 'feed', 'facebook page', 'fb page',
                    'commerce manager', 'catalog feed',
                )):
                    return (
                        "Here's how to connect your Meta Catalog Feed:\n\n"
                        "1. Sync your inventory first — open Marketplace Hub and run a sync.\n"
                        "2. Your feed URL is: "
                        "https://[your-domain]/api/v1/catalog/[user_id].csv\n"
                        "   (Use the Diagnostics tab in this panel to find your user_id.)\n"
                        "3. Open Meta Commerce Manager -> Catalogs -> your catalog -> Data Sources.\n"
                        "4. Click Add Data Source -> Scheduled Feed.\n"
                        "5. Paste your feed URL, set the update schedule to Daily, and save.\n\n"
                        "Tip: Use the Diagnostics tab to validate all required Meta fields "
                        "(fb_page_id, vehicle_id, price, link, image_link) before submitting."
                    )

                # Wishlist / customer matching
                if any(k in ml for k in ('wishlist', 'wish list', 'match customer', 'customer match')):
                    return (
                        "The Inventory Wishlist auto-matches customers to active inventory:\n\n"
                        "1. Click Add Customer and enter name, phone, and vehicle preferences "
                        "(Make, Model, Year range, Max Mileage, Max Budget).\n"
                        "2. The matcher runs on every sync and every 30 seconds automatically.\n"
                        "3. Matched customers float to the top with a green MATCH FOUND badge.\n"
                        "4. Click View Match -> Text Customer to send a pre-filled SMS.\n\n"
                        "For multiple makes: select 'Any / All Makes', or create multiple "
                        "wishlist entries for the same customer."
                    )

                # Customer mail / thank-you / anniversary letters
                if any(k in ml for k in (
                    'thank you letter', 'thank-you', 'anniversary letter',
                    'customer mail', 'dealer logo', 'return address', 'store branding',
                )):
                    return (
                        "Here's how to set up Customer Cards & Mail:\n\n"
                        "1. Open Customer Cards & Mail from the sidebar.\n"
                        "2. Expand '⚙️ Direct Mailer & Store Branding Setup' at the top.\n"
                        "3. Enter your dealership name, return address, logo URL, phone, "
                        "and support email. Click 'Save Dealership Info'.\n"
                        "4. Click 'Add Customer' to create a customer card with their name, "
                        "address, and vehicle purchased.\n"
                        "5. Click 'Generate Letter' on any customer card to create an "
                        "AI-written personalized thank-you or anniversary letter.\n\n"
                        "The dealership address and logo from Step 3 auto-fill every letter."
                    )

                # Default: warm overview
                return (
                    "Welcome to BDC Manager Desk! Here's what I can help you with:\n\n"
                    "• TikTok AI Video Studio — post vehicle walkaround videos with AI captions\n"
                    "• Marketplace Hub — sync inventory and publish to Facebook Meta catalog feeds\n"
                    "• Inventory Wishlist — auto-match customers to available vehicles\n"
                    "• Free AI Generator — create Facebook Marketplace posts from any VDP URL\n"
                    "• Customer Cards & Mail — generate personalized thank-you and anniversary letters\n"
                    "• Team & Seats — manage Rooftop team reps and seat allocations\n\n"
                    "Try the Quick Guides tab for step-by-step walkthroughs, or ask me anything!"
                )

            if not _api_key:
                self._json({'reply': _smart_fallback(_msg)})
                return

            try:
                _req_body = json.dumps({
                    'model': 'gpt-5-nano',
                    'messages': _messages,
                    'max_tokens': 600,
                    'temperature': 0.6,
                }).encode('utf-8')
                _req = urllib.request.Request(
                    f'{_base_url}/chat/completions',
                    data=_req_body,
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {_api_key}',
                    },
                    method='POST',
                )
                with urllib.request.urlopen(_req, timeout=30) as _resp:
                    _resp_data = json.loads(_resp.read().decode('utf-8'))
                _reply = _resp_data['choices'][0]['message']['content']
                self._json({'reply': _reply})
            except Exception as _exc:
                print(f'[HELP] chat fallback triggered: {_exc}')
                self._json({'reply': _smart_fallback(_msg)})

        elif path == "/api/v1/referrals":
            _uid = user["id"]
            _rconn = sqlite3.connect(DB_FILE)
            _rconn.row_factory = sqlite3.Row
            _urow = _rconn.execute(
                "SELECT referral_code, account_credit FROM users WHERE id = ?", (_uid,)
            ).fetchone()
            _ref_code    = (_urow["referral_code"] or "") if _urow else ""
            _acct_credit = float(_urow["account_credit"] or 0) if _urow else 0.0
            _ref_rows = _rconn.execute(
                """SELECT r.id, r.status, r.credit_amount, r.created_at,
                          u.username AS referred_username
                   FROM referrals r
                   JOIN users u ON u.id = r.referred_user_id
                   WHERE r.referrer_id = ?
                   ORDER BY r.created_at DESC""",
                (_uid,),
            ).fetchall()
            # Billing events — last 20 credit / invoice events for this user
            _be_rows = _rconn.execute(
                """SELECT event_type, stripe_invoice_id,
                          amount_cents, credit_applied_cents,
                          description, created_at
                   FROM billing_events
                   WHERE user_id = ?
                   ORDER BY created_at DESC
                   LIMIT 20""",
                (_uid,),
            ).fetchall()
            _rconn.close()
            _app_url = APP_BASE_URL
            _ref_link = f"{_app_url}/?ref={_ref_code}" if _ref_code else ""
            self._json({
                "referral_code":  _ref_code,
                "referral_link":  _ref_link,
                "account_credit": _acct_credit,
                "referrals": [
                    {
                        "id":                 r["id"],
                        "referred_username":  r["referred_username"],
                        "status":             r["status"],
                        "credit_amount":      float(r["credit_amount"] or 0),
                        "created_at":         str(r["created_at"] or ""),
                    }
                    for r in _ref_rows
                ],
                "billing_events": [
                    {
                        "event_type":           be["event_type"],
                        "stripe_invoice_id":    be["stripe_invoice_id"] or "",
                        "amount_cents":         int(be["amount_cents"] or 0),
                        "credit_applied_cents": int(be["credit_applied_cents"] or 0),
                        "description":          be["description"] or "",
                        "created_at":           str(be["created_at"] or ""),
                    }
                    for be in _be_rows
                ],
            })

        elif path == "/api/tiktok/catchphrase":
            # ── TikTok: AI car-sales catchphrase ────────────────────────
            if not self._require_subscription(user):
                return
            _hook = _call_openai_chat([
                {
                    "role": "system",
                    "content": (
                        "You are a high-energy car-sales TikTok content creator. "
                        "Write ONE punchy caption (≤150 chars) for a dealership video, "
                        "ending with these hashtags: "
                        "#CarSales #DealershipLife #CarTok #AutoDeals #NewCar"
                    ),
                },
                {"role": "user", "content": "Write me a TikTok caption for a car dealership video."},
            ])
            if not _hook:
                self._json({"error": "AI service unavailable. Please try again."}, 503)
                return
            self._json({"catchphrase": _hook.strip()})

        elif path == "/api/tiktok/publish/init":
            # ── TikTok: initialise chunk-upload slot ─────────────────────
            # ── Trial / subscription gate ─────────────────────────────────
            _trial = _get_tiktok_trial_status(user)
            if not _trial["allowed"]:
                if _trial["trial_expired"]:
                    self._json({
                        "success": False,
                        "error":   "trial_expired",
                        "message": "Your 5-day TikTok trial has ended. Upgrade to Pro for unlimited posting.",
                        "trial_status": _trial,
                    }, 403)
                else:
                    self._json({
                        "success": False,
                        "error":   "daily_limit_hit",
                        "message": "You've reached your 3 daily trial posts. Come back tomorrow or upgrade to Pro.",
                        "trial_status": _trial,
                    }, 403)
                return
            try:
                _at3, _ = TikTokTokenManager.refresh_if_needed(user["id"])
            except TikTokRefreshExpiredError as _rfe3r:
                self._json({
                    "success": False,
                    "error":   "tiktok_refresh_expired",
                    "message": str(_rfe3r) or (
                        "Your TikTok authorization has fully expired. "
                        "Please reconnect your TikTok account."
                    ),
                }, 403)
                return
            except TikTokTokenExpiredError as _rfe3:
                self._json({
                    "success": False,
                    "error":   "tiktok_token_expired",
                    "message": str(_rfe3) or (
                        "Your TikTok session has expired. Please reconnect your TikTok account."
                    ),
                }, 403)
                return
            _init_data    = json.loads(post_data.decode("utf-8")) if content_length else {}
            _vid_title    = str(_init_data.get("title",      "")).strip()[:150] or "Vehicle Showcase"
            _vid_size     = int(_init_data.get("video_size", 0))
            _chunk_size   = 10 * 1024 * 1024   # 10 MB per chunk
            _total_chunks = max(1, (_vid_size + _chunk_size - 1) // _chunk_size) if _vid_size else 1
            _init_payload = json.dumps({
                "post_info": {
                    "title":            _vid_title,
                    "privacy_level":    _init_data.get("privacy_level", "SELF_ONLY"),
                    "disable_duet":     False,
                    "disable_comment":  False,
                    "disable_stitch":   False,
                },
                "source_info": {
                    "source":             "FILE_UPLOAD",
                    "video_size":         _vid_size,
                    "chunk_size":         _chunk_size,
                    "total_chunk_count":  _total_chunks,
                },
            }).encode("utf-8")
            _init_req = urllib.request.Request(
                f"{TIKTOK_API_BASE}/v2/post/publish/video/init/",
                data=_init_payload,
                headers={
                    "Authorization": f"Bearer {_at3}",
                    "Content-Type":  "application/json; charset=UTF-8",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(_init_req, timeout=30) as _ir:
                    _id = json.loads(_ir.read().decode("utf-8"))
                _idata      = _id.get("data", {})
                _upload_url = _idata.get("upload_url", "")
                _publish_id = _idata.get("publish_id", "")
                if not _upload_url or not _publish_id:
                    _ec = _id.get("error", {}).get("code", "")
                    _em = _id.get("error", {}).get("message", "TikTok init failed")
                    self._json({"success": False, "error": f"{_em} ({_ec})"}, 502)
                    return
                # Charge one trial post on successful init (TikTok accepted the slot)
                if not _trial["is_pro"]:
                    _increment_tiktok_daily_post(user["id"])
                # Record the post in tiktok_posts with PROCESSING status.
                # This entire block is non-fatal: bookkeeping failures must
                # not turn into a user-visible publish error.
                try:
                    _pc = sqlite3.connect(DB_FILE)
                    try:
                        try:
                            _pc.execute(
                                "INSERT INTO tiktok_posts (user_id, publish_id, title, status) "
                                "VALUES (?, ?, ?, 'PROCESSING')",
                                (user["id"], _publish_id, _vid_title),
                            )
                        except Exception as _pe:
                            print(f"[TikTok] Failed to insert tiktok_posts record: {_pe}")
                            # In PostgreSQL a failed statement leaves the transaction in an
                            # aborted state; the subsequent commit() becomes a no-op and the
                            # connection still closes cleanly.  The explicit rollback here
                            # makes that intent unambiguous and prevents any partially-written
                            # state from sitting until the next GC cycle.
                            try:
                                _pc.rollback()
                            except Exception:
                                pass
                        else:
                            # INSERT succeeded — prune old rows in the same transaction.
                            # Keep only the newest 500 per user AND drop anything older
                            # than 90 days (whichever is stricter).  Prune failure is
                            # non-fatal: the publish flow continues regardless.
                            _cutoff_90d = (datetime.utcnow() - timedelta(days=90)).strftime(
                                "%Y-%m-%d %H:%M:%S"
                            )
                            try:
                                _pc.execute(
                                    """
                                    DELETE FROM tiktok_posts
                                    WHERE user_id = ?
                                      AND (
                                        posted_at < ?
                                        OR id NOT IN (
                                          SELECT id FROM tiktok_posts
                                          WHERE user_id = ?
                                          ORDER BY posted_at DESC
                                          LIMIT 500
                                        )
                                      )
                                    """,
                                    (user["id"], _cutoff_90d, user["id"]),
                                )
                            except Exception as _prune_err:
                                print(f"[TikTok] Failed to prune tiktok_posts: {_prune_err}")
                        try:
                            _pc.commit()
                        except Exception as _commit_err:
                            print(f"[TikTok] Failed to commit tiktok_posts transaction: {_commit_err}")
                    finally:
                        _pc.close()
                except Exception as _db_err:
                    print(f"[TikTok] Failed to open or close tiktok_posts DB connection: {_db_err}")
                self._json({
                    "success":      True,
                    "upload_url":   _upload_url,
                    "publish_id":   _publish_id,
                    "chunk_size":   _chunk_size,
                    "total_chunks": _total_chunks,
                })
            except Exception as _ie:
                self._json({"success": False, "error": str(_ie)}, 502)

        else:
            self._json({"error": "Route not found"}, 404)


# =====================================================================
# APPLICATION ENTRY POINT
# =====================================================================
    def do_PUT(self):
        """Profile updates accept PUT /api/users/me (same body as POST)."""
        return self.do_POST()

    def do_PATCH(self):
        """Handle PATCH — admin user management (toggle-pro, toggle-suspend)."""
        path = self.path.split("?")[0]
        _len = int(self.headers.get("Content-Length", 0) or 0)
        try:
            payload = json.loads(self.rfile.read(_len)) if _len else {}
        except (json.JSONDecodeError, ValueError):
            payload = {}

        # ── Toggle Pro status ─────────────────────────────────────────
        # ── Admin: save TikTok credentials to DB (master admin only) ────────────
        if path == "/api/admin/tiktok-config":
            adm = self._require_master_admin()
            if not adm:
                return
            try:
                _body_len = int(self.headers.get('Content-Length', 0))
                _body = json.loads(self.rfile.read(_body_len)) if _body_len else {}
            except Exception:
                self._json({"error": "Invalid JSON body."}, 400)
                return
            _new_ck = str(_body.get('client_key',    '')).strip()
            _new_cs = str(_body.get('client_secret', '')).strip()
            if not _new_ck or not _new_cs:
                self._json({"error": "client_key and client_secret are both required."}, 400)
                return
            _sc = sqlite3.connect(DB_FILE)
            try:
                # UPSERT both credentials atomically
                for _k, _v in (('tiktok_client_key', _new_ck),
                                ('tiktok_client_secret', _new_cs)):
                    _sc.execute(
                        "INSERT INTO system_settings (key, value, updated_at) "
                        "VALUES (?, ?, CURRENT_TIMESTAMP) "
                        "ON CONFLICT(key) DO UPDATE SET "
                        "value=excluded.value, updated_at=CURRENT_TIMESTAMP",
                        (_k, _v),
                    )
                _sc.commit()
            except Exception:
                try:
                    _sc.rollback()
                except Exception:
                    pass
                raise
            finally:
                _sc.close()
            _hint = (_new_ck[:4] + "…" + _new_ck[-4:]) if len(_new_ck) > 8 else "***"
            print(f"[ADMIN] {adm['username']!r} saved TikTok credentials via Admin Console "
                  f"(key_hint={_hint!r}). Active immediately for all users.")
            self._json({"status": "ok", "key_hint": _hint})
            return

        if path.startswith("/api/admin/users/") and path.endswith("/toggle-pro"):
            adm = self._require_master_admin()
            if not adm:
                return
            try:
                target_id = int(path.split("/")[4])
            except (IndexError, ValueError):
                self._json({"error": "Invalid user ID."}, 400)
                return
            _c = sqlite3.connect(DB_FILE)
            _c.row_factory = sqlite3.Row
            row = _c.execute(
                "SELECT id, subscription_status, is_admin FROM users WHERE id = ?",
                (target_id,)
            ).fetchone()
            if not row:
                _c.close()
                self._json({"error": "User not found."}, 404)
                return
            if row["is_admin"]:
                _c.close()
                self._json({"error": "Cannot modify admin account."}, 400)
                return
            new_status = "inactive" if row["subscription_status"] == "active" else "active"
            try:
                _c.execute(
                    "UPDATE users SET subscription_status = ? WHERE id = ?",
                    (new_status, target_id)
                )
                _c.commit()
            except Exception:
                try:
                    _c.rollback()
                except Exception:
                    pass
                raise
            finally:
                _c.close()
            print(f"[ADMIN] {adm['username']!r} toggled Pro -> {new_status!r} for user id={target_id}")
            self._json({"status": "ok", "subscription_status": new_status})
            return

        # ── Toggle suspension ─────────────────────────────────────────
        if path.startswith("/api/admin/users/") and path.endswith("/toggle-suspend"):
            adm = self._require_master_admin()
            if not adm:
                return
            try:
                target_id = int(path.split("/")[4])
            except (IndexError, ValueError):
                self._json({"error": "Invalid user ID."}, 400)
                return
            _c = sqlite3.connect(DB_FILE)
            _c.row_factory = sqlite3.Row
            row = _c.execute(
                "SELECT id, is_suspended, is_admin FROM users WHERE id = ?",
                (target_id,)
            ).fetchone()
            if not row:
                _c.close()
                self._json({"error": "User not found."}, 404)
                return
            if row["is_admin"]:
                _c.close()
                self._json({"error": "Cannot suspend admin account."}, 400)
                return
            new_val = 0 if row["is_suspended"] else 1
            try:
                _c.execute(
                    "UPDATE users SET is_suspended = ? WHERE id = ?",
                    (new_val, target_id)
                )
                _c.commit()
            except Exception:
                try:
                    _c.rollback()
                except Exception:
                    pass
                raise
            finally:
                _c.close()
            if new_val:  # kick any live sessions immediately
                _dead = [t for t, uid in _ACTIVE_SESSIONS.items() if uid == target_id]
                for t in _dead:
                    del _ACTIVE_SESSIONS[t]
            action = "suspended" if new_val else "unsuspended"
            print(f"[ADMIN] {adm['username']!r} {action} user id={target_id}")
            self._json({"status": "ok", "is_suspended": bool(new_val)})
            return

        # ── Admin: reset a user's recovery ID ────────────────────────────
        _rid_reset_m = re.match(r'^/api/admin/users/(\d+)/recovery-id/reset$', path)
        if _rid_reset_m:
            adm = self._require_master_admin()
            if not adm:
                return
            _target_id = int(_rid_reset_m.group(1))
            _new_rid = _generate_recovery_id()
            _rid_c = sqlite3.connect(DB_FILE)
            try:
                _rid_c.execute(
                    "UPDATE users SET recovery_id = ? WHERE id = ?",
                    (_new_rid, _target_id),
                )
                _rid_c.commit()
            except Exception:
                try:
                    _rid_c.rollback()
                except Exception:
                    pass
                raise
            finally:
                _rid_c.close()
            print(f"[ADMIN] {adm['username']!r} reset recovery ID for user id={_target_id}")
            self._json({"status": "ok", "recovery_id": _new_rid})
            return

        self._json({"error": "PATCH endpoint not found."}, 404)

    def do_DELETE(self):
        """Handle DELETE — admin account deletion."""
        path = self.path.split("?")[0]

        # ── Delete user account and all related data ──────────────────
        if path.startswith("/api/admin/users/"):
            adm = self._require_master_admin()
            if not adm:
                return
            try:
                target_id = int(path.split("/")[4])
            except (IndexError, ValueError):
                self._json({"error": "Invalid user ID."}, 400)
                return
            _c = sqlite3.connect(DB_FILE)
            _c.row_factory = sqlite3.Row
            row = _c.execute(
                "SELECT id, username, is_admin FROM users WHERE id = ?",
                (target_id,)
            ).fetchone()
            if not row:
                _c.close()
                self._json({"error": "User not found."}, 404)
                return
            if row["is_admin"]:
                _c.close()
                self._json({"error": "Cannot delete admin account."}, 400)
                return
            _uname = row["username"]
            try:
                for _tbl in ("user_sessions", "user_locations", "marketplace_inventory",
                             "posting_queue", "posting_cycle", "wishlist",
                             "password_reset_tokens"):
                    try:
                        _c.execute(f"DELETE FROM {_tbl} WHERE user_id = ?", (target_id,))
                    except Exception:
                        pass
                _c.execute("DELETE FROM users WHERE id = ?", (target_id,))
                _c.commit()
            except Exception:
                try:
                    _c.rollback()
                except Exception:
                    pass
                raise
            finally:
                _c.close()
            _dead = [t for t, uid in _ACTIVE_SESSIONS.items() if uid == target_id]
            for t in _dead:
                del _ACTIVE_SESSIONS[t]
            print(f"[ADMIN] {adm['username']!r} deleted user {_uname!r} (id={target_id})")
            self._json({"status": "ok", "deleted": _uname})
            return

        if path == "/api/tiktok/disconnect":
            # ── TikTok: disconnect account ────────────────────────────────
            user = self._require_auth()
            if not user:
                return
            _at4 = user.get("tiktok_access_token", "")
            _dc  = sqlite3.connect(DB_FILE)
            try:
                _dc.execute(
                    "UPDATE users SET tiktok_access_token=NULL, tiktok_refresh_token=NULL, "
                    "tiktok_open_id=NULL, tiktok_token_expires_at=NULL WHERE id=?",
                    (user["id"],),
                )
                _dc.commit()
            except Exception:
                try:
                    _dc.rollback()
                except Exception:
                    pass
                raise
            finally:
                _dc.close()
            # Best-effort token revocation
            _ck_dc, _ = _tiktok_creds()
            if _at4 and _ck_dc:
                try:
                    _rev_payload = urllib.parse.urlencode({
                        "client_key":      _ck_dc,
                        "token":           _at4,
                        "token_type_hint": "access_token",
                    }).encode("utf-8")
                    _rev_req = urllib.request.Request(
                        "https://open.tiktokapis.com/v2/oauth/revoke/",
                        data=_rev_payload,
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                        method="POST",
                    )
                    urllib.request.urlopen(_rev_req, timeout=5)
                except Exception:
                    pass
            print(f"[TikTok] Disconnected user_id={user['id']}")
            self._json({"success": True})
            return

        self._json({"error": "DELETE endpoint not found."}, 404)


def _check_db_persistence() -> None:
    """Verify the database connection is live and confirm which backend is used.

    This guard runs once at startup so any misconfiguration (wrong DSN,
    unavailable host, unwritable SQLite path) surfaces immediately as a loud
    error rather than a silent data-loss event later.  Runs before init_db(),
    so a brand-new database with no tables yet is not an error.
    """
    backend = "PostgreSQL" if DATABASE_URL else "SQLite"
    try:
        conn = sqlite3.connect(DB_FILE)
        try:
            row = conn.execute("SELECT COUNT(*) FROM users").fetchone()
            user_count = row[0] if row else 0
        except Exception:
            user_count = None      # schema not created yet — init_db() runs next
        conn.close()
        # Redact password from DSN for safe logging
        _dsn_safe = re.sub(r":[^@/]+@", ":***@", DB_FILE)
        _users = "schema pending" if user_count is None else f"{user_count} user(s)"
        print(f"[DB]   {backend} connection OK — {_users} — {_dsn_safe}")
        print(f"[DB]   Data is fully persistent ({backend}).")
        print("[DB]   Schema migrations use CREATE IF NOT EXISTS + ALTER TABLE only.")
        print("[DB]   DROP TABLE is never issued during startup or migration.")
    except Exception as _db_exc:
        raise RuntimeError(
            f"[DB] FATAL: Cannot connect to {backend} at startup: {_db_exc}\n"
            "Set DATABASE_URL to a PostgreSQL DSN, or leave it unset to use the "
            f"local SQLite file at {_LOCAL_SQLITE}."
        ) from _db_exc


def main():
    _check_db_persistence()
    init_db()

    # Nuke leftover cancel / sync-session state so scrapes always start clean.
    if _scraper_engine is not None:
        try:
            _scraper_engine.clear_all_sync_sessions_on_startup()
        except Exception as _sync_clr_err:
            print(f"[SCRAPE] sync_sessions startup clear failed: {_sync_clr_err}")

    # Hydrate users row from permanent dealer_config.json (refresh-safe URLs).
    if _dealer_config is not None:
        try:
            _cfg_uid = _local_settings_user_id()
            if _cfg_uid:
                _dealer_config.apply_disk_config_to_user(
                    lambda: sqlite3.connect(DB_FILE), _cfg_uid,
                )
        except Exception as _cfg_err:
            print(f"[CONFIG] Startup hydrate failed: {_cfg_err}")

    # Sibling engine schemas + demo data. These run after init_db() rather than
    # inside it: each opens its own connection, which would block on the write
    # transaction init_db() holds open.
    try:
        from leads_engine import init_leads_schema
        init_leads_schema(DB_FILE)
    except Exception as _le:
        print(f"[INIT] leads_engine init failed: {_le}")

    try:
        from marketplace_engine import init_marketplace_schema
        init_marketplace_schema(DB_FILE)
    except Exception as _me:
        print(f"[INIT] marketplace_engine init failed: {_me}")

    _load_sessions_from_db()

    # NOTE: Automatic lead follow-up and re-engagement daemons are
    # intentionally disabled. Leads are only created by genuine incoming
    # webhooks/messages via POST /api/v1/lead or POST /api/v1/twilio/inbound.
    # To re-enable: uncomment the two blocks below.
    #
    # worker = BDCFollowUpWorker(check_interval_seconds=5)
    # worker.start()
    #
    # email_worker = EmailReengagementWorker()
    # email_worker.start()

    # ── One-time cleanup: purge Moses demo inventory from non-Moses accounts ─────
    # Before the demo-seed guard was added, non-Moses accounts could receive
    # the MOSES_DEMO_INVENTORY seed when their scrape returned empty.  Remove
    # those rows now so fake sequential stock numbers (NH1001, UH2001, …) no
    # longer appear in their Marketplace Hub.
    # Skip on local SQLite preview — sample seeding is intentional there.
    if not _IS_LOCAL_PREVIEW:
      try:
        _demo_vins = tuple(v['vin'] for v in MOSES_DEMO_INVENTORY)
        _pc = sqlite3.connect(DB_FILE)
        _pu = _pc.execute(
            "SELECT id, inventory_url_used, inventory_url_new FROM users"
        ).fetchall()
        _purged_total = 0
        for _pid, _pused, _pnew in _pu:
            _urls = ((_pused or '') + ' ' + (_pnew or '')).lower()
            if 'mosescars.com' in _urls:
                continue  # legitimate Moses account — leave it alone
            _ph = ','.join(['?' for _ in _demo_vins])
            _cnt = _pc.execute(
                f"SELECT COUNT(*) FROM marketplace_inventory "
                f"WHERE user_id=? AND vin IN ({_ph})",
                (_pid, *_demo_vins),
            ).fetchone()[0]
            if _cnt:
                _pc.execute(
                    f"DELETE FROM marketplace_inventory "
                    f"WHERE user_id=? AND vin IN ({_ph})",
                    (_pid, *_demo_vins),
                )
                _purged_total += _cnt
                print(f"[INIT] Purged {_cnt} Moses demo vehicle(s) from "
                      f"non-Moses user {_pid}.")
        _pc.commit()
        _pc.close()
        if _purged_total:
            print(f"[INIT] Demo-inventory cleanup done — {_purged_total} "
                  f"row(s) removed across all non-Moses accounts.")
      except Exception as _pe:
        print(f"[INIT] Demo-inventory cleanup failed (non-fatal): {_pe}")
    else:
        print("[INIT] Local SQLite preview — keeping sample/demo inventory seeds.")

    moses_worker = MosesScraperWorker()
    moses_worker.start()

    csv_feed_worker = CsvFeedWorker()
    csv_feed_worker.start()

    queue_worker = PostingQueueWorker()
    queue_worker.start()

    tiktok_refresh_worker = TikTokTokenRefreshWorker()
    tiktok_refresh_worker.start()

    # Age out any PROCESSING posts that were left stuck before this restart.
    # The background worker repeats this sweep every SCAN_INTERVAL, but running
    # it once at startup ensures rows are cleaned immediately on server boot.
    try:
        _expire_stale_tiktok_posts()
    except Exception as _esp_err:
        print(f"[TikTok] Startup stale-post sweep failed (non-fatal): {_esp_err}")

    # Verify email transport before accepting requests
    _check_email_connection()

    # ── Startup inventory sync: immediately re-sync every user that has
    # configured inventory URLs so the Marketplace Hub reflects the latest
    # data right after a server restart (rather than waiting for the
    # MosesScraperWorker's 6-hour cadence).
    def _startup_sync() -> None:
        import time as _time
        _time.sleep(4)   # let DB connections settle
        try:
            _users = UserManager.get_all_users()
        except Exception as _e:
            print(f"[STARTUP SYNC] Could not fetch users: {_e}")
            return
        for _u in _users:
            _uid  = _u['id']
            _used = (_u.get('inventory_url_used') or '').strip()
            _new  = (_u.get('inventory_url_new')  or '').strip()
            if not (_used or _new):
                continue   # no URLs configured — nothing to sync
            try:
                _job = _SYNC_JOBS.setdefault(_uid, {})
                _job.update({'syncing': True, 'phase': 'fetching', 'synced': 0,
                             'total': 0, 'done': False})
                _r = _sync_user_inventory(_uid, _used, _new)
                _job.update({'syncing': False, 'phase': 'done',
                             'synced': _r['synced'], 'total': _r['synced'],
                             'done': True, 'reason': _r.get('reason', 'ok')})
                print(f"[STARTUP SYNC u{_uid}] {_r['synced']} synced, "
                      f"{_r['sold']} sold.")
            except Exception as _e:
                print(f"[STARTUP SYNC u{_uid}] Error: {_e}")

    _startup_sync_thread = threading.Thread(target=_startup_sync, daemon=True)
    _startup_sync_thread.start()

    # Start Embedded HTTP Server
    server_address = (SERVER_HOST, SERVER_PORT)
    httpd = HTTPServer(server_address, BDCRequestHandler)

    _display_host = "127.0.0.1" if SERVER_HOST in ("", "0.0.0.0") else SERVER_HOST
    print("=" * 65)
    print("BDC AUTOMATION ENGINE IS RUNNING")
    print(f"Web Server Listening on {SERVER_HOST}:{SERVER_PORT}")
    print(f"Local URL: http://{_display_host}:{SERVER_PORT}/api/healthz")
    print("Available Endpoints:")
    print("   POST /api/v1/lead            (Inbound Lead Gateway)")
    print("   POST /api/v1/twilio/inbound  (Twilio Inbound Webhook)")
    print("   GET  /api/v1/appointments    (Sales Desk Board)")
    print("   GET  /api/v1/sessions        (Lead Pipeline)")
    print("   GET  /api/v1/analytics       (Desk KPI Metrics)")
    print("   GET  /api/v1/inventory       (Vehicle Inventory)")
    print("   GET  /api/healthz            (Server Status Check)")
    print("=" * 65)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down BDC Server gracefully.")
        httpd.server_close()


if __name__ == "__main__":
    main()
