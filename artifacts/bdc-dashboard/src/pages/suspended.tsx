import { ShieldOff, AlertTriangle, Mail } from 'lucide-react';

/**
 * Shown when a user's account has been automatically suspended by the
 * security monitoring system due to a detected policy violation.
 * This page is always public — no auth required.
 */
export default function SuspendedPage() {
  return (
    <div className="min-h-dvh bg-background flex flex-col items-center justify-center px-5 py-12">
      {/* Icon */}
      <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-6">
        <ShieldOff className="w-8 h-8 text-destructive" />
      </div>

      {/* Heading */}
      <h1 className="text-2xl font-display font-bold tracking-tight text-center mb-2">
        Account Suspended
      </h1>
      <p className="text-sm text-muted-foreground text-center max-w-md mb-8">
        Your account has been automatically suspended because our security
        system detected a potential policy violation.
      </p>

      {/* Detail card */}
      <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-5 space-y-4 mb-8">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-destructive">
              Zero-Tolerance Exploitation Policy
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              BDC Manager Desk automatically monitors all API requests for SQL
              injection, script injection, unauthorized resource access, and
              excessive endpoint abuse. Any detected exploit attempt triggers an
              immediate account suspension with no prior warning, in accordance
              with our Acceptable Use Policy.
            </p>
          </div>
        </div>

        <div className="border-t border-destructive/20 pt-4 flex items-start gap-3">
          <Mail className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            If you believe this suspension was made in error, please contact
            support through the email address on file. Include your username
            and the approximate time the issue occurred.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <a
          href="/terms#exploitation-policy"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
        >
          Review Acceptable Use Policy
        </a>
        <span className="hidden sm:inline text-muted-foreground/40">·</span>
        <a
          href="/login"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
        >
          Return to Sign In
        </a>
      </div>

      {/* Branding footer */}
      <p className="mt-12 text-xs text-muted-foreground/50 text-center">
        © {new Date().getFullYear()} BDC Manager Desk
      </p>
    </div>
  );
}
