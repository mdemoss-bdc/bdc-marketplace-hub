/**
 * Exhaustive step-by-step setup guides for every manual setting surface.
 * Values may include {{origin}} — replaced at render time with window.location.origin.
 */

export type SetupGuideStep = {
  title: string;
  body: string;
  link?: { label: string; href: string };
};

export type SetupGuideCopyBlock = {
  label: string;
  value: string;
  note?: string;
};

export type SetupGuide = {
  id: string;
  title: string;
  overview: string;
  steps: SetupGuideStep[];
  copyBlocks?: SetupGuideCopyBlock[];
  troubleshooting: string[];
};

export const SETUP_GUIDES: Record<string, SetupGuide> = {
  'scraper-inventory-url': {
    id: 'scraper-inventory-url',
    title: 'Scraper Target Inventory URL',
    overview:
      'The inventory scraper needs the public New and/or Used inventory listing pages on your dealership website. BDC crawls those URLs on your schedule, extracts vehicles, and syncs them into Marketplace Hub and your Meta catalog feed.',
    steps: [
      {
        title: 'Open your dealership website in a browser',
        body: 'Navigate to the inventory search page customers use — not a single vehicle detail page (VDP). You should see a grid or list of many vehicles with pagination.',
      },
      {
        title: 'Copy the Used inventory page URL',
        body: 'Click into Used Inventory (or All Inventory filtered to Used). Copy the full URL from the address bar. It must start with https:// (or http:// for local testing).',
      },
      {
        title: 'Copy the New inventory page URL (if applicable)',
        body: 'Repeat for New Inventory. If new and used share one URL, paste the same URL in both fields or leave New blank.',
      },
      {
        title: 'Paste into BDC',
        body: 'Go to Marketplace Hub → expand ⚙️ Inventory Scraper & Source Setup (or Settings → Scraper & Sync Schedules). Paste Used / New URLs into the Location fields. Add a Location Name for each rooftop.',
      },
      {
        title: 'Set sync frequency and save',
        body: 'Choose Manual, Hourly, Every 6 hours, or Daily. Click Save Settings / Save Scraper Settings. Then run Sync Now from Marketplace Hub to verify vehicles appear.',
      },
    ],
    copyBlocks: [
      {
        label: 'Example Used URL format',
        value: 'https://yourdealer.com/used-inventory/',
        note: 'Replace with your real public inventory listing URL.',
      },
    ],
    troubleshooting: [
      'URL returns 0 vehicles → confirm it is a listing page (not a VDP) and loads without login.',
      'Cloudflare / bot walls → the scraper may be blocked; try a CSV feed URL instead (Enable Automated CSV Feed).',
      'Wrong dealer inventory → verify you pasted the correct rooftop URL for that Location Name.',
      'Saved but not syncing → engine offline; check Engine Status in the sidebar and retry Sync Now.',
    ],
  },

  'meta-catalog-feed': {
    id: 'meta-catalog-feed',
    title: 'Meta Catalog Scheduled Feed',
    overview:
      'Meta Commerce Manager pulls your vehicle catalog from a CSV feed URL hosted by BDC. Once connected on a schedule, Facebook/Instagram ads and Marketplace stay in sync with your scraped inventory.',
    steps: [
      {
        title: 'Sync inventory first',
        body: 'In Marketplace Hub, ensure vehicles are listed. Save your Commerce Catalog ID (and Business Manager ID) in the Meta section of Inventory Setup.',
      },
      {
        title: 'Copy your Feed URL',
        body: 'Use the copy block below (or Settings → Facebook → Catalog Feed). Prefer catalog_id when you have a Commerce Catalog ID; otherwise user_id works.',
      },
      {
        title: 'Open Meta Commerce Manager',
        body: 'Sign in with a Business Manager user that owns the catalog.',
        link: { label: 'Open Commerce Manager', href: 'https://business.facebook.com/commerce' },
      },
      {
        title: 'Select or create an Automotive catalog',
        body: 'Choose an existing Vehicles catalog, or create Catalog → Auto → Vehicles.',
      },
      {
        title: 'Add a Scheduled Feed data source',
        body: 'Catalog → Data sources → Add Data Feed → Use a URL (Scheduled Feed). Paste your Feed URL, set frequency to Hourly or Daily, then Upload / Save.',
      },
      {
        title: 'Validate with Diagnostics',
        body: 'Open the floating AI Help widget → Diagnostics → Run Diagnostic Test to confirm required Meta fields before Meta finishes processing.',
      },
    ],
    copyBlocks: [
      {
        label: 'Feed URL (by catalog)',
        value: '{{origin}}/api/feeds/meta?format=csv&catalog_id=YOUR_CATALOG_ID',
      },
      {
        label: 'Feed URL (by user)',
        value: '{{origin}}/api/feeds/meta?format=csv&user_id=YOUR_USER_ID',
      },
      {
        label: 'Feed URL with optional token',
        value: '{{origin}}/api/feeds/meta?format=csv&user_id=YOUR_USER_ID&token=YOUR_CATALOG_TOKEN',
        note: 'Only if you set a Catalog Token in Settings.',
      },
    ],
    troubleshooting: [
      'Invalid price → vehicles with $0 are often rejected; fix prices on the source site or exclude them.',
      'Missing fb_page_id → set Facebook Page ID in Settings → Meta API Credentials and re-sync.',
      '0 vehicles in feed → run Marketplace Hub sync; confirm location filters are not excluding everything.',
      '401 / token errors → append ?token=… if Catalog Token is set, or clear the token for open access.',
    ],
  },

  'meta-api-credentials': {
    id: 'meta-api-credentials',
    title: 'Facebook / Meta Graph API Credentials',
    overview:
      'Page ID and a long-lived Page Access Token let BDC post and manage catalog data via the Meta Graph API. Prefer Connect Facebook (OAuth) when available; manual paste is supported for advanced setups.',
    steps: [
      {
        title: 'Find your Facebook Page ID',
        body: 'Open your Facebook Page → About (or Professional dashboard → Page settings → Page info). Copy the numeric Page ID.',
        link: { label: 'Facebook Pages', href: 'https://www.facebook.com/pages/' },
      },
      {
        title: '(Recommended) Connect via OAuth',
        body: 'In Settings → Facebook / Meta Integration, click Connect Facebook. Authorize the Business/Page and Commerce Catalog when prompted. Tokens are stored securely — existing passwords and other users are never touched.',
      },
      {
        title: 'Or create a System User token (manual)',
        body: 'In Meta Business Settings → Users → System users, create a system user, assign your Page + Catalog with catalog_management / pages_manage_posts permissions, then Generate token.',
        link: { label: 'Meta Business Settings', href: 'https://business.facebook.com/settings' },
      },
      {
        title: 'Paste credentials in Settings',
        body: 'Settings → Meta API Credentials → paste Facebook Page ID and Meta Access Token → Save Facebook Settings. Leave the token field blank on later saves to keep the stored token.',
      },
      {
        title: 'Add Business / Catalog / Pixel IDs (Marketplace Hub)',
        body: 'In Marketplace Hub → Inventory Setup → Meta column, enter Facebook Business Manager ID, Commerce Account Catalog ID, and optional Meta Pixel ID, then Save.',
      },
    ],
    troubleshooting: [
      'Token expired → reconnect via Connect Facebook or generate a new long-lived Page token.',
      'Wrong Page → confirm the Page ID matches the page tied to your Commerce catalog.',
      'Permission errors → System User needs the Page and Catalog assigned with marketing/catalog permissions.',
      'OAuth redirect fails → ensure APP_BASE_URL matches your public HTTPS domain.',
    ],
  },

  'tiktok-developer-app': {
    id: 'tiktok-developer-app',
    title: 'TikTok Developer App Keys',
    overview:
      'Global Client Key and Client Secret from the TikTok Developer Portal power OAuth connect and video publish for every subscriber. Admins set them once in Admin Console → TikTok Integration (or via env vars).',
    steps: [
      {
        title: 'Open TikTok Developer Portal',
        body: 'Sign in with the TikTok account that owns your Login Kit / Content Posting app.',
        link: { label: 'developers.tiktok.com', href: 'https://developers.tiktok.com/' },
      },
      {
        title: 'Create or select your app',
        body: 'Create an app (or open an existing one) with Login Kit and Content Posting API products enabled for video upload.',
      },
      {
        title: 'Configure Redirect URI',
        body: 'Under Login Kit / Redirect URI, add exactly the callback URL from the copy block below (must match APP_BASE_URL + /api/tiktok/callback).',
      },
      {
        title: 'Add domain verification file',
        body: 'TikTok may ask you to verify domain ownership. Use the verification token/file path from the Verification File guide. BDC already serves common verification paths on your app domain.',
      },
      {
        title: 'Copy Client Key & Client Secret',
        body: 'From the app credentials page, copy Client Key and Client Secret.',
      },
      {
        title: 'Paste into Admin Console',
        body: 'Admin Console → TikTok Integration → paste both fields → Save Credentials. Keys go live immediately for all subscribers (no restart). Alternatively set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in .env and restart the API.',
      },
    ],
    copyBlocks: [
      {
        label: 'OAuth Redirect URI (exact)',
        value: '{{origin}}/api/tiktok/callback',
        note: 'Must match the URI registered in TikTok Developer Portal character-for-character.',
      },
      {
        label: 'Legacy Redirect URI (if still registered)',
        value: '{{origin}}/api/tiktok/oauth/callback',
      },
    ],
    troubleshooting: [
      'Connect button says keys not configured → save keys in Admin Console or set env vars and restart.',
      'redirect_uri mismatch → register the exact callback URL; APP_BASE_URL must equal your public origin.',
      'App in sandbox → only approved sandbox users can authorize until the app is live.',
      'Feed push / publish failing → reconnect TikTok account; check trial limits and Content Posting scopes.',
    ],
  },

  'tiktok-oauth-connect': {
    id: 'tiktok-oauth-connect',
    title: 'Pair / Connect TikTok Account',
    overview:
      'Each salesperson authorizes their own TikTok account so walkaround videos publish to their profile. Admin keys must already be configured.',
    steps: [
      {
        title: 'Confirm API keys are active',
        body: 'If you see “TikTok API credentials not configured”, ask a master admin to complete the Developer App Keys guide first.',
      },
      {
        title: 'Open TikTok Hub',
        body: 'Sidebar → TikTok Hub (or /tiktok). Expand ⚙️ TikTok Connection & Account Setup.',
      },
      {
        title: 'Click Connect TikTok Account',
        body: 'You are redirected to TikTok. Sign in and authorize BDC Manager Desk (video upload scopes).',
      },
      {
        title: 'Return and set privacy',
        body: 'After redirect, status turns Connected. Choose Default Video Privacy (Public recommended for reach).',
      },
      {
        title: 'Post a test walkaround',
        body: 'Upload MP4/MOV (max 500 MB), Generate Catchphrase, then Post to TikTok. Chunks upload from your browser directly to TikTok.',
      },
    ],
    troubleshooting: [
      'Why is my feed push failing? → Reconnect if session expired; confirm video under 500 MB; wait for TikTok processing (can take minutes).',
      'Trial locked → Free trial is 3 posts/day for 5 days; upgrade to Pro for unlimited posts.',
      'Wrong TikTok account → Disconnect/Reconnect and authorize the correct account on TikTok’s consent screen.',
    ],
  },

  'tiktok-verification-file': {
    id: 'tiktok-verification-file',
    title: 'TikTok Domain Verification File',
    overview:
      'TikTok Developer Portal may require a verification file or query-string challenge on your public domain before Login Kit goes live. BDC serves the standard verification paths from the API host.',
    steps: [
      {
        title: 'Copy the verification string from TikTok',
        body: 'In Developer Portal → your app → domain verification, copy the token TikTok shows (often tiktok-developers-site-verification=…).',
      },
      {
        title: 'Confirm APP_BASE_URL',
        body: 'Your public app origin (HTTPS) must be the domain you verify in TikTok. Set APP_BASE_URL in .env to that origin.',
      },
      {
        title: 'Use BDC-hosted verification paths',
        body: 'Point TikTok at one of the hosted paths in the copy blocks (served by the API without login). If TikTok gave a custom filename, place that file on your static host or ask engineering to register the path.',
      },
      {
        title: 'Complete verification in the portal',
        body: 'Click Verify in TikTok Developer Portal. Once green, Redirect URIs and Login Kit can be used in production.',
      },
    ],
    copyBlocks: [
      {
        label: 'Common verification HTML path',
        value: '{{origin}}/tiktok-developers-site-verification.html',
      },
      {
        label: 'Common verification TXT path',
        value: '{{origin}}/tiktok-developers-site-verification.txt',
      },
    ],
    troubleshooting: [
      '404 on verification URL → ensure requests hit the API host (Vite proxies /api; verification paths are on the API root).',
      'Token mismatch → the file body must equal the exact string TikTok issued.',
      'Works locally but not prod → verify production domain in the portal, not localhost.',
    ],
  },

  'user-rooftop-management': {
    id: 'user-rooftop-management',
    title: 'User Account & Rooftop Management',
    overview:
      'Master admins manage all users and rooftop organizations from Admin Console: suspend/restore, Pro flags, recovery IDs, temporary passwords, and seat-aware rooftop groups. This never bulk-resets passwords on deploy.',
    steps: [
      {
        title: 'Open Admin Console',
        body: 'Sign in as master admin → sidebar Admin (or /admin).',
      },
      {
        title: 'Review Rooftop Accounts',
        body: 'Rooftop orgs appear first. Expand a rooftop to see the owner and member seats. Seat counts show used vs max.',
      },
      {
        title: 'Manage individual users',
        body: 'Use row actions to suspend/restore, toggle Pro, copy recovery ID, or Reset / Temp Password (forces change on next login).',
      },
      {
        title: 'Invite reps (rooftop admins)',
        body: 'Rooftop admins share their referral link (Account / Referrals). New signups via that link join the rooftop and consume a seat.',
      },
      {
        title: 'Team & Seats',
        body: 'Rooftop admins use Team (/team) to view seats and purchase extras via Stripe when needed.',
      },
    ],
    troubleshooting: [
      'User cannot log in → check Suspended badge; restore if needed. Confirm username (case-insensitive).',
      'Temp password loop → user must complete Forced Password Change modal; then must_change_password clears.',
      'Seat full → increase seats on /team or remove inactive members.',
      'Password unexpectedly changed → only Admin temp/reset, Profile change-password, or force-change-password write hashes.',
    ],
  },

  'webhooks-api-keys': {
    id: 'webhooks-api-keys',
    title: 'Webhook Endpoints & API Keys',
    overview:
      'Inbound webhooks (Twilio SMS, Stripe billing) and outbound CRM keys are configured via environment variables on the API server. Register the exact public HTTPS URLs below in each provider’s console.',
    steps: [
      {
        title: 'Set public APP_BASE_URL',
        body: 'In .env, set APP_BASE_URL to your production origin (https://your-domain). All webhook URLs are derived from it.',
      },
      {
        title: 'Stripe billing webhook',
        body: 'Stripe Dashboard → Developers → Webhooks → Add endpoint. Point to the Stripe webhook URL below. Copy the signing secret into STRIPE_WEBHOOK_SECRET.',
        link: { label: 'Stripe Webhooks', href: 'https://dashboard.stripe.com/webhooks' },
      },
      {
        title: 'Twilio inbound SMS',
        body: 'Twilio Console → Phone Numbers → your number → Messaging webhook (HTTP POST) → paste the Twilio inbound URL below.',
        link: { label: 'Twilio Console', href: 'https://console.twilio.com/' },
      },
      {
        title: 'Lead intake API',
        body: 'External forms / CRMs POST JSON to /api/v1/lead. Use Lead Gateway in the app to dry-run payloads.',
      },
      {
        title: 'Optional Cox / VinSolutions',
        body: 'Set COX_CLIENT_ID, COX_CLIENT_SECRET, COX_DEALER_ID in .env. Without them, leads save locally only (engine logs that Cox is not configured).',
      },
      {
        title: 'Restart API after env changes',
        body: 'Restart the Python/Node API process so new secrets load. UI-only saves (TikTok Admin keys, user settings) do not require restart.',
      },
    ],
    copyBlocks: [
      {
        label: 'Stripe webhook endpoint',
        value: '{{origin}}/api/v1/billing/webhook',
      },
      {
        label: 'Twilio inbound SMS webhook',
        value: '{{origin}}/api/v1/twilio/inbound',
      },
      {
        label: 'Inbound lead gateway',
        value: '{{origin}}/api/v1/lead',
      },
      {
        label: 'Health check',
        value: '{{origin}}/api/healthz',
      },
    ],
    troubleshooting: [
      'Stripe signature failed → STRIPE_WEBHOOK_SECRET must match the endpoint’s signing secret; use raw body verification.',
      'Twilio 404 → path must be exactly /api/v1/twilio/inbound on the public API host.',
      'Leads not in CRM → Cox credentials missing; check engine logs for INFO Cox credentials not configured.',
      'Local testing → use a tunnel (ngrok) and register that HTTPS origin with providers.',
    ],
  },

  'lead-gateway': {
    id: 'lead-gateway',
    title: 'Lead Gateway & Inbound Pipeline',
    overview:
      'Lead Gateway lets you submit a sample lead through the same NLP pipeline as production SMS/webhooks — ideal for verifying intents, escalation, and appointment booking before wiring Twilio.',
    steps: [
      {
        title: 'Open Lead Gateway',
        body: 'Go to /lead-gateway (or Lead Gateway in navigation where available).',
      },
      {
        title: 'Fill a test lead',
        body: 'Enter phone (required), optional name, source, and a natural-language message (e.g. “I’d like to book a test drive Saturday at 2pm”).',
      },
      {
        title: 'Submit and read the bot reply',
        body: 'Check intent, escalated flag, reply text, and booked_slot. Confirm the lead appears under Leads / Lead Center.',
      },
      {
        title: 'Wire production webhooks',
        body: 'When satisfied, follow the Webhook Endpoints guide to point Twilio (and optional CRM) at the live API.',
      },
    ],
    copyBlocks: [
      {
        label: 'Production lead POST URL',
        value: '{{origin}}/api/v1/lead',
      },
    ],
    troubleshooting: [
      '400 phone required → include phone_number in E.164-ish format.',
      'No appointment booked → message must include a clear time request the NLP can parse.',
      'Escalated unexpectedly → review message for keywords that trigger human handoff.',
    ],
  },
};

/** Guides suggested on each route (for AI Help + inline buttons). */
export const ROUTE_SETUP_GUIDES: Record<string, string[]> = {
  '/marketplace-hub': ['scraper-inventory-url', 'meta-catalog-feed', 'meta-api-credentials'],
  '/settings': [
    'meta-api-credentials',
    'meta-catalog-feed',
    'scraper-inventory-url',
    'tiktok-oauth-connect',
  ],
  '/tiktok': ['tiktok-oauth-connect', 'tiktok-developer-app', 'tiktok-verification-file'],
  '/admin': [
    'tiktok-developer-app',
    'tiktok-verification-file',
    'user-rooftop-management',
    'webhooks-api-keys',
  ],
  '/leads': ['lead-gateway', 'webhooks-api-keys'],
  '/lead-gateway': ['lead-gateway', 'webhooks-api-keys'],
  '/forms': ['lead-gateway'],
  '/team': ['user-rooftop-management'],
};

export function resolveSetupGuide(id: string): SetupGuide | undefined {
  return SETUP_GUIDES[id];
}

export function expandGuideValue(value: string, origin?: string): string {
  const o = origin || (typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.com');
  return value.replaceAll('{{origin}}', o);
}
