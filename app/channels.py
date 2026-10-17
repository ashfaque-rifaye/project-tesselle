"""Outreach channels the agents use on the customer's behalf: email from the customer's connected
inbox (send + read replies + find order confirmations) and phone calls by the voice agent (Twilio).

Credentials never live in the repo or the image. They are read at runtime from Secret Manager
(created by the owner with tools/setup_channels.ps1) and cached briefly:
  tesselle-mail       {"address": "...@gmail.com", "app_password": "...", "name": "optional sender name"}
  tesselle-twilio     {"account_sid": "AC...", "auth_token": "...", "from_number": "+1..."}
  tesselle-owner-key  a random passphrase; actions that use the owner's inbox or phone line need it.
Until a secret exists the matching channel reports itself as not connected and the UI says so.
"""

from __future__ import annotations

import asyncio
import base64
import email
import email.utils
import hashlib
import hmac
import imaplib
import json
import logging
import re
import smtplib
import time
from email.header import decode_header, make_header
from email.message import EmailMessage
from typing import Any, Optional
from xml.sax.saxutils import escape

import httpx

from . import config, identity

log = logging.getLogger(__name__)

_cache: dict[str, tuple[float, Optional[str]]] = {}


def _token() -> str:
    import google.auth
    import google.auth.transport.requests

    creds = identity.credentials()
    if creds is None:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


async def secret(name: str) -> Optional[str]:
    """Latest version of a Secret Manager secret (None if it doesn't exist or can't be read)."""
    hit = _cache.get(name)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    value: Optional[str] = None
    try:
        tok = await asyncio.to_thread(_token)
        async with httpx.AsyncClient(timeout=6) as h:
            r = await h.get(f"https://secretmanager.googleapis.com/v1/projects/{config.PROJECT}/secrets/{name}/versions/latest:access",
                            headers={"Authorization": f"Bearer {tok}"})
        if r.status_code == 200:
            value = base64.b64decode(r.json()["payload"]["data"]).decode("utf-8").strip()
    except Exception as e:
        log.info("secret %s unavailable: %s", name, type(e).__name__)
    _cache[name] = (time.time(), value)
    return value


async def _json_secret(name: str) -> Optional[dict[str, Any]]:
    raw = await secret(name)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        log.warning("secret %s is not valid JSON", name)
        return None


async def is_owner(key: Optional[str]) -> bool:
    expected = await secret("tesselle-owner-key")
    return bool(expected and key and hmac.compare_digest(expected.strip(), key.strip()))


async def status() -> dict[str, Any]:
    mail = await _json_secret("tesselle-mail")
    tw = await _json_secret("tesselle-twilio")
    return {"email": bool(mail and mail.get("address") and mail.get("app_password")),
            "email_address": _mask(mail.get("address")) if mail else None,
            "calls": bool(tw and tw.get("account_sid") and tw.get("auth_token") and tw.get("from_number")),
            "owner_key_set": bool(await secret("tesselle-owner-key"))}


def _mask(addr: Optional[str]) -> Optional[str]:
    if not addr or "@" not in addr:
        return None
    user, dom = addr.split("@", 1)
    return user[:2] + "***@" + dom


# ---- Email ------------------------------------------------------------------------------------


async def send_email(to: str, subject: str, body: str, attachments: list[tuple[str, bytes, str]]) -> str:
    """Send from the connected inbox (Gmail SMTP with an app password). Returns the Message-ID."""
    cfg = await _json_secret("tesselle-mail")
    if not cfg:
        raise RuntimeError("Email isn't connected yet.")
    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((cfg.get("name") or "Tesselle shopping agent", cfg["address"]))
    msg["To"] = to
    msg["Subject"] = subject
    mid = email.utils.make_msgid(domain="tesselle.agent")
    msg["Message-ID"] = mid
    msg.set_content(body)
    for name, data, mime in attachments:
        maintype, _, subtype = mime.partition("/")
        msg.add_attachment(data, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=name)

    def _send() -> None:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
            s.login(cfg["address"], cfg["app_password"].replace(" ", ""))
            s.send_message(msg)

    await asyncio.to_thread(_send)
    return mid


def _decode(v: Optional[str]) -> str:
    try:
        return str(make_header(decode_header(v or "")))
    except Exception:
        return v or ""


def _parse(raw: bytes) -> dict[str, Any]:
    m = email.message_from_bytes(raw)
    text, html, images = "", "", []
    for part in m.walk():
        ctype = part.get_content_type()
        disp = (part.get("Content-Disposition") or "").lower()
        if ctype == "text/plain" and "attachment" not in disp and not text:
            text = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
        elif ctype == "text/html" and "attachment" not in disp and not html:
            html = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
        elif ctype.startswith("image/") or ctype == "application/pdf":
            data = part.get_payload(decode=True)
            if data and len(data) < 8_000_000 and len(images) < 3:
                images.append((data, ctype))
    if not text and html:
        text = re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style).*?</\1>", " ", html))
        text = re.sub(r"\s+", " ", text)
    # Drop the quoted original below the reply.
    text = re.split(r"\n\s*On .{5,120}wrote:\s*\n|\n-----Original Message-----", text)[0]
    return {"from": _decode(m.get("From")), "subject": _decode(m.get("Subject")), "date": m.get("Date"),
            "message_id": m.get("Message-ID"), "in_reply_to": m.get("In-Reply-To") or "", "references": m.get("References") or "",
            "text": text.strip()[:12000], "files": images}


async def _imap(query: str, limit: int = 20) -> list[dict[str, Any]]:
    cfg = await _json_secret("tesselle-mail")
    if not cfg:
        raise RuntimeError("Email isn't connected yet.")

    def _run() -> list[dict[str, Any]]:
        out = []
        with imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30) as im:
            im.login(cfg["address"], cfg["app_password"].replace(" ", ""))
            im.select('"[Gmail]/All Mail"', readonly=True)
            typ, data = im.search(None, "X-GM-RAW", f'"{query}"')
            ids = (data[0].split() if typ == "OK" and data and data[0] else [])[-limit:]
            for i in reversed(ids):
                typ, msg = im.fetch(i, "(RFC822)")
                if typ == "OK" and msg and isinstance(msg[0], tuple):
                    out.append(_parse(msg[0][1]))
        return out

    return await asyncio.to_thread(_run)


async def find_replies(ref: str, since_days: int = 30) -> list[dict[str, Any]]:
    """Replies to messages Tesselle sent, matched by the reference in the subject."""
    return [m for m in await _imap(f"subject:{ref} newer_than:{since_days}d -in:sent", 20)
            if "tesselle.agent" not in (m.get("message_id") or "")]


ORDER_SENDERS = ("amazon.in", "flipkart.com", "myntra.com", "nykaa.com", "ikea.in", "ikea.com", "pepperfry.com", "urbanladder.com",
                 "ajio.com", "croma.com", "tatacliq.com", "meesho.com", "firstcry.com", "jiomart.com", "shopify.com", "snapdeal.com")


async def find_order_emails(days: int = 120, limit: int = 25) -> list[dict[str, Any]]:
    senders = " OR ".join(f"from:{d}" for d in ORDER_SENDERS)
    return await _imap(f"({senders}) (subject:order OR subject:ordered OR subject:shipped OR subject:delivered) newer_than:{days}d", limit)


# ---- Phone calls (Twilio Programmable Voice) ----------------------------------------------------

VOICE = "Google.en-IN-Neural2-A"


async def twilio() -> Optional[dict[str, Any]]:
    return await _json_secret("tesselle-twilio")


async def start_call(to: str, call_id: str, base_url: str) -> str:
    cfg = await twilio()
    if not cfg:
        raise RuntimeError("Calling isn't connected yet.")
    async with httpx.AsyncClient(timeout=15, auth=(cfg["account_sid"], cfg["auth_token"])) as h:
        r = await h.post(f"https://api.twilio.com/2010-04-01/Accounts/{cfg['account_sid']}/Calls.json", data={
            "To": to, "From": cfg["from_number"], "Url": f"{base_url}/api/calls/{call_id}/voice", "Method": "POST",
            "StatusCallback": f"{base_url}/api/calls/{call_id}/status", "StatusCallbackMethod": "POST",
            "StatusCallbackEvent": "completed", "Timeout": "30",
        })
    if r.status_code >= 300:
        raise RuntimeError(f"Twilio refused the call: {r.json().get('message', r.text)[:200]}")
    return r.json()["sid"]


async def valid_signature(url: str, params: dict[str, str], signature: str) -> bool:
    cfg = await twilio()
    if not cfg:
        return False
    data = url + "".join(k + params[k] for k in sorted(params))
    digest = base64.b64encode(hmac.new(cfg["auth_token"].encode(), data.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(digest, signature or "")


def twiml_say_gather(say: str, action: str, hints: str = "") -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?><Response>'
            f'<Gather input="speech" action="{escape(action)}" method="POST" speechTimeout="auto" language="en-IN" '
            f'actionOnEmptyResult="true" hints="{escape(hints)}"><Say voice="{VOICE}">{escape(say)}</Say></Gather>'
            f'<Redirect method="POST">{escape(action)}</Redirect></Response>')


def twiml_say_hangup(say: str) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="{VOICE}">{escape(say)}</Say><Hangup/></Response>'


def normalise_phone(raw: str) -> Optional[str]:
    """Indian numbers in E.164: '098400 12345' -> '+919840012345'."""
    d = re.sub(r"[^\d+]", "", raw or "")
    if d.startswith("+"):
        return d if 10 <= len(d) <= 16 else None
    d = d.lstrip("0")
    if len(d) == 10:
        return "+91" + d
    if len(d) == 12 and d.startswith("91"):
        return "+" + d
    return None
