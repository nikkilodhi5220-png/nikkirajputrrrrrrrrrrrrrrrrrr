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

// Session & Transport Cache Management
const activeState = { stopRequested: false };
const connectionMap = new Map();

// Express Configuration
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   ADVANCED HELPER UTILITIES
   ========================================================================== */

// 1. Connection Engine (Prevents IP/Port Throttling)
function acquireTransport(email, appPassword) {
  const accountKey = `${email.toLowerCase().trim()}:${appPassword}`;

  if (!connectionMap.has(accountKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // TLS/SSL Protocol Direct Connection
      auth: {
        user: email.toLowerCase().trim(),
        pass: appPassword
      },
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      rateLimit: true,
      rateDelta: 1000
    });
    connectionMap.set(accountKey, transporter);
  }

  return connectionMap.get(accountKey);
}

// 2. Multi-level Spintax Parser
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let depth = 0;

  while (regex.test(spun) && depth < 8) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    depth++;
  }
  return spun;
}

// 3. RFC-Compliant Plain-Text Normalizer
function convertToPlainText(html) {
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
   API ENDPOINTS
   ========================================================================== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Password Authentication
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authentication Successful" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

// Credentials Verification
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials missing" });
  }

  try {
    const transporter = acquireTransport(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Handshake Success" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "SMTP Connection Refused" });
  }
});

// Streaming Mail Dispatcher (Speed: 1.1s - 1.2s)
app.post('/api/send-stream', async (req, res) => {
  // Setup Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Payload" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  activeState.stopRequested = false;

  // SSE Heartbeat to prevent socket drops
  const pingInterval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 8000);

  const domain = cleanEmail.split('@')[1] || 'gmail.com';

  for (let i = 0; i < recipients.length; i++) {
    if (activeState.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Execution Halts by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const transporter = acquireTransport(email, appPassword);
      
      // Parse Dynamic Content
      const finalSubject = parseSpintax(subject);
      let rawBody = parseSpintax(messageBody);

      // Inboxing Hack: Add Unique Reference Tag to bypass Spam Hash Matching
      const uniqueRef = crypto.randomBytes(4).toString('hex');
      const isHtml = /<[a-z][\s\S]*>/i.test(rawBody);

      if (isHtml) {
        rawBody += `<br><br><span style="color:#ffffff;font-size:1px;display:none;">Ref: ${uniqueRef}</span>`;
      } else {
        rawBody += `\n\n[Ref: ${uniqueRef}]`;
      }

      // Generate Custom Unique RFC Message-ID
      const customMessageId = `<${Date.now()}.${uniqueRef}@${domain}>`;

      const mailData = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: finalSubject,
        messageId: customMessageId,
        headers: {
          'X-Entity-Ref-ID': uniqueRef,
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        mailData.html = rawBody;
        mailData.text = convertToPlainText(rawBody);
      } else {
        mailData.text = rawBody;
      }

      await transporter.sendMail(mailData);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (err) {
      console.error(`Transmission Error to ${recipient}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // EXACT SPEED DELAY: 1.1s to 1.2s (1100ms - 1200ms)
    if (i < recipients.length - 1) {
      const delay = Math.floor(1100 + Math.random() * 100);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  clearInterval(pingInterval);
  res.write("data: [DONE]\n\n");
  res.end();
});

// Stop Signal Route
app.post('/api/stop', (req, res) => {
  activeState.stopRequested = true;
  res.json({ success: true, message: "Stop signal processed" });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Inboxing Server operational on port ${PORT}`);
});
