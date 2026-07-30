import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ClipboardList, Car, KeyRound, PackageCheck, Printer, Save, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type FormKind = 'test_drive' | 'gate_pass' | 'delivery';

interface MasterFields {
  buyer_name: string;
  vin: string;
  stock_number: string;
  price: string;
  mileage: string;
  active_form: FormKind;
  notes: string;
}

const EMPTY: MasterFields = {
  buyer_name: '',
  vin: '',
  stock_number: '',
  price: '',
  mileage: '',
  active_form: 'test_drive',
  notes: '',
};

const TABS: { id: FormKind; label: string; icon: typeof Car }[] = [
  { id: 'test_drive', label: 'Test Drive Agreement', icon: Car },
  { id: 'gate_pass',  label: 'Gate Pass',            icon: KeyRound },
  { id: 'delivery',   label: 'Delivery Checklist',   icon: PackageCheck },
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-black/20 pb-1 min-h-[2.25rem]">
      <div className="text-[10px] uppercase tracking-wide text-black/50 font-semibold">{label}</div>
      <div className="text-sm font-medium text-black min-h-[1.25rem]">{value || '\u00A0'}</div>
    </div>
  );
}

function SigLine({ label }: { label: string }) {
  return (
    <div className="mt-8">
      <div className="border-b border-black h-8" />
      <div className="text-[11px] text-black/60 mt-1">{label}</div>
    </div>
  );
}

function TestDriveDoc({ m }: { m: MasterFields }) {
  return (
    <article className="forms-doc space-y-5 text-black">
      <header className="text-center border-b-2 border-black pb-3">
        <h2 className="text-xl font-bold tracking-tight">Test Drive Agreement</h2>
        <p className="text-xs text-black/60 mt-1">Customer acknowledgment prior to operating a dealership vehicle</p>
      </header>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Buyer / Driver Name" value={m.buyer_name} />
        <Field label="Stock #" value={m.stock_number} />
        <Field label="VIN" value={m.vin} />
        <Field label="Odometer (mi)" value={m.mileage} />
        <Field label="Asking Price" value={m.price} />
        <Field label="Date" value={new Date().toLocaleDateString()} />
      </div>
      <section className="text-xs leading-relaxed space-y-2">
        <p>
          I acknowledge that I am a licensed driver, that I have read and understand the dealership’s
          test-drive policy, and that I accept full responsibility for the vehicle listed above while
          it is in my care. I agree to remain within the approved route, to obey all traffic laws, and
          to return the vehicle in the same condition.
        </p>
        <p>
          I authorize the dealership to hold a copy of my driver’s license for the duration of the test
          drive and understand that any damage, traffic citation, or loss occurring during the test drive
          may be my financial responsibility.
        </p>
      </section>
      <div className="grid grid-cols-2 gap-8">
        <SigLine label="Customer Signature" />
        <SigLine label="Sales Consultant Signature" />
      </div>
    </article>
  );
}

function GatePassDoc({ m }: { m: MasterFields }) {
  return (
    <article className="forms-doc space-y-5 text-black">
      <header className="text-center border-b-2 border-black pb-3">
        <h2 className="text-xl font-bold tracking-tight">Vehicle Gate Pass</h2>
        <p className="text-xs text-black/60 mt-1">Authorization to remove a vehicle from dealership property</p>
      </header>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Authorized Driver" value={m.buyer_name} />
        <Field label="Stock #" value={m.stock_number} />
        <Field label="VIN" value={m.vin} />
        <Field label="Odometer Out" value={m.mileage} />
        <Field label="Quoted Price" value={m.price} />
        <Field label="Pass Date" value={new Date().toLocaleDateString()} />
      </div>
      <section className="text-xs leading-relaxed space-y-2 border border-black/30 p-3">
        <p className="font-semibold uppercase text-[10px] tracking-wide">Security / Lot Attendant</p>
        <p>
          Permit the vehicle identified above to leave the lot with the authorized driver. This pass is
          valid for a single departure and must be surrendered upon exit. Verify photo ID against the
          name on this pass before opening the gate.
        </p>
      </section>
      <div className="grid grid-cols-2 gap-8">
        <SigLine label="Manager Authorization" />
        <SigLine label="Gate Attendant Initials / Time Out" />
      </div>
    </article>
  );
}

function DeliveryDoc({ m }: { m: MasterFields }) {
  const checks = [
    'Keys (primary + spare) delivered',
    'Owner’s manual / warranty booklet',
    'Floor mats / weather protection installed',
    'Fuel level reviewed with customer',
    'Trade-in appraisal / payoff confirmed (if applicable)',
    'Registration / temp tag paperwork completed',
    'Warranty & aftermarket products explained',
    'Follow-up appointment / CSI survey scheduled',
  ];
  return (
    <article className="forms-doc space-y-5 text-black">
      <header className="text-center border-b-2 border-black pb-3">
        <h2 className="text-xl font-bold tracking-tight">Delivery Checklist</h2>
        <p className="text-xs text-black/60 mt-1">Final walk-through before the customer takes delivery</p>
      </header>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Buyer Name" value={m.buyer_name} />
        <Field label="Stock #" value={m.stock_number} />
        <Field label="VIN" value={m.vin} />
        <Field label="Delivery Mileage" value={m.mileage} />
        <Field label="Sale Price" value={m.price} />
        <Field label="Delivery Date" value={new Date().toLocaleDateString()} />
      </div>
      <ul className="space-y-2">
        {checks.map((item) => (
          <li key={item} className="flex items-start gap-3 text-sm">
            <span className="mt-0.5 inline-block w-4 h-4 border border-black shrink-0" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {m.notes ? (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-black/50 font-semibold mb-1">Notes</div>
          <p className="text-sm whitespace-pre-wrap border border-black/20 p-2 min-h-[3rem]">{m.notes}</p>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-8">
        <SigLine label="Customer Acknowledgment" />
        <SigLine label="Delivery Specialist" />
      </div>
    </article>
  );
}

export default function FormsPage() {
  const { authFetch } = useAuth();
  const [master, setMaster] = useState<MasterFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/v1/forms/draft');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setMaster({
              buyer_name:   data.buyer_name   || '',
              vin:          data.vin          || '',
              stock_number: data.stock_number || '',
              price:        data.price        || '',
              mileage:      data.mileage      || '',
              active_form:  (data.active_form as FormKind) || 'test_drive',
              notes:        data.notes        || '',
            });
          }
        }
      } catch {
        /* draft load is best-effort */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch]);

  function patch<K extends keyof MasterFields>(key: K, value: MasterFields[K]) {
    setMaster((prev) => ({ ...prev, [key]: value }));
  }

  async function saveDraft() {
    setSaving(true);
    try {
      const res = await authFetch('/api/v1/forms/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(master),
      });
      if (res.ok) setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mr-2" />
        Loading forms…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Screen-only chrome */}
      <div className="forms-controls space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-amber-300/90">
              <ClipboardList className="h-4 w-4" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">
                Dealership Forms
              </span>
            </div>
            <h1 className="bg-gradient-to-b from-white to-slate-400 bg-clip-text font-display text-2xl font-bold tracking-tight text-transparent">
              Paperwork Desk
            </h1>
            <p className="mt-1.5 text-sm tracking-tight text-slate-400">
              Enter buyer and vehicle details once — they fill every document below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savedAt && (
              <span className="text-xs text-slate-500">Saved {savedAt}</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={saveDraft}
              disabled={saving}
              className="border-slate-700/60 bg-white/[0.03] text-slate-300 hover:bg-white/[0.08] hover:text-slate-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save draft
            </Button>
            <Button
              size="sm"
              onClick={() => window.print()}
              className="bg-gradient-to-b from-amber-300 to-amber-500 text-slate-950 hover:from-amber-200 hover:to-amber-400"
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </div>
        </div>

        {/* Master input bar */}
        <div className="glass-panel grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1">
            <span className="meta-label text-[10px]">Buyer Name</span>
            <Input
              value={master.buyer_name}
              onChange={(e) => patch('buyer_name', e.target.value)}
              placeholder="Jane Doe"
              className="glass-input"
            />
          </label>
          <label className="space-y-1">
            <span className="meta-label text-[10px]">VIN</span>
            <Input
              value={master.vin}
              onChange={(e) => patch('vin', e.target.value.toUpperCase().slice(0, 17))}
              placeholder="17-character VIN"
              className="glass-input font-mono text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="meta-label text-[10px]">Stock #</span>
            <Input
              value={master.stock_number}
              onChange={(e) => patch('stock_number', e.target.value)}
              placeholder="A12345"
              className="glass-input"
            />
          </label>
          <label className="space-y-1">
            <span className="meta-label text-[10px]">Price</span>
            <Input
              value={master.price}
              onChange={(e) => patch('price', e.target.value)}
              placeholder="$32,995"
              className="glass-input"
            />
          </label>
          <label className="space-y-1">
            <span className="meta-label text-[10px]">Mileage</span>
            <Input
              value={master.mileage}
              onChange={(e) => patch('mileage', e.target.value)}
              placeholder="12,450"
              className="glass-input"
            />
          </label>
        </div>

        {/* Form tabs */}
        <div className="flex flex-wrap gap-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => patch('active_form', id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium border transition-colors',
                master.active_form === id
                  ? 'border-amber-300/40 bg-gradient-to-b from-amber-300 to-amber-500 text-slate-950'
                  : 'border-slate-800/60 bg-slate-900/60 text-slate-300 hover:bg-white/[0.06] hover:text-slate-100',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {master.active_form === 'delivery' && (
          <label className="block space-y-1">
            <span className="meta-label text-[10px]">
              Delivery notes (printed on checklist)
            </span>
            <textarea
              value={master.notes}
              onChange={(e) => patch('notes', e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-300/40 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
              placeholder="Optional delivery notes…"
            />
          </label>
        )}
      </div>

      {/* Printable document surface — stays paper-white for print fidelity */}
      <div className="forms-print-surface rounded-xl border border-slate-700/50 bg-white p-6 shadow-[0_20px_50px_-28px_rgba(0,0,0,0.8)] md:p-10">
        {master.active_form === 'test_drive' && <TestDriveDoc m={master} />}
        {master.active_form === 'gate_pass'  && <GatePassDoc m={master} />}
        {master.active_form === 'delivery'   && <DeliveryDoc m={master} />}
      </div>
    </div>
  );
}
