import { Scale, ArrowLeft, ShieldAlert, AlertTriangle, Gavel, Info, ShieldOff } from 'lucide-react';

export default function TermsOfService() {
  return (
    <div className="max-w-3xl mx-auto py-10 px-5">
      {/* Back */}
      <a
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </a>

      {/* Page header */}
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Scale className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-3xl font-display font-bold tracking-tight">
          Terms of Service &amp; Refund Policy
        </h1>
      </div>
      <p className="text-sm text-muted-foreground mb-10">
        Effective date: January 1, 2025 &nbsp;·&nbsp; BDC Manager Desk
      </p>

      <div className="space-y-8 text-foreground">

        {/* § 1 — Acceptance */}
        <Section icon={Info} iconClass="text-primary" bgClass="bg-primary/8">
          <h2 className="text-base font-bold mb-2">1. Acceptance of Terms</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            By creating an account or subscribing to BDC Manager Desk ("the Service"), you agree
            to be bound by these Terms of Service and Refund Policy. If you do not agree to all
            of these terms, do not access or use the Service.
          </p>
        </Section>

        {/* § 2 — No Refunds — highlighted */}
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive flex-shrink-0" />
            <h2 className="text-base font-bold text-destructive">2. No Refund Policy</h2>
          </div>
          <p className="text-sm leading-relaxed font-semibold">
            All subscription purchases, renewals, setup fees, and any other fees paid to BDC
            Manager Desk are strictly non-refundable.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This includes but is not limited to:
          </p>
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc list-inside pl-1">
            <li>Monthly and annual subscription charges</li>
            <li>One-time setup or onboarding fees</li>
            <li>Add-on feature purchases</li>
            <li>Charges for periods in which the account was inactive but not cancelled</li>
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            By completing checkout or creating an account, you explicitly acknowledge and accept
            this no-refund policy. Your acceptance — including the timestamp and IP address of
            your device — is recorded and may be submitted to your payment processor as evidence
            in the event of a chargeback dispute.
          </p>
        </div>

        {/* § 3 — Subscription & Billing */}
        <Section icon={Gavel} iconClass="text-primary" bgClass="bg-primary/8">
          <h2 className="text-base font-bold mb-2">3. Subscription &amp; Billing</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Subscriptions are billed on a recurring monthly basis. By subscribing, you authorize
            BDC Manager Desk to charge your payment method on file automatically at the start of
            each billing cycle. You may cancel at any time; cancellation takes effect at the end
            of the current billing period. No prorated refunds will be issued for unused portions
            of any billing period.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed mt-3 border-t border-border pt-3 italic">
            "By completing your purchase, you authorize recurring charges to your payment method
            and acknowledge that all software sales, setup fees, and subscriptions are
            non-refundable. Service is provided 'As-Is' without guarantees of third-party
            platform availability."
          </p>
        </Section>

        {/* § 4 — Disclaimer of Warranties */}
        <Section icon={AlertTriangle} iconClass="text-amber-500" bgClass="bg-amber-500/8">
          <h2 className="text-base font-bold mb-2">4. Disclaimer of Warranties</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            THE SERVICE IS PROVIDED <strong className="text-foreground">"AS IS"</strong> AND{' '}
            <strong className="text-foreground">"AS AVAILABLE"</strong> WITHOUT WARRANTIES OF ANY
            KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. BDC Manager
            Desk does not warrant that the Service will be uninterrupted, error-free, or free of
            harmful components. We do not guarantee the accuracy, completeness, or timeliness of
            any data, including vehicle inventory data scraped from third-party sources.
          </p>
        </Section>

        {/* § 5 — Limitation of Liability */}
        <Section icon={Scale} iconClass="text-primary" bgClass="bg-primary/8">
          <h2 className="text-base font-bold mb-2">5. Limitation of Liability</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, BDC MANAGER DESK AND ITS
            AFFILIATES, OFFICERS, EMPLOYEES, AGENTS, SUPPLIERS, AND LICENSORS SHALL NOT BE LIABLE
            FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES. IN NO
            EVENT SHALL THE TOTAL AGGREGATE LIABILITY OF BDC MANAGER DESK TO YOU FOR ALL CLAIMS
            ARISING OUT OF OR RELATING TO THE SERVICE EXCEED THE TOTAL FEES YOU PAID TO BDC
            MANAGER DESK IN THE{' '}
            <strong className="text-foreground">TWELVE (12) MONTHS</strong> IMMEDIATELY PRECEDING
            THE DATE THE CLAIM AROSE.
          </p>
        </Section>

        {/* § 6 — Independent Platform Disclaimer */}
        <Section icon={Info} iconClass="text-blue-500" bgClass="bg-blue-500/8">
          <h2 className="text-base font-bold mb-2">6. Independent Platform Disclaimer</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            BDC Manager Desk is an <strong className="text-foreground">independent software
            product</strong> and is{' '}
            <strong className="text-foreground">not affiliated with, endorsed by, sponsored
            by, or officially connected to Meta Platforms, Inc.</strong>, Facebook, Instagram,
            or any of their subsidiaries or affiliates. The names "Meta", "Facebook", and
            "Instagram" are registered trademarks of Meta Platforms, Inc. References to Meta
            products or services are solely for descriptive purposes. BDC Manager Desk makes no
            guarantees regarding the availability, API access, or continued operation of any
            third-party platform, including Meta Commerce Manager. Changes to third-party
            platforms may affect the Service without notice and without entitlement to a refund.
          </p>
        </Section>

        {/* § 7 — Governing Law */}
        <Section icon={Gavel} iconClass="text-primary" bgClass="bg-primary/8">
          <h2 className="text-base font-bold mb-2">7. Governing Law</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            These Terms shall be governed by the laws of the State of West Virginia, without
            regard to its conflict of law provisions. Any disputes shall be resolved exclusively
            in the courts of West Virginia.
          </p>
        </Section>

        {/* § 8 — Changes */}
        <Section icon={Info} iconClass="text-primary" bgClass="bg-primary/8">
          <h2 className="text-base font-bold mb-2">8. Changes to Terms</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We reserve the right to modify these Terms at any time. Continued use of the Service
            after any modification constitutes your acceptance of the new Terms. It is your
            responsibility to review these Terms periodically.
          </p>
        </Section>

        {/* § 9 — Zero-Tolerance Exploitation Policy */}
        <div
          id="exploitation-policy"
          className="rounded-xl border border-destructive/50 bg-destructive/5 p-5 space-y-4"
        >
          <div className="flex items-center gap-2">
            <ShieldOff className="w-5 h-5 text-destructive flex-shrink-0" />
            <h2 className="text-base font-bold text-destructive">
              9. Zero-Tolerance Exploitation Policy
            </h2>
          </div>

          <p className="text-sm font-semibold leading-relaxed">
            Any attempt to exploit, probe, tamper with, or reverse-engineer system endpoints,
            databases, or organizational boundaries will result in immediate, automated account
            suspension or revocation without notice and without refund.
          </p>

          <p className="text-sm text-muted-foreground leading-relaxed">
            BDC Manager Desk operates automated security monitoring on every authenticated API
            request. The system continuously scans for:
          </p>

          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc list-inside pl-1">
            <li>
              <strong className="text-foreground">SQL injection payloads</strong> — including
              UNION SELECT statements, boolean-based injections, time-based blind attacks, and
              stacked query attempts.
            </li>
            <li>
              <strong className="text-foreground">Script and markup injection</strong> — including
              &lt;script&gt; tags, JavaScript protocol handlers, DOM event-handler attribute
              injections, and iframe embedding attempts.
            </li>
            <li>
              <strong className="text-foreground">Unauthorized resource access</strong> — including
              attempts to query, modify, or enumerate organization IDs, user records, or seat data
              belonging to a different account.
            </li>
            <li>
              <strong className="text-foreground">Excessive rate abuse</strong> — automated or
              scripted flooding of protected management endpoints beyond normal usage thresholds.
            </li>
            <li>
              <strong className="text-foreground">Path traversal attacks</strong> — including
              directory escape sequences designed to access files outside the application scope.
            </li>
          </ul>

          <div className="border-t border-destructive/20 pt-4 space-y-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              When a violation is detected, the following actions occur <strong className="text-foreground">
              instantly and automatically</strong>:
            </p>
            <ol className="space-y-1 text-sm text-muted-foreground list-decimal list-inside pl-1">
              <li>The account is permanently suspended.</li>
              <li>All active session tokens are revoked immediately.</li>
              <li>
                The event is logged to a tamper-evident audit record containing the IP address,
                account identifier, timestamp, and the exact payload that triggered the detection.
              </li>
              <li>An HTTP 403 Forbidden response is returned to the caller.</li>
            </ol>
          </div>

          <p className="text-sm text-muted-foreground leading-relaxed italic border-t border-destructive/20 pt-4">
            Suspended accounts are not eligible for refunds. Audit records may be submitted to
            law enforcement or your internet service provider in the event of criminal activity.
            If you believe a suspension was made in error, contact support with your username and
            the timestamp of the incident.
          </p>
        </div>

      </div>

      {/* Footer */}
      <div className="mt-12 pt-6 border-t border-border text-xs text-muted-foreground text-center">
        © {new Date().getFullYear()} BDC Manager Desk. All rights reserved. &nbsp;·&nbsp;
        Questions? Contact us through the Settings page in your account.
      </div>
    </div>
  );
}

// ── Shared section wrapper ─────────────────────────────────────────────────
function Section({
  icon: Icon,
  iconClass,
  bgClass,
  children,
}: {
  icon: React.ElementType;
  iconClass: string;
  bgClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-border ${bgClass} p-5`}>
      <div className={`inline-flex items-center justify-center w-7 h-7 rounded-full bg-background mb-3`}>
        <Icon className={`w-3.5 h-3.5 ${iconClass}`} />
      </div>
      {children}
    </div>
  );
}
