/* ============================================================================
   ChargeFlow — premium analytics dashboard
   Zero-build vanilla app. Tailwind (Play CDN) + Chart.js (CDN) are loaded in
   index.html. The data layer talks directly to Supabase PostgREST.
   ========================================================================== */

const LOCAL_KEY = 'chargeflow_entries_v1';
const SUPABASE_URL = 'https://sxhdzdrgvgoxazcoguyx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NThhpaesI2pnF8uXWpmNaA_qoQwmsp2';

/* business constants */
const PAGE_SIZE = 8;
const PRICE = 120;          // AMD per kWh sold
const POWER_COST = 50;      // AMD per kWh paid to the grid
const SERVICE_RATE = 0.15;  // platform / partner fee on gross
const TAX_RATE = 0.10;      // income tax, applied after the service fee
const LOAN_TARGET = 230000; // AMD — monthly break-even (loan payment)
const TREND_DAYS = 30;

let entries = [], loading = true, dbError = '';
let mode = 'kwh', period = 'all', exactDate = '', page = 1;
let trendChart = null, distChart = null;

const app = document.querySelector('#app');

/* ===========================================================================
   Theme
   ========================================================================= */

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
/** Resolve a design token to a canvas-ready colour (Chart.js can't read vars). */
const themeColor = (name, alpha = 1) => `rgb(${cssVar(name)} / ${alpha})`;
const isDark = () => document.documentElement.dataset.theme === 'dark';

function toggleTheme() {
  const root = document.documentElement;
  const next = isDark() ? 'light' : 'dark';
  root.classList.add('theme-transition');
  root.dataset.theme = next;
  root.classList.toggle('dark', next === 'dark');
  try { localStorage.setItem('chargeflow_theme', next); } catch {}
  setTimeout(() => root.classList.remove('theme-transition'), 320);
  render(); // charts paint to canvas, so they must be rebuilt on the new palette
}

/* Follow the OS only while the user has not chosen explicitly. */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  let saved = null;
  try { saved = localStorage.getItem('chargeflow_theme'); } catch {}
  if (saved) return;
  const root = document.documentElement;
  root.dataset.theme = e.matches ? 'dark' : 'light';
  root.classList.toggle('dark', e.matches);
  render();
});

/* ===========================================================================
   Data layer
   ========================================================================= */

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    let error = {};
    try { error = body ? JSON.parse(body) : {}; } catch {}
    throw new Error(error.message || error.hint || error.details || `Supabase սխալ՝ ${response.status}`);
  }
  return body ? JSON.parse(body) : null;
}

function fromRow(row) {
  return { id: row.id, date: row.charge_date, kwh: Number(row.kwh), type: row.connector_type, createdAt: row.created_at };
}

async function fetchAll() {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await supabase(`charging_sessions?select=id,charge_date,kwh,connector_type,created_at&order=charge_date.desc,created_at.desc&offset=${offset}&limit=1000`);
    all.push(...batch);
    if (batch.length < 1000) break;
  }
  return all.map(fromRow);
}

async function migrateLocalData() {
  const local = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
  if (!Array.isArray(local)) return;
  const real = local.filter(e =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.id) &&
    e.date && Number(e.kwh) > 0 && ['GB/T', 'CCS1'].includes(e.type));
  if (!real.length) { localStorage.removeItem(LOCAL_KEY); return; }
  await supabase('charging_sessions?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(real.map(e => ({ id: e.id, charge_date: e.date, kwh: Number(e.kwh), connector_type: e.type }))),
  });
  localStorage.removeItem(LOCAL_KEY);
}

async function loadEntries() {
  loading = true; dbError = ''; render();
  try {
    await migrateLocalData();
    entries = await fetchAll();
  } catch (error) {
    dbError = error.message || 'Չհաջողվեց միանալ Supabase-ին';
  } finally {
    loading = false; render();
  }
}

async function addSession(data) {
  const rows = await supabase('charging_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ charge_date: data.date, kwh: data.kwh, connector_type: data.type }),
  });
  const item = fromRow(rows[0]);
  entries.unshift(item);
  return item;
}

async function removeSession(id) {
  await supabase(`charging_sessions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  entries = entries.filter(e => e.id !== id);
}

/* ===========================================================================
   Formatting & date helpers
   ========================================================================= */

const fmt = (n, d = 1) => Number(n).toLocaleString('hy-AM', { maximumFractionDigits: d });
const money = n => `${Math.round(n).toLocaleString('hy-AM')} ֏`;
const compact = n => Math.abs(n) >= 1000 ? `${(n / 1000).toLocaleString('hy-AM', { maximumFractionDigits: 1 })}հզր ֏` : `${Math.round(n)} ֏`;
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dateLabel = (s, long = false) =>
  new Intl.DateTimeFormat('hy-AM', long ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })
    .format(new Date(s + 'T00:00:00'));
const timeLabel = ts => ts ? new Intl.DateTimeFormat('hy-AM', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : '—';

function rangeFor(p) {
  const now = new Date(), end = iso(now);
  if (p === 'today') return [end, end];
  if (p === 'week') { const start = new Date(now); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); return [iso(start), end]; }
  if (p === 'month') return [`${end.slice(0, 7)}-01`, end];
  return [null, null];
}

function filtered() {
  if (period === 'date' && exactDate) return entries.filter(e => e.date === exactDate);
  const [start, end] = rangeFor(period);
  return start ? entries.filter(e => e.date >= start && e.date <= end) : entries;
}

function periodText() {
  if (period === 'today') return 'Այսօր';
  if (period === 'week') return 'Այս շաբաթ';
  if (period === 'month') return 'Այս ամիս';
  if (period === 'date' && exactDate) return dateLabel(exactDate, true);
  return 'Ամբողջ ժամանակահատվածը';
}

/* ===========================================================================
   Business maths
   ========================================================================= */

/** Full P&L for a given energy volume. Net margin is linear in kWh:
 *  120 − 15% − 10% (after fee) − 50 = 41.8 ֏ per kWh. */
function economics(kwh) {
  const revenue = kwh * PRICE;
  const service = revenue * SERVICE_RATE;
  const tax = (revenue - service) * TAX_RATE;
  const power = kwh * POWER_COST;
  return { revenue, service, tax, power, costs: service + tax + power, net: revenue - service - tax - power };
}

function daily(list) {
  const m = {};
  list.forEach(e => {
    m[e.date] ??= { date: e.date, kwh: 0, cars: 0 };
    m[e.date].kwh += +e.kwh;
    m[e.date].cars++;
  });
  return Object.values(m).sort((a, b) => a.date.localeCompare(b.date));
}

/** Continuous last-N-day series (zero-filled) of revenue & net profit. */
function trendSeries(list, days = TREND_DAYS) {
  const byDate = Object.fromEntries(daily(list).map(d => [d.date, d]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = iso(d);
    const kwh = byDate[key]?.kwh ?? 0;
    const { revenue, net } = economics(kwh);
    out.push({ date: key, kwh, cars: byDate[key]?.cars ?? 0, revenue, net });
  }
  return out;
}

/** kWh-per-session histogram — this is what proves the "~25 kWh top-up" story. */
const BUCKETS = [
  { label: '0–10', min: 0, max: 10 },
  { label: '10–20', min: 10, max: 20 },
  { label: '20–30', min: 20, max: 30 },
  { label: '30–40', min: 30, max: 40 },
  { label: '40–60', min: 40, max: 60 },
  { label: '60+', min: 60, max: Infinity },
];

function distribution(list) {
  const counts = BUCKETS.map(() => 0);
  list.forEach(e => {
    const i = BUCKETS.findIndex(b => e.kwh >= b.min && e.kwh < b.max);
    if (i >= 0) counts[i]++;
  });
  return counts;
}

function trend(vals) {
  if (vals.length < 2) return 0;
  const split = Math.ceil(vals.length / 2);
  const a = vals.slice(0, split).reduce((x, y) => x + y, 0);
  const b = vals.slice(split).reduce((x, y) => x + y, 0);
  return a ? ((b - a) / a) * 100 : 0;
}

/** Session size tier — used for the colour-coded status badge in the table. */
function tier(kwh) {
  if (kwh >= 40) return { key: 'big', label: 'Խոշոր լիցք', cls: 'bg-brand/12 text-brand-text ring-brand/30' };
  if (kwh >= 15) return { key: 'std', label: 'Ստանդարտ', cls: 'bg-info/10 text-info-text ring-info/30' };
  return { key: 'top', label: 'Կարճ լիցք', cls: 'bg-raised text-muted ring-hair' };
}

/* ===========================================================================
   Shared class tokens
   ========================================================================= */

const CARD = 'group relative rounded-3xl border border-hair bg-surface p-5 shadow-card backdrop-blur-xl transition duration-300 hover:border-faint/60 hover:bg-raised hover:shadow-lift sm:p-6';
const EYEBROW = 'text-[.72rem] font-medium uppercase tracking-[.09em] text-muted';
const BTN = 'inline-flex items-center justify-center gap-2 rounded-xl border border-hair bg-raised px-4 py-2.5 text-sm font-medium text-fg2 transition duration-200 hover:-translate-y-px hover:border-faint/70 hover:bg-track active:translate-y-0 disabled:pointer-events-none disabled:opacity-50';
const BTN_PRIMARY = 'inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-onbrand shadow-glow transition duration-200 hover:-translate-y-px hover:bg-brand-deep active:translate-y-0 disabled:pointer-events-none disabled:opacity-50';
const FIELD = 'w-full rounded-xl border border-hair bg-field px-3.5 py-2.5 text-sm text-fg placeholder:text-faint transition focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-brand/25';

function trendPill(v) {
  const up = v >= 0;
  const cls = up ? 'bg-brand/12 text-brand-text ring-brand/25' : 'bg-danger/12 text-danger-text ring-danger/25';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[.7rem] font-semibold ring-1 ring-inset ${cls}">${up ? '↗' : '↘'} ${Math.abs(v).toFixed(1)}%</span>`;
}

function sparkBar(pct, cls = 'from-brand to-brand-soft') {
  return `<div class="h-1.5 w-full overflow-hidden rounded-full bg-track"><div class="h-full rounded-full bg-gradient-to-r ${cls} transition-[width] duration-700 ease-out" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;
}

/* ===========================================================================
   Sections
   ========================================================================= */

function kpiSection(shown, days) {
  const totalKwh = shown.reduce((s, e) => s + +e.kwh, 0);
  const econ = economics(totalKwh);

  /* month-to-date figures always reflect the real calendar month, whatever
     filter is active — the loan is a monthly obligation. */
  const monthStart = `${iso(new Date()).slice(0, 7)}-01`;
  const monthEntries = entries.filter(e => e.date >= monthStart);
  const monthKwh = monthEntries.reduce((s, e) => s + +e.kwh, 0);
  const monthEcon = economics(monthKwh);
  const progress = (monthEcon.net / LOAN_TARGET) * 100;
  const remaining = Math.max(0, LOAN_TARGET - monthEcon.net);
  const kwhToTarget = remaining / (PRICE - PRICE * SERVICE_RATE - (PRICE - PRICE * SERVICE_RATE) * TAX_RATE - POWER_COST);

  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const pace = (dayOfMonth / daysInMonth) * 100;
  const onTrack = progress >= pace;

  const avgKwh = shown.length ? totalKwh / shown.length : 0;
  const avgCars = days.length ? shown.length / days.length : 0;
  const kTrend = trend(days.map(x => x.kwh));
  const cTrend = trend(days.map(x => x.cars));
  const costShare = econ.revenue ? (econ.costs / econ.revenue) * 100 : 0;
  const topUps = shown.filter(e => e.kwh >= 15 && e.kwh < 40).length;
  const topUpShare = shown.length ? (topUps / shown.length) * 100 : 0;

  return `
  <section class="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">

    <!-- Monthly net profit — the hero metric -->
    <article class="${CARD} sm:col-span-2 xl:col-span-2 !border-brand/25 !bg-gradient-to-br !from-brand/[.10] !via-surface/40 !to-transparent hover:!border-brand/45">
      <div class="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-brand/60 to-transparent"></div>
      <div class="flex items-start justify-between gap-3">
        <span class="${EYEBROW}">Ամսվա մաքուր շահույթ</span>
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand/15 text-brand-text ring-1 ring-inset ring-brand/30">֏</span>
      </div>
      <div class="mt-4 text-[2.15rem] font-bold leading-none tracking-tight text-fg sm:text-[2.6rem]">${money(monthEcon.net)}</div>
      <p class="mt-2 text-sm text-muted">${fmt(monthKwh)} կՎտ⋅ժ · ${monthEntries.length} մեքենա այս ամիս</p>
      <div class="mt-5 grid grid-cols-2 gap-3 border-t border-hair pt-4">
        <div><div class="${EYEBROW}">Շրջանառություն</div><div class="mt-1 text-sm font-semibold text-fg2">${money(monthEcon.revenue)}</div></div>
        <div><div class="${EYEBROW}">Ծախսեր</div><div class="mt-1 text-sm font-semibold text-danger-text">− ${money(monthEcon.costs)}</div></div>
      </div>
    </article>

    <!-- Break-even progress -->
    <article class="${CARD} sm:col-span-2 xl:col-span-2">
      <div class="flex items-start justify-between gap-3">
        <span class="${EYEBROW}">Վարկի ծածկույթ</span>
        <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[.7rem] font-semibold ring-1 ring-inset ${onTrack ? 'bg-brand/12 text-brand-text ring-brand/25' : 'bg-warn/12 text-warn-text ring-warn/30'}">
          ${onTrack ? '● Գրաֆիկում է' : '● Հետ է մնում'}
        </span>
      </div>
      <div class="mt-4 flex items-baseline gap-2">
        <span class="text-[2.15rem] font-bold leading-none tracking-tight text-fg">${progress.toFixed(0)}%</span>
        <span class="text-sm text-muted">${money(LOAN_TARGET)}-ից</span>
      </div>
      <div class="relative mt-5">
        <div class="h-2.5 w-full overflow-hidden rounded-full bg-track ring-1 ring-inset ring-hair">
          <div class="h-full rounded-full bg-gradient-to-r from-brand-deep via-brand to-brand-soft shadow-[0_0_18px_rgb(var(--brand)/.5)] transition-[width] duration-[900ms] ease-out"
               style="width:${Math.max(1.5, Math.min(100, progress))}%"></div>
        </div>
        <div class="absolute -top-1 bottom-[-.35rem] w-px bg-fg/30" style="left:${Math.min(100, pace)}%" title="Ամսվա ընթացիկ տեմպը"></div>
      </div>
      <div class="mt-3 flex items-center justify-between text-xs">
        <span class="text-muted">Օր ${dayOfMonth}/${daysInMonth}</span>
        <span class="font-medium ${remaining ? 'text-fg2' : 'text-brand-text'}">
          ${remaining ? `Մնում է ${money(remaining)} · ≈${fmt(kwhToTarget, 0)} կՎտ⋅ժ` : 'Վարկը ծածկված է ✓'}
        </span>
      </div>
    </article>

    <!-- Revenue vs costs -->
    <article class="${CARD} xl:col-span-2">
      <div class="flex items-start justify-between gap-3">
        <span class="${EYEBROW}">Շրջանառություն / Ծախս</span>
        ${trendPill(kTrend)}
      </div>
      <div class="mt-4 text-3xl font-bold leading-none tracking-tight text-fg">${money(econ.revenue)}</div>
      <p class="mt-2 text-sm text-muted">Ծախս՝ <b class="font-semibold text-danger-text">${money(econ.costs)}</b> · մարժա ${(100 - costShare).toFixed(1)}%</p>
      <div class="mt-4 space-y-2">
        ${sparkBar(100, 'from-info/70 to-info/30')}
        ${sparkBar(costShare, 'from-danger/80 to-danger/40')}
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span><i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-info align-middle"></i>Շրջանառություն</span>
        <span><i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-danger align-middle"></i>Ընդհանուր ծախս</span>
      </div>
    </article>

    <!-- Average kWh per session -->
    <article class="${CARD} xl:col-span-3">
      <div class="flex items-start justify-between gap-3">
        <span class="${EYEBROW}">Միջին լիցքավորում</span>
        <span class="text-faint">∿</span>
      </div>
      <div class="mt-4 flex items-baseline gap-1.5">
        <span class="text-3xl font-bold leading-none tracking-tight text-fg">${fmt(avgKwh)}</span>
        <span class="text-sm font-medium text-muted">կՎտ⋅ժ</span>
      </div>
      <p class="mt-2 text-sm text-muted">
        Լիցքավորումների <b class="font-semibold text-fg2">${topUpShare.toFixed(0)}%</b>-ը 15–40 կՎտ⋅ժ «լրալիցք» է
      </p>
      <div class="mt-4">${sparkBar(topUpShare, 'from-brand to-brand-soft')}</div>
      <p class="mt-2 text-xs text-muted">${topUps} գրառում ${shown.length}-ից · մեկ լիցքի շահույթ ≈ ${money(avgKwh * 41.8)}</p>
    </article>

    <!-- Daily average vehicles -->
    <article class="${CARD} xl:col-span-3">
      <div class="flex items-start justify-between gap-3">
        <span class="${EYEBROW}">Օրական միջին մեքենա</span>
        ${trendPill(cTrend)}
      </div>
      <div class="mt-4 flex items-baseline gap-1.5">
        <span class="text-3xl font-bold leading-none tracking-tight text-fg">${fmt(avgCars)}</span>
        <span class="text-sm font-medium text-muted">մեքենա/օր</span>
      </div>
      <p class="mt-2 text-sm text-muted">${shown.length} մեքենա · ${days.length} ակտիվ օր</p>
      <div class="mt-4 flex items-end gap-1" aria-hidden="true">
        ${(() => {
          const last = days.slice(-24);
          const max = Math.max(...last.map(d => d.cars), 1);
          return last.map(d => `<span class="flex-1 rounded-sm bg-gradient-to-t from-brand-deep/40 to-brand/80 transition-all duration-500" style="height:${Math.max(3, (d.cars / max) * 34)}px"></span>`).join('') || '<span class="text-xs text-faint">Տվյալ չկա</span>';
        })()}
      </div>
    </article>
  </section>`;
}

function chartsSection(shown) {
  const hasData = shown.length > 0;
  return `
  <section class="grid grid-cols-1 gap-4 xl:grid-cols-5">
    <article class="${CARD} xl:col-span-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold tracking-tight text-fg">Շրջանառություն և մաքուր շահույթ</h2>
          <p class="mt-1 text-sm text-muted">Վերջին ${TREND_DAYS} օրը · օրական կտրվածքով</p>
        </div>
        <div class="flex items-center gap-4 text-xs text-muted">
          <span><i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-info align-middle"></i>Շրջանառություն</span>
          <span><i class="mr-1.5 inline-block h-2 w-2 rounded-full bg-brand align-middle"></i>Մաքուր շահույթ</span>
        </div>
      </div>
      <div class="chart-canvas-wrap mt-5 h-[290px]">
        ${hasData ? '<canvas id="trendChart" height="290"></canvas>' : emptyState('Այս ժամանակահատվածում տվյալներ չկան')}
      </div>
    </article>

    <article class="${CARD} xl:col-span-2">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold tracking-tight text-fg">Լիցքի ծավալի բաշխում</h2>
          <p class="mt-1 text-sm text-muted">Քանի՞ լիցքավորում՝ ըստ կՎտ⋅ժ միջակայքի</p>
        </div>
        <div class="flex rounded-lg border border-hair bg-raised p-0.5">
          ${[['kwh', 'կՎտ⋅ժ'], ['cars', 'Մեքենա']].map(([v, l]) => `
            <button class="tab rounded-[.4rem] px-2.5 py-1 text-xs font-medium transition ${mode === v ? 'bg-track text-fg shadow-sm' : 'text-muted hover:text-fg2'}" data-mode="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="chart-canvas-wrap mt-5 h-[290px]">
        ${hasData ? '<canvas id="distChart" height="290"></canvas>' : emptyState('Բաշխում ցուցադրելու տվյալ չկա')}
      </div>
    </article>
  </section>`;
}

function emptyState(text) {
  return `<div class="flex h-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-hair text-center">
    <span class="text-2xl text-faint">⌁</span>
    <b class="text-sm font-medium text-muted">${text}</b>
    <small class="text-xs text-faint">Փոխիր ֆիլտրը կամ ավելացրու լիցքավորում</small>
  </div>`;
}

function financeSection(shown) {
  const totalKwh = shown.reduce((s, e) => s + +e.kwh, 0);
  const e = economics(totalKwh);
  const types = { 'GB/T': 0, CCS1: 0 };
  shown.forEach(x => { types[x.type] = (types[x.type] || 0) + 1; });
  const typeTotal = Math.max(shown.length, 1);
  const gb = (types['GB/T'] / typeTotal) * 100;

  const step = (label, value, note, kind = '') => `
    <div class="flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition hover:bg-raised ${kind === 'result' ? 'mt-1 border border-brand/25 bg-brand/[.07]' : ''}">
      <div class="min-w-0">
        <div class="truncate text-sm ${kind === 'result' ? 'font-semibold text-fg' : 'text-fg2'}">${label}</div>
        <div class="mt-0.5 text-xs text-muted">${note}</div>
      </div>
      <b class="shrink-0 text-sm font-semibold tabular-nums ${kind === 'result' ? 'text-brand-text' : kind === 'income' ? 'text-fg' : 'text-danger-text'}">${value}</b>
    </div>`;

  return `
  <section class="grid grid-cols-1 gap-4 xl:grid-cols-5">
    <article class="${CARD} xl:col-span-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold tracking-tight text-fg">Ֆինանսական հաշվարկ</h2>
          <p class="mt-1 text-sm text-muted">${periodText()} · ${fmt(totalKwh)} կՎտ⋅ժ</p>
        </div>
      </div>
      <div class="mt-4 space-y-0.5">
        ${step('Ընդհանուր շրջանառություն', money(e.revenue), `${fmt(totalKwh)} × ${PRICE} ֏`, 'income')}
        ${step('Գործընկերոջ սպասարկում՝ 15%', `− ${money(e.service)}`, 'Ընդհանուր շրջանառությունից')}
        ${step('Եկամտահարկ՝ 10%', `− ${money(e.tax)}`, '15%-ը հանելուց հետո')}
        ${step('ՀԷՑ-ի վճար', `− ${money(e.power)}`, `${fmt(totalKwh)} × ${POWER_COST} ֏`)}
        ${step('Մաքուր մնացորդ', `= ${money(e.net)}`, `≈ 41.8 ֏ յուրաքանչյուր կՎտ⋅ժ-ից`, 'result')}
      </div>
    </article>

    <article class="${CARD} xl:col-span-2">
      <div>
        <h2 class="text-base font-semibold tracking-tight text-fg">Միակցիչների բաժանում</h2>
        <p class="mt-1 text-sm text-muted">Ըստ լիցքավորումների քանակի</p>
      </div>
      <div class="mt-6 flex items-center gap-6">
        <div class="relative h-[124px] w-[124px] shrink-0">
          <div class="h-full w-full rounded-full transition-all duration-700"
               style="background:conic-gradient(rgb(var(--brand)) 0 ${gb}%, rgb(var(--info)) ${gb}% 100%)"></div>
          <div class="absolute inset-[13px] grid place-items-center rounded-full bg-surface ring-1 ring-inset ring-hair">
            <b class="text-xl font-bold text-fg">${shown.length}</b>
            <span class="text-[.68rem] text-muted">լիցքավորում</span>
          </div>
        </div>
        <div class="min-w-0 flex-1 space-y-3">
          ${[['GB/T', types['GB/T'], 'bg-brand'], ['CCS1', types.CCS1, 'bg-info']].map(([label, count, dot]) => `
            <div>
              <div class="flex items-center justify-between text-sm">
                <span class="flex items-center gap-2 text-fg2"><i class="h-2 w-2 rounded-full ${dot}"></i>${label}</span>
                <b class="font-semibold tabular-nums text-fg2">${count} · ${Math.round((count / typeTotal) * 100)}%</b>
              </div>
              <div class="mt-1.5">${sparkBar((count / typeTotal) * 100, dot === 'bg-brand' ? 'from-brand-deep to-brand-soft' : 'from-info/80 to-info/40')}</div>
            </div>`).join('')}
        </div>
      </div>
    </article>
  </section>`;
}

function tableSection(shown) {
  const sorted = [...shown].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  page = Math.min(page, pageCount);
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const TH = 'whitespace-nowrap px-4 py-3 text-left text-[.72rem] font-medium uppercase tracking-[.08em] text-muted';
  const TD = 'whitespace-nowrap border-t border-hair px-4 py-3.5 text-sm';

  const body = rows.map(e => {
    const { revenue, net } = economics(e.kwh);
    const t = tier(e.kwh);
    return `<tr class="group/row transition duration-200 hover:bg-raised/70 md:hover:shadow-[inset_3px_0_0_0_rgb(var(--brand)/.85)]">
      <td class="${TD} font-medium text-fg2" data-label="Ամսաթիվ">${dateLabel(e.date, true)}</td>
      <td class="${TD} tabular-nums text-muted" data-label="Ժամ">${timeLabel(e.createdAt)}</td>
      <td class="${TD} tabular-nums font-semibold text-fg" data-label="Էներգիա"><span>${fmt(e.kwh)} <span class="font-normal text-muted">կՎտ⋅ժ</span></span></td>
      <td class="${TD}" data-label="Միակցիչ"><span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${e.type === 'GB/T' ? 'bg-brand/10 text-brand-text ring-brand/25' : 'bg-info/10 text-info-text ring-info/30'}">${e.type}</span></td>
      <td class="${TD} tabular-nums text-fg2" data-label="Շրջանառություն">${money(revenue)}</td>
      <td class="${TD} tabular-nums font-semibold text-brand-text" data-label="Մաքուր շահույթ">${money(net)}</td>
      <td class="${TD}" data-label="Կարգավիճակ"><span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${t.cls}"><i class="h-1.5 w-1.5 rounded-full bg-current"></i>${t.label}</span></td>
      <td class="${TD} row-action text-right" data-label="">
        <button class="delete inline-flex h-8 w-8 items-center justify-center rounded-lg text-faint transition hover:bg-danger/12 hover:text-danger-text md:opacity-0 md:group-hover/row:opacity-100 md:focus:opacity-100 disabled:opacity-40"
                data-id="${e.id}" aria-label="Ջնջել">✕</button>
      </td>
    </tr>`;
  }).join('');

  return `
  <section class="${CARD} group/table !p-0 overflow-hidden">
    <div class="flex flex-wrap items-start justify-between gap-3 p-5 sm:p-6">
      <div>
        <h2 class="text-base font-semibold tracking-tight text-fg">Վերջին լիցքավորումները</h2>
        <p class="mt-1 text-sm text-muted">${sorted.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, sorted.length)}՝ ${sorted.length} գրառումից` : 'Ընտրված ժամանակահատվածում'}</p>
      </div>
      <span class="rounded-lg border border-hair bg-raised px-2.5 py-1 text-xs text-muted">${periodText()}</span>
    </div>
    <div class="overflow-x-auto px-4 pb-4 sm:px-6 sm:pb-6 md:px-0 md:pb-0">
      ${rows.length ? `<table class="rtable w-full border-collapse">
        <thead class="bg-raised/60">
          <tr>
            <th class="${TH}">Ամսաթիվ</th>
            <th class="${TH}" title="Գրառման ժամը (լիցքավորման փաստացի ժամը բազայում չի պահվում)">Ժամ</th>
            <th class="${TH}">Էներգիա</th>
            <th class="${TH}">Միակցիչ</th>
            <th class="${TH}">Շրջանառություն</th>
            <th class="${TH}">Մաքուր շահույթ</th>
            <th class="${TH}">Կարգավիճակ</th>
            <th class="${TH}"></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>` : `<div class="p-10">${emptyState('Այս ֆիլտրով լիցքավորում չի գտնվել')}</div>`}
    </div>
    ${sorted.length > PAGE_SIZE ? `<nav class="flex items-center justify-center gap-1 border-t border-hair p-4" aria-label="Էջեր">
      <button class="page-btn ${pageBtnCls(false)}" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>
      ${pager(page, pageCount)}
      <button class="page-btn ${pageBtnCls(false)}" data-page="${page + 1}" ${page === pageCount ? 'disabled' : ''}>›</button>
    </nav>` : ''}
  </section>`;
}

const pageBtnCls = active =>
  `min-w-[2.25rem] rounded-lg px-2.5 py-1.5 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-30 ${
    active ? 'bg-brand text-onbrand' : 'text-muted hover:bg-track hover:text-fg'}`;

function pager(current, total) {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  let out = '', prev = 0;
  for (const n of pages) {
    if (prev && n - prev > 1) out += '<span class="px-1 text-faint">…</span>';
    out += `<button class="page-btn ${pageBtnCls(current === n)}" data-page="${n}">${n}</button>`;
    prev = n;
  }
  return out;
}

function filterBar(shown) {
  return `
  <section class="flex flex-wrap items-center gap-3 rounded-2xl border border-hair bg-surface p-2.5 shadow-card backdrop-blur-xl">
    <div class="-mx-1 flex flex-1 gap-1 overflow-x-auto px-1 sm:flex-none [&::-webkit-scrollbar]:hidden">
      ${[['all', 'Բոլորը'], ['today', 'Այսօր'], ['week', 'Այս շաբաթ'], ['month', 'Այս ամիս']].map(([v, l]) => `
        <button class="filter-chip shrink-0 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-medium transition duration-200 ${
          period === v ? 'bg-track text-fg shadow-sm ring-1 ring-inset ring-hair' : 'text-muted hover:bg-raised hover:text-fg2'}" data-period="${v}">${l}</button>`).join('')}
    </div>
    <div class="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
      <label class="hidden text-xs text-muted sm:block" for="exactDate">Կոնկրետ օր</label>
      <input id="exactDate" type="date" value="${exactDate}" aria-label="Ընտրել կոնկրետ օր"
             class="w-full sm:w-auto rounded-xl border border-hair bg-field px-3 py-2 text-sm text-fg2 transition focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-brand/25">
      <button id="clearDate" aria-label="Մաքրել ամսաթիվը" ${period !== 'date' ? 'hidden' : ''}
              class="${period !== 'date' ? 'hidden' : 'inline-flex'} h-9 w-9 items-center justify-center rounded-xl text-muted transition hover:bg-track hover:text-fg">✕</button>
      <div class="hidden items-center gap-2 rounded-xl border border-hair bg-raised px-3 py-2 text-xs sm:flex">
        <b class="font-semibold text-fg2">${periodText()}</b>
        <span class="text-muted">${shown.length} լիցքավորում</span>
      </div>
    </div>
  </section>`;
}

function header() {
  return `
  <header class="mb-6 flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-brand to-brand-deep text-xl text-onbrand shadow-glow">ϟ</div>
      <div>
        <h1 class="text-lg font-semibold tracking-tight text-fg">ChargeFlow</h1>
        <p class="text-[.8rem] text-muted">Արագ լիցքավորման վերլուծություն</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <span class="hidden items-center gap-2 rounded-full border border-hair bg-raised px-3 py-1.5 text-xs text-muted sm:inline-flex">
        <i class="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_rgb(var(--brand)/.8)]"></i> Supabase
      </span>
      <button class="${BTN} !px-2.5" id="theme" aria-label="Փոխել թեման" title="${isDark() ? 'Անցնել բաց թեմային' : 'Անցնել մուգ թեմային'}">${isDark() ? '☀' : '☾'}</button>
      <button class="${BTN}" id="export">⇩ <span class="hidden sm:inline">Արտահանել CSV</span></button>
      <button class="${BTN_PRIMARY}" id="add">＋ <span class="hidden sm:inline">Նոր լիցքավորում</span></button>
    </div>
  </header>`;
}

function modal() {
  return `
  <div id="modal" class="fixed inset-0 z-50 hidden place-items-center bg-[rgb(var(--scrim)/.55)] p-4 backdrop-blur-md">
    <div class="dialog-in w-full max-w-md rounded-3xl border border-hair bg-elevated p-6 shadow-lift" role="dialog" aria-modal="true" aria-labelledby="dialogTitle">
      <div class="mb-5 flex items-center justify-between">
        <h2 id="dialogTitle" class="text-base font-semibold tracking-tight text-fg">Նոր լիցքավորում</h2>
        <button id="close" aria-label="Փակել" class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-track hover:text-fg">✕</button>
      </div>
      <form id="form" class="space-y-4">
        <div>
          <label for="date" class="mb-1.5 block text-xs font-medium text-muted">Ամսաթիվ</label>
          <input id="date" name="date" type="date" required class="${FIELD}">
        </div>
        <div>
          <label for="kwh" class="mb-1.5 block text-xs font-medium text-muted">Վաճառված էներգիա (կՎտ⋅ժ)</label>
          <input id="kwh" name="kwh" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="օր.՝ 25.55" required class="${FIELD}">
        </div>
        <div>
          <label for="type" class="mb-1.5 block text-xs font-medium text-muted">Միակցիչի տեսակը</label>
          <select id="type" name="type" class="${FIELD}"><option>GB/T</option><option>CCS1</option></select>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="${BTN}" id="cancel">Չեղարկել</button>
          <button type="submit" class="${BTN_PRIMARY}">Պահպանել</button>
        </div>
      </form>
    </div>
  </div>`;
}

/* ===========================================================================
   Render
   ========================================================================= */

function render() {
  destroyCharts();

  if (loading) {
    app.innerHTML = `<div class="mx-auto max-w-[1440px] p-5 sm:p-7">
      ${header()}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        ${['sm:col-span-2 xl:col-span-2 h-44', 'sm:col-span-2 xl:col-span-2 h-44', 'xl:col-span-2 h-44', 'xl:col-span-3 h-40', 'xl:col-span-3 h-40', 'sm:col-span-2 xl:col-span-6 h-72']
          .map(c => `<div class="skeleton rounded-3xl border border-hair ${c}"></div>`).join('')}
      </div>
    </div>`;
    return;
  }

  if (dbError) {
    app.innerHTML = `<div class="grid min-h-screen place-items-center p-6">
      <div class="w-full max-w-md rounded-3xl border border-hair bg-surface p-8 text-center shadow-lift backdrop-blur-xl">
        <div class="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-warn/15 text-xl text-warn-text">!</div>
        <h1 class="mt-5 text-lg font-semibold text-fg">Supabase կապը դեռ պատրաստ չէ</h1>
        <p class="mt-2 text-sm text-muted">${dbError}</p>
        <p class="mt-3 text-xs text-faint">Supabase SQL Editor-ում աշխատեցրու ստացած SQL-ը, հետո նորից փորձիր։</p>
        <button class="${BTN_PRIMARY} mt-6 w-full" id="retry">Նորից փորձել</button>
        <button class="${BTN} mt-2 w-full" id="theme">${isDark() ? '☀ Բաց թեմա' : '☾ Մուգ թեմա'}</button>
      </div>
    </div>`;
    document.querySelector('#retry').onclick = loadEntries;
    document.querySelector('#theme').onclick = toggleTheme;
    return;
  }

  const shown = filtered();
  const days = daily(shown);

  app.innerHTML = `<div class="mx-auto max-w-[1440px] space-y-4 p-5 sm:p-7">
    ${header()}
    ${filterBar(shown)}
    ${kpiSection(shown, days)}
    ${chartsSection(shown)}
    ${financeSection(shown)}
    ${tableSection(shown)}
  </div>
  ${modal()}`;

  bind();
  drawCharts(shown);
}

/* ===========================================================================
   Chart.js
   ========================================================================= */

function destroyCharts() {
  trendChart?.destroy(); trendChart = null;
  distChart?.destroy(); distChart = null;
}

const grid = () => themeColor('fg', isDark() ? 0.07 : 0.09);
const tick = () => themeColor('muted');

function tooltipStyle() {
  return {
    backgroundColor: themeColor('elevated', 0.98),
    borderColor: themeColor('hair'),
    borderWidth: 1,
    titleColor: themeColor('fg'),
    bodyColor: themeColor('fg2'),
    padding: 12,
    cornerRadius: 12,
    displayColors: true,
    boxPadding: 5,
    usePointStyle: true,
  };
}

function drawCharts(shown) {
  if (typeof Chart === 'undefined' || !shown.length) return;

  Chart.defaults.font.family = "Inter, ui-sans-serif, system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = tick();

  /* --- Area chart: revenue vs net profit, last 30 days ------------------ */
  const trendCanvas = document.querySelector('#trendChart');
  if (trendCanvas) {
    const series = trendSeries(shown);
    const ctx = trendCanvas.getContext('2d');
    const gradient = (from, to) => {
      const g = ctx.createLinearGradient(0, 0, 0, 290);
      g.addColorStop(0, from); g.addColorStop(1, to);
      return g;
    };

    trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: series.map(d => dateLabel(d.date)),
        datasets: [
          {
            label: 'Շրջանառություն',
            data: series.map(d => Math.round(d.revenue)),
            borderColor: themeColor('info'),
            backgroundColor: gradient(themeColor('info', 0.3), themeColor('info', 0)),
            borderWidth: 2, fill: true, tension: 0.38,
            pointRadius: 0, pointHoverRadius: 5,
            pointHoverBackgroundColor: themeColor('info'), pointHoverBorderColor: themeColor('surface'), pointHoverBorderWidth: 3,
          },
          {
            label: 'Մաքուր շահույթ',
            data: series.map(d => Math.round(d.net)),
            borderColor: themeColor('brand'),
            backgroundColor: gradient(themeColor('brand', 0.34), themeColor('brand', 0)),
            borderWidth: 2.25, fill: true, tension: 0.38,
            pointRadius: 0, pointHoverRadius: 5,
            pointHoverBackgroundColor: themeColor('brand'), pointHoverBorderColor: themeColor('surface'), pointHoverBorderWidth: 3,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 750, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            callbacks: {
              title: items => dateLabel(series[items[0].dataIndex].date, true),
              label: item => ` ${item.dataset.label}՝ ${money(item.parsed.y)}`,
              afterBody: items => {
                const d = series[items[0].dataIndex];
                return `\n${fmt(d.kwh)} կՎտ⋅ժ · ${d.cars} մեքենա`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: {
            beginAtZero: true,
            grid: { color: grid(), drawTicks: false },
            border: { display: false },
            ticks: { maxTicksLimit: 5, padding: 8, callback: v => compact(v) },
          },
        },
      },
    });
  }

  /* --- Bar chart: kWh-per-session distribution -------------------------- */
  const distCanvas = document.querySelector('#distChart');
  if (distCanvas) {
    const counts = distribution(shown);
    const kwhTotals = BUCKETS.map((b, i) =>
      shown.filter(e => e.kwh >= b.min && e.kwh < b.max).reduce((s, e) => s + +e.kwh, 0));
    const values = mode === 'cars' ? counts : kwhTotals.map(v => Math.round(v));
    const peak = Math.max(...values);
    const ctx = distCanvas.getContext('2d');
    const bar = ctx.createLinearGradient(0, 0, 0, 290);
    bar.addColorStop(0, themeColor('brand', 0.95));
    bar.addColorStop(1, themeColor('brand', 0.25));
    const dim = ctx.createLinearGradient(0, 0, 0, 290);
    dim.addColorStop(0, themeColor('faint', 0.45));
    dim.addColorStop(1, themeColor('faint', 0.14));

    distChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: BUCKETS.map(b => b.label),
        datasets: [{
          label: mode === 'cars' ? 'Մեքենա' : 'կՎտ⋅ժ',
          data: values,
          backgroundColor: values.map(v => (v === peak && peak > 0 ? bar : dim)),
          hoverBackgroundColor: bar,
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 46,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 700, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle(),
            callbacks: {
              title: items => `${items[0].label} կՎտ⋅ժ միջակայք`,
              label: item => mode === 'cars'
                ? ` ${item.parsed.y} լիցքավորում`
                : ` ${fmt(item.parsed.y, 0)} կՎտ⋅ժ · ${counts[item.dataIndex]} լիցքավորում`,
              afterBody: items => ` Շահույթ՝ ${money(kwhTotals[items[0].dataIndex] * 41.8)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { padding: 4 } },
          y: { beginAtZero: true, grid: { color: grid(), drawTicks: false }, border: { display: false }, ticks: { maxTicksLimit: 5, padding: 8, precision: 0 } },
        },
      },
    });
  }
}

/* ===========================================================================
   Events
   ========================================================================= */

function bind() {
  const modalEl = document.querySelector('#modal');
  const open = () => {
    modalEl.classList.replace('hidden', 'grid');
    document.querySelector('#date').value = iso(new Date());
    document.querySelector('#kwh').focus();
  };
  const close = () => { modalEl.classList.replace('grid', 'hidden'); };

  document.querySelector('#add').onclick = open;
  document.querySelector('#close').onclick = close;
  document.querySelector('#cancel').onclick = close;
  modalEl.onclick = e => { if (e.target === modalEl) close(); };
  document.onkeydown = e => { if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) close(); };

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { mode = b.dataset.mode; render(); });
  document.querySelectorAll('.filter-chip').forEach(b => b.onclick = () => { period = b.dataset.period; exactDate = ''; page = 1; render(); });

  document.querySelector('#exactDate').onchange = e => { exactDate = e.target.value; period = exactDate ? 'date' : 'all'; page = 1; render(); };
  document.querySelector('#clearDate').onclick = () => { exactDate = ''; period = 'all'; page = 1; render(); };

  document.querySelectorAll('.page-btn[data-page]').forEach(b => b.onclick = () => {
    page = +b.dataset.page; render();
    document.querySelector('.rtable')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('.delete').forEach(b => b.onclick = async () => {
    if (!confirm('Ջնջե՞լ այս լիցքավորման տվյալը։')) return;
    b.disabled = true;
    try { await removeSession(b.dataset.id); render(); toast('Տվյալը ջնջված է'); }
    catch (error) { b.disabled = false; toast(error.message || 'Չհաջողվեց ջնջել'); }
  });

  document.querySelector('#form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const button = e.target.querySelector('[type="submit"]');
    const data = { date: f.get('date'), kwh: +f.get('kwh'), type: f.get('type') };
    button.disabled = true; button.textContent = 'Պահպանվում է…';
    try { await addSession(data); period = 'all'; exactDate = ''; page = 1; render(); toast('Տվյալը պահպանված է Supabase-ում'); }
    catch (error) { button.disabled = false; button.textContent = 'Պահպանել'; toast(error.message || 'Չհաջողվեց պահպանել'); }
  };

  document.querySelector('#export').onclick = exportCSV;
  document.querySelector('#theme').onclick = toggleTheme;
}

function exportCSV() {
  const list = filtered();
  const rows = [
    ['date', 'kwh', 'type', 'revenue_amd', 'net_profit_amd'],
    ...list.map(e => [e.date, e.kwh, e.type, Math.round(economics(e.kwh).revenue), Math.round(economics(e.kwh).net)]),
  ];
  const blob = new Blob(['﻿' + rows.map(r => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chargeflow-data.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function toast(text) {
  const x = document.createElement('div');
  x.className = 'toast-in fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-xl border border-hair bg-elevated px-4 py-3 text-sm text-fg2 shadow-lift backdrop-blur-xl';
  x.textContent = text;
  document.body.append(x);
  setTimeout(() => x.remove(), 2400);
}

loadEntries();

/* ===========================================================================
   Agent tools (document.modelContext)
   ========================================================================= */

function registerAgentTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const fail = m => { throw new Error(m); };

  Promise.resolve(context.registerTool({
    name: 'add_charging_session',
    title: 'Ավելացնել լիցքավորում',
    description: 'Պահպանում է մեկ մեքենայի լիցքավորման տվյալը Supabase-ում և թարմացնում dashboard-ը։',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        kwh: { type: 'number', exclusiveMinimum: 0 },
        connectorType: { type: 'string', enum: ['GB/T', 'CCS1'] },
      },
      required: ['date', 'kwh', 'connectorType'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) fail('Ամսաթիվը պետք է լինի YYYY-MM-DD ձևաչափով։');
      if (!Number.isFinite(input.kwh) || input.kwh <= 0) fail('կՎտ⋅ժ-ը պետք է լինի դրական թիվ։');
      if (!['GB/T', 'CCS1'].includes(input.connectorType)) fail('Անհայտ միակցիչ։');
      await addSession({ date: input.date, kwh: input.kwh, type: input.connectorType });
      render();
      return { saved: true, totalSessions: entries.length };
    },
  })).catch(() => {});

  Promise.resolve(context.registerTool({
    name: 'read_charging_summary',
    title: 'Կարդալ ամփոփումը',
    description: 'Վերադարձնում է Supabase-ից բեռնված ընթացիկ ֆինանսական և օգտագործման ամփոփումը։',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const list = filtered();
      const totalKwh = list.reduce((s, e) => s + +e.kwh, 0);
      const e = economics(totalKwh);
      const monthStart = `${iso(new Date()).slice(0, 7)}-01`;
      const monthNet = economics(entries.filter(x => x.date >= monthStart).reduce((s, x) => s + +x.kwh, 0)).net;
      return {
        period: periodText(),
        totalKwh: Number(totalKwh.toFixed(1)),
        totalSessions: list.length,
        revenueAMD: Math.round(e.revenue),
        serviceAMD: Math.round(e.service),
        incomeTaxAMD: Math.round(e.tax),
        powerCostAMD: Math.round(e.power),
        netAMD: Math.round(e.net),
        monthToDateNetAMD: Math.round(monthNet),
        loanTargetAMD: LOAN_TARGET,
        loanCoveragePct: Number(((monthNet / LOAN_TARGET) * 100).toFixed(1)),
      };
    },
  })).catch(() => {});
}

registerAgentTools();
