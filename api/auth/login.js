/**
 * POST /api/auth/login
 * Server-side credential check against DASHBOARD_PASSWORD / TESTER_PASSWORD.
 * Never reads VITE_* variables.
 */
const { authenticate, signSession, setCors } = require('../_lib/session');

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  body = body || {};

  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const user = authenticate(username, password);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  try {
    const token = signSession(user);
    res.status(200).json({ ...user, token });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Session signing failed.',
    });
  }
};
