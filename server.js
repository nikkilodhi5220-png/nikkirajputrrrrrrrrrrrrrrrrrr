import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   HELPER UTILITIES
   ========================================================================== */
function generateMessageId() {
  const hex = crypto.randomBytes(4).toString('hex');
  return `ref-${hex}`;
}

function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let passes = 0;

  while (regex.test(spun) && passes < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    passes++;
  }
  return spun;
}

function createPlainTextFromHtml(html) {
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
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   TRANSPORTER CONFIG
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `smtp_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // TLS via STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 1, // Single connection to mimic human activity
      maxMessages: 50
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   ROUTES
   ========================================================================== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials Missing" });
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Connection Failed" });
  }
});

/* ==========================================================================
   HIGH INBOXING STREAM DISPATCH
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = getTransporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const refId = generateMessageId();
      const spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Mandatory Unsubscribe Footer (Anti-Spam Filter Policy)
      const unsubscribeFooterHtml = `
        <br><br>
        <hr style="border:none;border-top:1px solid #e0e0e0;margin-top:20px;">
        <p style="font-size:11px;color:#888888;font-family:sans-serif;">
          If you no longer wish to receive these emails, reply with "UNSUBSCRIBE" to opt-out.<br>
          Ref ID: [${refId}]
        </p>`;

      const unsubscribeFooterText = `\n\n---\nTo unsubscribe, reply with "UNSUBSCRIBE".\nRef ID: [${refId}]`;

      let finalBodyHtml = "";
      let finalBodyText = "";

      if (isHtml) {
        finalBodyHtml = spunBody + unsubscribeFooterHtml;
        finalBodyText = createPlainTextFromHtml(spunBody) + unsubscribeFooterText;
      } else {
        finalBodyText = spunBody + unsubscribeFooterText;
      }

      // RFC Standard Headers (Inboxing Rate Elevators)
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        text: finalBodyText,
        ...(isHtml && { html: finalBodyHtml }),
        headers: {
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Entity-Ref-ID': refId
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, refId })}\n\n`);

    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // HUMAN PACING DELAY (1.0s to 1.8s per email)
    if (i < recipients.length - 1) {
      const safeDelay = Math.floor(600 + Math.random() * 600);
      
      // Step-by-step sleep to prevent SSE timeout
      const seconds = Math.floor(safeDelay / 1000);
      for (let s = 0; s < seconds; s++) {
        if (globalSession.stopRequested) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
        res.write(': keep-alive\n\n');
      }
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Process stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Inboxing Server listening on Port ${PORT}`);
});
