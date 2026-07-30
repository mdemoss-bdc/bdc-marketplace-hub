/**
 * Nodemailer SMTP transporter for Vercel serverless auth/profile routes.
 *
 * Env: SMTP_HOST, SMTP_PORT (465|587), SMTP_USER, SMTP_PASS
 * Aliases: EMAIL_USER / EMAIL_PASS
 * Optional: SMTP_FROM / EMAIL_FROM
 *
 * secure = (SMTP_PORT === '465'); tls.rejectUnauthorized = false
 */
const nodemailer = require('nodemailer');

let _transporter = null;
let _verified = false;
let _lastError = '';

function env(...keys) {
  for (const key of keys) {
    const val = String(process.env[key] ?? '').trim();
    if (val) return val;
  }
  return '';
}

function smtpConfigured() {
  const user = env('SMTP_USER', 'EMAIL_USER');
  const pass = env('SMTP_PASS', 'EMAIL_PASS');
  const host = env('SMTP_HOST') || (user && pass ? 'smtp.gmail.com' : '');
  return Boolean(host && user && pass);
}

function getSmtpConfig() {
  const portRaw = env('SMTP_PORT') || '465';
  const port = Number(portRaw) || 465;
  const user = env('SMTP_USER', 'EMAIL_USER');
  const pass = env('SMTP_PASS', 'EMAIL_PASS');
  const host = env('SMTP_HOST') || 'smtp.gmail.com';
  const secure = String(process.env.SMTP_PORT || '465') === '465' || port === 465;

  return {
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  };
}

function createMailTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport(getSmtpConfig());
  return _transporter;
}

async function verifyMailTransporter() {
  const cfg = getSmtpConfig();
  const summary = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.auth?.user || '',
  };

  if (!smtpConfigured()) {
    _lastError =
      'SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.';
    return { ok: false, error: _lastError, config: summary };
  }

  try {
    const transporter = createMailTransporter();
    await transporter.verify();
    _verified = true;
    _lastError = '';
    console.log(
      `[EMAIL] Nodemailer verify OK (${summary.host}:${summary.port} secure=${summary.secure} as ${summary.user})`,
    );
    return { ok: true, config: summary };
  } catch (err) {
    _verified = false;
    _lastError = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] Nodemailer verify FAILED: ${_lastError}`);
    return { ok: false, error: _lastError, config: summary };
  }
}

async function sendMail({ to, subject, text, html }) {
  const recipient = String(to || '')
    .trim()
    .toLowerCase();
  if (!recipient || !recipient.includes('@')) {
    _lastError = `Invalid recipient: ${to}`;
    return { ok: false, error: _lastError };
  }

  if (!smtpConfigured()) {
    console.log('='.repeat(72));
    console.log('[EMAIL] No SMTP credentials — logging dispatch payload');
    console.log(`[EMAIL] To: ${recipient}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(text);
    console.log('='.repeat(72));
    _lastError = '';
    return { ok: true, console: true };
  }

  const from =
    env('SMTP_FROM', 'EMAIL_FROM', 'RESEND_FROM_EMAIL') ||
    `BDC Manager Desk <${env('SMTP_USER', 'EMAIL_USER')}>`;

  try {
    if (!_verified) {
      const verified = await verifyMailTransporter();
      if (!verified.ok) {
        console.warn(
          `[EMAIL] verify failed (${verified.error}); attempting sendMail anyway`,
        );
      }
    }

    const transporter = createMailTransporter();
    const info = await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html: html || undefined,
    });
    console.log(
      `[EMAIL] Sent (Nodemailer) '${subject}' -> ${recipient} id=${info.messageId || '?'}`,
    );
    _lastError = '';
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    _lastError = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] sendMail FAILED -> ${recipient}: ${_lastError}`);
    return { ok: false, error: _lastError };
  }
}

function getAppBaseUrl() {
  return (
    env('APP_BASE_URL', 'VITE_APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL') ||
    'http://127.0.0.1:5173'
  ).replace(/\/$/, '');
}

/**
 * Security alert (old inbox) + confirmation (new inbox) for profile email change.
 */
async function dispatchEmailChangeNotifications({
  userId,
  newEmail,
  oldEmail,
  revertToken,
}) {
  const revertUrl = `${getAppBaseUrl()}/api/security/revert-email?token=${encodeURIComponent(revertToken)}`;
  const changedAt = new Date().toUTCString();

  const alertText =
    `SECURITY ALERT — BDC Manager Desk\n\n` +
    `The email address on your account was just changed.\n\n` +
    `Changed to:  ${newEmail}\n` +
    `Changed at:  ${changedAt}\n` +
    `Previous:    ${oldEmail || '(none)'}\n\n` +
    `If YOU authorized this change, no action is needed.\n\n` +
    `If you did NOT authorize this change, click the link below IMMEDIATELY\n` +
    `to lock your account and revert the email address:\n\n` +
    `  ${revertUrl}\n\n` +
    `This emergency link expires in 48 hours.\n\n` +
    `— The BDC Manager Desk Security Team`;

  const confirmText =
    `Hi,\n\n` +
    `Your BDC Manager Desk account email address was successfully updated.\n\n` +
    `New email: ${newEmail}\n` +
    `Changed:   ${changedAt}\n\n` +
    `If you did not make this change, contact support immediately.\n\n` +
    `— The BDC Manager Desk Team`;

  const errors = [];
  let alertSent = false;
  let confirmSent = false;

  if (oldEmail) {
    const alert = await sendMail({
      to: oldEmail,
      subject:
        'SECURITY ALERT: Email address changed on your BDC Manager Desk account',
      text: alertText,
      html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${alertText}</pre>`,
    });
    alertSent = Boolean(alert.ok);
    if (!alert.ok) errors.push(`alert: ${alert.error}`);
  }

  const confirm = await sendMail({
    to: newEmail,
    subject: 'Your BDC Manager Desk email address has been updated',
    text: confirmText,
    html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${confirmText}</pre>`,
  });
  confirmSent = Boolean(confirm.ok);
  if (!confirm.ok) errors.push(`confirm: ${confirm.error}`);

  return {
    alert_sent: alertSent,
    confirm_sent: confirmSent,
    revert_url: revertUrl,
    error: errors.length ? errors.join(' | ') : '',
    ok: confirmSent || (!oldEmail && confirmSent) || (alertSent && confirmSent),
  };
}

module.exports = {
  smtpConfigured,
  getSmtpConfig,
  createMailTransporter,
  verifyMailTransporter,
  sendMail,
  dispatchEmailChangeNotifications,
  getLastError: () => _lastError,
};
