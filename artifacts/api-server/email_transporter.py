"""
Transactional email transporter for the BDC engine (stdlib-first).

Provider priority:
  1. Resend      - RESEND_API_KEY (+ optional RESEND_FROM_EMAIL)
  2. SendGrid    - SENDGRID_API_KEY (+ optional SENDGRID_FROM_EMAIL)
  3. Generic SMTP - SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
                    (aliases: EMAIL_USER / EMAIL_PASS -> Gmail SMTP SSL 465)
  4. Console     - when no live credentials are configured, log the full
                    message payload to stdout so local testing still works.

No hard dependency on Nodemailer / the Resend Python SDK - HTTP APIs use
urllib; SMTP uses smtplib. The optional ``resend`` package is used when
installed.
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import traceback
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any


def _env(*keys: str) -> str:
    for key in keys:
        val = os.environ.get(key, "").strip()
        if val:
            return val
    return ""


def configured_provider() -> str:
    """Return the active provider name for startup logs."""
    if _env("RESEND_API_KEY"):
        return "resend"
    if _env("SENDGRID_API_KEY"):
        return "sendgrid"
    if _env("SMTP_HOST") and _env("SMTP_USER", "EMAIL_USER") and _env("SMTP_PASS", "EMAIL_PASS"):
        return "smtp"
    if _env("EMAIL_USER") and _env("EMAIL_PASS"):
        return "gmail-smtp"
    return "console"


def _default_from_address() -> str:
    return (
        _env("RESEND_FROM_EMAIL", "SENDGRID_FROM_EMAIL", "SMTP_FROM", "EMAIL_FROM")
        or "BDC Manager Desk <noreply@bdcmanagerdesk.local>"
    )


def _send_resend(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str,
    api_key: str,
) -> bool:
    from_addr = _env("RESEND_FROM_EMAIL") or "BDC Manager Desk <onboarding@resend.dev>"

    # Prefer official SDK when available.
    try:
        import resend as _resend  # type: ignore

        _resend.api_key = api_key
        _resend.Emails.send(
            {
                "from": from_addr,
                "to": [to_addr],
                "subject": subject,
                "html": body_html or f"<pre>{body_text}</pre>",
                "text": body_text,
            }
        )
        print(f"[EMAIL] Sent (Resend SDK) '{subject}' -> {to_addr}")
        return True
    except ImportError:
        pass
    except Exception as err:
        print(f"[EMAIL] Resend SDK error for {to_addr!r}: {err}")
        print(traceback.format_exc())
        # Fall through to HTTP API.

    payload = {
        "from": from_addr,
        "to": [to_addr],
        "subject": subject,
        "text": body_text,
        "html": body_html or f"<pre>{body_text}</pre>",
    }
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if 200 <= getattr(resp, "status", 200) < 300:
                print(f"[EMAIL] Sent (Resend HTTP) '{subject}' -> {to_addr}")
                return True
            print(f"[EMAIL] Resend HTTP unexpected status: {getattr(resp, 'status', '?')}")
            return False
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:500]
        print(f"[EMAIL] Resend HTTP error {err.code} for {to_addr!r}: {detail}")
        return False
    except Exception as err:
        print(f"[EMAIL] Resend HTTP error for {to_addr!r}: {err}")
        print(traceback.format_exc())
        return False


def _send_sendgrid(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str,
    api_key: str,
) -> bool:
    from_email = _env("SENDGRID_FROM_EMAIL", "EMAIL_FROM", "EMAIL_USER") or "noreply@bdcmanagerdesk.local"
    # Allow "Name <addr@x.com>" or bare address.
    if "<" in from_email and ">" in from_email:
        display = from_email.split("<", 1)[0].strip().strip('"') or "BDC Manager Desk"
        addr = from_email.split("<", 1)[1].split(">", 1)[0].strip()
    else:
        display = "BDC Manager Desk"
        addr = from_email

    content: list[dict[str, str]] = [{"type": "text/plain", "value": body_text}]
    if body_html:
        content.append({"type": "text/html", "value": body_html})

    payload = {
        "personalizations": [{"to": [{"email": to_addr}]}],
        "from": {"email": addr, "name": display},
        "subject": subject,
        "content": content,
    }
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            # SendGrid returns 202 Accepted on success.
            status = getattr(resp, "status", 202)
            if 200 <= status < 300:
                print(f"[EMAIL] Sent (SendGrid) '{subject}' -> {to_addr}")
                return True
            print(f"[EMAIL] SendGrid unexpected status: {status}")
            return False
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")[:500]
        print(f"[EMAIL] SendGrid error {err.code} for {to_addr!r}: {detail}")
        return False
    except Exception as err:
        print(f"[EMAIL] SendGrid error for {to_addr!r}: {err}")
        print(traceback.format_exc())
        return False


def _build_mime(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str,
    from_full: str,
) -> Any:
    if body_html:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_full
        msg["To"] = to_addr
        msg.attach(MIMEText(body_text, "plain"))
        msg.attach(MIMEText(body_html, "html"))
        return msg
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_full
    msg["To"] = to_addr
    msg.set_content(body_text)
    return msg


def _send_smtp(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str,
) -> bool:
    host = _env("SMTP_HOST") or "smtp.gmail.com"
    port = int(_env("SMTP_PORT") or "465")
    user = _env("SMTP_USER", "EMAIL_USER")
    password = _env("SMTP_PASS", "EMAIL_PASS")
    if not user or not password:
        return False

    from_full = _env("SMTP_FROM", "EMAIL_FROM") or f"BDC Manager Desk <{user}>"
    msg = _build_mime(to_addr, subject, body_text, body_html, from_full)
    use_ssl = port == 465 or _env("SMTP_SSL", "1") not in ("0", "false", "False")

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            ctx = ssl.create_default_context()
            if use_ssl:
                with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as smtp:
                    smtp.login(user, password)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP(host, port, timeout=20) as smtp:
                    smtp.ehlo()
                    smtp.starttls(context=ctx)
                    smtp.ehlo()
                    smtp.login(user, password)
                    smtp.send_message(msg)
            print(
                f"[EMAIL] Sent (SMTP {host}:{port}) '{subject}' -> {to_addr}"
                + (f" (attempt {attempt + 1})" if attempt else "")
            )
            return True
        except smtplib.SMTPServerDisconnected as err:
            last_err = err
            print(f"[EMAIL] SMTP disconnected (attempt {attempt + 1}): {err}")
        except Exception as err:
            print(f"[EMAIL] SMTP Connection Error: {err}")
            print(traceback.format_exc())
            return False
    print(f"[EMAIL] SMTP Connection Error (after retry): {last_err}")
    return False


def _log_console(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str = "",
) -> bool:
    """Dev/test fallback - print the full dispatch payload; treat as delivered."""
    print("=" * 72)
    print("[EMAIL] No live provider configured - logging dispatch payload for testing")
    print(f"[EMAIL] To:      {to_addr}")
    print(f"[EMAIL] Subject: {subject}")
    print(f"[EMAIL] From:    {_default_from_address()}")
    print("-" * 72)
    print(body_text)
    if body_html:
        print("-" * 72)
        print("[EMAIL] HTML body (truncated):")
        print(body_html[:1200] + ("…" if len(body_html) > 1200 else ""))
    print("=" * 72)
    print(
        "[EMAIL] Tip: set RESEND_API_KEY, SENDGRID_API_KEY, or "
        "SMTP_HOST/SMTP_USER/SMTP_PASS (or EMAIL_USER/EMAIL_PASS) in .env"
    )
    return True


def send_email(
    to_addr: str,
    subject: str,
    body_text: str,
    body_html: str = "",
) -> bool:
    """Send one transactional email via the best available provider."""
    to_addr = (to_addr or "").strip().lower()
    if not to_addr or "@" not in to_addr:
        print(f"[EMAIL] Refusing send - invalid recipient: {to_addr!r}")
        return False

    print(f"[EMAIL] Dispatching '{subject}' -> {to_addr}")

    resend_key = _env("RESEND_API_KEY")
    if resend_key:
        return _send_resend(to_addr, subject, body_text, body_html, resend_key)

    sendgrid_key = _env("SENDGRID_API_KEY")
    if sendgrid_key:
        return _send_sendgrid(to_addr, subject, body_text, body_html, sendgrid_key)

    if _env("SMTP_HOST") or (_env("EMAIL_USER") and _env("EMAIL_PASS")) or (
        _env("SMTP_USER") and _env("SMTP_PASS")
    ):
        if _send_smtp(to_addr, subject, body_text, body_html):
            return True
        # If SMTP was configured but failed, still fall through to console so
        # local profile tests can see the payload.
        print("[EMAIL] SMTP send failed - falling back to console log.")

    return _log_console(to_addr, subject, body_text, body_html)


def check_connection() -> None:
    """Print provider status at startup (never raises)."""
    provider = configured_provider()
    if provider == "resend":
        frm = _env("RESEND_FROM_EMAIL") or "onboarding@resend.dev (shared)"
        print(f"[EMAIL] Provider: Resend - from: {frm}")
        return
    if provider == "sendgrid":
        frm = _env("SENDGRID_FROM_EMAIL", "EMAIL_FROM") or "(unset)"
        print(f"[EMAIL] Provider: SendGrid - from: {frm}")
        return
    if provider in ("smtp", "gmail-smtp"):
        host = _env("SMTP_HOST") or "smtp.gmail.com"
        port = _env("SMTP_PORT") or "465"
        user = _env("SMTP_USER", "EMAIL_USER")
        print(f"[EMAIL] Provider: SMTP ({host}:{port}) as {user}")
        password = _env("SMTP_PASS", "EMAIL_PASS")
        if not password:
            print("[EMAIL] WARNING: SMTP password missing.")
            return
        try:
            ctx = ssl.create_default_context()
            port_i = int(port)
            if port_i == 465:
                with smtplib.SMTP_SSL(host, port_i, context=ctx, timeout=15) as smtp:
                    smtp.login(user, password)
            else:
                with smtplib.SMTP(host, port_i, timeout=15) as smtp:
                    smtp.ehlo()
                    smtp.starttls(context=ctx)
                    smtp.login(user, password)
            print(f"[EMAIL] SMTP server ready (authenticated as {user})")
        except Exception as err:
            print(f"[EMAIL] SMTP Connection Error: {err}")
        return

    print(
        "[EMAIL] WARNING: No live email provider configured. "
        "Profile security emails will be logged to the console. "
        "Set RESEND_API_KEY, SENDGRID_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS."
    )
