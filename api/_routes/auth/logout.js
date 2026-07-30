/**
 * POST /api/auth/logout
 * Clears the bdc_session auth cookie.
 */
const { clearAuthCookie } = require('../../_lib/jwt');
const { applySecurityHeaders } = require('../../_lib/security');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  clearAuthCookie(res);
  res.status(200).json({ status: 'logged_out' });
};
