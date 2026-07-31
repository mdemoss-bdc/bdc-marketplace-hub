/**
 * GET /tiktok-developers-site-verification
 * TikTok Developers domain verification — exact text/plain body.
 */
const BODY =
  'tiktok-developers-site-verification=kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Content-Type', 'text/plain');
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Content-Type', 'text/plain');
    res.status(405).send('Method not allowed');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Length', Buffer.byteLength(BODY, 'utf8'));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(BODY);
};
