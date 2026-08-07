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

// Global Session & Transporter Pool
const globalSession = { stopRequested: false };
const poolMap = new Map();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. UNIQUE ID & UTILITY FUNCTIONS
   ========================================================================== */

// Outputs format like: [id:0c35ce]
function generateShortMessageId() {
  const randomHex = crypto.randomBytes(3).toString('hex');
  return `[id:${randomHex}]`;
}

// Spintax Processor: {Hello|Hi|Hey}
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

// HTML to Clean Plain Text Converter
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
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   2. SMTP TRANSPORTER (PORT 587 WITH POOLING)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `smtp_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 2,
      maxMessages: 50
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   3. ROUTES
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
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connection Verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Connection Failed" });
  }
});

/* ==========================================================================
   4. INBOX-OPTIMIZED DISPATCH ENGINE (SSE STREAM)
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

  const transporter = getPort587Transporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      // Unique Tag Generation
      const uniqueIdTag = generateShortMessageId();
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);

      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Standard Unsubscribe & Reference Footer
      const footerHtml = `
        <br><br>
        <hr style="border:none;border-top:1px solid #eeeeee;margin-top:20px;">
        <p style="font-size:11px;color:#777777;font-family:sans-serif;line-height:1.4;">
          If you no longer wish to receive these emails, reply with "UNSUBSCRIBE".<br>
          Reference Code: <strong>${uniqueIdTag}</strong>
        </p>`;

      const footerText = `\n\n---\nTo unsubscribe, reply with "UNSUBSCRIBE".\nReference Code: ${uniqueIdTag}`;

      let finalBodyHtml = "";
      let finalBodyText = "";

      if (isHtml) {
        finalBodyHtml = spunBody + footerHtml;
        finalBodyText = createPlainTextFromHtml(spunBody) + footerText;
      } else {
        finalBodyText = spunBody + footerText;
      }

      // RFC Standard Anti-Spam Headers
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
          'X-Entity-Ref-ID': uniqueIdTag.replace(/\[|\]|id:/g, '')
        }
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, messageIdTag: uniqueIdTag })}\n\n`);

    } catch (err) {
      console.error(`Send Error (${recipient}):`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // DELAY & BATCH WARMUP PAUSE LOGIC
    if (i < recipients.length - 1) {
      const currentMailNumber = i + 1;

      // 1. Batch Warmup Pause: Har 15 mails ke baad 15-20 sec ka pause
      if (currentMailNumber % 15 === 0) {
        const batchPauseMs = Math.floor(15000 + Math.random() * 5000);
        const pauseSeconds = Math.floor(batchPauseMs / 1000);

        for (let p = 0; p < pauseSeconds; p++) {
          if (globalSession.stopRequested) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          res.write(': keep-alive\n\n');
        }
      } 
      // 2. Standard Natural Delay: Har mail ke baad 1.0s se 1.8s ka gap
      else {
        const perMailDelayMs = Math.floor(600 + Math.random() * 400);
        const delaySeconds = Math.floor(perMailDelayMs / 1000);

        for (let d = 0; d < delaySeconds; d++) {
          if (globalSession.stopRequested) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          res.write(': keep-alive\n\n');
        }
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
  console.log(`Inboxing-Optimized Server listening on Port ${PORT}`);
});
