import 'dotenv/config';
import express from 'express';
import { Resend } from 'resend';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// Initialize Resend Client
const resend = new Resend(RESEND_API_KEY);

// Express Middleware Setup
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   HELPER: SPINTAX PARSER ({Hi|Hello|Hey})
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;
  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

/* ==========================================================================
   HELPER: PLAIN-TEXT FALLBACK (Dual MIME for High Deliverability)
   ========================================================================== */
function convertHtmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   SSE STREAM ROUTE (HIGH-INBOX DELIVERABILITY VIA RESEND API)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { fromEmail, senderName, subject, messageBody, recipients } = req.body;

  // fromEmail MUST use your verified custom domain (e.g., hello@yourdomain.com)
  if (!fromEmail || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const formattedFrom = cleanSenderName ? `${cleanSenderName} <${fromEmail}>` : fromEmail;

  activeSessions['global_stop'] = false;

  for (let index = 0; index < recipients.length; index++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[index] ? recipients[index].trim() : "";
    if (!recipient) continue;

    res.write(': keep-alive\n\n');

    try {
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      const payload = {
        from: formattedFrom,
        to: recipient,
        subject: spunSubject,
        headers: {
          'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
        }
      };

      if (isHtml) {
        payload.html = spunBody;
        payload.text = convertHtmlToText(spunBody);
      } else {
        payload.text = spunBody;
      }

      // Send via Resend API
      const response = await resend.emails.send(payload);

      if (response.error) {
        throw new Error(response.error.message);
      }

      res.write(`data: ${JSON.stringify({ success: true, recipient, id: response.data.id })}\n\n`);

    } catch (error) {
      console.error(`Error sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Rate-limit safety pause between requests
    if (index < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  activeSessions['global_stop'] = true;
  res.json({ success: true, message: "Stop process registered" });
});

export default app;
