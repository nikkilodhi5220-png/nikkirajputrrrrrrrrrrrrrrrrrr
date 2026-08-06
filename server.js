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

// Session Tracker & Transporter Pool
const globalSession = { stopRequested: false };
const poolMap = new Map();

// Express Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   PORT 587 ENGINE (Explicit TLS & High Security Pool)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const key = `port587_${email.toLowerCase().trim()}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,             // PORT 587 (Explicit TLS)
      secure: false,        // Port 587 ke liye false hona chahiye
      requireTLS: true,     // Force Security Handshake
      auth: {
        user: email.toLowerCase().trim(),
        pass: appPassword
      },
      pool: true,
      maxConnections: 3,    // Fast Processing
      maxMessages: 100,
      tls: {
        rejectUnauthorized: false,
        ciphers: 'SSLv3'
      }
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   SPINTAX & CONTENT UTILITIES
   ========================================================================== */
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
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
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
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "Port 587 Connection Verified" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Port 587 Connection Failed" });
  }
});

/* ==========================================================================
   STREAMING DISPATCH (Speed: 1.1s - 1.2s on Port 587)
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
  }, 9000);

  const senderDomain = cleanEmail.split('@')[1] || 'gmail.com';

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const transporter = getPort587Transporter(email, appPassword);
      
      const spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      // Inboxing Tracker Hash Generator
      const messageHash = crypto.randomBytes(3).toString('hex');
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      if (isHtml) {
        spunBody += `<br><span style="display:none;font-size:1px;color:#ffffff;">id:${messageHash}</span>`;
      } else {
        spunBody += `\n\n[id:${messageHash}]`;
      }

      // Dynamic Port 587 RFC Message Header
      const uniqueMsgId = `<${Date.now()}.${messageHash}@${senderDomain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Delivery-Context': messageHash,
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        mailOptions.html = spunBody;
        mailOptions.text = createPlainTextFromHtml(spunBody);
      } else {
        mailOptions.text = spunBody;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (err) {
      console.error(`Port 587 Send Failure to ${recipient}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // SPEED: 1.1s to 1.2s (1100ms - 1200ms)
    if (i < recipients.length - 1) {
      const exactDelay = Math.floor(1100 + Math.random() * 100);
      await new Promise(resolve => setTimeout(resolve, exactDelay));
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
  console.log(`Server listening on Port ${PORT} using SMTP 587 Engine`);
});
