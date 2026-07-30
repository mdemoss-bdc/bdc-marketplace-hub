import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  Mail, Printer, Plus, Pencil, Trash2, X, Loader2,
  Copy, Check, Users, MapPin, Car, FileText,
  Send, MailOpen, Tag, ChevronDown, ChevronUp,
  ToggleLeft, ToggleRight,
  Building2, Save, Phone, AtSign, ImagePlus,
} from 'lucide-react';

// ── Avery label format specs ───────────────────────────────────────────────
const LABEL_FORMATS = {
  '5160': {
    id: '5160' as const,
    name: 'Avery 5160 / 8160',
    dims: '1″ × 2⅝″',
    perSheet: '30 labels — 3 columns × 10 rows',
    cols: 3, rows: 10,
    labelW: '2.625in', labelH: '1in',
    marginTop: '0.5in', marginLeft: '0.1875in',
    colGap: '0.125in', rowGap: '0in',
    returnFontSize: '5.5pt', nameFontSize: '8pt', addrFontSize: '7.5pt',
    labelPad: '0.07in 0.08in 0.06in 0.10in',
  },
  '5161': {
    id: '5161' as const,
    name: 'Avery 5161 / 8161',
    dims: '1″ × 4″',
    perSheet: '20 labels — 2 columns × 10 rows',
    cols: 2, rows: 10,
    labelW: '4in', labelH: '1in',
    marginTop: '0.5in', marginLeft: '0.15625in',
    colGap: '0.1875in', rowGap: '0in',
    returnFontSize: '6pt', nameFontSize: '9pt', addrFontSize: '8.5pt',
    labelPad: '0.08in 0.12in 0.06in 0.12in',
  },
  '5163': {
    id: '5163' as const,
    name: 'Avery 5163 / 8163',
    dims: '2″ × 4″',
    perSheet: '10 labels — 2 columns × 5 rows',
    cols: 2, rows: 5,
    labelW: '4in', labelH: '2in',
    marginTop: '0.5in', marginLeft: '0.15625in',
    colGap: '0.1875in', rowGap: '0in',
    returnFontSize: '7pt', nameFontSize: '11pt', addrFontSize: '10pt',
    labelPad: '0.14in 0.16in 0.10in 0.16in',
  },
} as const;

type LabelFormatId = keyof typeof LABEL_FORMATS;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const API_BASE = '/api';

interface Customer {
  id: number;
  user_id: number;
  name: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  vehicle_purchased: string;
  notes: string;
  created_at: string;
}

interface DealerInfo {
  dealer_name: string;
  dealer_address_line1: string;
  dealer_city: string;
  dealer_state: string;
  dealer_zip: string;
  dealer_phone: string;
  dealer_support_email: string;
  dealer_logo_url: string;
  username: string;
}

interface GeneratedEmail {
  subject: string;
  body: string;
}

const EMAIL_TEMPLATES = [
  {
    id: 'thank_you',
    label: 'Immediate Sale Thank You',
    description: 'Send same day as purchase',
    emoji: '🎉',
  },
  {
    id: 'follow_up_30',
    label: '30-Day Follow Up',
    description: 'Check in after a month',
    emoji: '📅',
  },
  {
    id: 'referral',
    label: 'Referral Request',
    description: 'Ask for friends & family',
    emoji: '⭐',
  },
] as const;

const EMPTY_FORM = {
  name: '', email: '', address_line1: '', address_line2: '',
  city: '', state: '', zip: '', vehicle_purchased: '', notes: '',
};

type FormState = typeof EMPTY_FORM;

export default function CustomerMail() {
  const { authFetch } = useAuth();

  const [customers, setCustomers]   = useState<Customer[]>([]);
  const [loading, setLoading]       = useState(true);
  const [dealerInfo, setDealerInfo] = useState<DealerInfo | null>(null);

  // ── Dealer info editing ───────────────────────────────────────────────
  const [showDealerPanel, setShowDealerPanel]   = useState(false);
  const [dealerName, setDealerName]             = useState('');
  const [dealerPhone, setDealerPhone]           = useState('');
  const [dealerEmail, setDealerEmail]           = useState('');
  const [dealerAddr1, setDealerAddr1]           = useState('');
  const [dealerCity, setDealerCity]             = useState('');
  const [dealerState, setDealerState]           = useState('');
  const [dealerZip, setDealerZip]               = useState('');
  const [dealerLogoUrl, setDealerLogoUrl]       = useState('');
  const [savingDealer, setSavingDealer]         = useState(false);
  const [dealerSaveStatus, setDealerSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [dealerSaveMsg, setDealerSaveMsg]       = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Add/Edit modal
  const [showForm, setShowForm]   = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]           = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');

  // Email modal
  const [emailCustomer, setEmailCustomer]         = useState<Customer | null>(null);
  const [selectedTemplate, setSelectedTemplate]   = useState<string>('thank_you');
  const [generatingEmail, setGeneratingEmail]     = useState(false);
  const [generatedEmail, setGeneratedEmail]       = useState<GeneratedEmail | null>(null);
  const [emailCopied, setEmailCopied]             = useState(false);

  // Delete confirm
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // ── Label printing ────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds]         = useState<Set<number>>(new Set());
  const [showLabelModal, setShowLabelModal]   = useState(false);
  const [labelFormat, setLabelFormat]         = useState<LabelFormatId>('5160');
  const [startRow, setStartRow]               = useState(1);
  const [startCol, setStartCol]               = useState(1);
  const [includeReturn, setIncludeReturn]     = useState(true);

  // Derived selection state
  const allAddressable   = customers.filter(c => c.address_line1);
  const isAllSelected    = allAddressable.length > 0 &&
                           allAddressable.every(c => selectedIds.has(c.id));
  const isSomeSelected   = !isAllSelected && allAddressable.some(c => selectedIds.has(c.id));
  const selectedCount    = customers.filter(c => selectedIds.has(c.id)).length;

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allAddressable.map(c => c.id)));
    }
  }, [isAllSelected, allAddressable]);

  // When format changes, clamp start position to valid range
  const changeLabelFormat = useCallback((fmt: LabelFormatId) => {
    setLabelFormat(fmt);
    setStartRow(1);
    setStartCol(1);
  }, []);

  // ── Print labels ─────────────────────────────────────────────────────
  const printLabels = useCallback(() => {
    const fmt = LABEL_FORMATS[labelFormat];
    const skipCount = (startRow - 1) * fmt.cols + (startCol - 1);

    const labelCustomers = customers.filter(c => selectedIds.has(c.id) && c.address_line1);
    const allSlots: Array<Customer | null> = [
      ...Array(skipCount).fill(null),
      ...labelCustomers,
    ];

    const d = dealerInfo;
    const returnLines = includeReturn
      ? [
          d?.dealer_name || d?.username || '',
          d?.dealer_address_line1 || '',
          [d?.dealer_city, d?.dealer_state, d?.dealer_zip].filter(Boolean).join(', '),
        ].filter(Boolean)
      : [];

    const slotHtml = allSlots.map(c => {
      if (!c) return `<div class="label empty"></div>`;
      const cityStateZip = [c.city, c.state, c.zip].filter(Boolean).join(', ');
      const returnHtml = returnLines.length
        ? `<div class="return-addr">${returnLines.map(l => `<div>${escHtml(l)}</div>`).join('')}</div>`
        : '';
      return `<div class="label">
      ${returnHtml}
      <div class="label-name">${escHtml(c.name.trim())}</div>
      ${c.address_line1 ? `<div class="label-addr">${escHtml(c.address_line1)}</div>` : ''}
      ${c.address_line2 ? `<div class="label-addr">${escHtml(c.address_line2)}</div>` : ''}
      ${cityStateZip     ? `<div class="label-addr">${escHtml(cityStateZip)}</div>`   : ''}
    </div>`;
    }).join('\n');

    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('Popup blocked — please allow popups for this site to print labels.'); return; }

    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Address Labels — ${labelFormat}</title>
<style>
  @page { size: letter portrait; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: white;
    font-family: Arial, Helvetica, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .sheet {
    width: 8.5in;
    padding-top: ${fmt.marginTop};
    padding-left: ${fmt.marginLeft};
    display: grid;
    grid-template-columns: repeat(${fmt.cols}, ${fmt.labelW});
    column-gap: ${fmt.colGap};
    row-gap: ${fmt.rowGap};
  }

  .label {
    width: ${fmt.labelW};
    height: ${fmt.labelH};
    padding: ${fmt.labelPad};
    display: flex;
    flex-direction: column;
    justify-content: center;
    overflow: hidden;
    break-inside: avoid;
  }

  .label.empty { /* blank placeholder for skipped slots */ }

  .return-addr {
    font-size: ${fmt.returnFontSize};
    line-height: 1.25;
    color: #555;
    margin-bottom: 0.04in;
  }

  .label-name {
    font-size: ${fmt.nameFontSize};
    font-weight: bold;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #000;
  }

  .label-addr {
    font-size: ${fmt.addrFontSize};
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #000;
  }

  @media print {
    html, body { width: 8.5in; }
  }
</style>
</head>
<body>
  <div class="sheet">
${slotHtml}
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 400);
      window.onafterprint = function() { window.close(); };
    };
  </script>
</body>
</html>`);
    win.document.close();
    setShowLabelModal(false);
  }, [customers, selectedIds, dealerInfo, labelFormat, startRow, startCol, includeReturn]);

  // ── Load customers + dealer info ─────────────────────────────────────
  useEffect(() => {
    Promise.all([
      authFetch(`${API_BASE}/v1/customers`).then(r => r.json()),
      authFetch(`${API_BASE}/v1/dealer-settings`).then(r => r.json()),
    ])
      .then(([cData, dData]) => {
        setCustomers(cData.customers ?? []);
        setDealerInfo(dData);
        // Populate edit fields so the form reflects persisted values immediately
        setDealerName(dData.dealer_name             || '');
        setDealerPhone(dData.dealer_phone            || '');
        setDealerEmail(dData.dealer_support_email    || '');
        setDealerAddr1(dData.dealer_address_line1    || '');
        setDealerCity(dData.dealer_city              || '');
        setDealerState(dData.dealer_state            || '');
        setDealerZip(dData.dealer_zip                || '');
        setDealerLogoUrl(dData.dealer_logo_url       || '');
        // Auto-open panel if address has never been set
        if (!dData.dealer_address_line1) setShowDealerPanel(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authFetch]);

  // ── Form helpers ─────────────────────────────────────────────────────
  function setField(k: keyof FormState, v: string) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  }

  function openEdit(c: Customer) {
    setEditingId(c.id);
    setForm({
      name: c.name, email: c.email,
      address_line1: c.address_line1, address_line2: c.address_line2,
      city: c.city, state: c.state, zip: c.zip,
      vehicle_purchased: c.vehicle_purchased, notes: c.notes,
    });
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { setFormError('Customer name is required.'); return; }
    setSaving(true); setFormError('');
    try {
      if (editingId !== null) {
        const res = await authFetch(`${API_BASE}/v1/customers/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingId, ...form }),
        });
        if (!res.ok) throw new Error('Failed to save changes');
        setCustomers(cs =>
          cs.map(c => c.id === editingId ? { ...c, ...form } : c),
        );
      } else {
        const res = await authFetch(`${API_BASE}/v1/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to add customer');
        setCustomers(cs => [data.customer, ...cs]);
      }
      setShowForm(false);
    } catch (e: unknown) {
      setFormError((e as Error).message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    const res = await authFetch(`${API_BASE}/v1/customers/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setCustomers(cs => cs.filter(c => c.id !== id));
      setDeletingId(null);
    }
  }

  // ── Email helpers ────────────────────────────────────────────────────
  function openEmail(c: Customer) {
    setEmailCustomer(c);
    setSelectedTemplate('thank_you');
    setGeneratedEmail(null);
    setEmailCopied(false);
  }

  async function generateEmail() {
    if (!emailCustomer) return;
    setGeneratingEmail(true);
    setGeneratedEmail(null);
    try {
      const res = await authFetch(`${API_BASE}/v1/customers/generate-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: emailCustomer.id, template_id: selectedTemplate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGeneratedEmail(data);
    } catch { /* silent — user can try again */ }
    finally { setGeneratingEmail(false); }
  }

  function copyEmail() {
    if (!generatedEmail) return;
    const text = `Subject: ${generatedEmail.subject}\n\n${generatedEmail.body}`;
    navigator.clipboard.writeText(text).then(() => {
      setEmailCopied(true);
      setTimeout(() => setEmailCopied(false), 2500);
    });
  }

  // ── Save dealer info ─────────────────────────────────────────────────
  const saveDealerInfo = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingDealer(true);
    setDealerSaveStatus('idle');
    try {
      const res = await authFetch(`${API_BASE}/v1/dealer-info`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealer_name:          dealerName,
          dealer_phone:         dealerPhone,
          dealer_support_email: dealerEmail,
          dealer_address_line1: dealerAddr1,
          dealer_city:          dealerCity,
          dealer_state:         dealerState,
          dealer_zip:           dealerZip,
          dealer_logo_url:      dealerLogoUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      // Sync in-memory dealerInfo so prints immediately reflect new values
      setDealerInfo(prev => prev ? {
        ...prev,
        dealer_name:          dealerName,
        dealer_phone:         dealerPhone,
        dealer_support_email: dealerEmail,
        dealer_address_line1: dealerAddr1,
        dealer_city:          dealerCity,
        dealer_state:         dealerState,
        dealer_zip:           dealerZip,
        dealer_logo_url:      dealerLogoUrl,
      } : null);
      setDealerSaveStatus('success');
      setDealerSaveMsg('Dealership info saved.');
    } catch (err: unknown) {
      setDealerSaveStatus('error');
      setDealerSaveMsg(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingDealer(false);
    }
  }, [authFetch, dealerName, dealerPhone, dealerEmail, dealerAddr1, dealerCity, dealerState, dealerZip, dealerLogoUrl]);

  // ── Logo upload — resize to 240×80 max before storing as base64 ───────
  const handleLogoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX_W = 240, MAX_H = 80;
      const scale = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        setDealerLogoUrl(canvas.toDataURL('image/png', 0.9));
      }
      URL.revokeObjectURL(objectUrl);
    };
    img.src = objectUrl;
    // Reset input so the same file can be re-selected after removal
    e.target.value = '';
  }, []);

  // ── Envelope print (opens new window sized to #10 envelope) ─────────
  function printEnvelope(customer: Customer) {
    const d = dealerInfo;
    const returnLine1 = d?.dealer_name || d?.username || '';
    const returnLine2 = d?.dealer_address_line1 || '';
    const returnLine3 = [d?.dealer_city, d?.dealer_state, d?.dealer_zip].filter(Boolean).join(', ');
    const logoUrl     = d?.dealer_logo_url || '';

    const win = window.open('', '_blank', 'width=1100,height=550');
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html><head>
<title>Envelope — ${customer.name}</title>
<style>
  @page { size: 9.5in 4.125in landscape; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    width: 9.5in; height: 4.125in;
    font-family: 'Times New Roman', Times, serif;
    background: white; position: relative; overflow: hidden;
  }
  .return {
    position: absolute; top: 0.35in; left: 0.5in;
    font-size: 10pt; line-height: 1.55; color: #111;
  }
  .return .org { font-weight: bold; }
  .stamp {
    position: absolute; top: 0.3in; right: 0.45in;
    width: 1.25in; height: 0.95in;
    border: 1.5px dashed #bbb; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    color: #bbb; font-size: 8pt; text-align: center;
    font-family: Arial, sans-serif;
  }
  .recipient {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-35%, -50%);
    margin-top: 0.2in;
    font-size: 13pt; line-height: 1.75; color: #111;
  }
  .recipient .rname { font-weight: bold; }
</style>
</head><body>
  <div class="return">
    ${logoUrl ? `<img src="${logoUrl.replace(/"/g, '&quot;')}" alt="" style="max-height:26pt;max-width:88pt;object-fit:contain;display:block;margin-bottom:4pt;" />` : ''}
    ${returnLine1 ? `<div class="org">${returnLine1}</div>` : ''}
    ${returnLine2 ? `<div>${returnLine2}</div>` : ''}
    ${returnLine3 ? `<div>${returnLine3}</div>` : ''}
  </div>
  <div class="stamp">PLACE<br>STAMP<br>HERE</div>
  <div class="recipient">
    <div class="rname">${customer.name}</div>
    ${customer.address_line1 ? `<div>${customer.address_line1}</div>` : ''}
    ${customer.address_line2 ? `<div>${customer.address_line2}</div>` : ''}
    ${[customer.city, customer.state, customer.zip].filter(Boolean).join(', ')
      ? `<div>${[customer.city, customer.state, customer.zip].filter(Boolean).join(', ')}</div>` : ''}
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 350);
      window.onafterprint = function() { window.close(); };
    };
  </script>
</body></html>`);
    win.document.close();
  }

  // ── Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        Loading customers…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">

      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <MailOpen className="w-4.5 h-4.5 text-primary" />
            </div>
            <h1 className="text-2xl font-display font-bold tracking-tight">
              Customer Cards &amp; Mail
            </h1>
          </div>
          <p className="text-sm text-muted-foreground pl-0.5">
            Send personalized thank-you emails and print addressed envelopes for your customers.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedCount > 0 && (
            <Button
              variant="outline"
              className="gap-2 text-sm border-primary/40 text-primary hover:bg-primary/5"
              onClick={() => setShowLabelModal(true)}
            >
              <Tag className="w-4 h-4" />
              Print Address Labels
              <span className="ml-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 leading-none">
                {selectedCount}
              </span>
            </Button>
          )}
          <Button onClick={openAdd} className="gap-2 flex-shrink-0">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </div>
      </div>

      {/* ── Dealership Info Panel ──────────────────────────────────────── */}
      <div id="dealer-info-panel" className="rounded-xl border bg-card overflow-hidden">
        {/* Collapsible toggle header */}
        <button
          type="button"
          onClick={() => setShowDealerPanel(p => !p)}
          className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-muted/30 transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Building2 className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="text-left min-w-0">
              <p className="text-sm font-semibold">⚙️ Direct Mailer &amp; Store Branding Setup</p>
              {!showDealerPanel && (dealerInfo?.dealer_name || dealerInfo?.dealer_address_line1) && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {[dealerInfo?.dealer_name, dealerInfo?.dealer_address_line1].filter(Boolean).join(' · ')}
                </p>
              )}
              {!showDealerPanel && !dealerInfo?.dealer_address_line1 && (
                <p className="text-xs text-amber-500 mt-0.5 font-medium">
                  Address not set — required for printed envelopes
                </p>
              )}
            </div>
          </div>
          {showDealerPanel
            ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
        </button>

        {showDealerPanel && (
          <div className="border-t px-4 py-5">
            {/* Quick Setup Instructions */}
            <div className="mb-4 rounded-lg bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 px-4 py-3 space-y-1.5">
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-400">💡 Quick Setup Instructions</p>
              <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
                1. Enter your official dealership name and return address as you want them to appear on physical customer letters.
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
                2. Paste your store's logo image link to automatically brand custom thank-you and anniversary letters.
              </p>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Used as the return address on printed envelopes and address labels.
              The logo appears on printed envelopes. Phone and email auto-fill into
              generated customer mail templates.
            </p>
            <form onSubmit={saveDealerInfo} className="space-y-4">

              {/* Name + Phone */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="di-name" className="text-xs font-medium">Dealership Name</Label>
                  <Input
                    id="di-name"
                    value={dealerName}
                    onChange={e => setDealerName(e.target.value)}
                    placeholder="Moses Auto Group"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="di-phone" className="text-xs font-medium">Store Phone</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                    <Input
                      id="di-phone"
                      type="tel"
                      value={dealerPhone}
                      onChange={e => setDealerPhone(e.target.value)}
                      placeholder="(304) 555-0100"
                      className="pl-8"
                    />
                  </div>
                </div>
              </div>

              {/* Support Email */}
              <div className="space-y-1.5">
                <Label htmlFor="di-email" className="text-xs font-medium">Support Email</Label>
                <div className="relative">
                  <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    id="di-email"
                    type="email"
                    value={dealerEmail}
                    onChange={e => setDealerEmail(e.target.value)}
                    placeholder="sales@dealership.com"
                    className="pl-8"
                  />
                </div>
              </div>

              {/* Street Address */}
              <div className="space-y-1.5">
                <Label htmlFor="di-addr1" className="text-xs font-medium">Street Address</Label>
                <Input
                  id="di-addr1"
                  value={dealerAddr1}
                  onChange={e => setDealerAddr1(e.target.value)}
                  placeholder="123 Auto Plaza Dr"
                />
              </div>

              {/* City / State / ZIP */}
              <div className="grid grid-cols-6 gap-2">
                <div className="col-span-3 space-y-1.5">
                  <Label htmlFor="di-city" className="text-xs font-medium">City</Label>
                  <Input
                    id="di-city"
                    value={dealerCity}
                    onChange={e => setDealerCity(e.target.value)}
                    placeholder="Charleston"
                  />
                </div>
                <div className="col-span-1 space-y-1.5">
                  <Label htmlFor="di-state" className="text-xs font-medium">State</Label>
                  <Input
                    id="di-state"
                    value={dealerState}
                    onChange={e => setDealerState(e.target.value.toUpperCase().slice(0, 2))}
                    placeholder="WV"
                    maxLength={2}
                    className="text-center uppercase font-medium"
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="di-zip" className="text-xs font-medium">ZIP</Label>
                  <Input
                    id="di-zip"
                    value={dealerZip}
                    onChange={e => setDealerZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="25301"
                  />
                </div>
              </div>

              {/* Logo Upload */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Logo / Header Image</Label>
                <div className="flex items-start gap-3">
                  {dealerLogoUrl ? (
                    <img
                      src={dealerLogoUrl}
                      alt="Dealership logo preview"
                      className="h-10 max-w-[100px] object-contain rounded border bg-white p-1 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-[100px] h-10 rounded border border-dashed border-border bg-muted/50 flex items-center justify-center flex-shrink-0">
                      <ImagePlus className="w-4 h-4 text-muted-foreground/40" />
                    </div>
                  )}
                  <div className="flex-1 space-y-1.5">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleLogoUpload}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => logoInputRef.current?.click()}
                        className="gap-1.5 h-8 text-xs"
                      >
                        <ImagePlus className="w-3.5 h-3.5" />
                        {dealerLogoUrl ? 'Change' : 'Upload Logo'}
                      </Button>
                      {dealerLogoUrl && (
                        <button
                          type="button"
                          onClick={() => setDealerLogoUrl('')}
                          className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      PNG, JPG, or SVG. Auto-resized to 240×80 px. Appears on printed envelopes.
                    </p>
                  </div>
                </div>
              </div>

              {/* Status banner */}
              {dealerSaveStatus !== 'idle' && (
                <div className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
                  dealerSaveStatus === 'success'
                    ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'bg-destructive/10 text-destructive',
                )}>
                  {dealerSaveStatus === 'success'
                    ? <Check className="w-4 h-4 flex-shrink-0" />
                    : <X className="w-4 h-4 flex-shrink-0" />}
                  {dealerSaveMsg}
                </div>
              )}

              <Button type="submit" disabled={savingDealer} className="gap-2">
                {savingDealer
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving…</>
                  : <><Save className="w-3.5 h-3.5" />Save Dealership Info</>}
              </Button>
            </form>
          </div>
        )}
      </div>

      {/* ── Customer table ─────────────────────────────────────────────── */}
      {customers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 py-20 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
            <Users className="w-7 h-7 text-muted-foreground/40" />
          </div>
          <div>
            <p className="font-semibold">No customers yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Add your first customer to start sending personalized thank-you mail.
            </p>
          </div>
          <Button onClick={openAdd} variant="outline" className="gap-2">
            <Plus className="w-4 h-4" />
            Add Your First Customer
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {/* Select-all checkbox */}
                  <th className="w-10 pl-3 pr-1 py-3">
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      ref={el => { if (el) el.indeterminate = isSomeSelected; }}
                      onChange={toggleSelectAll}
                      disabled={allAddressable.length === 0}
                      title="Select all customers with addresses"
                      className="w-4 h-4 rounded border-border accent-primary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                  </th>
                  {['Customer', 'Vehicle', 'Address', 'Actions'].map((h, i) => (
                    <th
                      key={h}
                      className={[
                        'px-4 py-3 text-left font-semibold text-[11px] text-muted-foreground uppercase tracking-wide',
                        i === 1 ? 'hidden sm:table-cell' : '',
                        i === 2 ? 'hidden md:table-cell' : '',
                        i === 3 ? 'text-right' : '',
                      ].join(' ')}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {customers.map(c => (
                  <tr
                    key={c.id}
                    className={[
                      'hover:bg-muted/20 transition-colors group',
                      selectedIds.has(c.id) ? 'bg-primary/4' : '',
                    ].join(' ')}
                  >
                    {/* Row checkbox — only enabled for customers with addresses */}
                    <td className="w-10 pl-3 pr-1 py-3.5">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                        disabled={!c.address_line1}
                        title={!c.address_line1 ? 'Add an address to include in label print' : 'Select for label printing'}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                      />
                    </td>
                    {/* Name + email */}
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-foreground">{c.name}</p>
                      {c.email && (
                        <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                          <Mail className="w-3 h-3 flex-shrink-0" />
                          {c.email}
                        </p>
                      )}
                    </td>
                    {/* Vehicle */}
                    <td className="px-4 py-3.5 hidden sm:table-cell">
                      {c.vehicle_purchased ? (
                        <span className="flex items-center gap-1.5 text-sm text-foreground/80">
                          <Car className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          {c.vehicle_purchased}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      )}
                    </td>
                    {/* Address */}
                    <td className="px-4 py-3.5 hidden md:table-cell">
                      {c.address_line1 ? (
                        <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <MapPin className="w-3 h-3 flex-shrink-0 mt-0.5" />
                          <span>
                            {c.address_line1}
                            {c.city ? `, ${c.city}` : ''}
                            {c.state ? `, ${c.state}` : ''}
                            {c.zip ? ` ${c.zip}` : ''}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40 text-xs">No address on file</span>
                      )}
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 text-xs"
                          onClick={() => openEmail(c)}
                        >
                          <Mail className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Send Email</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 text-xs"
                          onClick={() => printEnvelope(c)}
                          disabled={!c.address_line1}
                          title={!c.address_line1 ? 'Add an address to print an envelope' : 'Print addressed envelope'}
                        >
                          <Printer className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Print Envelope</span>
                        </Button>
                        <button
                          onClick={() => openEdit(c)}
                          title="Edit"
                          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeletingId(c.id)}
                          title="Delete"
                          className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-border bg-muted/20 flex items-center justify-between gap-4 flex-wrap">
            <p className="text-xs text-muted-foreground">
              {customers.length} customer{customers.length !== 1 ? 's' : ''}
              {selectedCount > 0 && (
                <span className="ml-2 text-primary font-medium">
                  · {selectedCount} selected for labels
                </span>
              )}
            </p>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
              >
                Clear selection
              </button>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          ADD / EDIT MODAL
      ══════════════════════════════════════════════════════════════════ */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-[95vw] sm:max-w-lg rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-5 max-h-[85dvh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">
                {editingId !== null ? 'Edit Customer' : 'Add Customer'}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Customer Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={form.name}
                  onChange={e => setField('name', e.target.value)}
                  placeholder="Jane Smith"
                  className="h-10"
                />
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <Mail className="w-3 h-3" />
                  Email Address
                </label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={e => setField('email', e.target.value)}
                  placeholder="jane@example.com"
                  className="h-10"
                />
              </div>

              {/* Vehicle */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <Car className="w-3 h-3" />
                  Vehicle Purchased
                </label>
                <Input
                  value={form.vehicle_purchased}
                  onChange={e => setField('vehicle_purchased', e.target.value)}
                  placeholder="2023 Toyota Camry SE"
                  className="h-10"
                />
              </div>

              {/* Address */}
              <div className="border-t border-border pt-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <MapPin className="w-3 h-3" />
                  Mailing Address
                </p>
                <Input
                  value={form.address_line1}
                  onChange={e => setField('address_line1', e.target.value)}
                  placeholder="Street Address"
                  className="h-10"
                />
                <Input
                  value={form.address_line2}
                  onChange={e => setField('address_line2', e.target.value)}
                  placeholder="Apt, Suite, Unit (optional)"
                  className="h-10"
                />
                <div className="grid grid-cols-6 gap-2">
                  <Input
                    value={form.city}
                    onChange={e => setField('city', e.target.value)}
                    placeholder="City"
                    className="h-10 col-span-3"
                  />
                  <Input
                    value={form.state}
                    onChange={e => setField('state', e.target.value.toUpperCase().slice(0, 2))}
                    placeholder="WV"
                    maxLength={2}
                    className="h-10 col-span-1 text-center uppercase font-medium"
                  />
                  <Input
                    value={form.zip}
                    onChange={e => setField('zip', e.target.value.replace(/\D/g, '').slice(0, 5))}
                    placeholder="ZIP"
                    className="h-10 col-span-2"
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <FileText className="w-3 h-3" />
                  Notes
                </label>
                <Textarea
                  value={form.notes}
                  onChange={e => setField('notes', e.target.value)}
                  placeholder="Trade-in, referral source, follow-up reminders…"
                  className="min-h-[80px] text-sm resize-none"
                />
              </div>

              {formError && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                  {formError}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <Button variant="outline" onClick={() => setShowForm(false)} className="flex-1 h-10">
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving} className="flex-1 h-10 gap-2">
                  {saving
                    ? <><Loader2 className="w-4 h-4 animate-spin" />Saving…</>
                    : editingId !== null ? 'Save Changes' : 'Add Customer'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          DELETE CONFIRM MODAL
      ══════════════════════════════════════════════════════════════════ */}
      {deletingId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-[95vw] sm:max-w-sm rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-bold">Delete Customer?</h3>
                <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 h-10"
                onClick={() => setDeletingId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1 h-10"
                onClick={() => handleDelete(deletingId!)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          EMAIL MODAL
      ══════════════════════════════════════════════════════════════════ */}
      {emailCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-[95vw] sm:max-w-lg rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-5 max-h-[85dvh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Send Email Thank You</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  To:{' '}
                  <span className="font-semibold text-foreground">{emailCustomer.name}</span>
                  {emailCustomer.email && (
                    <span> · {emailCustomer.email}</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => setEmailCustomer(null)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Template selector */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Choose a Template
              </p>
              <div className="space-y-2">
                {EMAIL_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { setSelectedTemplate(t.id); setGeneratedEmail(null); }}
                    className={[
                      'w-full text-left rounded-lg border px-4 py-3 transition-all',
                      selectedTemplate === t.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'border-border hover:border-muted-foreground/40 hover:bg-muted/30',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base leading-none">{t.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">{t.label}</p>
                        <p className="text-xs text-muted-foreground">{t.description}</p>
                      </div>
                      {selectedTemplate === t.id && (
                        <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Generate button */}
            <Button
              onClick={generateEmail}
              disabled={generatingEmail}
              className="w-full h-11 gap-2"
            >
              {generatingEmail
                ? <><Loader2 className="w-4 h-4 animate-spin" />Generating Email…</>
                : <><Send className="w-4 h-4" />Generate Email Preview</>}
            </Button>

            {/* Preview */}
            {generatedEmail && (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">
                      Subject
                    </p>
                    <p className="text-sm font-semibold leading-snug">{generatedEmail.subject}</p>
                  </div>
                  <div className="h-px bg-border" />
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">
                      Body
                    </p>
                    <p className="text-sm leading-relaxed whitespace-pre-line text-foreground/90">
                      {generatedEmail.body}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1 h-10 gap-2 text-xs"
                    onClick={copyEmail}
                  >
                    {emailCopied
                      ? <><Check className="w-3.5 h-3.5 text-green-500" />Copied!</>
                      : <><Copy className="w-3.5 h-3.5" />Copy Email</>}
                  </Button>
                  {emailCustomer.email ? (
                    <a
                      href={`mailto:${emailCustomer.email}?subject=${encodeURIComponent(generatedEmail.subject)}&body=${encodeURIComponent(generatedEmail.body)}`}
                      className="flex-1 flex items-center justify-center gap-2 h-10 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
                    >
                      <Mail className="w-3.5 h-3.5" />
                      Open in Mail Client
                    </a>
                  ) : (
                    <div className="flex-1 flex items-center justify-center h-10 text-xs text-muted-foreground border border-border rounded-md bg-muted/20">
                      No email on file
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          PRINT ADDRESS LABELS MODAL
      ══════════════════════════════════════════════════════════════════ */}
      {showLabelModal && (() => {
        const fmt = LABEL_FORMATS[labelFormat];
        const skipCount  = (startRow - 1) * fmt.cols + (startCol - 1);
        const labelCount = customers.filter(c => selectedIds.has(c.id) && c.address_line1).length;
        const totalSlots = labelCount + skipCount;
        const sheetsNeeded = Math.ceil(totalSlots / (fmt.rows * fmt.cols));
        const hasReturn = !!(dealerInfo?.dealer_name || dealerInfo?.dealer_address_line1);

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowLabelModal(false); }}
          >
            <div className="relative w-full max-w-[95vw] sm:max-w-xl rounded-2xl border border-border bg-card shadow-2xl flex flex-col max-h-[90dvh]">

              {/* Header */}
              <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-4 border-b border-border flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Tag className="w-4.5 h-4.5 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold leading-tight">Print Address Labels</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {labelCount} customer{labelCount !== 1 ? 's' : ''} selected · configure layout below
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowLabelModal(false)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Scrollable body */}
              <div className="overflow-y-auto px-6 py-5 space-y-6 flex-1">

                {/* ── 1. Label Format ─────────────────────────────── */}
                <div className="space-y-2.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Label Format / Size
                  </p>
                  <div className="space-y-2">
                    {(Object.values(LABEL_FORMATS) as typeof LABEL_FORMATS[LabelFormatId][]).map(f => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => changeLabelFormat(f.id)}
                        className={[
                          'w-full text-left rounded-xl border px-4 py-3 transition-all',
                          labelFormat === f.id
                            ? 'border-primary bg-primary/5 ring-1 ring-primary'
                            : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30',
                        ].join(' ')}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            {/* Tiny label shape preview */}
                            <div
                              className={[
                                'flex-shrink-0 border rounded-sm bg-white shadow-sm',
                                f.id === '5160' ? 'w-8 h-3'
                                  : f.id === '5161' ? 'w-10 h-3'
                                  : 'w-10 h-5',
                                labelFormat === f.id ? 'border-primary/60' : 'border-border',
                              ].join(' ')}
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold">{f.name}</p>
                              <p className="text-xs text-muted-foreground leading-tight">
                                {f.dims} &nbsp;·&nbsp; {f.perSheet}
                              </p>
                            </div>
                          </div>
                          {labelFormat === f.id && (
                            <div className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── 2. Start Position ───────────────────────────── */}
                <div className="space-y-2.5">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Print Start Position
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Skip labels already used on a partially-used sheet.
                    </p>
                  </div>
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Row */}
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium w-10">Row</label>
                      <div className="flex items-center gap-1 border border-border rounded-lg overflow-hidden bg-background">
                        <button
                          type="button"
                          onClick={() => setStartRow(r => Math.max(1, r - 1))}
                          className="px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          disabled={startRow <= 1}
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-semibold select-none">
                          {startRow}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStartRow(r => Math.min(fmt.rows, r + 1))}
                          className="px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          disabled={startRow >= fmt.rows}
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <span className="text-xs text-muted-foreground">of {fmt.rows}</span>
                    </div>

                    {/* Column */}
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium w-10">Col</label>
                      <div className="flex items-center gap-1 border border-border rounded-lg overflow-hidden bg-background">
                        <button
                          type="button"
                          onClick={() => setStartCol(c => Math.max(1, c - 1))}
                          className="px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          disabled={startCol <= 1}
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-semibold select-none">
                          {startCol}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStartCol(c => Math.min(fmt.cols, c + 1))}
                          className="px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          disabled={startCol >= fmt.cols}
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <span className="text-xs text-muted-foreground">of {fmt.cols}</span>
                    </div>
                  </div>
                  {skipCount > 0 && (
                    <p className="text-xs text-muted-foreground">
                      ↳ Skipping {skipCount} blank slot{skipCount !== 1 ? 's' : ''} at the start of the sheet.
                    </p>
                  )}
                </div>

                {/* ── 3. Include Return Address ────────────────────── */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Return Address
                  </p>
                  <button
                    type="button"
                    onClick={() => setIncludeReturn(v => !v)}
                    className="flex items-center gap-3 w-full rounded-xl border border-border px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                  >
                    {includeReturn
                      ? <ToggleRight className="w-5 h-5 text-primary flex-shrink-0" />
                      : <ToggleLeft  className="w-5 h-5 text-muted-foreground flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        {includeReturn ? 'Including return address' : 'No return address'}
                      </p>
                      {includeReturn && hasReturn ? (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {[dealerInfo?.dealer_name, dealerInfo?.dealer_address_line1,
                            [dealerInfo?.dealer_city, dealerInfo?.dealer_state, dealerInfo?.dealer_zip]
                              .filter(Boolean).join(', ')
                          ].filter(Boolean).join(' · ')}
                        </p>
                      ) : includeReturn && !hasReturn ? (
                        <p className="text-xs text-amber-500 mt-0.5">
                          ⚠ No dealership address set —{' '}
                          <a
                            href="/settings"
                            target="_blank"
                            className="underline"
                            onClick={e => e.stopPropagation()}
                          >
                            add it in Settings
                          </a>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Labels will print recipient address only.
                        </p>
                      )}
                    </div>
                  </button>
                </div>

                {/* ── 4. Sheet summary ────────────────────────────── */}
                <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Print Summary
                  </p>
                  <div className="text-sm space-y-0.5 pt-0.5">
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Labels to print</span>
                      <span className="font-semibold">{labelCount}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Skipped slots</span>
                      <span className="font-semibold">{skipCount}</span>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-border pt-1 mt-1">
                      <span className="text-muted-foreground">Sheets needed</span>
                      <span className="font-semibold">{sheetsNeeded}</span>
                    </div>
                  </div>
                  {labelCount === 0 && (
                    <p className="text-xs text-destructive pt-1">
                      No selected customers have an address on file.
                    </p>
                  )}
                </div>

              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-border flex items-center justify-between gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setShowLabelModal(false)}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <Button
                  onClick={printLabels}
                  disabled={labelCount === 0}
                  className="gap-2"
                >
                  <Printer className="w-4 h-4" />
                  Print {labelCount} Label{labelCount !== 1 ? 's' : ''}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
