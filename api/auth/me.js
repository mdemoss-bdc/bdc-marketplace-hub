/**
 * GET/POST /api/auth/me
 * Validates a vs_* session token issued by /api/auth/login (Vercel).
 */
const { verifySession, setCors } = require('../_lib/session');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const header = String(req.headers.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';

  const user = verifySession(token);
  if (!user) {
    res.status(401).json({ error: 'Authorization required.' });
    return;
  }

  res.status(200).json(user);
};
