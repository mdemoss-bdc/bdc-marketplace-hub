/**
 * GET /api/auth/smtp-verify
 * Runs Nodemailer transporter.verify() and returns diagnostics JSON.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const {
  verifyMailTransporter,
  smtpConfigured,
  getSmtpConfig,
} = require('../../_lib/mailer');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  const cfg = getSmtpConfig();
  const verified = await verifyMailTransporter();
  res.status(verified.ok ? 200 : 502).json({
    success: verified.ok,
    smtp_configured: smtpConfigured(),
    config: {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.auth?.user || '',
    },
    error: verified.error || undefined,
    message: verified.ok
      ? 'Nodemailer SMTP verify succeeded.'
      : verified.error || 'Nodemailer SMTP verify failed.',
  });
};
