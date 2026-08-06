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

// Multi-Session Engine & Transporter Pool
const activeSessions = new Set();
const poolMap = new Map();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. UNIQUE CODE GENERATOR (Inboxing & Fingerprint Avoidance)
   ========================================================================== */
/**
 * Har mail ke liye Unique Format Code banata hai
 * Example Formats: REF-8X9A2K, TRK-94218, SEC-3M7P0Q
 */
function generateUniqueCode(prefix = 'REF', length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Readable characters
  let randomStr = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    randomStr += chars[bytes[i] % chars.length];
  }
  return `${prefix}-${randomStr}`;
}

/* ==========================================================================
   2. PORT 587 TRANSPORTER POOL (Modern TLS)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `port587_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,       // STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      },
      connectionTimeout: 15000,
      socketTimeout: 30000
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   3. SPINTAX & TEXT CLEANER UTILITIES
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
   4. ROUTES
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
    return res.status(401).json({ success: false, message: `Connection Failed: ${err.message}` });
  }
});

/* ==========================================================================
   5. STREAMING DISPATCH (Inboxing Engine with Unique Code per Mail)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId, codePrefix } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data" })}\n\n`);
    res.end();
    return;
  }

  const currentSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  activeSessions.add(currentSessionId);

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const senderDomain = cleanEmail.split('@')[1] || 'gmail.com';
  const prefix = (codePrefix || 'REF').toUpperCase().trim();

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 9000);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    activeSessions.delete(currentSessionId);
    clearInterval(keepAlivePing);
  });

  for (let i = 0; i < recipients.length; i++) {
    if (!activeSessions.has(currentSessionId) || clientDisconnected) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : "";
    if (!recipient) continue;

    try {
      const transporter = getPort587Transporter(email, appPassword);
      
      // A. HAR EMAIL KE LIYE UNIQUE CODE GENERATE HO RAHA HAI
      const uniqueCode = generateUniqueCode(prefix, 6); // Output e.g: REF-8K2P9X
      const trackingHash = crypto.randomBytes(4).toString('hex');

      // B. Spintax Process
      let spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);

      // C. Replace Code Placeholders ({CODE} ya [[CODE]]) in Subject & Body
      spunSubject = spunSubject
        .replace(/{CODE}/g, uniqueCode)
        .replace(/\[\[CODE\]\]/g, uniqueCode)
        .replace(/{REF}/g, uniqueCode);

      spunBody = spunBody
        .replace(/{CODE}/g, uniqueCode)
        .replace(/\[\[CODE\]\]/g, uniqueCode)
        .replace(/{REF}/g, uniqueCode);

      // D. HTML Inboxing Enhancements (Auto Footer with Unique Code if missing)
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      if (isHtml) {
        // Aesthetic & Anti-Spam Footer Injection
        spunBody += `
          <br><br>
          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px solid #f0f0f0; font-family: monospace, sans-serif; font-size: 11px; color: #888888;">
            Reference Code: <strong style="color:#444444;">${uniqueCode}</strong> | Security Hash: <span>${trackingHash}</span>
          </div>
          <span style="display:none;font-size:1px;color:#ffffff;">[id:${trackingHash}]</span>
        `;
      } else {
        spunBody += `\n\n-------------------------\nReference Code: ${uniqueCode}\nRef Hash: ${trackingHash}`;
      }

      // E. Unique Message-ID & Compliant Headers
      const uniqueMsgId = `<${Date.now()}.${uniqueCode.replace('-', '')}@${senderDomain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: spunSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Entity-Ref-ID': uniqueCode,
          'X-Delivery-Context': trackingHash,
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

      // Send Success Event with Generated Code
      res.write(`data: ${JSON.stringify({ 
        success: true, 
        recipient, 
        generatedCode: uniqueCode,
        sessionId: currentSessionId 
      })}\n\n`);

    } catch (err) {
      console.error(`Send Failure to ${recipient}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // Dynamic Human-like Delay (1.2s - 1.5s)
    if (i < recipients.length - 1 && activeSessions.has(currentSessionId) && !clientDisconnected) {
      const exactDelay = Math.floor(1200 + Math.random() * 300);
      await new Promise(resolve => setTimeout(resolve, exactDelay));
    }
  }

  activeSessions.delete(currentSessionId);
  clearInterval(keepAlivePing);
  
  if (!clientDisconnected) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

app.post('/api/stop', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    activeSessions.delete(sessionId);
  } else {
    activeSessions.clear();
  }
  res.json({ success: true, message: "Process stopped successfully" });
});

app.listen(PORT, () => {
  console.log(`Server running on Port ${PORT} with Auto Code Generator & Inboxing Engine`);
});
