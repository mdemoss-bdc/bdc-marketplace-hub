import { Shield, User2, Briefcase, Car } from 'lucide-react';
import { LOCAL_ACCOUNTS, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const ICONS = [Shield, User2, Briefcase] as const;

/**
 * Full-screen local Account Selector — no network, no splash spinner.
 * One click writes `active_user` and mounts the dashboard shell.
 */
export function AccountSelector() {
  const { switchAccount } = useAuth();

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-950 px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(251,191,36,0.08),transparent_55%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,rgba(51,65,85,0.45),transparent_50%)]"
      />

      <div className="relative w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-b from-amber-300 to-amber-600 shadow-[0_0_20px_-4px_rgba(251,191,36,0.55)]">
            <Car className="h-6 w-6 text-slate-950" />
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-400">
            BDC Manager Desk
          </h1>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            Local Account Selector
          </p>
          <p className="mt-3 text-sm text-slate-400">
            Choose a workspace. No password — sessions live only in this browser.
          </p>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-800/80 bg-slate-900/80 p-3 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] backdrop-blur-xl">
          {LOCAL_ACCOUNTS.map((account, i) => {
            const Icon = ICONS[i] ?? User2;
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => switchAccount(account.id)}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-xl px-3.5 py-3.5 text-left',
                  'border border-slate-800/60 bg-slate-950/40',
                  'transition-all duration-200',
                  'hover:border-amber-300/30 hover:bg-amber-400/[0.06]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40',
                )}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-amber-300/20 to-amber-600/10 text-amber-200 ring-1 ring-inset ring-amber-300/20 transition-colors group-hover:from-amber-300/30">
                  <Icon className="h-4.5 w-4.5 h-4 w-4" />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-100">
                    {account.user.name}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                    <span className="font-mono text-slate-400">@{account.user.username}</span>
                    <span aria-hidden="true" className="text-slate-700">·</span>
                    <span className="uppercase tracking-wider text-amber-300/80">
                      {account.user.role}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11px] text-slate-500">
                    {account.description}
                  </span>
                </span>
                <span className="flex-shrink-0 rounded-md bg-gradient-to-b from-amber-300 to-amber-500 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-950 opacity-90 transition-opacity group-hover:opacity-100">
                  Sign in
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-5 text-center text-[11px] text-slate-600">
          Session stored as <span className="font-mono text-slate-500">active_user</span> in localStorage
        </p>
      </div>
    </div>
  );
}
