/**
 * Shared request helpers for serverless profile/auth routes.
 */
function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  return body && typeof body === 'object' ? body : {};
}

function requireAuthUser(req, res, getUserByUsername) {
  const { verifyJwt, getTokenFromRequest } = require('./jwt');
  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token);
  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Authorization required.', success: false });
    return null;
  }
  const user = getUserByUsername(payload.sub);
  if (!user) {
    res.status(401).json({ error: 'Authorization required.', success: false });
    return null;
  }
  return user;
}

module.exports = {
  parseBody,
  requireAuthUser,
};
