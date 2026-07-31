/**
 * 3-tier adaptive inventory extraction for Vercel serverless.
 * Tier 1: JSON-LD / data-* / VDP anchors (cheerio)
 * Tier 2: DOM heuristics (cheerio + he.decode)
 * Tier 3: optional LLM (skipped unless OPENAI_API_KEY is set)
 *
 * Never imports Playwright or Puppeteer.
 */
const { fetchHtml } = require('./html');
const { extractTier1 } = require('./tier1');
const { extractTier2 } = require('./tier2');
const { VehicleSchema } = require('./schema');

function validateBatch(vehicles, minCount = 5) {
  if (!vehicles.length) return { ok: false, reason: 'empty' };
  if (vehicles.length < minCount) return { ok: false, reason: `count_${vehicles.length}` };
  const thin = vehicles.filter(
    (v) => !v.price || !v.link || !v.stockNumber || v.stockNumber === 'N/A',
  ).length;
  if (thin > vehicles.length * 0.6) return { ok: false, reason: 'validation' };
  return { ok: true, reason: 'ok' };
}

async function extractTier3(html, pageUrl, prior = []) {
  const key = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
  if (!key) return prior;
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const chunk = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 12000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extract vehicle inventory as JSON {"vehicles":[{stockNumber,year,make,model,trim,price,mileage,exteriorColor,link,imageUrl,vin}]}. Absolute VDP links required.',
          },
          {
            role: 'user',
            content: `Page URL: ${pageUrl}\n\n${chunk}`,
          },
        ],
      }),
    });
    if (!res.ok) return prior;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.vehicles) ? parsed.vehicles : [];
    const out = [];
    for (const raw of list) {
      const v = VehicleSchema.safeParse(raw);
      if (v.success) out.push(v.data);
    }
    return out.length ? out : prior;
  } catch {
    return prior;
  }
}

function toEngineRows(vehicles, condition = 'Used') {
  return vehicles.map((v) => ({
    vin: v.vin,
    stock_number: v.stockNumber === 'N/A' ? '' : v.stockNumber,
    condition,
    year: v.year || 0,
    make: v.make || '',
    model: v.model || '',
    trim: v.trim || '',
    mileage: v.mileage || 0,
    price: v.price || 0,
    exterior_color: v.exteriorColor || '',
    interior_color: '',
    image_url: v.imageUrl || '',
    vdp_url: v.link || '',
    link: v.link || '',
    location: '',
    status: 'ACTIVE',
  }));
}

async function extractInventory(html, pageUrl, { condition = 'Used', minOk = 5 } = {}) {
  let tier = 1;
  let reason = 'tier1';
  let vehicles = extractTier1(html, pageUrl);
  let check = validateBatch(vehicles, minOk);
  if (!check.ok) {
    tier = 2;
    reason = `tier1_${check.reason}`;
    const t2 = extractTier2(html, pageUrl);
    const byVin = new Map(vehicles.map((v) => [v.vin, v]));
    for (const v of t2) {
      if (!byVin.has(v.vin)) byVin.set(v.vin, v);
    }
    vehicles = [...byVin.values()];
    check = validateBatch(vehicles, minOk);
  }
  if (!check.ok) {
    tier = 3;
    reason = `tier2_${check.reason}`;
    vehicles = await extractTier3(html, pageUrl, vehicles);
    check = validateBatch(vehicles, Math.min(minOk, 1));
    reason = check.ok ? 'tier3_ok' : `tier3_${check.reason}`;
  } else if (tier === 1) {
    reason = 'tier1_ok';
  } else {
    reason = 'tier2_ok';
  }
  return {
    vehicles,
    rows: toEngineRows(vehicles, condition),
    tier,
    reason,
    count: vehicles.length,
    condition,
    url: pageUrl,
  };
}

async function scrapeUrl(url, opts = {}) {
  const html = await fetchHtml(url);
  return extractInventory(html, url, opts);
}

module.exports = {
  extractInventory,
  scrapeUrl,
  toEngineRows,
  validateBatch,
};
