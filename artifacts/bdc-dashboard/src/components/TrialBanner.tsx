import { useState, useEffect } from 'react';
import { X, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { useAuth } from '@/lib/auth';

const API_BASE = import.meta.env.BASE_URL + 'api';

interface QuotaData {
  is_pro: boolean;
  is_trial_expired: boolean;
  trial_day: number;
  trial_max_days: number;
  daily_limit: number;
  days_remaining: number;
  ai_post: { used: number; remaining: number };
  wishlist_entry: { used: number; remaining: number };
}

export function TrialBanner() {
  const { token, isSubscribed } = useAuth();
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token || isSubscribed) return;
    fetch(`${API_BASE}/v1/trial-quota`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setQuota(data); })
      .catch(() => {});
  }, [token, isSubscribed]);

  if (!quota || quota.is_pro || dismissed) return null;

  // Daily actions remaining = the lower of the two action-type counts
  const actionsRemaining = Math.min(quota.ai_post.remaining, quota.wishlist_entry.remaining);
  const expired = quota.is_trial_expired;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg text-sm mb-5">
      <Zap className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
      <p className="flex-1 text-amber-900 dark:text-amber-200 leading-snug">
        {expired ? (
          <>
            <span className="font-semibold">Free Trial Ended</span>
            {' — '}
            <Link href="/pricing" className="font-semibold underline underline-offset-2 hover:opacity-80">
              Upgrade to Pro
            </Link>
            {' for unlimited AI posts, Wishlist leads, and inventory sync.'}
          </>
        ) : (
          <>
            <span className="font-semibold">
              Free Trial: Day {quota.trial_day} of {quota.trial_max_days}
            </span>
            {' — '}
            {actionsRemaining > 0 ? (
              <>{actionsRemaining} daily action{actionsRemaining !== 1 ? 's' : ''} remaining today. </>
            ) : (
              <>Daily limit reached. </>
            )}
            <Link href="/pricing" className="font-semibold underline underline-offset-2 hover:opacity-80">
              Upgrade to Pro
            </Link>
            {' for unlimited access.'}
          </>
        )}
      </p>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-600 dark:text-amber-400 hover:opacity-70 transition-opacity flex-shrink-0"
        aria-label="Dismiss banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
