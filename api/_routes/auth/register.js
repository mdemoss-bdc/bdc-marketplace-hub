/**
 * POST /api/auth/register
 * POST /api/auth/signup (alias)
 *
 * Creates a new user with a scrypt password hash, persists to PostgreSQL
 * (DATABASE_URL / POSTGRES_URL) or the local SQLite+vault fallback, and returns
 * a JWT session token for immediate sign-in.
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
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const confirm = String(body.confirm_password || body.confirmPassword || '');
  const email = String(body.email || '').trim().toLowerCase();
  const fullName = String(body.full_name || body.name || username).trim();
  const accountType = String(body.account_type || '').trim().toLowerCase();

  if (!username) {
    res.status(400).json({ success: false, error: 'Username is required.' });
    return;
  }
  if (!email) {
    res.status(400).json({ success: false, error: 'Email address is required.' });
    return;
  }
  if (!password) {
    res.status(400).json({ success: false, error: 'Password is required.' });
    return;
  }
  if (confirm && confirm !== password) {
    res.status(400).json({ success: false, error: 'Passwords do not match.' });
    return;
  }

  try {
    const user = await createUser({
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

    console.log('[AUTH OK]', user.username, 'registered');
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
