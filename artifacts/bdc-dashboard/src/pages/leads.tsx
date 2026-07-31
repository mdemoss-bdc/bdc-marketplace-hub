/**
 * Lead Management — smoked-glass SLA cards, AI reply drawer, and
 * Log Call / Schedule Test Drive modal. Backed by /api/leads*.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle,
  CalendarClock,
  CheckCheck,
  Clock,
  Copy,
  Inbox,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react';
import { SetupGuideButton } from '@/components/SetupGuideDrawer';

// ── Types ─────────────────────────────────────────────────────────────────

type LeadStatus = 'New' | 'Contacted' | 'Scheduled' | 'Closed' | 'Lost';
type LeadSource = 'Facebook' | 'Web Form' | 'Phone' | 'Email' | 'Walk-In';
type ActionType = 'call' | 'text' | 'email' | 'note' | 'appointment';

interface Lead {
  id: number;
  customer_name: string;
  phone: string;
  email: string;
  requested_vin: string;
  source: LeadSource | string;
  status: LeadStatus | string;
  notes?: string;
  created_at: string;
  last_action_at: string | null;
  is_unanswered_sla: boolean;
  minutes_since_action: number | null;
}

interface ReplyPayload {
  lead_id: number;
  customer_name?: string;
  phone?: string;
  vehicle?: string;
  reply_text: string;
  source?: string;
  character_count?: number;
}

const SLA_MINUTES = 15;
const STATUS_FILTERS = ['All', 'New', 'Contacted', 'Scheduled', 'Closed'] as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.replace('Z', '+00:00'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seconds remaining until SLA breach (negative = overdue). */
function slaSecondsRemaining(lead: Lead, nowMs: number): number {
  const ref = parseIso(lead.last_action_at) || parseIso(lead.created_at);
  if (!ref) return -SLA_MINUTES * 60;
  const deadline = ref.getTime() + SLA_MINUTES * 60 * 1000;
  return Math.floor((deadline - nowMs) / 1000);
}

function formatCountdown(totalSeconds: number): string {
  const overdue = totalSeconds < 0;
  const abs = Math.abs(totalSeconds);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const pad = `${m}:${String(s).padStart(2, '0')}`;
  return overdue ? `+${pad}` : pad;
}

function sourceIcon(source: string) {
  const s = source.toLowerCase();
  if (s.includes('phone')) return Phone;
  if (s.includes('email')) return Mail;
  return MessageSquare;
}

function statusTone(status: string): string {
  switch (status) {
    case 'New':        return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
    case 'Contacted':  return 'border-amber-300/30 bg-amber-400/10 text-amber-200';
    case 'Scheduled':  return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200';
    case 'Closed':     return 'border-slate-600 bg-slate-800/60 text-slate-400';
    case 'Lost':       return 'border-red-400/30 bg-red-500/10 text-red-200';
    default:           return 'border-slate-700 bg-slate-800/50 text-slate-300';
  }
}

function smsHref(phone: string, body: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return `sms:${digits}?&body=${encodeURIComponent(body)}`;
}

/** Lead Center endpoints are open on the local engine — no session token is
 *  sent and auth failures are not special-cased. */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function Leads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('All');
  const [slaOnly, setSlaOnly] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Reply drawer
  const [replyLead, setReplyLead] = useState<Lead | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [copied, setCopied] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);

  // Log / schedule modal
  const [logLead, setLogLead] = useState<Lead | null>(null);
  const [logAction, setLogAction] = useState<ActionType>('call');
  const [logStatus, setLogStatus] = useState<LeadStatus | ''>('');
  const [logNote, setLogNote] = useState('');
  const [logSaving, setLogSaving] = useState(false);
  const [logError, setLogError] = useState('');

  // Live countdown ticker
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filter !== 'All') params.set('status', filter);
      if (slaOnly) params.set('sla_only', '1');
      const qs = params.toString();
      const res = await fetch(`/api/leads${qs ? `?${qs}` : ''}`);
      const data = await readJson(res);
      if (!res.ok) throw new Error(String(data.error || 'Failed to load leads'));
      setLeads(Array.isArray(data.leads) ? (data.leads as Lead[]) : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load leads');
      setLeads([]);
    } finally {
      setLoading(false);
    }
  }, [filter, slaOnly]);

  useEffect(() => { void fetchLeads(); }, [fetchLeads]);

  // Auto-refresh every 15s so SLA flags stay current
  useEffect(() => {
    const id = window.setInterval(() => { void fetchLeads(); }, 15_000);
    return () => window.clearInterval(id);
  }, [fetchLeads]);

  const slaCount = useMemo(
    () => leads.filter((l) => l.is_unanswered_sla).length,
    [leads],
  );

  const sortedLeads = useMemo(() => {
    return [...leads].sort((a, b) => {
      if (a.is_unanswered_sla !== b.is_unanswered_sla) {
        return a.is_unanswered_sla ? -1 : 1;
      }
      const aSec = slaSecondsRemaining(a, nowMs);
      const bSec = slaSecondsRemaining(b, nowMs);
      return aSec - bSec; // most overdue first
    });
  }, [leads, nowMs]);

  // ── Generate Reply ────────────────────────────────────────────────────

  const openReplyDrawer = async (lead: Lead) => {
    setReplyLead(lead);
    setReplyText('');
    setReplyError('');
    setCopied(false);
    setSentFlash(false);
    setReplyLoading(true);
    try {
      const res = await fetch('/api/leads/generate-reply', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = (await readJson(res)) as unknown as ReplyPayload & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Reply generation failed');
      setReplyText(data.reply_text || '');
    } catch (e: unknown) {
      setReplyError(e instanceof Error ? e.message : 'Reply generation failed');
    } finally {
      setReplyLoading(false);
    }
  };

  const handleCopyReply = async () => {
    if (!replyText) return;
    try {
      await navigator.clipboard.writeText(replyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setReplyError('Clipboard copy failed — select the text manually.');
    }
  };

  const handleSendSms = async () => {
    if (!replyLead || !replyText) return;
    // Open native SMS composer with prefilled body
    window.open(smsHref(replyLead.phone, replyText), '_blank');
    // Log the text attempt so SLA resets
    try {
      await fetch('/api/leads/log-action', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          lead_id: replyLead.id,
          action_type: 'text',
          note: replyText.slice(0, 500),
          new_status: replyLead.status === 'New' ? 'Contacted' : undefined,
        }),
      });
      setSentFlash(true);
      window.setTimeout(() => setSentFlash(false), 2500);
      void fetchLeads();
    } catch {
      /* SMS composer still opened — non-blocking */
    }
  };

  // ── Log Call / Schedule modal ─────────────────────────────────────────

  const openLogModal = (lead: Lead, preset: 'call' | 'appointment' = 'call') => {
    setLogLead(lead);
    setLogAction(preset);
    setLogStatus(preset === 'appointment' ? 'Scheduled' : lead.status === 'New' ? 'Contacted' : (lead.status as LeadStatus));
    setLogNote(preset === 'appointment' ? 'Test drive scheduled with customer.' : '');
    setLogError('');
  };

  const submitLogAction = async () => {
    if (!logLead) return;
    setLogSaving(true);
    setLogError('');
    try {
      const res = await fetch('/api/leads/log-action', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          lead_id: logLead.id,
          action_type: logAction,
          note: logNote,
          new_status: logStatus || undefined,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(String(data.error || 'Failed to log action'));
      setLogLead(null);
      void fetchLeads();
    } catch (e: unknown) {
      setLogError(e instanceof Error ? e.message : 'Failed to log action');
    } finally {
      setLogSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1.5 flex items-center gap-2 text-amber-300/90">
            <Inbox className="h-4 w-4" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">
              Incoming Lead Tracking
            </span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent md:text-3xl">
              BDC Lead Center
            </h1>
            <SetupGuideButton guideId="lead-gateway" label="❓ Setup Guide" />
            <SetupGuideButton guideId="webhooks-api-keys" label="❓ Webhooks" />
          </div>
          <p className="mt-1.5 text-sm tracking-tight text-slate-400">
            15-minute response SLA · AI reply drafts · one-tap log &amp; schedule
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchLeads()}
          className="h-8 gap-1.5 border-slate-700/60 bg-white/[0.03] text-slate-300 hover:border-amber-300/30 hover:text-amber-100"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Open Leads" value={String(leads.length)} />
        <Kpi
          label="SLA Breached"
          value={String(slaCount)}
          accent={slaCount > 0 ? 'danger' : 'ok'}
        />
        <Kpi
          label="New"
          value={String(leads.filter((l) => l.status === 'New').length)}
        />
        <Kpi
          label="Scheduled"
          value={String(leads.filter((l) => l.status === 'Scheduled').length)}
          accent="ok"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              filter === s
                ? 'border-amber-300/40 bg-amber-400/10 text-amber-100'
                : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-700 hover:text-slate-200',
            )}
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSlaOnly((v) => !v)}
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
            slaOnly
              ? 'border-red-400/40 bg-red-500/15 text-red-200'
              : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-amber-300/30 hover:text-amber-100',
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          SLA only
        </button>
      </div>

      {/* Lead cards */}
      {error && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && leads.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
        </div>
      ) : sortedLeads.length === 0 ? (
        <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 px-6 py-16 text-center backdrop-blur-md">
          <User className="mx-auto h-8 w-8 text-slate-600" />
          <p className="mt-3 text-sm text-slate-400">No leads match this filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {sortedLeads.map((lead) => {
            const remaining = slaSecondsRemaining(lead, nowMs);
            const breached = lead.is_unanswered_sla || remaining < 0;
            const critical = breached && remaining < -(5 * 60); // >5 min overdue
            const SourceIcon = sourceIcon(lead.source);
            const showTimer = !['Scheduled', 'Closed', 'Lost'].includes(lead.status);

            return (
              <article
                key={lead.id}
                className={cn(
                  'overflow-hidden rounded-xl border bg-slate-900/80 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset] backdrop-blur-md transition-colors',
                  critical
                    ? 'border-red-500/55 ring-1 ring-red-500/25'
                    : breached
                      ? 'border-amber-400/50 ring-1 ring-amber-400/20'
                      : 'border-slate-800',
                )}
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-800/60 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-100">
                        {lead.customer_name || 'Unknown'}
                      </h3>
                      <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider', statusTone(lead.status))}>
                        {lead.status}
                      </span>
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
                      <SourceIcon className="h-3 w-3 text-slate-500" />
                      {lead.source}
                      {lead.phone ? (
                        <>
                          <span className="text-slate-700">·</span>
                          <span className="font-mono text-slate-300">{lead.phone}</span>
                        </>
                      ) : null}
                    </p>
                  </div>

                  {showTimer && (
                    <div
                      className={cn(
                        'flex flex-shrink-0 flex-col items-end gap-1 rounded-md border px-2 py-1',
                        critical
                          ? 'border-red-400/40 bg-red-500/15'
                          : breached
                            ? 'border-amber-300/40 bg-amber-400/15'
                            : remaining < 5 * 60
                              ? 'border-amber-300/25 bg-amber-400/10'
                              : 'border-slate-700 bg-slate-950/60',
                      )}
                      title={breached ? 'SLA breached — respond now' : 'Time remaining before the 15-minute SLA breach'}
                    >
                      <span
                        className={cn(
                          'flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em]',
                          critical ? 'text-red-300' : breached ? 'text-amber-200' : 'text-slate-500',
                        )}
                      >
                        {breached ? <AlertTriangle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
                        15m SLA
                      </span>
                      <span
                        className={cn(
                          'font-mono text-[13px] font-bold leading-none tabular-nums',
                          critical ? 'text-red-200' : breached ? 'text-amber-100' : 'text-slate-300',
                        )}
                      >
                        {breached ? `+${formatCountdown(remaining).replace('+', '')}` : formatCountdown(remaining)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-3 px-4 py-3">
                  {lead.requested_vin && (
                    <p className="text-xs text-slate-400">
                      <span className="font-semibold uppercase tracking-wider text-slate-500">VIN </span>
                      <span className="font-mono text-slate-200">{lead.requested_vin}</span>
                    </p>
                  )}
                  {lead.notes && (
                    <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {lead.notes}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      onClick={() => void openReplyDrawer(lead)}
                      className="h-8 gap-1.5 border-0 bg-amber-400/90 px-3 text-xs font-semibold text-slate-950 hover:bg-amber-300"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Generate Reply
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openLogModal(lead, 'call')}
                      className="h-8 gap-1.5 border-slate-700/60 bg-white/[0.03] px-3 text-xs text-slate-200 hover:border-amber-300/30 hover:text-amber-100"
                    >
                      <PhoneCall className="h-3.5 w-3.5" />
                      Log Call
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openLogModal(lead, 'appointment')}
                      className="h-8 gap-1.5 border-slate-700/60 bg-white/[0.03] px-3 text-xs text-slate-200 hover:border-emerald-400/30 hover:text-emerald-200"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      Schedule Test Drive
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ── Reply Sheet ─────────────────────────────────────────────── */}
      <Sheet open={!!replyLead} onOpenChange={(open) => { if (!open) setReplyLead(null); }}>
        <SheetContent
          side="right"
          className="w-full border-slate-800 bg-slate-950 text-slate-100 sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle className="text-slate-100">
              AI Reply — {replyLead?.customer_name}
            </SheetTitle>
            <SheetDescription className="text-slate-400">
              High-converting SMS draft referencing vehicle availability. Edit before sending.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
            {replyLead && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-xs text-slate-400">
                <span className="font-mono text-slate-200">{replyLead.phone || 'No phone'}</span>
                {replyLead.requested_vin ? (
                  <>
                    <span className="mx-1.5 text-slate-700">·</span>
                    <span className="font-mono">{replyLead.requested_vin}</span>
                  </>
                ) : null}
              </div>
            )}

            {replyLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating reply…
              </div>
            ) : replyError ? (
              <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {replyError}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 border-red-400/30 text-xs text-red-100"
                  onClick={() => replyLead && void openReplyDrawer(replyLead)}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <Textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={7}
                  className="resize-none border-slate-700/60 bg-slate-900/80 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-amber-300/40"
                />
                <p className="text-[11px] tabular-nums text-slate-500">
                  {replyText.length} characters
                </p>
              </>
            )}

            <div className="flex flex-col gap-2">
              <Button
                onClick={() => void handleSendSms()}
                disabled={!replyText || replyLoading}
                className={cn(
                  'h-10 gap-2 font-semibold',
                  sentFlash
                    ? 'border-0 bg-emerald-500 text-white hover:bg-emerald-500'
                    : 'border-0 bg-[#ff0050] text-white hover:bg-[#d4003f]',
                )}
              >
                {sentFlash ? (
                  <><CheckCheck className="h-4 w-4" /> Logged &amp; Opened SMS</>
                ) : (
                  <><MessageSquare className="h-4 w-4" /> Send SMS</>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleCopyReply()}
                disabled={!replyText || replyLoading}
                className={cn(
                  'h-10 gap-2 border-slate-700/60 bg-white/[0.03]',
                  copied ? 'border-emerald-400/40 text-emerald-300' : 'text-slate-200 hover:border-amber-300/30 hover:text-amber-100',
                )}
              >
                {copied ? (
                  <><CheckCheck className="h-4 w-4" /> Copied!</>
                ) : (
                  <><Copy className="h-4 w-4" /> Copy Reply</>
                )}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Log Call / Schedule modal ───────────────────────────────── */}
      <Dialog open={!!logLead} onOpenChange={(open) => { if (!open) setLogLead(null); }}>
        <DialogContent className="border-slate-800 bg-slate-950 text-slate-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-slate-100">
              {logAction === 'appointment' ? 'Schedule Test Drive' : 'Log Call / Action'}
            </DialogTitle>
          </DialogHeader>

          {logLead && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                Updating <span className="font-semibold text-slate-200">{logLead.customer_name}</span>
                {' '}resets the 15-minute SLA timer.
              </p>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Action Type
                </label>
                <Select value={logAction} onValueChange={(v) => setLogAction(v as ActionType)}>
                  <SelectTrigger className="h-9 border-slate-700/60 bg-slate-900/80 text-slate-100">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950 text-slate-100">
                    <SelectItem value="call">Phone Call</SelectItem>
                    <SelectItem value="text">Text / SMS</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="appointment">Schedule Appointment</SelectItem>
                    <SelectItem value="note">Internal Note</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  New Status
                </label>
                <Select value={logStatus || undefined} onValueChange={(v) => setLogStatus(v as LeadStatus)}>
                  <SelectTrigger className="h-9 border-slate-700/60 bg-slate-900/80 text-slate-100">
                    <SelectValue placeholder="Keep current" />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950 text-slate-100">
                    <SelectItem value="New">New</SelectItem>
                    <SelectItem value="Contacted">Contacted</SelectItem>
                    <SelectItem value="Scheduled">Scheduled</SelectItem>
                    <SelectItem value="Closed">Closed</SelectItem>
                    <SelectItem value="Lost">Lost</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Note
                </label>
                <Textarea
                  value={logNote}
                  onChange={(e) => setLogNote(e.target.value)}
                  rows={3}
                  placeholder="What happened on this touch?"
                  className="resize-none border-slate-700/60 bg-slate-900/80 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-amber-300/40"
                />
              </div>

              {logError && (
                <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {logError}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setLogLead(null)}
              className="border-slate-700/60 bg-white/[0.03] text-slate-300"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitLogAction()}
              disabled={logSaving}
              className="gap-1.5 border-0 bg-amber-400/90 font-semibold text-slate-950 hover:bg-amber-300"
            >
              {logSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save &amp; Reset SLA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Small KPI tile ────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'danger' | 'ok';
}) {
  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/80 px-3.5 py-3 backdrop-blur-md">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p
        className={cn(
          'mt-1 font-display text-2xl font-bold tabular-nums tracking-tight',
          accent === 'danger' ? 'text-red-300' : accent === 'ok' ? 'text-emerald-300' : 'text-slate-100',
        )}
      >
        {value}
      </p>
    </div>
  );
}
