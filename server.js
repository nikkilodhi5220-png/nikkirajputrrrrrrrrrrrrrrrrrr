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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. UTILITIES & HELPERS
   ========================================================================== */

/**
 * Standard Reference Code Generator
 */
function generateReferenceCode(prefix = 'REF', length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomStr = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    randomStr += chars[bytes[i] % chars.length];
  }
  return `${prefix}-${randomStr}`;
}

/**
 * Managed Transporter Pool with Hashed Keys
 */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `${cleanEmail}_${crypto.createHash('md5').update(appPassword).digest('hex')}`;

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

/**
 * HTML to Plain-Text Fallback
 */
function createPlainTextFromHtml(html) {
  if (!html) return '';
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

/**
 * Clean Footer Injection
 */
function injectFooter(htmlBody, footerContent) {
  if (htmlBody.includes('</body>')) {
    return htmlBody.replace('</body>', `${footerContent}</body>`);
  }
  return htmlBody + footerContent;
}

/* ==========================================================================
   2. ROUTES
   ========================================================================== */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials Missing' });
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Connection Verified' });
  } catch (err) {
    return res.status(401).json({ success: false, message: `Connection Failed: ${err.message}` });
  }
});

/* ==========================================================================
   3. DISPATCH STREAMING
   ========================================================================== */

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId, codePrefix } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    res.end();
    return;
  }

  const currentSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  activeSessions.add(currentSessionId);

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/"/g, '').trim();
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
      res.write(`data: ${JSON.stringify({ success: false, error: 'Process Stopped' })}\n\n`);
      break;
    }

    const recipient = recipients[i] ? recipients[i].trim() : '';
    if (!recipient) continue;

    try {
      const transporter = getTransporter(email, appPassword);
      const uniqueCode = generateReferenceCode(prefix, 6);

      let finalSubject = subject ? subject.replace(/{CODE}|\[\[CODE\]\]|{REF}/g, uniqueCode) : 'No Subject';
      let finalBody = messageBody ? messageBody.replace(/{CODE}|\[\[CODE\]\]|{REF}/g, uniqueCode) : '';

      const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

      const footerHtml = `
        <div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #e0e0e0; font-family: sans-serif; font-size: 11px; color: #666666;">
          Ref Code: <strong>${uniqueCode}</strong>
        </div>
      `;

      const domainMsgId = `<${Date.now()}.${Math.random().toString(36).substring(2, 8)}@${senderDomain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient,
        replyTo: cleanEmail,
        subject: finalSubject,
        messageId: domainMsgId,
        headers: {
          'X-Entity-Ref-ID': uniqueCode,
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        mailOptions.html = injectFooter(finalBody, footerHtml);
        mailOptions.text = createPlainTextFromHtml(finalBody);
      } else {
        mailOptions.text = `${finalBody}\n\nRef Code: ${uniqueCode}`;
      }

      await transporter.sendMail(mailOptions);

      res.write(`data: ${JSON.stringify({
        success: true,
        recipient,
        generatedCode: uniqueCode,
        sessionId: currentSessionId
      })}\n\n`);

    } catch (err) {
      console.error(`Error sending to ${recipient}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: err.message })}\n\n`);
    }

    // Delay to prevent SMTP rate-limiting (1.5s to 2.5s)
    if (i < recipients.length - 1 && activeSessions.has(currentSessionId) && !clientDisconnected) {
      const delay = Math.floor(1500 + Math.random() * 1000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  activeSessions.delete(currentSessionId);
  clearInterval(keepAlivePing);

  if (!clientDisconnected) {
    res.write('data: [DONE]\n\n');
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
  res.json({ success: true, message: 'Process stopped successfully' });
});

app.listen(PORT, () => {
  console.log(`Server running on Port ${PORT}`);
});
