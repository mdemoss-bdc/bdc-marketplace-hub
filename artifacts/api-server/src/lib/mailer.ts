/**
 * Nodemailer SMTP transporter for BDC Manager Desk.
 *
 * Env (required for live SMTP):
 *   SMTP_HOST, SMTP_PORT (465|587), SMTP_USER, SMTP_PASS
 * Optional:
 *   SMTP_FROM / EMAIL_FROM
 * Aliases: EMAIL_USER / EMAIL_PASS
 *
 * Port 465 → secure:true (SSL). Port 587 → STARTTLS.
 * tls.rejectUnauthorized=false avoids serverless SSL handshake issues.
 */
import nodemailer from 'nodemailer';

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

let _transporter: nodemailer.Transporter | null = null;
let _verified = false;

function env(...keys: string[]): string {
  for (const key of keys) {
    const val = String(process.env[key] ?? '').trim();
    if (val) return val;
  }
  return '';
}

export function smtpConfigured(): boolean {
  const user = env('SMTP_USER', 'EMAIL_USER');
  const pass = env('SMTP_PASS', 'EMAIL_PASS');
  const host = env('SMTP_HOST') || (user && pass ? 'smtp.gmail.com' : '');
  return Boolean(host && user && pass);
}

export function getSmtpConfig(): nodemailer.TransportOptions {
  const port = Number(env('SMTP_PORT') || '465') || 465;
  const user = env('SMTP_USER', 'EMAIL_USER');
  const pass = env('SMTP_PASS', 'EMAIL_PASS');
  const host = env('SMTP_HOST') || 'smtp.gmail.com';
  const secure = String(process.env.SMTP_PORT || '465') === '465' || port === 465;

  return {
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  } as nodemailer.TransportOptions;
}

export function createMailTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport(getSmtpConfig());
  return _transporter;
}

/** Nodemailer transporter.verify() — call on boot or before first send. */
export async function verifyMailTransporter(): Promise<{
  ok: boolean;
  error?: string;
  config: { host: string; port: number; secure: boolean; user: string };
}> {
  const cfg = getSmtpConfig() as {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user?: string };
  };
  const summary = {
    host: String(cfg.host || ''),
    port: Number(cfg.port || 465),
    secure: Boolean(cfg.secure),
    user: String(cfg.auth?.user || ''),
  };

  if (!smtpConfigured()) {
    return {
      ok: false,
      error:
        'SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.',
      config: summary,
    };
  }

  try {
    const transporter = createMailTransporter();
    await transporter.verify();
    _verified = true;
    console.log(
      `[EMAIL] Nodemailer verify OK (${summary.host}:${summary.port} secure=${summary.secure} as ${summary.user})`,
    );
    return { ok: true, config: summary };
  } catch (err) {
    _verified = false;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] Nodemailer verify FAILED: ${message}`);
    return { ok: false, error: message, config: summary };
  }
}

export async function sendMail(
  input: SendMailInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const to = String(input.to || '')
    .trim()
    .toLowerCase();
  if (!to || !to.includes('@')) {
    return { ok: false, error: `Invalid recipient: ${input.to}` };
  }

  if (!smtpConfigured()) {
    console.log('='.repeat(72));
    console.log('[EMAIL] No SMTP credentials — logging dispatch payload');
    console.log(`[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${input.subject}`);
    console.log(input.text);
    console.log('='.repeat(72));
    return { ok: true };
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
      to,
      subject: input.subject,
      text: input.text,
      html: input.html || undefined,
    });
    console.log(
      `[EMAIL] Sent (Nodemailer) '${input.subject}' -> ${to} id=${info.messageId || '?'}`,
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EMAIL] sendMail FAILED -> ${to}: ${message}`);
    return { ok: false, error: message };
  }
}

export function resetMailerForTests(): void {
  _transporter = null;
  _verified = false;
}
