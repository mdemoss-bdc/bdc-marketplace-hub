/**
 * Privacy Policy page — served at /privacy on the public app origin.
 *
 * Required by Stripe for business verification.
 * Last updated: July 2026
 */

import { ChevronRight } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';

const LAST_UPDATED = 'July 25, 2026';
const SUPPORT_EMAIL = 'support.bdcmanager@gmail.com';

// Public origin of the deployment. Set VITE_APP_URL at build time; falls back to
// the origin the page is actually served from.
const APP_URL =
  import.meta.env.VITE_APP_URL ??
  (typeof window !== 'undefined' ? window.location.origin : '');

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-background flex flex-col">

      {/* ── Minimal header ─────────────────────────────────────────────────── */}
      <header className="border-b border-border bg-card h-14 flex items-center px-4 sm:px-8">
        <a href="/" className="flex items-center gap-2">
          <BrandLogo className="h-7 w-7 flex-shrink-0 rounded-md" />
          <span className="font-display font-bold text-sm tracking-tight">BDC Manager Desk</span>
        </a>
        <nav className="ml-auto flex items-center gap-4">
          <a href="/terms" className="text-xs text-muted-foreground hover:text-foreground">Terms</a>
          <a href="/" className="text-xs font-semibold text-primary hover:underline underline-offset-2">
            Home <ChevronRight className="inline w-3 h-3" />
          </a>
        </nav>
      </header>

      {/* ── Policy body ────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">

        <h1 className="text-3xl font-display font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: {LAST_UPDATED}</p>

        <div className="prose prose-sm max-w-none text-foreground space-y-8">

          {/* 1 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">1. Who We Are</h2>
            <p className="text-muted-foreground leading-relaxed">
              BDC Manager Desk ("<strong>we</strong>", "<strong>us</strong>", or "<strong>our</strong>") operates the
              website and SaaS platform available at{' '}
              <a href={APP_URL} className="text-primary underline underline-offset-2">{APP_URL}</a>.
              We provide automotive dealership BDC (Business Development Center) software tools including
              AI-powered Facebook Marketplace post generation, inventory management, lead tracking, and
              customer follow-up features.
            </p>
            <p className="text-muted-foreground leading-relaxed mt-3">
              Questions about this policy can be directed to us at{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline underline-offset-2">
                {SUPPORT_EMAIL}
              </a>.
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">2. Information We Collect</h2>
            <p className="text-muted-foreground leading-relaxed mb-3">
              We collect the following categories of information when you use our platform:
            </p>
            <ul className="space-y-3 text-muted-foreground">
              <li>
                <strong className="text-foreground">Account information.</strong>{' '}
                When you register, we collect your chosen username, email address, and a hashed
                (non-reversible) version of your password. We never store plain-text passwords.
              </li>
              <li>
                <strong className="text-foreground">Settings and configuration.</strong>{' '}
                Dealership name and address (used to generate customer mail templates), Facebook
                Page ID, inventory source URL, and CRM integration credentials you choose to provide.
              </li>
              <li>
                <strong className="text-foreground">Inventory data.</strong>{' '}
                Vehicle listings pulled from your dealership's public website or DMS sitemap. This
                data is publicly available and is cached in your private account workspace.
              </li>
              <li>
                <strong className="text-foreground">Lead and customer data.</strong>{' '}
                Phone numbers, names, and conversational history of leads managed through the platform.
                This data is entered by you or received via Twilio SMS webhooks from inbound leads.
              </li>
              <li>
                <strong className="text-foreground">Usage data.</strong>{' '}
                Log records of AI generation requests, posting queue activity, login timestamps, and
                IP addresses. Used for security, analytics, and rate-limiting purposes.
              </li>
              <li>
                <strong className="text-foreground">Payment information.</strong>{' '}
                Billing is handled entirely by Stripe. We do not store full card numbers, CVVs, or
                bank account details. We receive a Stripe Customer ID and subscription status from
                Stripe after a successful checkout.
              </li>
              <li>
                <strong className="text-foreground">Device fingerprint.</strong>{' '}
                An anonymised browser fingerprint (via FingerprintJS) is collected during registration
                to prevent abuse of the free trial. No personally identifiable information is derived
                from this fingerprint.
              </li>
            </ul>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">3. How We Use Your Information</h2>
            <ul className="space-y-2 text-muted-foreground">
              <li><span className="text-foreground font-medium">Provide the service.</span> Authenticate you, display your inventory, generate AI content, and manage your lead pipeline.</li>
              <li><span className="text-foreground font-medium">Process payments.</span> Create Stripe checkout sessions, handle subscription lifecycle events (renewal, cancellation, refunds), and apply referral credits.</li>
              <li><span className="text-foreground font-medium">Send transactional emails.</span> Welcome emails, email verification, password reset, and referral credit notifications. We do not send marketing emails.</li>
              <li><span className="text-foreground font-medium">Fraud prevention.</span> Detect free-trial abuse using device fingerprints and rate limiting.</li>
              <li><span className="text-foreground font-medium">Improve the platform.</span> Aggregate, anonymous usage analytics (e.g. which features are most used) to guide product decisions.</li>
              <li><span className="text-foreground font-medium">Legal compliance.</span> Maintain ToS acceptance audit logs as required for payment-processor compliance (Stripe chargeback evidence).</li>
            </ul>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">4. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed mb-3">
              We integrate with the following third-party services, each governed by their own
              privacy policy:
            </p>
            <div className="space-y-3 text-muted-foreground">
              {[
                {
                  name: 'Stripe',
                  url: 'https://stripe.com/privacy',
                  desc: 'Payment processing, subscription management, customer balance (billing credit) transactions.',
                },
                {
                  name: 'Twilio',
                  url: 'https://www.twilio.com/en-us/legal/privacy',
                  desc: 'SMS webhook delivery for inbound lead messages (optional integration).',
                },
                {
                  name: 'Google Gmail (SMTP)',
                  url: 'https://policies.google.com/privacy',
                  desc: 'Transactional email delivery via SMTP.',
                },
                {
                  name: 'OpenAI',
                  url: 'https://openai.com/policies/privacy-policy',
                  desc: 'AI-powered post generation. Vehicle listing text (public data) is sent to the OpenAI API. No personal user data is included in AI prompts.',
                },
                {
                  name: 'FingerprintJS',
                  url: 'https://dev.fingerprint.com/docs/privacy-policy',
                  desc: 'Anonymised browser fingerprinting for free-trial abuse prevention.',
                },
              ].map(s => (
                <div key={s.name}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2 font-medium"
                  >
                    {s.name}
                  </a>
                  {' — '}
                  {s.desc}
                </div>
              ))}
            </div>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">5. Data Retention</h2>
            <p className="text-muted-foreground leading-relaxed">
              Account data (username, email, settings, inventory) is retained for the lifetime of your
              account and deleted within 30 days of account deletion upon request. Payment and legal
              audit records (ToS acceptance logs, billing event logs) are retained for 7 years to
              satisfy financial-regulatory and dispute-resolution requirements. Lead and conversation
              data is stored for the duration of your subscription and deleted with your account.
            </p>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">6. Data Security</h2>
            <p className="text-muted-foreground leading-relaxed">
              Passwords are hashed with PBKDF2-HMAC-SHA256 (260,000 iterations) and are never stored in
              plain text. All data is stored in a managed PostgreSQL database with encrypted
              connections. Session tokens are cryptographically random and expire on logout. All network
              traffic is encrypted via TLS/HTTPS.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">7. Sharing and Disclosure</h2>
            <p className="text-muted-foreground leading-relaxed">
              We do not sell, rent, or share your personal information with third parties for marketing
              purposes. We disclose data only: (a) to the third-party service providers listed in Section 4
              to the minimum extent necessary to operate the service; (b) when required by law, court order,
              or governmental authority; or (c) to protect the rights, safety, or property of BDC Manager
              Desk, our users, or the public.
            </p>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">8. Your Rights</h2>
            <p className="text-muted-foreground leading-relaxed">
              You may request access to, correction of, or deletion of your personal data at any time by
              emailing{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline underline-offset-2">
                {SUPPORT_EMAIL}
              </a>
              . Account deletion requests are processed within 30 days. Note that certain data (billing
              audit records) cannot be deleted before the legally-required retention period expires.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">9. Cookies</h2>
            <p className="text-muted-foreground leading-relaxed">
              We use browser localStorage to persist your authentication session token. We do not use
              third-party tracking cookies or advertising pixels. The FingerprintJS library may set a
              first-party cookie for device recognition during registration; this is used solely for
              free-trial abuse prevention.
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">10. Children's Privacy</h2>
            <p className="text-muted-foreground leading-relaxed">
              BDC Manager Desk is a business-to-business SaaS platform intended for use by automotive
              dealership professionals aged 18 and over. We do not knowingly collect personal information
              from anyone under the age of 18.
            </p>
          </section>

          {/* 11 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">11. Changes to This Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update this Privacy Policy from time to time. When we do, we will revise the
              "Last updated" date at the top. Continued use of the platform after changes are posted
              constitutes your acceptance of the revised policy.
            </p>
          </section>

          {/* 12 */}
          <section>
            <h2 className="text-lg font-semibold mb-2">12. Contact Us</h2>
            <p className="text-muted-foreground leading-relaxed">
              For privacy-related questions, data access or deletion requests, or any other concern:
            </p>
            <div className="mt-3 space-y-1 text-sm text-muted-foreground">
              <p><span className="text-foreground font-medium">Product:</span> BDC Manager Desk</p>
              <p>
                <span className="text-foreground font-medium">Email:</span>{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline underline-offset-2">
                  {SUPPORT_EMAIL}
                </a>
              </p>
              <p><span className="text-foreground font-medium">Website:</span>{' '}
                <a href={APP_URL} className="text-primary underline underline-offset-2">{APP_URL}</a>
              </p>
            </div>
          </section>

        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} BDC Manager Desk</p>
            <nav className="flex items-center gap-6">
              <a href="/" className="text-xs text-muted-foreground hover:text-foreground">Home</a>
              <a href="/terms" className="text-xs text-muted-foreground hover:text-foreground">Terms of Service</a>
              <a href="/privacy" className="text-xs text-primary font-medium">Privacy Policy</a>
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-xs text-muted-foreground hover:text-foreground">Support</a>
            </nav>
          </div>
        </div>
      </footer>

    </div>
  );
}
