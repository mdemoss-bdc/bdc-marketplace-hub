/**
 * AdminFixTool — ⚡ AI Fix Generator
 *
 * Visible ONLY to the master admin (user.is_master_admin).
 *
 * Intercepts browser console errors, runtime exceptions, unhandled promise
 * rejections, and failed network requests at the module level (persists across
 * re-renders). When the admin opens the modal, the captured events are fed to
 * the AI which produces a ready-to-paste debugging prompt for an AI coding agent.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Zap, X, Copy, CheckCheck, Loader2,
  Bug, Globe, ChevronDown, ChevronUp, RefreshCw, Terminal,
} from 'lucide-react';

// ─── Module-level circular error buffers (survive re-renders) ─────────────────

interface CapturedError {
  type: 'console' | 'runtime' | 'promise';
  message: string;
  ts: string;
  stack?: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  status: number;
  statusText: string;
  ts: string;
}

const _errBuf: CapturedError[]   = [];
const _netBuf: CapturedRequest[] = [];
let   _installed                 = false;

function _pushErr(e: CapturedError)  { _errBuf.push(e);  if (_errBuf.length > 20) _errBuf.shift(); }
function _pushNet(r: CapturedRequest){ _netBuf.push(r);  if (_netBuf.length > 15) _netBuf.shift(); }

function _ts() { return new Date().toISOString(); }

/** Call once — idempotent. Hooks console.error, onerror, unhandledrejection, fetch. */
export function installErrorInterceptors() {
  if (_installed || typeof window === 'undefined') return;
  _installed = true;

  // console.error ──────────────────────────────────────────────────────────────
  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origErr(...args);
    const msg = args.map(a =>
      a instanceof Error ? `${a.message}\n${a.stack ?? ''}`
      : typeof a === 'object' ? JSON.stringify(a)
      : String(a),
    ).join(' ');
    _pushErr({ type: 'console', message: msg.slice(0, 800), ts: _ts() });
  };

  // window.onerror ─────────────────────────────────────────────────────────────
  const prevOnError = window.onerror;
  window.onerror = (msg, src, line, col, err) => {
    _pushErr({
      type:    'runtime',
      message: `${String(msg)}  ·  ${src ?? '?'}:${line ?? '?'}:${col ?? '?'}`,
      ts:      _ts(),
      stack:   err?.stack,
    });
    return prevOnError ? prevOnError(msg, src, line, col, err) : false;
  };

  // unhandledrejection ─────────────────────────────────────────────────────────
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev.reason;
    _pushErr({
      type:    'promise',
      message: String(reason?.message ?? reason ?? 'Unhandled rejection'),
      ts:      _ts(),
      stack:   reason?.stack,
    });
  });

  // fetch (non-2xx + network throws) ───────────────────────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const rawUrl =
      typeof input === 'string'        ? input
      : input instanceof Request       ? input.url
      : String(input);
    const relUrl = rawUrl.replace(window.location.origin, '') || rawUrl;
    const method = (args[1] as RequestInit | undefined)?.method ?? 'GET';

    let resp: Response;
    try {
      resp = await origFetch(...args);
      if (!resp.ok) {
        _pushNet({ method, url: relUrl, status: resp.status, statusText: resp.statusText, ts: _ts() });
      }
      return resp;
    } catch (err: unknown) {
      _pushNet({
        method,
        url:        relUrl,
        status:     0,
        statusText: err instanceof Error ? err.message : 'Network error',
        ts:         _ts(),
      });
      throw err;
    }
  };
}

// ─── Fallback prompt (when AI key absent / call fails) ────────────────────────

function buildFallbackPrompt(
  route: string,
  errors: CapturedError[],
  requests: CapturedRequest[],
): string {
  const lines: string[] = [`Fix the following errors detected on ${route}:\n`];

  if (errors.length > 0) {
    lines.push('## Console / Runtime Errors');
    errors.slice(-6).forEach((e, i) => {
      lines.push(`${i + 1}. [${e.type.toUpperCase()}] ${e.message.slice(0, 300)}`);
      if (e.stack) {
        const firstFrame = e.stack.split('\n').find(l => l.trim().startsWith('at '));
        if (firstFrame) lines.push(`   → ${firstFrame.trim()}`);
      }
    });
    lines.push('');
  }

  if (requests.length > 0) {
    lines.push('## Failed API Requests');
    requests.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.method} ${r.url}  →  HTTP ${r.status} ${r.statusText}`);
    });
    lines.push('');
  }

  lines.push('## Investigation Steps');
  lines.push('1. Locate and open the file/route handler associated with the errors above.');
  lines.push('2. Check authentication guards, null-safety assertions, and TypeScript types.');
  lines.push('3. Verify each listed API endpoint returns the correct JSON shape and 200 status.');
  lines.push('4. Add proper error handling for async operations and re-test.');
  lines.push('');
  lines.push('## Expected Outcome');
  lines.push('All identified errors resolved. App renders without console errors.');
  lines.push('All listed API endpoints return 200 JSON with the expected response shape.');

  return lines.join('\n');
}

// ─── Module-level imperative trigger (used by Sidebar to open the modal) ─────

let _triggerOpen: (() => void) | null = null;
const _badgeListeners: Array<(n: number) => void> = [];

/** Called by the Sidebar's Engine Status row button. */
export function triggerAdminFix() { _triggerOpen?.(); }

/** Subscribe to live badge-count updates. Returns an unsubscribe fn. */
export function onAdminFixBadge(fn: (n: number) => void): () => void {
  _badgeListeners.push(fn);
  return () => {
    const i = _badgeListeners.indexOf(fn);
    if (i !== -1) _badgeListeners.splice(i, 1);
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AdminFixTool() {
  const { user, authFetch } = useAuth();
  const [location]          = useLocation();

  const [open,       setOpen]       = useState(false);
  const [errors,     setErrors]     = useState<CapturedError[]>([]);
  const [requests,   setRequests]   = useState<CapturedRequest[]>([]);
  const [errOpen,    setErrOpen]    = useState(true);
  const [netOpen,    setNetOpen]    = useState(true);
  const [generating, setGenerating] = useState(false);
  const [prompt,     setPrompt]     = useState('');
  const [copied,     setCopied]     = useState(false);
  const [badgeCount, setBadgeCount] = useState(0);

  // Stable ref so the sidebar trigger can always call the latest handleOpen
  // without violating the hooks-before-early-return rule.
  const _openRef = useRef<(() => void) | null>(null);

  // Install interceptors as soon as master admin loads the app
  useEffect(() => { installErrorInterceptors(); }, []);

  // Register imperative trigger (stable pointer via ref — safe before guard)
  useEffect(() => {
    _triggerOpen = () => _openRef.current?.();
    return () => { _triggerOpen = null; };
  }, []);

  // Keep badge count live; also notify Sidebar subscribers
  useEffect(() => {
    const tick = () => {
      const n = _errBuf.length + _netBuf.length;
      setBadgeCount(n);
      _badgeListeners.forEach(fn => fn(n));
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  // Gate — master admin only
  if (!user?.is_master_admin) return null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleOpen = () => {
    setErrors([..._errBuf]);
    setRequests([..._netBuf]);
    setPrompt('');
    setCopied(false);
    setOpen(true);
  };
  // Keep ref in sync so the pre-guard trigger effect always calls the latest version
  _openRef.current = handleOpen;

  const handleRefresh = () => {
    setErrors([..._errBuf]);
    setRequests([..._netBuf]);
  };

  const totalIssues = errors.length + requests.length;

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setPrompt('');

    const errSummary = errors.length > 0
      ? errors.map(e =>
          `[${e.type.toUpperCase()} @ ${e.ts}] ${e.message}` +
          (e.stack ? `\n  → ${e.stack.split('\n').find(l => l.trim().startsWith('at '))?.trim() ?? ''}` : '')
        ).join('\n\n')
      : 'No console errors captured.';

    const netSummary = requests.length > 0
      ? requests.map(r => `${r.method} ${r.url}  →  HTTP ${r.status} ${r.statusText}  (${r.ts})`).join('\n')
      : 'No failed network requests captured.';

    const aiMsg =
      `You are a debugging assistant embedded inside a React/Vite + Python HTTP ` +
      `server dashboard app (BDC Manager Desk). ` +
      `Analyze the browser errors and failed API requests below, then produce ONE concise, ` +
      `structured prompt the developer can paste DIRECTLY into an AI coding agent to fix the issue.\n\n` +
      `Current Route: ${location}\n` +
      `Captured At: ${new Date().toISOString()}\n\n` +
      `=== Console / Runtime Errors ===\n${errSummary}\n\n` +
      `=== Failed API Requests ===\n${netSummary}\n\n` +
      `Formatting rules for the output prompt:\n` +
      `• Start with: "Fix the following error detected on ${location}:"\n` +
      `• List 3–5 numbered investigation steps. Name specific files, route handlers, or ` +
      `  TypeScript interfaces where possible.\n` +
      `• End with "Expected outcome:" describing exactly what success looks like.\n` +
      `• Output ONLY the prompt text — no preamble, no meta-commentary.`;

    try {
      const res = await authFetch('/api/v1/help/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: aiMsg,
          context: 'Master Admin AI Fix Generator',
        }),
      });
      const data = await res.json();
      const reply = (data.reply ?? '').trim();
      setPrompt(reply || buildFallbackPrompt(location, errors, requests));
    } catch {
      setPrompt(buildFallbackPrompt(location, errors, requests));
    } finally {
      setGenerating(false);
    }
  }, [authFetch, location, errors, requests]);

  const handleCopy = () => {
    if (!prompt) return;
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Modal backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Modal panel */}
      {open && (
        <div className={cn(
          'fixed z-[71] flex flex-col overflow-hidden',
          // Mobile: full-height sheet from bottom
          'bottom-0 left-0 right-0 h-[92dvh] rounded-t-2xl',
          // Desktop: centered dialog
          'sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:right-auto',
          'sm:-translate-x-1/2 sm:-translate-y-1/2',
          'sm:w-[620px] sm:h-[700px] sm:rounded-2xl',
          'bg-zinc-950 border border-zinc-800 shadow-2xl',
          'animate-in slide-in-from-bottom-4 duration-200',
        )}>

          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-zinc-800 flex-shrink-0">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold tracking-tight text-zinc-100">⚡ AI Fix Generator</p>
              <p className="text-[10px] text-zinc-500 mt-0.5 font-mono">
                Master Admin · <span className="text-amber-500/80">{location}</span>
              </p>
            </div>
            <button
              onClick={handleRefresh}
              className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              title="Refresh — pull latest captured events"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">

            {/* Context summary card */}
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Session Context
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                <span className="text-zinc-500">Current route</span>
                <span className="font-mono text-amber-400">{location}</span>

                <span className="text-zinc-500">Console errors</span>
                <span className={cn('font-bold', errors.length > 0 ? 'text-red-400' : 'text-emerald-400')}>
                  {errors.length}
                </span>

                <span className="text-zinc-500">Failed requests</span>
                <span className={cn('font-bold', requests.length > 0 ? 'text-amber-400' : 'text-emerald-400')}>
                  {requests.length}
                </span>

                <span className="text-zinc-500">Snapshot taken</span>
                <span className="text-zinc-400 font-mono text-[10px]">{new Date().toLocaleTimeString()}</span>
              </div>
            </div>

            {/* Console / Runtime errors */}
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
              <button
                onClick={() => setErrOpen(p => !p)}
                className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-zinc-800/50 transition-colors"
              >
                <Bug className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                <span className="flex-1 text-xs font-semibold text-left text-zinc-200">
                  Console &amp; Runtime Errors
                </span>
                <span className={cn(
                  'px-2 py-0.5 rounded-full text-[10px] font-bold mr-1',
                  errors.length > 0
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-emerald-500/15 text-emerald-500',
                )}>
                  {errors.length}
                </span>
                {errOpen
                  ? <ChevronUp   className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                  : <ChevronDown className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />}
              </button>

              {errOpen && (
                <div className="border-t border-zinc-800">
                  {errors.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-zinc-600 italic">
                      No errors captured yet — interact with the app to reproduce, then refresh.
                    </p>
                  ) : (
                    <div className="divide-y divide-zinc-800/60 max-h-52 overflow-y-auto">
                      {errors.map((e, i) => (
                        <div key={i} className="px-4 py-2.5 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'text-[9px] font-bold px-1.5 py-0.5 rounded uppercase',
                              e.type === 'console' ? 'bg-red-900/60 text-red-400'
                              : e.type === 'promise' ? 'bg-amber-900/60 text-amber-400'
                              : 'bg-orange-900/60 text-orange-400',
                            )}>
                              {e.type}
                            </span>
                            <span className="text-[10px] text-zinc-600 font-mono">
                              {new Date(e.ts).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-300 font-mono leading-relaxed break-all line-clamp-3">
                            {e.message.slice(0, 400)}
                          </p>
                          {e.stack && (
                            <p className="text-[10px] text-zinc-600 font-mono truncate">
                              {e.stack.split('\n').find(l => l.trim().startsWith('at '))?.trim()}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Failed network requests */}
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden">
              <button
                onClick={() => setNetOpen(p => !p)}
                className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-zinc-800/50 transition-colors"
              >
                <Globe className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                <span className="flex-1 text-xs font-semibold text-left text-zinc-200">
                  Failed API Requests
                </span>
                <span className={cn(
                  'px-2 py-0.5 rounded-full text-[10px] font-bold mr-1',
                  requests.length > 0
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'bg-emerald-500/15 text-emerald-500',
                )}>
                  {requests.length}
                </span>
                {netOpen
                  ? <ChevronUp   className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                  : <ChevronDown className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />}
              </button>

              {netOpen && (
                <div className="border-t border-zinc-800">
                  {requests.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-zinc-600 italic">
                      No failed requests captured yet.
                    </p>
                  ) : (
                    <div className="divide-y divide-zinc-800/60 max-h-40 overflow-y-auto">
                      {requests.map((r, i) => (
                        <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                          <span className={cn(
                            'text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5',
                            r.status >= 500 ? 'bg-red-900/70 text-red-400'
                            : r.status >= 400 ? 'bg-amber-900/60 text-amber-400'
                            : 'bg-zinc-800 text-zinc-400',
                          )}>
                            {r.status || 'ERR'}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-mono text-zinc-300 truncate">
                              <span className="text-zinc-500">{r.method} </span>
                              {r.url}
                            </p>
                            <p className="text-[10px] text-zinc-600">
                              {r.statusText} · {new Date(r.ts).toLocaleTimeString()}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Analyze button */}
            <Button
              onClick={handleGenerate}
              disabled={generating || totalIssues === 0}
              className="w-full gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold border-0 shadow-md"
            >
              {generating
                ? <><Loader2 className="w-4 h-4 animate-spin" />Analyzing with AI…</>
                : <><Zap className="w-4 h-4" />Analyze &amp; Generate Fix Prompt</>}
            </Button>

            {totalIssues === 0 && !generating && (
              <p className="text-[11px] text-zinc-600 text-center -mt-1">
                No errors captured yet — reproduce the issue, then click the refresh button (↻) above.
              </p>
            )}

            {/* Generated prompt */}
            {prompt && (
              <div className="rounded-xl bg-zinc-900 border border-amber-500/40 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/80">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-xs font-bold text-amber-400">AI Agent Fix Prompt</span>
                  </div>
                  <button
                    onClick={handleCopy}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all duration-150',
                      copied
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25',
                    )}
                  >
                    {copied
                      ? <><CheckCheck className="w-3 h-3" /> Copied!</>
                      : <><Copy className="w-3 h-3" /> 📋 Copy Fix Prompt</>}
                  </button>
                </div>
                <pre className="px-4 py-3 text-[11px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                  {prompt}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Trigger button moved into Sidebar beside Engine Status */}
    </>
  );
}
