import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '##';

// Express Middleware Setup
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   TRANSPORTER POOLING (TLS Socket & Port 587 Direct Handling)
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.trim().replace(/\s+/g, '');
  const cacheKey = `${cleanEmail}_${cleanPass}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // TLS Require
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
      tls: {
        rejectUnauthorized: false
      }
    });
    transporters.set(cacheKey, transporter);
  }
  return transporters.get(cacheKey);
}

/* ==========================================================================
   SPINTAX PARSER & ANTI-SPAM HASH
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 30) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : "";
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function generateRandomHash() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let hash = '';
  for (let i = 0; i < 14; i++) {
    hash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return hash;
}

/* ==========================================================================
   HTML TO PLAIN-TEXT FALLBACK (Dual Multipart MIME)
   ========================================================================== */
function convertHtmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   AUTHENTICATION ROUTES
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Credentials required" });

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed. Check App Password." });
  }
});

/* ==========================================================================
   SSE STREAM ROUTE (INBOX OPTIMIZED ENGINE)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();
  const senderDomain = senderEmail.split('@')[1] || 'gmail.com';

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
      const transporter = getTransporter(email, appPassword);
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Inboxing Enhancements: Anti-Spam Hidden Footprint
      const antiSpamHash = generateRandomHash();
      const invisibleFootprint = `<span style="opacity:0;font-size:0px;color:transparent;display:none;position:absolute;width:0;height:0;">${antiSpamHash}</span>`;

      let finalHtml = "";
      let finalPlainText = "";

      if (isHtml) {
        finalHtml = `${spunBody}${invisibleFootprint}`;
        finalPlainText = `${convertHtmlToText(spunBody)}\n\nRef: ${antiSpamHash}`;
      } else {
        finalHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #000000; line-height: 1.5;">${spunBody.replace(/\n/g, '<br>')}</div>${invisibleFootprint}`;
        finalPlainText = `${spunBody}\n\nRef: ${antiSpamHash}`;
      }

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        replyTo: senderEmail,
        subject: spunSubject,
        html: finalHtml,
        text: finalPlainText,
        encoding: 'utf-8',
        headers: {
          'X-Entity-Ref-ID': `${Date.now()}-${antiSpamHash}`,
          'Message-ID': `<${antiSpamHash}.${Date.now()}@${senderDomain}>`,
          'List-Unsubscribe': `<mailto:${senderEmail}?subject=unsubscribe>`,
          'X-Mailer': 'Nodemailer Express Engine'
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (error) {
      console.error(`Error sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Dynamic Human Delay (1.5s to 2.5s) to Bypass Gmail Spam Trigger
    if (index < recipients.length - 1) {
      const randomDelay = Math.floor(Math.random() * 1000) + 1250;
      const steps = Math.ceil(randomDelay / 500);

      for (let s = 0; s < steps; s++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        res.write(': keep-alive\n\n');
      }
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

/* ==========================================================================
   SERVER INITIALIZATION
   ========================================================================== */
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on Port ${PORT}`);
  });
}

export default app;
