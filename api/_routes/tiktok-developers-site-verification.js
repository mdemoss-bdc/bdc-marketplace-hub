/**
 * TikTok URL Property Verification — signature file handler.
 * Mounted at multiple root paths (.html / .txt / token-suffixed / bare).
 */
const BODY =
  'tiktok-developers-site-verification=kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7';

function contentTypeForUrl(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  return path.endsWith('.html') || path.endsWith('.html/') ? 'text/html' : 'text/plain';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Content-Type', 'text/plain');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Content-Type', 'text/plain');
    res.status(405).end('Method not allowed');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeForUrl(req.url || req.path || ''));
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Length', Buffer.byteLength(BODY, 'utf8'));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(BODY);
};
