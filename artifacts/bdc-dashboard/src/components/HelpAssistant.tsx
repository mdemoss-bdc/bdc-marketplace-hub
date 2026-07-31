import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  MessageCircle, X, ChevronDown, ChevronUp,
  Book, Activity, Send, Loader2, CheckCircle2,
  AlertCircle, AlertTriangle, RefreshCw, Sparkles,
  Rss, Store, Heart, Settings, LayoutDashboard,
  MailOpen, Zap, Bot, Trash2, Film, Users, Video,
  HelpCircle, Shield, FileText,
} from 'lucide-react';
import { ROUTE_SETUP_GUIDES, SETUP_GUIDES } from '@/lib/setupGuides';
import { SetupGuideDrawer } from '@/components/SetupGuideDrawer';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChatMsg { role: 'user' | 'assistant'; content: string }

interface DiagResult {
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
}

interface Guide {
  title: string;
  icon: React.ElementType;
  steps: string[];
}

// ── Tab-aware quick guides ─────────────────────────────────────────────────────
const GUIDES: Record<string, Guide[]> = {
  '/tiktok': [
    {
      title: 'Connect TikTok & post your first walkaround',
      icon: Film,
      steps: [
        "Expand the '⚙️ TikTok Connection & Account Setup' card at the top of the page.",
        "Click 'Connect TikTok Account' — you'll be redirected to TikTok to authorize BDC Manager Desk.",
        'After authorizing, you are returned here automatically. The status badge turns green.',
        'Choose your Default Video Privacy: Public (max reach), Friends, or Private.',
        'Drag-and-drop or click to upload your vehicle walkaround (MP4 or MOV, max 500 MB).',
        "Click 'Generate Catchphrase' for an AI hook + hashtags, or type your own caption.",
        "Click 'Post to TikTok' — chunks upload directly from your browser to TikTok's servers.",
      ],
    },
    {
      title: 'AI Catchphrase Generator',
      icon: Sparkles,
      steps: [
        "Click 'Generate Catchphrase' in the AI Catchphrase Generator panel on the right.",
        'The AI writes a viral car-sales hook with TikTok-optimised hashtags.',
        'Edit the caption freely before posting — it is not locked after generation.',
        'The first 150 characters are used as the TikTok video title.',
        'Max caption length is 2,200 characters (TikTok platform limit).',
        'Requires an active subscription — the generator is part of the Pro plan.',
      ],
    },
    {
      title: 'Trial limits & Pro upgrade',
      icon: Zap,
      steps: [
        'Free trial: 3 TikTok posts per day for a maximum of 5 days.',
        'The Trial Status Bar (below the setup card) shows posts used today and days left.',
        "After the 5-day trial, the studio locks. Upgrade via the 'Upgrade to Pro' button.",
        'Pro plan ($149/month): unlimited daily TikTok posts, no expiry locks.',
        'Pro users see no trial bar — the studio is always fully unlocked.',
      ],
    },
  ],
  '/marketplace-hub': [
    {
      title: 'Set up your inventory scraper',
      icon: Settings,
      steps: [
        "Expand the '⚙️ Inventory Scraper & Source Setup' card at the top of Marketplace Hub.",
        'Paste your Used Inventory Page URL (e.g. https://yourdealer.com/used-inventory/).',
        'Paste your New Inventory Page URL if you sell new vehicles too.',
        '(Optional) Enter your Salesperson ID to filter inventory to only your assigned units.',
        'Choose Auto-Sync Frequency: Manual only, Hourly, Every 6 hours, or Daily.',
        "Click 'Save Scraper Settings' — inventory syncs on the next scheduled run.",
        'Once synced, the inventory automatically exports to your Meta Catalog CSV feed.',
      ],
    },
    {
      title: 'Connect the Facebook Meta Catalog Feed',
      icon: Rss,
      steps: [
        'Your feed URL is: https://[your-domain]/api/feeds/meta?format=csv&user_id=[user_id]',
        'Use the Diagnostics tab in this panel to find your user_id and validate all required fields.',
        'Open Meta Commerce Manager (Business Portfolio) → Catalogs → your catalog → Data Sources.',
        'Click Add Data Source → Scheduled Feed → paste your feed URL.',
        'Set the update schedule to Daily and save.',
        'Run a test upload — use Run Diagnostics here to pre-validate before submitting.',
      ],
    },
    {
      title: 'Schedule the daily posting queue',
      icon: Store,
      steps: [
        'Select vehicles using the checkboxes in the Inventory tab.',
        'Click "Add to Queue" and choose your posting time slots.',
        'The Queue tab shows pending, posted, and skipped items.',
        'Vehicles rotate daily to keep your Facebook feed fresh.',
      ],
    },
  ],
  '/wishlist': [
    {
      title: 'Add a customer to the Wishlist',
      icon: Heart,
      steps: [
        'Click "Add Customer" in the Wishlist page.',
        'Enter their name, phone, and location.',
        'Set their vehicle criteria: condition, make, model, year range.',
        'Add a max budget and max mileage to narrow the match.',
        'Save — matching runs automatically on every inventory sync.',
      ],
    },
    {
      title: 'How inventory matching works',
      icon: Sparkles,
      steps: [
        'Every wishlist entry is compared to your active inventory.',
        'Matching checks condition, make, model, keyword, year range, mileage, and price.',
        'Matched customers appear at the top with a green "MATCH FOUND" badge.',
        'Matches update automatically every 30 seconds.',
      ],
    },
    {
      title: 'Contact a matched customer',
      icon: MessageCircle,
      steps: [
        'Click the green "View Match" button on a matched customer row.',
        'Review the matching vehicle(s) — image, price, mileage, and VDP link.',
        'Tap "Text Customer" to open a pre-filled SMS with the vehicle details.',
        'On desktop, the phone number is shown so you can call or copy it.',
      ],
    },
  ],
  '/free-generator': [
    {
      title: 'Free tier limits & trial',
      icon: Zap,
      steps: [
        'Free tier: 3 AI listings per day, resets at midnight.',
        '5-day free trial — after that, upgrade to Pro to continue.',
        'Pro plan: $75/month for unlimited posts, inventory sync, and all features.',
        'Your daily usage counter is shown in the URL input card.',
      ],
    },
    {
      title: 'How to generate a listing',
      icon: Sparkles,
      steps: [
        'Paste any vehicle VDP URL into the input field.',
        'Click "Generate Listing" — the AI scrapes and writes the post.',
        'Review the card showing Title, Condition, Price, and AI copy.',
        'Click "Copy Full Post" to copy Facebook Marketplace-ready text.',
        'Use "Text Customer" or paste directly into Facebook.',
      ],
    },
  ],
  '/settings': [
    {
      title: 'Configure your Meta Catalog Feed',
      icon: Rss,
      steps: [
        'Your feed URL is shown at the top of the Facebook section in Settings.',
        'Format: https://[your-domain]/api/feeds/meta?format=csv&user_id=[user_id]',
        'If you set a Catalog Token, append ?token=YOURTOKEN to the URL.',
        'Use "Run Diagnostics" (this panel) to validate your feed before submitting to Meta.',
      ],
    },
    {
      title: 'Connect Facebook integration',
      icon: Store,
      steps: [
        'Open Meta Business Settings and copy the number after business_id= in the URL bar into Facebook Business Manager ID.',
        'Under Accounts → Catalogs, copy the 15-digit Catalog ID into Commerce Account Catalog ID.',
        'Get your Facebook Page ID from facebook.com → your Page → About (or use Connect Facebook OAuth).',
        'Or create a System User in your Business Portfolio with catalog permissions, then paste Page ID + token in Settings → Facebook Integration.',
      ],
    },
    {
      title: 'Set up inventory sync',
      icon: RefreshCw,
      steps: [
        'Enter your dealer website\'s Used inventory URL (e.g. /used-inventory).',
        'Enter the New inventory URL if separate.',
        'Set the sync frequency (daily is recommended).',
        'Click "Save Inventory Settings" then trigger a manual sync from Marketplace Hub.',
      ],
    },
  ],
  '/customer-mail': [
    {
      title: 'Configure store branding & return address',
      icon: Settings,
      steps: [
        "Expand the '⚙️ Direct Mailer & Store Branding Setup' card at the top of the page.",
        'Enter your official dealership name and full return address.',
        'Paste your store logo image URL to brand letters automatically.',
        'Add your dealership phone and support email — these auto-fill mail templates.',
        "Click 'Save Dealership Info' — these details appear on every printed letter and envelope.",
      ],
    },
    {
      title: 'Create a customer card',
      icon: MailOpen,
      steps: [
        'Click "Add Customer" in the Customer Cards tab.',
        "Enter the customer's name, address, and vehicle purchased.",
        'Add any notes about their preferences or history.',
        'The card is saved and can be used for thank-you or anniversary mail.',
      ],
    },
    {
      title: 'Generate a thank-you or anniversary letter',
      icon: Sparkles,
      steps: [
        'Click the "Generate Letter" button on any customer card.',
        'The AI writes a personalized thank-you letter using their name, vehicle, and purchase details.',
        'Edit the letter as needed, then print or save as PDF.',
        'Anniversary letters re-engage past customers — use the same "Generate Letter" flow.',
        'Your dealership branding (name, address, logo) from the setup card fills in automatically.',
      ],
    },
  ],
  '/': [
    {
      title: 'Dashboard overview',
      icon: LayoutDashboard,
      steps: [
        'The dashboard shows today\'s lead count, active sessions, and appointments.',
        'Each metric card is clickable and links to the full detail view.',
        'The activity feed shows inbound leads and recent system events.',
        'Appointments pull from your CRM integration in real time.',
      ],
    },
    {
      title: 'BDC daily workflow',
      icon: Sparkles,
      steps: [
        'Morning: Check the Dashboard for overnight leads and respond within 5 min.',
        'Mid-day: Review the posting queue and post scheduled inventory.',
        'Afternoon: Check Wishlist for new matches and contact customers.',
        'End of day: Review analytics and plan tomorrow\'s posting queue.',
      ],
    },
  ],
  '/admin': [
    {
      title: 'Configure TikTok Developer keys',
      icon: Film,
      steps: [
        'Open Admin Console → TikTok Integration panel.',
        'In TikTok Developer Portal, create an app and copy Client Key + Client Secret.',
        'Register Redirect URI: https://[your-domain]/api/tiktok/callback',
        'Paste both keys here and click Save Credentials — active instantly for all users.',
        'Click ❓ Setup Guide next to the panel for the full portal walkthrough.',
      ],
    },
    {
      title: 'Reset / temporary password for a user',
      icon: Shield,
      steps: [
        'Find the user under Rooftop Accounts or Individual Accounts.',
        'Click Reset / Temp Password → enter or auto-generate a temporary password.',
        'Click Set Temporary Password — hash updates and must_change_password becomes true.',
        'On next login the user must set a new password before accessing the desk.',
        'Other users\' credentials are never modified by this action.',
      ],
    },
    {
      title: 'Webhook endpoints for Twilio & Stripe',
      icon: Settings,
      steps: [
        'Click ❓ Setup Guide on Webhook Endpoints in Admin Console.',
        'Register Stripe: POST /api/v1/billing/webhook with STRIPE_WEBHOOK_SECRET.',
        'Register Twilio inbound SMS: POST /api/v1/twilio/inbound.',
        'Set APP_BASE_URL to your public HTTPS origin before going live.',
      ],
    },
  ],
  '/leads': [
    {
      title: 'Work the Lead Center pipeline',
      icon: Users,
      steps: [
        'Open Lead Center to see sessions with status badges.',
        'Escalated leads are highlighted — take those first.',
        'Open a session to review bot replies and customer messages.',
        'Use Lead Gateway to dry-run NLP before wiring Twilio.',
      ],
    },
  ],
  '/lead-gateway': [
    {
      title: 'Test the inbound lead engine',
      icon: Zap,
      steps: [
        'Enter a phone number and a natural-language message.',
        'Submit — review intent, reply, escalated flag, and booked_slot.',
        'Confirm the lead appears in Lead Center.',
        'When ready, point Twilio at /api/v1/twilio/inbound (see Setup Guide).',
      ],
    },
  ],
  '/forms': [
    {
      title: 'Paperwork Desk basics',
      icon: FileText,
      steps: [
        'Paperwork Desk holds deal jackets and document workflows for the desk.',
        'Complete required fields for the active deal before marking ready.',
        'Inbound leads still flow through Lead Center / Lead Gateway — not this page.',
      ],
    },
  ],
  '/team': [
    {
      title: 'Invite reps and manage seats',
      icon: Users,
      steps: [
        'Copy your referral link from Referrals / Profile and share with sales reps.',
        'New signups via your link join the rooftop and consume one seat.',
        'Use Add More Seats to purchase extras through Stripe when the base 10 are full.',
      ],
    },
  ],
  '/email-desk': [
    {
      title: 'Email Desk follow-ups',
      icon: MailOpen,
      steps: [
        'Review queued customer emails and send or schedule follow-ups.',
        'SMTP credentials are configured via server environment variables (not per-user UI).',
        'APP_BASE_URL must be set so links inside emails resolve correctly.',
      ],
    },
  ],
  '/appointments': [
    {
      title: 'Appointment board',
      icon: LayoutDashboard,
      steps: [
        'Appointments are created when the BDC NLP books a slot from SMS or Lead Gateway.',
        'Open Appointments to see customer, time, and vehicle interest.',
        'Follow up on no-shows from Lead Center sessions.',
      ],
    },
  ],
};

const DEFAULT_GUIDES: Guide[] = [
  {
    title: 'Getting started with BDC Manager Desk',
    icon: LayoutDashboard,
    steps: [
      "Open Marketplace Hub → expand '⚙️ Inventory Scraper & Source Setup' and paste your dealer inventory URLs.",
      'Sync your inventory — it automatically exports to your Meta Catalog CSV feed.',
      'Connect your TikTok account in TikTok AI Video Studio to start posting vehicle walkarounds.',
      'Add customers to the Inventory Wishlist to auto-match them to available vehicles.',
      "Set up your store branding in Customer Cards & Mail → '⚙️ Direct Mailer & Store Branding Setup'.",
      'Use the Free AI Generator to create individual Facebook Marketplace posts from any VDP URL.',
    ],
  },
  {
    title: 'Team & Seats (Rooftop Admins)',
    icon: Users,
    steps: [
      'Rooftop Admin accounts see a Team section in the admin console.',
      'Copy your referral link from your Account / Profile area and share it with your sales reps.',
      'When a rep signs up using your link, they join your rooftop team automatically.',
      'Rooftop plans include up to 10 seats — the admin console shows seats used vs. available.',
      'Each rep has their own isolated workspace; you see centralized store-wide analytics.',
    ],
  },
];

const SUGGESTED_QUESTIONS: Record<string, string[]> = {
  '/tiktok': [
    'How do I pair my account?',
    'Why is my feed push failing?',
    'How do I set Client Key and Redirect URI?',
    'What are the TikTok trial limits for free users?',
  ],
  '/marketplace-hub': [
    'How do I set the scraper Target Inventory URL?',
    'Why is my Meta feed showing "invalid price" errors?',
    'How do I add vehicles to the posting queue?',
    'My feed URL returns 0 vehicles — what\'s wrong?',
  ],
  '/wishlist': [
    'How does the matching algorithm work?',
    'Why isn\'t a customer showing as matched?',
    'Can I add multiple makes for one customer?',
  ],
  '/free-generator': [
    'How many free listings can I generate per day?',
    'The generator returned an error — what should I try?',
    'How is the listing description written by the AI?',
  ],
  '/settings': [
    'Where do I find my Facebook Page ID?',
    'How do I get a Meta catalog access token?',
    'My inventory isn\'t syncing — how do I fix it?',
    'How do I connect TikTok from Settings?',
  ],
  '/customer-mail': [
    'How do I add my store logo to letters?',
    'What\'s the difference between a thank-you and an anniversary letter?',
    'Where does the return address on letters come from?',
  ],
  '/admin': [
    'How do I set TikTok Client Key and Secret?',
    'How do I assign a temporary password?',
    'What redirect URI do I register in TikTok?',
    'Where do I configure Stripe and Twilio webhooks?',
  ],
  '/leads': [
    'How does the lead pipeline work?',
    'How do I wire Twilio inbound SMS?',
    'Why was a lead escalated?',
  ],
  '/lead-gateway': [
    'How do I test the BDC lead engine?',
    'What URL should external forms POST to?',
    'How do I book an appointment from a test message?',
  ],
  '/forms': [
    'What is Paperwork Desk used for?',
    'How do leads from forms reach the BDC engine?',
  ],
  '/team': [
    'How do I invite a rep to my rooftop?',
    'How do I add more seats?',
  ],
  '/email-desk': [
    'How does Email Desk send follow-ups?',
    'Where do I configure SMTP?',
  ],
  '/appointments': [
    'Where do appointments come from?',
    'How do I confirm a booked slot?',
  ],
  '/': [
    'How do I post vehicle walkarounds to TikTok?',
    'How do I set up the Facebook Meta Feed?',
    'How do I upgrade to Pro?',
  ],
};

const PAGE_LABELS: Record<string, string> = {
  '/': 'Dashboard Hub',
  '/dashboard': 'Dashboard Hub',
  '/tiktok': 'TikTok Hub',
  '/marketplace-hub': 'Marketplace Hub',
  '/wishlist': 'Inventory Wishlist',
  '/free-generator': 'Free AI Generator',
  '/customer-mail': 'Customer Cards & Mail',
  '/settings': 'Settings / Integrations',
  '/leads': 'Lead Center',
  '/lead-gateway': 'Lead Gateway',
  '/forms': 'Paperwork Desk',
  '/appointments': 'Appointments',
  '/admin': 'Admin Console',
  '/team': 'Team & Seats',
  '/email-desk': 'Email Desk',
  '/referrals': 'Referrals',
  '/pricing': 'Pricing',
};

/** Normalize wouter path → guide/suggestion key. */
function resolveHelpRoute(location: string): string {
  const path = (location.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  if (GUIDES[path] || SUGGESTED_QUESTIONS[path]) return path;
  if (path === '/dashboard') return '/';
  const aliases: Record<string, string> = {
    '/tiktok-hub': '/tiktok',
    '/lead-center': '/leads',
    '/paperwork-desk': '/forms',
  };
  if (aliases[path]) return aliases[path];
  // Prefix match longest known key
  const keys = Object.keys(PAGE_LABELS).filter((k) => k !== '/').sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (path === k || path.startsWith(`${k}/`)) return k;
  }
  return path;
}

// ── Guide accordion item ───────────────────────────────────────────────────────
function GuideItem({ guide }: { guide: Guide }) {
  const [open, setOpen] = useState(false);
  const Icon = guide.icon;
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-3.5 h-3.5 text-primary" />
        </div>
        <span className="flex-1 text-sm font-semibold leading-tight">{guide.title}</span>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 bg-muted/30 space-y-2">
          {guide.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </span>
              <p className="text-xs text-foreground/80 leading-relaxed">{step}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Diagnostic result row ──────────────────────────────────────────────────────
function DiagRow({ result }: { result: DiagResult }) {
  const [open, setOpen] = useState(result.status !== 'pass');
  return (
    <div className={`rounded-lg border overflow-hidden ${
      result.status === 'pass' ? 'border-emerald-500/30 bg-emerald-500/5'
      : result.status === 'fail' ? 'border-destructive/30 bg-destructive/5'
      : 'border-amber-500/30 bg-amber-500/5'
    }`}>
      <button
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
        onClick={() => result.detail && setOpen(o => !o)}
        disabled={!result.detail}
      >
        {result.status === 'pass'
          ? <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          : result.status === 'fail'
          ? <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
          : <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />}
        <span className={`flex-1 text-xs font-semibold ${
          result.status === 'pass' ? 'text-emerald-700 dark:text-emerald-400'
          : result.status === 'fail' ? 'text-destructive'
          : 'text-amber-700 dark:text-amber-400'
        }`}>{result.label}</span>
        {result.detail && (
          open
            ? <ChevronUp className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
      </button>
      {open && result.detail && (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground leading-relaxed border-t border-current/10 pt-2">
          {result.detail}
        </p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function HelpAssistant() {
  const { token, authFetch, isSubscribed } = useAuth();
  const [location] = useLocation();

  const [open, setOpen]       = useState(false);
  const [tab, setTab]         = useState<'guides' | 'diagnostics' | 'chat'>('guides');
  const [setupGuideId, setSetupGuideId] = useState<string | null>(null);

  // Chat
  const [history, setHistory]     = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Diagnostics
  const [diagState, setDiagState]     = useState<'idle' | 'running' | 'done'>('idle');
  const [diagResults, setDiagResults] = useState<DiagResult[]>([]);
  const [userId, setUserId]           = useState<number | null>(null);

  const helpRoute = useMemo(() => resolveHelpRoute(location), [location]);

  // Load user_id for diagnostics feed URL
  useEffect(() => {
    if (!token || !isSubscribed) return;
    authFetch('/api/v1/settings')
      .then(r => r.json())
      .then(d => setUserId(d.user_id ?? null))
      .catch(() => {});
  }, [token, isSubscribed, authFetch]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, chatLoading]);

  // Guides for current page (route-aware)
  const guides = GUIDES[helpRoute] ?? DEFAULT_GUIDES;
  const suggestions = SUGGESTED_QUESTIONS[helpRoute] ?? SUGGESTED_QUESTIONS['/'];
  const pageLabel = PAGE_LABELS[helpRoute] ?? PAGE_LABELS[location] ?? 'this page';
  const setupGuideIds = ROUTE_SETUP_GUIDES[helpRoute] ?? [];

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const runDiagnostics = useCallback(async () => {
    setDiagState('running');
    setDiagResults([]);
    const results: DiagResult[] = [];

    if (!userId) {
      results.push({
        label: 'User ID',
        status: 'fail',
        detail: 'Could not load your user ID. Make sure you are signed in and subscribed.',
      });
      setDiagResults(results);
      setDiagState('done');
      return;
    }

    const feedUrl = `${window.location.origin}/api/feeds/meta?format=csv&user_id=${userId}`;

    try {
      const res = await fetch(feedUrl);

      // ── Check 1: Status 200 ──────────────────────────────────────────
      results.push({
        label: 'Feed returns 200 OK',
        status: res.status === 200 ? 'pass' : 'fail',
        detail: res.status !== 200
          ? `Server returned HTTP ${res.status}. Check that your catalog token is correct and the engine is running.`
          : undefined,
      });

      const text = await res.text();
      const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const header   = rawLines[0] ?? '';
      const dataRows = rawLines.slice(1);

      // ── Check 2: Non-empty body with at least 1 data row ────────────
      results.push({
        label: `Feed contains vehicle data (${dataRows.length} vehicle${dataRows.length !== 1 ? 's' : ''})`,
        status: dataRows.length > 0 ? 'pass' : 'fail',
        detail: dataRows.length === 0
          ? 'No vehicle rows found. Open Marketplace Hub and run an inventory sync, then re-run diagnostics.'
          : undefined,
      });

      // ── Check 3: Required Meta automotive fields ─────────────────────
      const REQUIRED = [
        { field: 'fb_page_id',    desc: 'Facebook Page ID — needed to link the catalog to your FB page.' },
        { field: 'vehicle_id',    desc: 'Unique vehicle identifier — required by Meta automotive catalog.' },
        { field: 'price',         desc: 'Price column — must be in "XXXXX USD" format.' },
        { field: 'link',          desc: 'VDP or dealer link — required; empty links will be rejected by Meta.' },
        { field: 'image_link',    desc: 'Primary vehicle image URL — required for carousel ads.' },
        { field: 'title',         desc: 'Listing title — required for ad display.' },
        { field: 'availability',  desc: '"in stock" value — required by Meta\'s automotive schema.' },
        { field: 'condition',     desc: '"new" or "used" — required by Meta\'s automotive schema.' },
      ];

      for (const { field, desc } of REQUIRED) {
        const present = header.toLowerCase().includes(field);
        results.push({
          label: `Meta field: ${field}`,
          status: present ? 'pass' : 'fail',
          detail: !present
            ? `"${field}" is missing from the CSV header. ${desc}`
            : undefined,
        });
      }

      // ── Check 4: Sample row column count matches header ──────────────
      if (dataRows.length > 0) {
        const headerCols  = header.split(',').length;
        const sampleLine  = dataRows[0];
        // Simple CSV column count (handles basic quoting)
        const sampleCols  = sampleLine.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length;
        const colsMatch   = Math.abs(headerCols - sampleCols) <= 1; // allow off-by-one for trailing comma
        results.push({
          label: `CSV column alignment (${headerCols} columns)`,
          status: colsMatch ? 'pass' : 'warn',
          detail: !colsMatch
            ? `Header has ${headerCols} columns but first data row has ${sampleCols}. Embedded commas may not be properly quoted — Meta may fail to parse some rows.`
            : undefined,
        });
      }

      // ── Check 5: No zero-price vehicles in sample ────────────────────
      if (dataRows.length > 0) {
        const priceIdx = header.split(',').findIndex(h => h.trim().toLowerCase() === 'price');
        if (priceIdx >= 0) {
          // Parse with basic CSV awareness (quoted fields)
          const parseRow = (row: string) =>
            row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(v => v.replace(/^"|"$/g, '').trim());

          const sampleData = dataRows.slice(0, 10).map(parseRow);
          const zeroPrices = sampleData.filter(cols => {
            const raw = cols[priceIdx] ?? '';
            return parseInt(raw.replace(/\D/g, '') || '0', 10) === 0;
          }).length;

          results.push({
            label: zeroPrices === 0
              ? 'Price values are valid (no zero prices detected)'
              : `${zeroPrices} vehicle(s) with $0 price in sample`,
            status: zeroPrices === 0 ? 'pass' : 'warn',
            detail: zeroPrices > 0
              ? 'Meta may reject listings with a price of $0. Check your inventory data for vehicles missing a price.'
              : undefined,
          });
        }
      }

    } catch (err) {
      results.push({
        label: 'Feed connection',
        status: 'fail',
        detail: `Could not reach ${feedUrl}. The API server may be down or the URL is incorrect.`,
      });
    }

    setDiagResults(results);
    setDiagState('done');
  }, [userId]);

  // ── Chat ───────────────────────────────────────────────────────────────────
  async function sendMessage(msg?: string) {
    const text = (msg ?? chatInput).trim();
    if (!text || chatLoading) return;
    setChatInput('');

    const userMsg: ChatMsg = { role: 'user', content: text };
    setHistory(h => [...h, userMsg]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/v1/help/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: text,
          context: pageLabel,
          route: helpRoute,
          history: history.slice(-8),
        }),
      });
      const data = await res.json();
      setHistory(h => [...h, { role: 'assistant', content: data.reply ?? 'No response.' }]);
    } catch {
      setHistory(h => [...h, {
        role: 'assistant',
        content: 'Connection error — please try again.',
      }]);
    } finally {
      setChatLoading(false);
    }
  }

  // ── Close-confirm handlers ─────────────────────────────────────────────────
  function handleXClick() {
    if (history.length > 0) {
      setCloseConfirm(true);
    } else {
      setOpen(false);
    }
  }

  function handleClearAndClose() {
    setHistory([]);
    setCloseConfirm(false);
    setOpen(false);
  }

  function handleKeepAndClose() {
    setCloseConfirm(false);
    setOpen(false);
  }

  // ── Render: don't render at all on the login page / when not authed ────────
  if (!token) return null;

  const passCount = diagResults.filter(r => r.status === 'pass').length;
  const failCount = diagResults.filter(r => r.status === 'fail').length;

  return (
    <>
      <SetupGuideDrawer
        guideId={setupGuideId}
        open={!!setupGuideId}
        onClose={() => setSetupGuideId(null)}
      />

      {/* ── Panel ──────────────────────────────────────────────────────── */}
      {open && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 z-[59] bg-black/40 backdrop-blur-sm sm:hidden"
            onClick={() => setOpen(false)}
          />

          <div className={`
            fixed z-[60] flex flex-col relative overflow-hidden
            bottom-0 left-0 right-0 h-[90dvh] rounded-t-2xl
            sm:bottom-20 sm:right-5 sm:left-auto sm:w-[390px] sm:h-[580px] sm:rounded-2xl
            bg-card border border-border shadow-2xl
            animate-in slide-in-from-bottom-4 duration-200
          `}>
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-primary-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold tracking-tight leading-none">BDC AI Assistant</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  {pageLabel} · Diagnostics & Help
                </p>
              </div>
              <button
                onClick={handleXClick}
                className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close assistant"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── Close-confirm overlay ───────────────────────────────── */}
            {closeConfirm && (
              <div
                className="absolute inset-0 z-30 bg-background/75 backdrop-blur-sm flex items-center justify-center p-6 rounded-2xl"
                onClick={handleKeepAndClose}
              >
                <div
                  className="bg-card border border-border rounded-2xl p-5 shadow-2xl w-full max-w-[280px] text-center space-y-4"
                  onClick={e => e.stopPropagation()}
                >
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                    <MessageCircle className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-bold tracking-tight">
                      Clear this conversation?
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                      Your chat history will be erased. Quick Guides and Diagnostics are unaffected.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleKeepAndClose}
                      className="flex-1 h-9 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      Keep Chat
                    </button>
                    <button
                      onClick={handleClearAndClose}
                      className="flex-1 h-9 rounded-lg bg-destructive text-destructive-foreground text-xs font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5"
                    >
                      <Trash2 className="w-3 h-3" />
                      Clear &amp; Close
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Tab bar ────────────────────────────────────────────── */}
            <div className="flex border-b border-border flex-shrink-0">
              {([
                { id: 'guides',      label: 'Quick Guides', icon: Book },
                { id: 'diagnostics', label: 'Diagnostics',  icon: Activity },
                { id: 'chat',        label: 'Ask AI',        icon: MessageCircle },
              ] as const).map(t => {
                const Icon = t.icon;
                const isActive = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                      isActive
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t.label}
                    {t.id === 'diagnostics' && diagState === 'done' && failCount > 0 && (
                      <span className="ml-0.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
                        {failCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* ── Body ───────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto">

              {/* ── Quick Guides tab ──────────────────────────────────── */}
              {tab === 'guides' && (
                <div className="p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Sparkles className="w-3.5 h-3.5 text-primary" />
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {pageLabel} — Quick Guides
                    </p>
                  </div>
                  {guides.map((g, i) => <GuideItem key={i} guide={g} />)}

                  {setupGuideIds.length > 0 && (
                    <div className="pt-2 border-t border-border space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Manual Settings — Setup Guides
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Exhaustive walkthroughs for the configurable fields on this page.
                      </p>
                      <div className="space-y-1.5">
                        {setupGuideIds.map((id) => {
                          const g = SETUP_GUIDES[id];
                          if (!g) return null;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setSetupGuideId(id)}
                              className="w-full text-left px-3 py-2 rounded-lg border border-sky-500/25 bg-sky-500/5 text-xs hover:bg-sky-500/10 transition-colors flex items-center gap-2"
                            >
                              <HelpCircle className="w-3.5 h-3.5 flex-shrink-0 text-sky-600 dark:text-sky-400" />
                              <span className="font-medium text-foreground/90">{g.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="pt-2 border-t border-border">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                      Common Questions for {pageLabel}
                    </p>
                    <div className="space-y-1.5">
                      {suggestions.map((q, i) => (
                        <button
                          key={i}
                          onClick={() => { setTab('chat'); sendMessage(q); }}
                          className="w-full text-left px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-2"
                        >
                          <MessageCircle className="w-3 h-3 flex-shrink-0 text-primary" />
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ── Diagnostics tab ──────────────────────────────────── */}
              {tab === 'diagnostics' && (
                <div className="p-4 space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Meta Catalog Feed Validator
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Fetches your live catalog feed and validates all required Meta Automotive fields
                      before you submit to Commerce Manager.
                    </p>
                  </div>

                  {userId && (
                    <div className="rounded-lg bg-muted/40 border border-border px-3 py-2">
                      <p className="text-[10px] font-semibold text-muted-foreground mb-0.5">Feed URL</p>
                      <p className="text-xs font-mono text-foreground/80 break-all">
                        {`${window.location.origin}/api/feeds/meta?format=csv&user_id=${userId}`}
                      </p>
                    </div>
                  )}

                  <Button
                    onClick={runDiagnostics}
                    disabled={diagState === 'running' || !userId}
                    className="w-full gap-2"
                    size="sm"
                  >
                    {diagState === 'running'
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Running checks…</>
                      : <><Activity className="w-3.5 h-3.5" />Run Diagnostic Test</>}
                  </Button>

                  {diagState === 'done' && (
                    <>
                      {/* Summary banner */}
                      <div className={`rounded-lg border px-3 py-2.5 flex items-center gap-2 ${
                        failCount === 0
                          ? 'border-emerald-500/30 bg-emerald-500/8'
                          : 'border-destructive/30 bg-destructive/8'
                      }`}>
                        {failCount === 0
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                          : <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
                        <p className={`text-xs font-semibold ${
                          failCount === 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'
                        }`}>
                          {failCount === 0
                            ? `All ${passCount} checks passed — feed is ready for Meta.`
                            : `${failCount} issue${failCount !== 1 ? 's' : ''} found — fix before submitting to Meta.`}
                        </p>
                      </div>

                      {/* Results list */}
                      <div className="space-y-1.5">
                        {diagResults.map((r, i) => <DiagRow key={i} result={r} />)}
                      </div>

                      {failCount > 0 && (
                        <button
                          onClick={() => { setTab('chat'); sendMessage('My Meta feed diagnostic failed. What should I fix first?'); }}
                          className="w-full text-xs text-primary hover:underline underline-offset-2 text-center"
                        >
                          Ask AI to help fix these issues →
                        </button>
                      )}
                    </>
                  )}

                  {diagState === 'idle' && !userId && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      Sign in with an active subscription to run diagnostics.
                    </p>
                  )}
                </div>
              )}

              {/* ── Chat tab ─────────────────────────────────────────── */}
              {tab === 'chat' && (
                <div className="flex flex-col h-full">
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {history.length === 0 && (
                      <div className="space-y-4">
                        <div className="flex items-start gap-2.5">
                          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Bot className="w-3 h-3 text-primary-foreground" />
                          </div>
                          <div className="flex-1 bg-muted/50 rounded-xl rounded-tl-sm px-3 py-2.5">
                            <p className="text-xs leading-relaxed">
                              Hi! I'm your BDC AI Assistant. I know every feature inside BDC Manager
                              Desk — TikTok posting, inventory scraper setup, the Meta Catalog Feed,
                              Wishlist matching, Customer Mail, and team management.
                              <br /><br />
                              What can I help you with?
                            </p>
                          </div>
                        </div>

                        {/* ── Global Quick Action Chips ─────────────────── */}
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                            Quick Actions
                          </p>
                          <div className="space-y-1.5">
                            {[
                              { icon: Film,          label: 'How do I post walkarounds to TikTok?' },
                              { icon: Settings,       label: 'How do I set up my inventory scraper?' },
                              { icon: Zap,            label: 'What are the Pro vs. Free limits for TikTok?' },
                              { icon: Users,          label: 'How do I invite reps to my Rooftop team?' },
                            ].map(({ icon: Icon, label }, i) => (
                              <button
                                key={i}
                                onClick={() => sendMessage(label)}
                                className="w-full text-left px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-xs text-primary hover:bg-primary/10 transition-colors flex items-center gap-2"
                              >
                                <Icon className="w-3 h-3 flex-shrink-0 opacity-70" />
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* ── Page-specific suggestions ─────────────────── */}
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                            Suggested for {pageLabel}
                          </p>
                          <div className="space-y-1.5">
                            {suggestions.map((q, i) => (
                              <button
                                key={i}
                                onClick={() => sendMessage(q)}
                                className="w-full text-left px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              >
                                {q}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {history.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                      >
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-gradient-to-br from-primary to-primary/70 text-primary-foreground'
                        }`}>
                          {msg.role === 'user'
                            ? <span className="text-[10px] font-bold">You</span>
                            : <Bot className="w-3 h-3" />}
                        </div>
                        <div className={`max-w-[82%] px-3 py-2.5 rounded-xl text-xs leading-relaxed whitespace-pre-wrap ${
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground rounded-tr-sm'
                            : 'bg-muted/50 text-foreground rounded-tl-sm'
                        }`}>
                          {msg.content}
                        </div>
                      </div>
                    ))}

                    {chatLoading && (
                      <div className="flex items-start gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Bot className="w-3 h-3 text-primary-foreground" />
                        </div>
                        <div className="bg-muted/50 rounded-xl rounded-tl-sm px-3 py-3 flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                        </div>
                      </div>
                    )}

                    <div ref={chatEndRef} />
                  </div>

                  {/* Chat input */}
                  <div className="border-t border-border p-3 flex-shrink-0">
                    {history.length > 0 && (
                      <button
                        onClick={() => setHistory([])}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-2 block"
                      >
                        Clear conversation
                      </button>
                    )}
                    <form
                      onSubmit={e => { e.preventDefault(); sendMessage(); }}
                      className="flex gap-2"
                    >
                      <Input
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        placeholder="Ask anything about BDC Manager Desk…"
                        className="flex-1 h-9 text-xs"
                        disabled={chatLoading}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-9 w-9 p-0 flex-shrink-0"
                        disabled={!chatInput.trim() || chatLoading}
                      >
                        {chatLoading
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Send className="w-3.5 h-3.5" />}
                      </Button>
                    </form>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Floating trigger button ─────────────────────────────────────── */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`
          fixed bottom-20 right-5 z-[60]
          h-12 px-4 rounded-full shadow-lg
          bg-gradient-to-br from-primary to-primary/80
          text-primary-foreground
          flex items-center gap-2
          transition-all duration-200
          hover:scale-105 active:scale-95 hover:shadow-xl
        `}
        aria-label={open ? 'Close AI Assistant' : 'Open AI Assistant'}
      >
        {open
          ? <X className="w-5 h-5" />
          : <>
              <Bot className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm font-semibold tracking-tight">AI Help</span>
            </>}
      </button>
    </>
  );
}
