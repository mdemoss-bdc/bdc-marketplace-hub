/**
 * GET /api/catalog/feed
 * GET /api/feeds/meta  (alias used by Settings / Help Assistant)
 *
 * Public Meta Commerce Manager automotive catalog feed.
 * No auth required — Meta's crawler must be able to fetch this URL.
 *
 * Query:
 *   format=xml|rss|json|csv   (default: xml)
 *   user_id=<n>               optional tenant filter
 *   token=<catalog_token>     optional gate when CATALOG_FEED_TOKEN is set
 */
const { applySecurityHeaders } = require('../../_lib/security');
const {
  buildCatalogItems,
  toJson,
  toRssXml,
  toListingsXml,
  toCsv,
} = require('../../_lib/meta-catalog-feed');

function publicHeaders(res, contentType, filename) {
  applySecurityHeaders(res);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (filename) {
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    publicHeaders(res, 'text/plain; charset=utf-8');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    publicHeaders(res, 'application/json; charset=utf-8');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const format = String(url.searchParams.get('format') || url.searchParams.get('fmt') || 'xml')
      .trim()
      .toLowerCase();
    const userId = url.searchParams.get('user_id') || url.searchParams.get('uid') || '';
    const token = (
      url.searchParams.get('token') ||
      url.searchParams.get('catalog_token') ||
      ''
    ).trim();

    const requiredToken = (
      process.env.CATALOG_FEED_TOKEN ||
      process.env.META_CATALOG_TOKEN ||
      ''
    ).trim();
    if (requiredToken && token !== requiredToken) {
      // Still public by default — only gated when an env token is configured.
      publicHeaders(res, 'application/json; charset=utf-8');
      res.status(401).json({
        success: false,
        error: 'Invalid or missing catalog feed token.',
      });
      return;
    }

    const items = await buildCatalogItems({
      userId: userId || undefined,
      limit: Number(url.searchParams.get('limit')) || 5000,
    });

    console.log(`[meta-catalog-feed] format=${format} count=${items.length} user_id=${userId || 'all'}`);

    if (format === 'json') {
      const body = toJson(items);
      publicHeaders(res, 'application/json; charset=utf-8', 'meta-catalog.json');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.status(200).send(body);
      return;
    }

    if (format === 'csv') {
      const body = toCsv(items);
      publicHeaders(res, 'text/csv; charset=utf-8', 'meta-catalog.csv');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.status(200).send(body);
      return;
    }

    if (format === 'listings' || format === 'listing') {
      const body = toListingsXml(items);
      publicHeaders(res, 'application/xml; charset=utf-8', 'meta-catalog.xml');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.status(200).send(body);
      return;
    }

    // Default: RSS/XML with <item> nodes (Meta-friendly)
    const body = toRssXml(items);
    publicHeaders(res, 'application/rss+xml; charset=utf-8', 'meta-catalog.xml');
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }
    res.status(200).send(body);
  } catch (err) {
    console.error('[api/catalog/feed]', err);
    publicHeaders(res, 'application/json; charset=utf-8');
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to build Meta catalog feed.',
    });
  }
};
