/**
 * POST /api/generate-description
 * (+ /api/marketplace/generate-description aliases)
 *
 * Internal Marketplace description generator — never redirects to external
 * Meta AI / Muse Spark UIs. Uses template copy + optional OPENAI_API_KEY polish.
 */
const { applySecurityHeaders } = require('../_lib/security');
const { parseBody } = require('../_lib/http');
const { getInventoryByVin, getLatestQueueCopy } = require('../_lib/marketplace');

function buildTemplate(vehicle) {
  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(' ');
  const price = Number(vehicle.price) || 0;
  const miles = Number(vehicle.mileage) || 0;
  const condition = String(vehicle.condition || 'Used');
  const stock = String(vehicle.stock_number || '').trim();
  const exterior = String(vehicle.exterior_color || '').trim();
  const interior = String(vehicle.interior_color || '').trim();
  const location = String(vehicle.location || '').trim();
  const dealer = process.env.DEALER_NAME || 'Moses Auto Group';

  const lines = [
    `🚗 ${title}`,
    '',
    'Looking for a clean, ready-to-drive vehicle? This one checks the boxes.',
    '',
    '✅ Value Snapshot',
    price ? `• Asking $${price.toLocaleString()}` : '• Competitive market pricing — ask for today’s out-the-door number',
    miles ? `• ${miles.toLocaleString()} miles` : null,
    `• Condition: ${condition}`,
    stock && stock.toUpperCase() !== 'N/A' ? `• Stock #${stock}` : null,
    exterior ? `• Exterior: ${exterior}` : null,
    interior ? `• Interior: ${interior}` : null,
    location ? `• Available at ${location}` : null,
    '',
    '✨ Why you’ll like it',
    '• Well-equipped for daily driving and weekend trips',
    '• Inspected and ready for a test drive',
    `• Backed by the ${dealer} team`,
    '',
    '📍 Local trust',
    `Shop with confidence at ${dealer}${location ? ` — ${location}` : ''}.`,
    '',
    '👉 Message us today to schedule your test drive or lock in this price before it’s gone!',
  ].filter((line) => line !== null);

  return {
    title,
    ai_description: lines.join('\n'),
    description: lines.join('\n'),
    source: 'template',
  };
}

async function polishWithOpenAI(templateText, vehicle) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(' ');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert automotive Facebook Marketplace copywriter. ' +
              'Rewrite the draft into polished, high-converting listing copy. ' +
              'Keep emojis light, stay truthful to the provided specs, and end with a clear CTA. ' +
              'Do not invent features, financing terms, or warranties that are not in the draft.',
          },
          {
            role: 'user',
            content: `Vehicle: ${title}\nVIN: ${vehicle.vin || ''}\n\nDraft:\n${templateText}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn('[generate-description] OpenAI HTTP', res.status);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return text;
  } catch (err) {
    console.warn('[generate-description] OpenAI failed', err.message || err);
    return null;
  }
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  const body = parseBody(req);
  const vin = String(body.vin || '').trim().toUpperCase();

  try {
    let vehicle = {
      vin,
      year: body.year,
      make: body.make,
      model: body.model,
      trim: body.trim,
      price: body.price,
      mileage: body.mileage,
      condition: body.condition,
      location: body.location,
      exterior_color: body.exterior_color || body.exteriorColor,
      interior_color: body.interior_color || body.interiorColor,
      stock_number: body.stock_number || body.stockNumber,
      ai_description: body.ai_description,
    };

    if (vin) {
      const queued = await getLatestQueueCopy(vin);
      if (queued?.ai_description) {
        res.status(200).json({
          success: true,
          ai_description: queued.ai_description,
          description: queued.ai_description,
          source: 'queue',
        });
        return;
      }
      const dbRow = await getInventoryByVin(vin);
      if (dbRow) {
        vehicle = { ...dbRow, ...vehicle, vin };
      }
    }

    const template = buildTemplate(vehicle);
    const polished = await polishWithOpenAI(template.ai_description, vehicle);
    if (polished) {
      res.status(200).json({
        success: true,
        title: template.title,
        ai_description: polished,
        description: polished,
        source: 'openai',
      });
      return;
    }

    res.status(200).json({ success: true, ...template });
  } catch (err) {
    console.error('[api/generate-description]', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Description generation failed.',
    });
  }
};
