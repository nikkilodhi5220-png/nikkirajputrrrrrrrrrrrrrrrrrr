import os
import re
import ssl
import json
import hmac
import html
import random
import smtplib
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, formatdate
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import (
    Flask,
    request,
    render_template,
    redirect,
    url_for,
    jsonify,
    session,
    Response,
    stream_with_context,
)

BASE_DIR = Path(__file__).resolve().parent.parent
app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)
handler = app

SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "").strip()
TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "").strip()
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()

if len(SESSION_SECRET) < 32:
    raise RuntimeError("Set SESSION_SECRET to a random value of at least 32 characters.")
if not LOGIN_PASSWORD:
    raise RuntimeError("Set LOGIN_PASSWORD in Vercel.")

app.secret_key = SESSION_SECRET
app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1_000_000,
)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20
MAX_RECIPIENTS = 25
MAX_WORKERS = 4
SEND_DELAY_SECONDS = 0

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)
SPINTAX_RE = re.compile(r"\{([^{}]+)\}")


def clean(value, limit=250):
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()[:limit]


def valid_email(value):
    if not isinstance(value, str):
        return False
    addr = value.strip()
    return len(addr) <= 254 and bool(EMAIL_RE.fullmatch(addr))


def logged_in():
    return session.get("authenticated") is True


def error(message, status=400):
    return jsonify({"success": False, "message": message}), status


def event_line(data):
    return json.dumps(data, ensure_ascii=False) + "\n"


def html_to_text(value):
    text = str(value or "")
    text = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", text)
    text = re.sub(r"(?i)</\s*(p|div|li|h[1-6])\s*>", "\n", text)
    text = re.sub(r"<[^>]*>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def apply_spintax(text):
    result = str(text or "")
    for _ in range(30):
        match = SPINTAX_RE.search(result)
        if not match:
            break
        choices = [c.strip() for c in match.group(1).split("|")]
        picked = random.choice(choices) if choices else ""
        result = result[: match.start()] + picked + result[match.end() :]
    return result.replace("{", "").replace("}", "")


def normalize_recipient(item):
    if isinstance(item, str):
        item = {"email": item}
    if not isinstance(item, dict):
        return None
    address = str(item.get("email", "")).strip().lower()
    if not valid_email(address):
        return None
    return {
        "email": address,
        **{
            k: clean(item.get(k, ""), 150)
            for k in ("name", "hi", "hello", "thanks", "ref_code")
        },
    }


def personalize(value, recipient):
    result = apply_spintax(str(value or ""))
    for key in ("hi", "hello", "thanks", "name", "email", "ref_code"):
        result = result.replace("{{" + key + "}}", recipient.get(key, ""))
    return result


def verify_turnstile(token, remote_ip=None):
    if not TURNSTILE_SECRET_KEY:
        return True, None
    if not token:
        return False, "Cloudflare verification is required."

    payload = {"secret": TURNSTILE_SECRET_KEY, "response": token}
    if remote_ip:
        payload["remoteip"] = remote_ip

    encoded = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        if result.get("success") is True:
            return True, None
        return False, "Cloudflare verification failed."
    except Exception:
        return False, "Unable to verify Cloudflare."


def build_message(gmail_clean, domain, sender_name, subject, body, is_html, recipient):
    msg = EmailMessage()
    msg["Subject"] = clean(personalize(subject, recipient), 250)
    msg["From"] = formataddr((clean(sender_name), gmail_clean))
    msg["To"] = recipient["email"]
    msg["Reply-To"] = gmail_clean
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain)
    msg["List-Unsubscribe"] = f"<mailto:{gmail_clean}?subject=unsubscribe>"

    content = personalize(body, recipient)
    if is_html:
        plain_fallback = (
            html_to_text(content)
            or "Please view this email in an HTML-capable email client."
        )
        msg.set_content(plain_fallback)
        msg.add_alternative(content, subtype="html")
    else:
        msg.set_content(content)

    return msg


def send_chunk(gmail, app_password, sender_name, subject, body, is_html, chunk):
    gmail_clean = gmail.strip().lower()
    domain = gmail_clean.split("@", 1)[1] if "@" in gmail_clean else "gmail.com"
    clean_pass = re.sub(r"\s+", "", str(app_password or ""))
    outcomes = []

    try:
        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            context=ssl.create_default_context(),
            timeout=SMTP_TIMEOUT,
        ) as smtp:
            smtp.ehlo()
            smtp.login(gmail_clean, clean_pass)

            for recipient in chunk:
                try:
                    msg = build_message(
                        gmail_clean,
                        domain,
                        sender_name,
                        subject,
                        body,
                        is_html,
                        recipient,
                    )
                    refused = smtp.send_message(
                        msg, from_addr=gmail_clean, to_addrs=[recipient["email"]]
                    )
                    if refused:
                        outcomes.append(
                            (recipient["email"], "failed", "Gmail refused this recipient.")
                        )
                    else:
                        outcomes.append((recipient["email"], "sent", None))
                except smtplib.SMTPRecipientsRefused:
                    outcomes.append(
                        (recipient["email"], "failed", "Gmail refused this recipient.")
                    )
                except smtplib.SMTPResponseException as exc:
                    outcomes.append(
                        (
                            recipient["email"],
                            "failed",
                            f"SMTP error {exc.smtp_code}: {str(exc.smtp_error)[:200]}",
                        )
                    )
                except (smtplib.SMTPException, TimeoutError, OSError) as exc:
                    outcomes.append(
                        (
                            recipient["email"],
                            "failed",
                            f"SMTP/network error: {str(exc)[:200]}",
                        )
                    )
                except Exception:
                    outcomes.append(
                        (
                            recipient["email"],
                            "failed",
                            "Unexpected error. Check Vercel logs.",
                        )
                    )
    except smtplib.SMTPAuthenticationError:
        for recipient in chunk:
            outcomes.append(
                (
                    recipient["email"],
                    "failed",
                    "Gmail authentication failed. Check address and App Password.",
                )
            )
    except (smtplib.SMTPException, TimeoutError, OSError) as exc:
        for recipient in chunk:
            outcomes.append(
                (
                    recipient["email"],
                    "failed",
                    f"SMTP/network error: {str(exc)[:200]}",
                )
            )
    except Exception:
        for recipient in chunk:
            outcomes.append(
                (
                    recipient["email"],
                    "failed",
                    "Unexpected error. Check Vercel logs.",
                )
            )

    return outcomes


@app.route("/login", methods=["GET", "POST"])
def login():
    if logged_in():
        return redirect(url_for("home"))
    if request.method == "GET":
        return render_template("login.html", error=None, turnstile_site_key=TURNSTILE_SITE_KEY)
    if not hmac.compare_digest(str(request.form.get("password", "")), LOGIN_PASSWORD):
        return (
            render_template(
                "login.html",
                error="Incorrect password.",
                turnstile_site_key=TURNSTILE_SITE_KEY,
            ),
            401,
        )
    session.clear()
    session.permanent = True
    session["authenticated"] = True
    return redirect(url_for("home"))


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
def home():
    if not logged_in():
        return redirect(url_for("login"))
    return render_template("index.html", turnstile_site_key=TURNSTILE_SITE_KEY)


@app.route("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "smtp": "Gmail SMTP",
            "max_recipients": MAX_RECIPIENTS,
            "send_delay_seconds": SEND_DELAY_SECONDS,
        }
    )


@app.route("/favicon.ico")
def favicon():
    return Response("", status=204)


@app.route("/sw.js")
def sw():
    return Response("", mimetype="application/javascript")


@app.route("/send-batch", methods=["POST"])
def send_batch():
    if not logged_in():
        return (
            jsonify(
                {
                    "success": False,
                    "message": "Please log in again.",
                    "login_required": True,
                }
            ),
            401,
        )

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return error("Invalid JSON request.")

    sender_name = clean(data.get("sender_name", ""))
    gmail = clean(data.get("gmail", ""), 254).lower()
    password = str(data.get("app_password", "")).strip()
    subject = clean(data.get("subject", ""), 250)
    body = str(data.get("body", ""))
    is_html = data.get("is_html") is True
    incoming = data.get("recipients", [])
    turnstile_token = str(data.get("turnstile_token", "")).strip()

    if not sender_name or not valid_email(gmail) or not gmail.endswith("@gmail.com"):
        return error("Enter a sender name and valid @gmail.com address.")
    if not password or not subject or not body.strip():
        return error("App Password, subject and body are required.")
    if len(body) > 100_000:
        return error("Email body is too large.")
    if not isinstance(incoming, list):
        return error("Recipients must be a list.")

    forwarded_for = request.headers.get("X-Forwarded-For")
    remote_ip = forwarded_for.split(",", 1)[0].strip() if forwarded_for else request.remote_addr
    verified, verify_error = verify_turnstile(turnstile_token, remote_ip)
    if not verified:
        return error(verify_error, 403)

    recipients, seen, invalid = [], set(), 0
    for item in incoming:
        r = normalize_recipient(item)
        if not r:
            invalid += 1
        elif r["email"] not in seen:
            seen.add(r["email"])
            recipients.append(r)

    if not recipients:
        return error("No valid recipients found.")
    if len(recipients) > MAX_RECIPIENTS:
        return error(f"Maximum {MAX_RECIPIENTS} unique recipients per batch.")

    @stream_with_context
    def generate():
        total, sent, failed = len(recipients), 0, 0
        yield event_line(
            {
                "type": "start",
                "total": total,
                "sent": 0,
                "failed": 0,
                "remaining": total,
                "invalid_skipped": invalid,
            }
        )

        worker_count = min(MAX_WORKERS, total)
        chunks = [recipients[i::worker_count] for i in range(worker_count)]
        chunks = [c for c in chunks if c]

        with ThreadPoolExecutor(max_workers=len(chunks)) as pool:
            futures = [
                pool.submit(
                    send_chunk,
                    gmail,
                    password,
                    sender_name,
                    subject,
                    body,
                    is_html,
                    chunk,
                )
                for chunk in chunks
            ]
            for future in as_completed(futures):
                try:
                    chunk_results = future.result()
                except Exception:
                    chunk_results = []

                for addr, status, err_msg in chunk_results:
                    if status == "sent":
                        sent += 1
                        item = {"type": "progress", "recipient": addr, "result": "sent"}
                    else:
                        failed += 1
                        item = {
                            "type": "progress",
                            "recipient": addr,
                            "result": "failed",
                            "error": err_msg or "Unexpected error. Check Vercel logs.",
                        }
                    item.update(
                        {
                            "total": total,
                            "sent": sent,
                            "failed": failed,
                            "remaining": total - sent - failed,
                        }
                    )
                    yield event_line(item)

        yield event_line(
            {
                "type": "complete",
                "success": failed == 0,
                "message": "Sending attempt finished.",
                "total": total,
                "sent": sent,
                "failed": failed,
                "remaining": 0,
            }
        )

    response = Response(generate(), content_type="application/x-ndjson; charset=utf-8")
    response.headers["Cache-Control"] = "no-store, no-cache, no-transform"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Accel-Buffering"] = "no"
    return response


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
