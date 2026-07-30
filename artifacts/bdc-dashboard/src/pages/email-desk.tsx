import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Loader2,
  CheckCircle,
  XCircle,
  Edit2,
  SkipForward,
  Bot,
  RefreshCw,
  Send,
  Inbox,
} from 'lucide-react';

const API_BASE = '/api';

type EmailStatus = 'pending_review' | 'approved' | 'sent' | 'skipped' | 'failed';

interface EmailDraft {
  id: number;
  user_id: number;
  phone_number: string;
  customer_name: string;
  last_conversation_summary: string;
  email_subject: string;
  email_body: string;
  status: EmailStatus;
  created_at: string;
  updated_at: string;
}

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_META: Record<EmailStatus, { label: string; cls: string }> = {
  pending_review: {
    label: 'Pending Review',
    cls: 'bg-amber-400/15 text-amber-700 dark:text-amber-400 border-amber-400/30',
  },
  approved: {
    label: 'Approved',
    cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30',
  },
  sent: {
    label: 'Sent',
    cls: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30',
  },
  skipped: {
    label: 'Skipped',
    cls: 'bg-muted text-muted-foreground border-border',
  },
  failed: {
    label: 'Failed',
    cls: 'bg-destructive/10 text-destructive border-destructive/20',
  },
};

function StatusBadge({ status }: { status: EmailStatus }) {
  const { label, cls } = STATUS_META[status] ?? STATUS_META.failed;
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  accentClass,
  icon,
}: {
  label: string;
  value: number;
  accentClass: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {label}
          </span>
          <span className={`${accentClass} opacity-60`}>{icon}</span>
        </div>
        <div className={`text-2xl font-display font-bold ${accentClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function EmailDesk() {
  const { token } = useAuth();

  const [queue, setQueue] = useState<EmailDraft[]>([]);
  const [autoSend, setAutoSend] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  // Per-row state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [actionBusy, setActionBusy] = useState<Record<number, string>>({});

  // ── Data fetching ───────────────────────────────────────────────────────────
  const fetchQueue = async (quiet = false) => {
    if (!token) return;
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/email/queue`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setQueue(data.queue ?? []);
      setAutoSend(!!data.auto_send_emails);
    } catch {}
    finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchQueue();
  }, [token]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const setAction = (id: number, a: string) =>
    setActionBusy((p) => ({ ...p, [id]: a }));
  const clearAction = (id: number) =>
    setActionBusy((p) => { const n = { ...p }; delete n[id]; return n; });

  const post = async (path: string, body: object) => {
    await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  };

  const handleApprove = async (id: number) => {
    setAction(id, 'approve');
    await post('/v1/email/approve', { id });
    clearAction(id);
    fetchQueue(true);
  };

  const handleSkip = async (id: number) => {
    setAction(id, 'skip');
    await post('/v1/email/skip', { id });
    clearAction(id);
    fetchQueue(true);
  };

  const handleSaveEdit = async (id: number) => {
    setAction(id, 'save');
    await post('/v1/email/update', {
      id,
      email_subject: editSubject,
      email_body: editBody,
    });
    clearAction(id);
    setEditingId(null);
    fetchQueue(true);
  };

  const handleToggleAutoSend = async (val: boolean) => {
    setToggleBusy(true);
    setAutoSend(val);
    await post('/v1/email/settings', { auto_send_emails: val });
    setToggleBusy(false);
  };

  // ── Derived counts ──────────────────────────────────────────────────────────
  const pending = queue.filter((e) => e.status === 'pending_review').length;
  const sent    = queue.filter((e) => e.status === 'sent').length;
  const skipped = queue.filter((e) => e.status === 'skipped').length;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-5xl">
      {/* ── Page header ────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-display font-bold tracking-tight flex items-center gap-2">
            <Bot className="w-7 h-7 text-primary" />
            AI Email Desk
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            AI-drafted re-engagement emails for leads silent 60+ days.
            Review, edit, and approve before they go out.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchQueue(true)}
          disabled={refreshing}
          className="flex-shrink-0"
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Refresh
        </Button>
      </div>

      {/* ── Stats row + Auto-Send toggle ────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Pending Review"
          value={pending}
          accentClass="text-amber-600 dark:text-amber-400"
          icon={<Inbox className="w-4 h-4" />}
        />
        <StatCard
          label="Sent"
          value={sent}
          accentClass="text-green-600 dark:text-green-400"
          icon={<Send className="w-4 h-4" />}
        />
        <StatCard
          label="Skipped"
          value={skipped}
          accentClass="text-muted-foreground"
          icon={<SkipForward className="w-4 h-4" />}
        />

        {/* Send-mode card */}
        <Card>
          <CardContent className="pt-4 pb-3 flex flex-col gap-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              Send Mode
            </span>

            <div className="flex items-center gap-2">
              <Switch
                id="auto-send-toggle"
                checked={autoSend}
                onCheckedChange={handleToggleAutoSend}
                disabled={toggleBusy}
              />
              <label
                htmlFor="auto-send-toggle"
                className="text-sm font-medium cursor-pointer leading-none"
              >
                {autoSend ? 'Auto-Send' : 'Manual Approval'}
              </label>
            </div>

            <p className="text-xs text-muted-foreground leading-snug">
              {autoSend
                ? 'Scheduler sends drafts automatically — no review required.'
                : 'Every draft waits for your approval before sending.'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Queue card ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Email Queue</CardTitle>
            {pending > 0 && (
              <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-400/30 text-xs">
                {pending} need review
              </Badge>
            )}
          </div>
          <CardDescription>
            {loading
              ? 'Loading…'
              : queue.length === 0
              ? 'No drafts yet — the scheduler scans every 30 minutes.'
              : `${queue.length} draft${queue.length !== 1 ? 's' : ''} in queue`}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              Loading drafts…
            </div>
          ) : queue.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <Bot className="w-10 h-10 mx-auto text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">
                No drafts generated yet.
              </p>
              <p className="text-xs text-muted-foreground/70 max-w-sm mx-auto">
                The AI scheduler automatically finds leads inactive for 60+ days
                and creates personalized re-engagement drafts every 30 minutes.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {queue.map((email) => {
                const isExpanded = expandedId === email.id;
                const isEditing  = editingId === email.id;
                const busy       = actionBusy[email.id];
                const isPending  = email.status === 'pending_review';

                return (
                  <div key={email.id} className="px-6 py-4 space-y-3">

                    {/* ── Row header ──────────────────────────────────── */}
                    <div className="flex items-start gap-4 flex-wrap">
                      {/* Customer info */}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">
                            {email.customer_name || email.phone_number}
                          </span>
                          <StatusBadge status={email.status} />
                          <span className="text-xs text-muted-foreground font-mono-data">
                            {email.phone_number}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          <span className="font-medium text-foreground/70">Subject: </span>
                          {email.email_subject}
                        </p>
                        <p className="text-xs text-muted-foreground/70 italic truncate">
                          <span className="not-italic font-medium text-foreground/60">
                            Last contact:{' '}
                          </span>
                          {email.last_conversation_summary}
                        </p>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
                        {/* Preview toggle */}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-muted-foreground px-2"
                          onClick={() =>
                            setExpandedId(isExpanded ? null : email.id)
                          }
                        >
                          {isExpanded ? 'Collapse' : 'Preview'}
                        </Button>

                        {isPending && !isEditing && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              disabled={!!busy}
                              onClick={() => {
                                setEditingId(email.id);
                                setEditSubject(email.email_subject);
                                setEditBody(email.email_body);
                                setExpandedId(email.id);
                              }}
                            >
                              <Edit2 className="w-3 h-3 mr-1" />
                              Edit
                            </Button>

                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2 text-muted-foreground"
                              disabled={!!busy}
                              onClick={() => handleSkip(email.id)}
                            >
                              {busy === 'skip' ? (
                                <Loader2 className="w-3 h-3 animate-spin mr-1" />
                              ) : (
                                <SkipForward className="w-3 h-3 mr-1" />
                              )}
                              Skip
                            </Button>

                            <Button
                              size="sm"
                              className="h-7 text-xs px-3"
                              disabled={!!busy}
                              onClick={() => handleApprove(email.id)}
                            >
                              {busy === 'approve' ? (
                                <Loader2 className="w-3 h-3 animate-spin mr-1" />
                              ) : (
                                <Send className="w-3 h-3 mr-1" />
                              )}
                              Approve &amp; Send
                            </Button>
                          </>
                        )}

                        {email.status === 'sent' && (
                          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Sent
                          </span>
                        )}
                        {email.status === 'skipped' && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <XCircle className="w-3.5 h-3.5" />
                            Dismissed
                          </span>
                        )}
                      </div>
                    </div>

                    {/* ── Expanded email body / inline editor ─────────── */}
                    {(isExpanded || isEditing) && (
                      <div className="border border-border rounded-lg bg-muted/30 p-4 space-y-3">
                        {isEditing ? (
                          <>
                            <div className="space-y-1.5">
                              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                Subject
                              </Label>
                              <Input
                                value={editSubject}
                                onChange={(e) => setEditSubject(e.target.value)}
                                className="text-sm h-8"
                              />
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                Email Body
                              </Label>
                              <Textarea
                                value={editBody}
                                onChange={(e) => setEditBody(e.target.value)}
                                rows={9}
                                className="text-sm font-sans resize-y leading-relaxed"
                              />
                            </div>

                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                disabled={!!busy}
                                onClick={() => handleSaveEdit(email.id)}
                              >
                                {busy === 'save' && (
                                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                )}
                                Save Changes
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs"
                                onClick={() => setEditingId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                              AI Draft
                            </p>
                            <p className="text-sm font-semibold">
                              {email.email_subject}
                            </p>
                            <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed text-foreground/90">
                              {email.email_body}
                            </pre>
                            <p className="text-xs text-muted-foreground border-t border-border pt-2 mt-1">
                              Generated{' '}
                              {new Date(email.created_at).toLocaleDateString()}{' '}
                              at{' '}
                              {new Date(email.created_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
