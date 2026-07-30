/**
 * GET/PUT/POST /api/users/me
 * Read or update the authenticated user's profile (phone, email).
 * Email changes dispatch Nodemailer SMTP security notifications.
 */
const {
  getUserByUsername,
  updateProfile,
} = require('../../_lib/db');
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody, requireAuthUser } = require('../../_lib/http');
const {
  dispatchEmailChangeNotifications,
  verifyMailTransporter,
  smtpConfigured,
} = require('../../_lib/mailer');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const user = requireAuthUser(req, res, getUserByUsername);
  if (!user) return;

  if (req.method === 'GET') {
    // Optional diagnostics: ?verify_smtp=1
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.searchParams.get('verify_smtp') === '1') {
      const verified = await verifyMailTransporter();
      res.status(verified.ok ? 200 : 502).json({
        success: verified.ok,
        smtp_configured: smtpConfigured(),
        verify: verified,
        user,
        phone: user.phone || '',
      });
      return;
    }
    res.status(200).json({ success: true, user, phone: user.phone || '' });
    return;
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.', success: false });
    return;
  }

  const body = parseBody(req);
  try {
    const { user: updated, emailChange } = updateProfile(user.id, {
      phone: body.phone,
      email: body.email,
      new_email: body.new_email,
      current_password: body.current_password,
    });

    if (emailChange) {
      const notify = await dispatchEmailChangeNotifications({
        userId: updated.id,
        newEmail: emailChange.new_email,
        oldEmail: emailChange.old_email,
        revertToken: emailChange.revert_token,
      });
      if (!notify.confirm_sent || notify.error) {
        res.status(502).json({
          success: false,
          error: notify.error || 'Email notification failed.',
          email_delivery_failed: true,
          user: updated,
          message:
            'Email address was saved, but notification delivery failed. See error for SMTP details.',
        });
        return;
      }
      res.status(200).json({
        success: true,
        user: updated,
        message:
          'Email updated. A security alert was sent to your previous address with an emergency revert link.',
        notify: {
          alert_sent: notify.alert_sent,
          confirm_sent: notify.confirm_sent,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      user: updated,
      message: 'Phone number saved.',
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update profile.',
    });
  }
};
