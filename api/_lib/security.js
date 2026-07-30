/**
 * Helmet-like security headers for auth/API responses.
 */

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
}

module.exports = {
  applySecurityHeaders,
};
