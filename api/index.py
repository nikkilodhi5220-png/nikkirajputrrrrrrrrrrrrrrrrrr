def send_one(smtp, gmail, sender_name, subject, body, is_html, recipient):
    msg = EmailMessage()
    # Subject me spam words jaise FREE, WINNER, !!! mat use karo
    msg["Subject"] = clean(personalize(subject, recipient), 250)
    msg["From"] = formataddr((clean(sender_name), gmail))
    msg["To"] = recipient["email"]
    msg["Reply-To"] = gmail
    msg["Date"] = formatdate(localtime=True)
    # Gmail ke domain se Message-ID banao, random nahi
    msg["Message-ID"] = make_msgid(domain="gmail.com")
    # Ye 2 header inbox ke liye bahut important hai
    msg["List-Unsubscribe"] = f"<mailto:{gmail}?subject=unsubscribe>"
    msg["X-Mailer"] = "MyApp-Mailer"

    content = personalize(body, recipient)
    if is_html:
        msg.set_content(html_to_text(content) or "Please view this email in an HTML-capable email client.")
        msg.add_alternative(content, subtype="html")
    else:
        msg.set_content(content)

    refused = smtp.send_message(msg, from_addr=gmail, to_addrs=[recipient["email"]])
    if refused:
        raise smtplib.SMTPRecipientsRefused(refused)

# send_batch ke andar generate() ko isse replace karo
def generate():
    total, sent, failed = len(recipients), 0, 0
    yield event_line({"type":"start","total":total,"sent":0,"failed":0,"remaining":total,"invalid_skipped":invalid})

    # Ek hi connection, ek-ek karke bhejo - Vercel par yahi stable hai
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=SMTP_TIMEOUT) as smtp:
            smtp.ehlo()
            smtp.login(gmail, re.sub(r"\s+", "", password))
            for r in recipients:
                try:
                    send_one(smtp, gmail, password, sender_name, subject, body, is_html, r)
                    sent += 1
                    item = {"type":"progress","recipient":r["email"],"result":"sent"}
                except Exception as exc:
                    failed += 1
                    item = {"type":"progress","recipient":r["email"],"result":"failed","error":str(exc)[:200]}
                item.update({"total":total,"sent":sent,"failed":failed,"remaining":total-sent-failed})
                yield event_line(item)
                time.sleep(2) # Gmail ko human jaisa lagne ke liye 2 sec gap
    except smtplib.SMTPAuthenticationError:
        yield event_line({"type":"progress","recipient":"all","result":"failed","error":"Gmail authentication failed. App Password check karo."})

    yield event_line({"type":"complete","success":failed==0,"message":"Sending attempt finished. SMTP acceptance does not prove Inbox delivery.","total":total,"sent":sent,"failed":failed,"remaining":0})
