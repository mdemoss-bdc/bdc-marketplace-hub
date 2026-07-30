import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Heart, Plus, X, Phone, MapPin, Car, DollarSign,
  Gauge, Loader2, MessageSquare, Trash2, ExternalLink,
  Search, Sparkles, CheckCircle2, Clock,
  RefreshCw, Eye, Pencil,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────
interface MatchedVehicle {
  id: number;
  vin: string;
  stock_number: string;
  condition: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  price: number;
  exterior_color: string;
  image_url: string;
  vdp_url: string;
}

interface VehicleChoiceData {
  condition: string;
  make: string;
  model: string;
  keyword: string;
  year_min: string;
  year_max: string;
  max_mileage: string;
  max_budget: string;
}

interface WishlistEntry {
  id: number;
  customer_name: string;
  phone: string;
  city: string;
  state: string;
  notes: string;
  status: string;
  created_at: string;
  matches: MatchedVehicle[];
  // Choice 1
  condition: string;
  make: string;
  model: string;
  keyword: string;
  year_min: number;
  year_max: number;
  max_mileage: number;
  max_budget: number;
  // Choice 2
  condition2: string;
  make2: string;
  model2: string;
  keyword2: string;
  year_min2: number;
  year_max2: number;
  max_mileage2: number;
  max_budget2: number;
  // Choice 3
  condition3: string;
  make3: string;
  model3: string;
  keyword3: string;
  year_min3: number;
  year_max3: number;
  max_mileage3: number;
  max_budget3: number;
}

interface FormState {
  customer_name: string;
  phone: string;
  city: string;
  state: string;
  notes: string;
  choices: VehicleChoiceData[];
}

// ── Phone helpers ──────────────────────────────────────────────────────────────
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function displayPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function rawPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits;
}

// ── General helpers ───────────────────────────────────────────────────────────
function fmt(n: number) {
  return n > 0 ? `$${n.toLocaleString()}` : '—';
}
function fmtMiles(n: number) {
  return n > 0 ? `${n.toLocaleString()} mi` : '—';
}
function relTime(iso: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function buildChoiceLabel(
  cond: string, make: string, model: string, ym: number, yx: number,
): string {
  const parts: string[] = [];
  if (cond && cond !== 'Any') parts.push(cond);
  if (make) parts.push(make);
  if (model) parts.push(model);
  if (ym > 0 || yx > 0) {
    if (ym > 0 && yx > 0) parts.push(`${ym}–${yx}`);
    else if (ym > 0)       parts.push(`${ym}+`);
    else                   parts.push(`≤${yx}`);
  }
  return parts.join(' ') || 'Any vehicle';
}

interface ChoiceSummary { label: string; cond: string; }

function getActiveChoices(e: WishlistEntry): ChoiceSummary[] {
  const list: ChoiceSummary[] = [
    { label: buildChoiceLabel(e.condition, e.make, e.model, e.year_min, e.year_max), cond: e.condition },
  ];
  if (e.make2 || e.model2 || (e.year_min2 ?? 0) > 0 || (e.year_max2 ?? 0) > 0) {
    list.push({ label: buildChoiceLabel(e.condition2, e.make2, e.model2, e.year_min2, e.year_max2), cond: e.condition2 });
  }
  if (e.make3 || e.model3 || (e.year_min3 ?? 0) > 0 || (e.year_max3 ?? 0) > 0) {
    list.push({ label: buildChoiceLabel(e.condition3, e.make3, e.model3, e.year_min3, e.year_max3), cond: e.condition3 });
  }
  return list;
}

function buildSearchLabel(e: WishlistEntry): string {
  return getActiveChoices(e).map(c => c.label).join(' / ');
}

/** Convert a saved WishlistEntry back into form state for editing. */
function entryToForm(e: WishlistEntry): FormState {
  const mkC = (
    cond: string, make: string, model: string, kw: string,
    ym: number, yx: number, mm: number, mb: number,
  ): VehicleChoiceData => ({
    condition:   cond || 'Any',
    make:        make || '',
    model:       model || '',
    keyword:     kw || '',
    year_min:    ym > 0 ? String(ym) : '',
    year_max:    yx > 0 ? String(yx) : '',
    max_mileage: mm > 0 ? String(mm) : '',
    max_budget:  mb > 0 ? String(mb) : '',
  });

  const choices: VehicleChoiceData[] = [
    mkC(e.condition, e.make, e.model, e.keyword, e.year_min, e.year_max, e.max_mileage, e.max_budget),
  ];
  if (e.make2 || e.model2 || (e.year_min2 ?? 0) > 0 || (e.year_max2 ?? 0) > 0) {
    choices.push(mkC(e.condition2, e.make2, e.model2, e.keyword2 || '', e.year_min2, e.year_max2, e.max_mileage2, e.max_budget2));
  }
  if (e.make3 || e.model3 || (e.year_min3 ?? 0) > 0 || (e.year_max3 ?? 0) > 0) {
    choices.push(mkC(e.condition3, e.make3, e.model3, e.keyword3 || '', e.year_min3, e.year_max3, e.max_mileage3, e.max_budget3));
  }

  return {
    customer_name: e.customer_name || '',
    phone:         displayPhone(e.phone),
    city:          e.city || '',
    state:         e.state || '',
    notes:         e.notes || '',
    choices,
  };
}

/** Serialize form state into the flat API payload. */
function buildPayload(form: FormState, id?: number): Record<string, unknown> {
  const p: Record<string, unknown> = {
    customer_name: form.customer_name.trim(),
    phone:         form.phone.replace(/\D/g, ''),
    city:          form.city.trim(),
    state:         form.state,
    notes:         form.notes.trim(),
  };
  if (id !== undefined) p.id = id;

  const sfxs = ['', '2', '3'] as const;
  sfxs.forEach((sfx, si) => {
    const c = form.choices[si];
    if (!c) return;
    p[`condition${sfx}`]   = c.condition;
    p[`make${sfx}`]        = c.make;
    p[`model${sfx}`]       = c.model;
    p[`keyword${sfx}`]     = c.keyword;
    p[`year_min${sfx}`]    = c.year_min    ? parseInt(c.year_min)                   : 0;
    p[`year_max${sfx}`]    = c.year_max    ? parseInt(c.year_max)                   : 0;
    p[`max_mileage${sfx}`] = c.max_mileage ? parseInt(c.max_mileage)                : 0;
    p[`max_budget${sfx}`]  = c.max_budget  ? parseInt(c.max_budget.replace(/\D/g, '')) : 0;
  });
  return p;
}

// ── Vehicle data ───────────────────────────────────────────────────────────────
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY',
];

const MAKES = [
  'Acura','Audi','BMW','Buick','Cadillac','Chevrolet','Chrysler',
  'Dodge','Ford','GMC','Honda','Hyundai','Infiniti','Jeep','Kia',
  'Land Rover','Lexus','Lincoln','Mazda','Mercedes-Benz','Mitsubishi',
  'Nissan','RAM','Subaru','Tesla','Toyota','Volkswagen','Volvo',
];

const MODELS_BY_MAKE: Record<string, string[]> = {
  'Acura':         ['ILX','MDX','RDX','TLX','NSX'],
  'Audi':          ['A3','A4','A5','A6','A7','A8','Q3','Q5','Q7','Q8','e-tron','e-tron GT'],
  'BMW':           ['2 Series','3 Series','4 Series','5 Series','7 Series','8 Series','X1','X3','X5','X6','X7','i4','i5','iX'],
  'Buick':         ['Enclave','Encore','Encore GX','Envision','LaCrosse'],
  'Cadillac':      ['CT4','CT5','Escalade','Escalade ESV','LYRIQ','OPTIQ','XT4','XT5','XT6'],
  'Chevrolet':     ['Blazer','Colorado','Corvette','Equinox','Malibu','Silverado 1500','Silverado 2500HD','Silverado 3500HD','Suburban','Tahoe','Traverse','Trailblazer','Trax'],
  'Chrysler':      ['300','Pacifica','Pacifica Hybrid','Voyager'],
  'Dodge':         ['Challenger','Charger','Durango','Hornet','Ram'],
  'Ford':          ['Bronco','Bronco Sport','Edge','Escape','Explorer','F-150','F-150 Lightning','F-250','F-350','Maverick','Mustang','Mustang Mach-E','Ranger','Transit','Transit Connect'],
  'GMC':           ['Acadia','Canyon','Envoy','Hummer EV','Sierra 1500','Sierra 2500HD','Sierra 3500HD','Terrain','Yukon','Yukon XL'],
  'Honda':         ['Accord','Civic','CR-V','CR-V Hybrid','HR-V','Odyssey','Passport','Pilot','Prologue','Ridgeline'],
  'Hyundai':       ['Elantra','IONIQ 5','IONIQ 6','IONIQ 9','Kona','Palisade','Santa Cruz','Santa Fe','Sonata','Tucson','Venue'],
  'Infiniti':      ['Q50','Q60','QX50','QX55','QX60','QX80'],
  'Jeep':          ['Cherokee','Compass','Gladiator','Grand Cherokee','Grand Cherokee L','Grand Wagoneer','Renegade','Wagoneer','Wrangler'],
  'Kia':           ['Carnival','EV6','EV9','Forte','K5','Niro','Seltos','Sorento','Soul','Sportage','Stinger','Telluride'],
  'Land Rover':    ['Defender','Discovery','Discovery Sport','Range Rover','Range Rover Evoque','Range Rover Sport','Range Rover Velar'],
  'Lexus':         ['ES','GS','GX','IS','LS','LX','NX','RC','RX','TX','UX'],
  'Lincoln':       ['Aviator','Corsair','Navigator','Nautilus'],
  'Mazda':         ['CX-30','CX-5','CX-50','CX-70','CX-90','Mazda3','Mazda6'],
  'Mercedes-Benz': ['C-Class','E-Class','GLA','GLB','GLC','GLE','GLS','S-Class','Sprinter'],
  'Mitsubishi':    ['Eclipse Cross','Outlander','Outlander Sport'],
  'Nissan':        ['Altima','Ariya','Armada','Frontier','Kicks','Leaf','Maxima','Murano','Pathfinder','Rogue','Sentra','Titan'],
  'RAM':           ['1500','1500 Classic','2500','3500','ProMaster','ProMaster City'],
  'Subaru':        ['Ascent','BRZ','Crosstrek','Forester','Impreza','Legacy','Outback','Solterra','WRX'],
  'Tesla':         ['Model 3','Model S','Model X','Model Y','Cybertruck'],
  'Toyota':        ['4Runner','bZ4X','Camry','Corolla','Corolla Cross','GR86','Highlander','Land Cruiser','Prius','Prius Prime','RAV4','RAV4 Prime','Sequoia','Sienna','Tacoma','Tundra','Venza'],
  'Volkswagen':    ['Atlas','Atlas Cross Sport','Golf','ID.4','Jetta','Passat','Taos','Tiguan'],
  'Volvo':         ['S60','S90','V60','V90','XC40','XC60','XC90'],
};

const YEARS: number[] = Array.from({ length: 2027 - 2000 + 1 }, (_, i) => 2027 - i);

const SELECT_CLS =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-ring text-foreground ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const BLANK_CHOICE: VehicleChoiceData = {
  condition: 'Any', make: '', model: '', keyword: '',
  year_min: '', year_max: '', max_mileage: '', max_budget: '',
};

const BLANK_FORM: FormState = {
  customer_name: '', phone: '', city: '', state: '', notes: '',
  choices: [{ ...BLANK_CHOICE }],
};

// ── VehicleChoiceBlock ─────────────────────────────────────────────────────────
function VehicleChoiceBlock({
  idx, choice, onChange, onRemove,
}: {
  idx: number;
  choice: VehicleChoiceData;
  onChange: (c: VehicleChoiceData) => void;
  onRemove?: () => void;
}) {
  const set = (k: keyof VehicleChoiceData, v: string) =>
    onChange({ ...choice, [k]: v });
  const handleMakeChange = (v: string) =>
    onChange({ ...choice, make: v, model: '' });
  const modelOptions = choice.make ? (MODELS_BY_MAKE[choice.make] ?? []) : [];

  const label = idx === 0
    ? 'Vehicle Criteria'
    : `Vehicle Choice ${idx + 1} (Optional)`;

  return (
    <div className="rounded-xl border border-border bg-muted/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        {onRemove && (
          <button
            onClick={onRemove}
            className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Condition */}
      <div className="flex gap-2">
        {(['Any', 'New', 'Used'] as const).map(c => (
          <button
            key={c}
            onClick={() => set('condition', c)}
            className={`flex-1 h-9 rounded-md text-sm font-medium border transition-colors ${
              choice.condition === c
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Make + Model */}
      <div className="grid grid-cols-2 gap-2">
        <select
          value={choice.make}
          onChange={e => handleMakeChange(e.target.value)}
          className={SELECT_CLS}
        >
          <option value="">Any / All Makes</option>
          {MAKES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          value={choice.model}
          onChange={e => set('model', e.target.value)}
          disabled={!choice.make}
          className={SELECT_CLS}
        >
          <option value="">
            {choice.make ? 'Any / All Models' : 'Select Make first'}
          </option>
          {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Keyword */}
      <Input
        placeholder="Keyword (e.g. crew cab, sunroof, 4WD)"
        value={choice.keyword}
        onChange={e => set('keyword', e.target.value)}
        className="h-10"
      />

      {/* Year range */}
      <div className="grid grid-cols-2 gap-2">
        <select
          value={choice.year_min}
          onChange={e => set('year_min', e.target.value)}
          className={SELECT_CLS}
        >
          <option value="">Any Min Year</option>
          {YEARS.map(y => (
            <option
              key={y}
              value={y}
              disabled={!!choice.year_max && y > parseInt(choice.year_max)}
            >
              {y}
            </option>
          ))}
        </select>
        <select
          value={choice.year_max}
          onChange={e => set('year_max', e.target.value)}
          className={SELECT_CLS}
        >
          <option value="">Any Max Year</option>
          {YEARS.map(y => (
            <option
              key={y}
              value={y}
              disabled={!!choice.year_min && y < parseInt(choice.year_min)}
            >
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* Mileage + Budget */}
      <div className="grid grid-cols-2 gap-2">
        <div className="relative">
          <Gauge className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Max Mileage"
            type="number"
            value={choice.max_mileage}
            onChange={e => set('max_mileage', e.target.value)}
            className="h-10 pl-8"
            min="0"
          />
        </div>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
          <Input
            placeholder="Max Budget"
            value={choice.max_budget}
            onChange={e => set('max_budget', e.target.value.replace(/[^\d,]/g, ''))}
            className="h-10 pl-6"
          />
        </div>
      </div>
    </div>
  );
}

// ── Shared Add / Edit Modal ────────────────────────────────────────────────────
function EntryFormModal({
  mode, entry, token, onClose, onSaved, onTrialLimit,
}: {
  mode: 'add' | 'edit';
  entry?: WishlistEntry;
  token: string;
  onClose: () => void;
  onSaved: (updated?: WishlistEntry) => void;
  onTrialLimit?: (message: string) => void;
}) {
  const [form, setForm] = useState<FormState>(
    mode === 'edit' && entry ? entryToForm(entry) : { ...BLANK_FORM, choices: [{ ...BLANK_CHOICE }] },
  );
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState('');

  const updateChoice = (idx: number, c: VehicleChoiceData) =>
    setForm(f => {
      const next = [...f.choices];
      next[idx] = c;
      return { ...f, choices: next };
    });

  const addChoice = () => {
    if (form.choices.length >= 3) return;
    setForm(f => ({ ...f, choices: [...f.choices, { ...BLANK_CHOICE }] }));
  };

  const removeChoice = (idx: number) => {
    if (form.choices.length <= 1) return;
    setForm(f => ({ ...f, choices: f.choices.filter((_, i) => i !== idx) }));
  };

  async function handleSave() {
    if (!form.customer_name.trim()) { setError('Customer name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const url    = mode === 'edit' ? '/api/v1/wishlist/update' : '/api/v1/wishlist';
      const payload = buildPayload(form, mode === 'edit' ? entry?.id : undefined);
      const res  = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        // Trial limit / expired — surface as upgrade prompt, not a form error
        if ((data.error === 'trial_limit' || data.error === 'trial_expired') && onTrialLimit) {
          onTrialLimit(data.message as string);
          return;
        }
        throw new Error(data.error || 'Server error');
      }
      if (data.error) throw new Error(data.error);
      onSaved(data.entry);
    } catch (e: unknown) {
      setError((e as Error).message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const isEdit = mode === 'edit';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92dvh] overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
              {isEdit
                ? <Pencil className="w-3.5 h-3.5 text-primary" />
                : <Heart className="w-3.5 h-3.5 text-primary" />}
            </div>
            <h2 className="text-base font-bold tracking-tight">
              {isEdit ? 'Edit Customer' : 'Add to Wishlist'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          {/* ── Customer Info ────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Customer Info
            </p>
            <div className="space-y-2">
              <Input
                placeholder="Customer Name *"
                value={form.customer_name}
                onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                className="h-10"
              />
              <div className="relative">
                <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="(555) 867-5309"
                  type="tel"
                  inputMode="numeric"
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: formatPhone(e.target.value) }))}
                  className="h-10 pl-8"
                  maxLength={14}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="City"
                  value={form.city}
                  onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
                  className="h-10"
                />
                <select
                  value={form.state}
                  onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                  className={SELECT_CLS}
                >
                  <option value="">State</option>
                  {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* ── Vehicle Choices ──────────────────────────────────────── */}
          {form.choices.map((choice, idx) => (
            <VehicleChoiceBlock
              key={idx}
              idx={idx}
              choice={choice}
              onChange={c => updateChoice(idx, c)}
              onRemove={form.choices.length > 1 ? () => removeChoice(idx) : undefined}
            />
          ))}

          {form.choices.length < 3 && (
            <button
              onClick={addChoice}
              className="w-full h-10 rounded-xl border-2 border-dashed border-border text-xs font-semibold text-muted-foreground hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Another Vehicle Choice
            </button>
          )}

          {/* ── Notes ────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Notes / Preferences
            </p>
            <Textarea
              placeholder="Any additional preferences, trade-in info, urgency, etc."
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="min-h-[80px] text-sm resize-none"
            />
          </div>

          {/* ── Actions ──────────────────────────────────────────────── */}
          <div className="flex gap-2 pt-1">
            <Button variant="outline" onClick={onClose} className="flex-1 h-11">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} className="flex-1 h-11 gap-2">
              {saving
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : isEdit
                  ? <Pencil className="w-4 h-4" />
                  : <Heart className="w-4 h-4" />}
              {isEdit ? 'Save Changes' : 'Save to Wishlist'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Match View Modal ───────────────────────────────────────────────────────────
function MatchModal({
  entry, onClose, onEdit,
}: {
  entry: WishlistEntry;
  onClose: () => void;
  onEdit: (e: WishlistEntry) => void;
}) {
  const phone   = entry.phone;
  const choices = getActiveChoices(entry);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative w-full sm:max-w-xl bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92dvh] overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between z-10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                <CheckCircle2 className="w-3 h-3" />
                {entry.matches.length} Match{entry.matches.length !== 1 ? 'es' : ''} Found
              </span>
            </div>
            <p className="text-base font-bold tracking-tight mt-1">{entry.customer_name}</p>
            <p className="text-xs text-muted-foreground">
              {choices.map(c => c.label).join(' / ')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
            <button
              onClick={() => { onEdit(entry); onClose(); }}
              className="h-8 px-3 rounded-md flex items-center gap-1.5 text-xs font-semibold border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Contact strip */}
        {(phone || entry.city || entry.state) && (
          <div className="px-5 py-3 border-b border-border bg-muted/30 flex flex-wrap items-center gap-4">
            {phone && (
              <a
                href={`sms:${rawPhone(phone)}`}
                className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline underline-offset-2"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Text {displayPhone(phone)}
              </a>
            )}
            {(entry.city || entry.state) && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="w-3 h-3" />
                {[entry.city, entry.state].filter(Boolean).join(', ')}
              </span>
            )}
            {entry.max_budget > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DollarSign className="w-3 h-3" />
                Budget up to {fmt(entry.max_budget)}
              </span>
            )}
          </div>
        )}

        {/* Matching vehicles */}
        <div className="p-5 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Matching Inventory
          </p>
          {entry.matches.map(v => (
            <div
              key={v.vin || v.id}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              <div className="flex items-center gap-3 p-3">
                <div className="w-16 h-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {v.image_url
                    ? <img src={v.image_url} alt="" className="w-full h-full object-cover" />
                    : <Car className="w-6 h-6 text-muted-foreground/30" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm leading-tight">
                    {v.year} {v.make} {v.model}{v.trim ? ` ${v.trim}` : ''}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <Badge className={v.condition?.toLowerCase() === 'new'
                      ? 'bg-blue-600 text-white border-0 text-[10px] px-1.5 py-0'
                      : 'bg-amber-500 text-white border-0 text-[10px] px-1.5 py-0'}>
                      {v.condition || 'Used'}
                    </Badge>
                    {v.mileage > 0 && (
                      <span className="text-xs text-muted-foreground">{fmtMiles(v.mileage)}</span>
                    )}
                    {v.exterior_color && (
                      <span className="text-xs text-muted-foreground">{v.exterior_color}</span>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-bold text-primary text-sm">{fmt(v.price)}</div>
                  {v.stock_number && (
                    <div className="text-[10px] text-muted-foreground font-mono">#{v.stock_number}</div>
                  )}
                </div>
              </div>
              <div className="border-t border-border px-3 py-2 flex items-center gap-2 bg-muted/20">
                {phone && (
                  <a
                    href={`sms:${rawPhone(phone)}?body=${encodeURIComponent(
                      `Hi ${entry.customer_name.split(' ')[0]}! We have a ${v.year} ${v.make} ${v.model} that matches what you're looking for. ${v.vdp_url || ''}`
                    )}`}
                    className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Text Customer
                  </a>
                )}
                {v.vdp_url && (
                  <a
                    href={v.vdp_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    View Details
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {entry.notes && (
          <div className="px-5 pb-5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Customer Notes
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed bg-muted/40 rounded-lg px-3 py-2.5 border border-border">
              {entry.notes}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Circled number helper ─────────────────────────────────────────────────────
const CIRCLE = ['①', '②', '③'];

// ── Main Wishlist Page ─────────────────────────────────────────────────────────
import { TrialBanner } from '@/components/TrialBanner';

export default function Wishlist() {
  const { token } = useAuth();
  const [entries,    setEntries]    = useState<WishlistEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd,      setShowAdd]      = useState(false);
  const [upgradeModal, setUpgradeModal] = useState<string | null>(null);
  const [matchEntry,   setMatchEntry]   = useState<WishlistEntry | null>(null);
  const [editEntry,    setEditEntry]    = useState<WishlistEntry | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [search,     setSearch]     = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const r = await fetch('/api/v1/wishlist', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json();
        setEntries(data.entries || []);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    fetchEntries();
    pollRef.current = setInterval(() => fetchEntries(true), 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchEntries]);

  async function handleDelete(id: number) {
    if (!confirm('Remove this customer from the wishlist?')) return;
    setDeletingId(id);
    try {
      await fetch('/api/v1/wishlist/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      setEntries(prev => prev.filter(e => e.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  function handleSaved(updated?: WishlistEntry) {
    if (updated) {
      // Update the entry in-place (edit mode), then refresh for accurate sort
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
    }
    setShowAdd(false);
    setEditEntry(null);
    fetchEntries(true);
  }

  function handleEditFromMatch(e: WishlistEntry) {
    setMatchEntry(null);
    setEditEntry(e);
  }

  const filtered = entries.filter(e => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.customer_name.toLowerCase().includes(q) ||
      e.make.toLowerCase().includes(q) ||
      e.model.toLowerCase().includes(q) ||
      (e.make2 || '').toLowerCase().includes(q) ||
      (e.model2 || '').toLowerCase().includes(q) ||
      e.keyword.toLowerCase().includes(q) ||
      e.phone.replace(/\D/g,'').includes(q.replace(/\D/g,'')) ||
      displayPhone(e.phone).includes(q) ||
      e.city.toLowerCase().includes(q)
    );
  });

  const matchedCount   = entries.filter(e => e.matches.length > 0).length;
  const unmatchedCount = entries.length - matchedCount;

  return (
    <div className="space-y-6 pb-12">
      <TrialBanner />

      {/* ── Modals ──────────────────────────────────────────────────── */}
      {showAdd && (
        <EntryFormModal
          mode="add"
          token={token || ''}
          onClose={() => setShowAdd(false)}
          onSaved={handleSaved}
          onTrialLimit={(msg) => { setShowAdd(false); setUpgradeModal(msg); }}
        />
      )}
      {editEntry && (
        <EntryFormModal
          mode="edit"
          entry={editEntry}
          token={token || ''}
          onClose={() => setEditEntry(null)}
          onSaved={handleSaved}
        />
      )}
      {upgradeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setUpgradeModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-bold tracking-tight">Trial Limit Reached!</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{upgradeModal}</p>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="/pricing"
                className="w-full inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors"
                onClick={() => setUpgradeModal(null)}
              >
                Upgrade to Pro — $75/mo
              </a>
              <button
                onClick={() => setUpgradeModal(null)}
                className="w-full rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}
      {matchEntry && (
        <MatchModal
          entry={matchEntry}
          onClose={() => setMatchEntry(null)}
          onEdit={handleEditFromMatch}
        />
      )}

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Heart className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-display font-bold tracking-tight">Inventory Wishlist</h1>
              {matchedCount > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/25 animate-pulse">
                  {matchedCount} Match{matchedCount !== 1 ? 'es' : ''}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              Track what customers want — up to 3 vehicle choices each — and auto-match to active inventory.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchEntries(true)}
            disabled={refreshing}
            className="gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={() => setShowAdd(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Add Customer
          </Button>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Watching</p>
          <p className="text-2xl font-bold mt-1">{entries.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">customers</p>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Matched</p>
          <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400 mt-1">{matchedCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">ready to contact</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Searching</p>
          <p className="text-2xl font-bold mt-1">{unmatchedCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">no match yet</p>
        </div>
      </div>

      {/* ── Match alert ─────────────────────────────────────────────── */}
      {matchedCount > 0 && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/8 px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
            <strong>{matchedCount}</strong> customer{matchedCount !== 1 ? 's' : ''} ha{matchedCount !== 1 ? 've' : 's'} matching vehicles — click{' '}
            <span className="font-bold">View Match</span> to review and send a text.
          </p>
        </div>
      )}

      {/* ── Search ─────────────────────────────────────────────────── */}
      {entries.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, make, model, or phone…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-border bg-card flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <Heart className="w-8 h-8 text-muted-foreground/30" />
          </div>
          <div>
            <p className="font-semibold text-muted-foreground">No wishlist entries yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Add a customer's vehicle preferences and we'll automatically match them<br className="hidden sm:block" /> to vehicles as they enter your inventory.
            </p>
          </div>
          <Button onClick={() => setShowAdd(true)} className="gap-2 mt-2">
            <Plus className="w-4 h-4" />
            Add First Customer
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Search className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No results for "{search}"</p>
          <button onClick={() => setSearch('')} className="text-xs text-primary hover:underline underline-offset-2">
            Clear search
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Customer</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Looking For</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap">Budget / Miles</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Match</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(entry => {
                  const hasMatch    = entry.matches.length > 0;
                  const choices     = getActiveChoices(entry);
                  const multiChoice = choices.length > 1;

                  return (
                    <tr
                      key={entry.id}
                      className={`transition-colors hover:bg-muted/20 cursor-pointer ${
                        hasMatch ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''
                      }`}
                      onClick={() => hasMatch && setMatchEntry(entry)}
                    >
                      {/* Customer */}
                      <td className="px-4 py-3">
                        <div className="font-semibold text-sm">{entry.customer_name}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {entry.phone && (
                            <a
                              href={`tel:${rawPhone(entry.phone)}`}
                              onClick={e => e.stopPropagation()}
                              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                            >
                              <Phone className="w-2.5 h-2.5" />
                              {displayPhone(entry.phone)}
                            </a>
                          )}
                          {(entry.city || entry.state) && (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <MapPin className="w-2.5 h-2.5" />
                              {[entry.city, entry.state].filter(Boolean).join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground/60 mt-0.5">{relTime(entry.created_at)}</div>
                      </td>

                      {/* Looking For */}
                      <td className="px-4 py-3">
                        {multiChoice ? (
                          <div className="space-y-1">
                            {choices.map((c, i) => (
                              <div key={i} className="flex items-center gap-1.5">
                                <span className="text-[10px] text-muted-foreground/60 font-mono w-4 flex-shrink-0">
                                  {CIRCLE[i]}
                                </span>
                                {c.cond !== 'Any' && (
                                  <Badge className={c.cond === 'New'
                                    ? 'bg-blue-600 text-white border-0 text-[10px] px-1.5 py-0'
                                    : 'bg-amber-500 text-white border-0 text-[10px] px-1.5 py-0'}>
                                    {c.cond}
                                  </Badge>
                                )}
                                <span className="text-xs font-medium text-foreground leading-tight">{c.label}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {entry.condition !== 'Any' && (
                              <Badge className={entry.condition === 'New'
                                ? 'bg-blue-600 text-white border-0 text-[10px] px-1.5 py-0'
                                : 'bg-amber-500 text-white border-0 text-[10px] px-1.5 py-0'}>
                                {entry.condition}
                              </Badge>
                            )}
                            <span className="text-sm font-medium text-foreground">
                              {choices[0]?.label || '—'}
                            </span>
                          </div>
                        )}
                        {!multiChoice && entry.keyword && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            keyword: <em>{entry.keyword}</em>
                          </div>
                        )}
                        {entry.notes && (
                          <div className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-1 italic">
                            {entry.notes}
                          </div>
                        )}
                      </td>

                      {/* Budget / Miles — show choice 1 values */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-sm font-medium">
                          {entry.max_budget > 0
                            ? <><DollarSign className="w-3 h-3 text-muted-foreground" />{fmt(entry.max_budget)}</>
                            : <span className="text-muted-foreground text-xs">Any budget</span>
                          }
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                          {entry.max_mileage > 0
                            ? <><Gauge className="w-2.5 h-2.5" />≤ {fmtMiles(entry.max_mileage)}</>
                            : 'Any mileage'
                          }
                        </div>
                      </td>

                      {/* Match */}
                      <td className="px-4 py-3">
                        {hasMatch ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                            <CheckCircle2 className="w-3 h-3" />
                            {entry.matches.length} MATCH{entry.matches.length !== 1 ? 'ES' : ''} FOUND
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-muted border border-border text-muted-foreground whitespace-nowrap">
                            <Clock className="w-3 h-3" />
                            Searching…
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                          {hasMatch && (
                            <Button
                              size="sm"
                              onClick={() => setMatchEntry(entry)}
                              className="h-7 px-2.5 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white border-0 whitespace-nowrap"
                            >
                              <Eye className="w-3 h-3" />
                              View Match
                            </Button>
                          )}
                          {entry.phone && (
                            <a
                              href={`sms:${rawPhone(entry.phone)}`}
                              className="h-7 px-2.5 rounded-md flex items-center gap-1 text-xs font-medium border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors whitespace-nowrap"
                            >
                              <MessageSquare className="w-3 h-3" />
                              Text
                            </a>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditEntry(entry)}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Edit customer"
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(entry.id)}
                            disabled={deletingId === entry.id}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          >
                            {deletingId === entry.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Trash2 className="w-3 h-3" />
                            }
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table footer */}
          <div className="border-t border-border px-4 py-2.5 bg-muted/20 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {filtered.length} of {entries.length} customer{entries.length !== 1 ? 's' : ''}
              {search ? ` matching "${search}"` : ''}
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="w-3 h-3" />
              Auto-matches on every inventory sync
            </div>
          </div>
        </div>
      )}

      {/* ── How it works ────────────────────────────────────────────── */}
      {entries.length < 3 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            How Wishlist Matching Works
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { icon: Plus, title: 'Add a customer', body: "Enter a customer's name, phone, and up to 3 vehicle choices — make, model, year range, budget, and condition." },
              { icon: Search, title: 'Auto-matching runs', body: 'Every inventory sync checks all vehicle choices for every customer. A match on any choice pins them to the top.' },
              { icon: MessageSquare, title: 'Contact them instantly', body: 'When a match is found, click "View Match" to see the vehicle and send a pre-filled text in one tap.' },
            ].map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
