/**
 * POST /api/auth/register
 * POST /api/auth/signup (alias)
 *
 * Creates a new user with a scrypt password hash and persists to SQLite + vault.
 */
const { createUser } = require('../../_lib/users');
const { signJwt, setAuthCookie } = require('../../_lib/jwt');
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');

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
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const email = String(body.email || '').trim();
  const fullName = String(body.full_name || body.name || username).trim();
  const accountType = String(body.account_type || '').trim().toLowerCase();
  const tosAccepted = Boolean(body.tos_accepted ?? body.tosAccepted);

  if (!tosAccepted && body.tos_accepted !== undefined) {
    res.status(400).json({
      success: false,
      error: 'You must accept the Terms of Service to create an account.',
    });
    return;
  }

  try {
    const user = createUser({
      username,
      password,
      email,
      full_name: fullName,
      account_type: accountType,
      subscription_status: 'inactive',
      role: 'Reviewer',
    });

    const token = signJwt({
      sub: user.username,
      id: user.id,
      role: user.role,
      is_admin: user.is_admin,
      is_master_admin: user.is_master_admin,
    });
    setAuthCookie(res, token);

    res.status(201).json({
      success: true,
      ...user,
      token,
      message: 'Account created.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed.';
    console.log('[AUTH FAIL]', username || '(empty)', `register: ${message}`);
    res.status(400).json({ success: false, error: message });
  }
};
