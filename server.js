import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. HIGH-SPEED INBOX TRANSPORTER (MAX POOL CONNECTION)
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `port587_${cleanEmail}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 6, // Fast 6 parallel connection pool
      maxMessages: 500,
      socketTimeout: 30000,
      connectionTimeout: 30000
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   2. RECIPIENT PARSER, SPINTAX & CUSTOM CTAS
   ========================================================================== */
function getOrganicCallToAction() {
  const ctas = [
    "Yes please do",
    "Yes please send",
    "Yes go ahead"
  ];
  return ctas[Math.floor(Math.random() * ctas.length)];
}

function parseRecipientData(input) {
  let email = "";
  let rawName = "";

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || "").trim();
    rawName = (input.name || input.fullName || input.first_name || "").trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : "";
      email = angleMatch[2].trim();
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        rawName = parts[1].trim();
      } else {
        rawName = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = str;
    }
  }

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : "";

  const firstName = formattedName ? formattedName.split(' ')[0] : "there";
  const domain = email.includes('@') ? email.split('@')[1] : "";

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

function parseSpintax(text) {
  if (!text) return "";
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 25) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : '';
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return "";
  let content = parseSpintax(template);
  const fallback = recipient.firstName || recipient.name || 'there';

  const currentDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  content = content.replace(/{Name}/gi, recipient.name || fallback);
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback);
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);
  content = content.replace(/{Date}/gi, currentDate);

  return content;
}

function createPlainTextFromHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
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
   3. API ROUTES
   ========================================================================== */
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials required" });
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "SMTP Auth Failed. Check App Password." });
  }
});

/* ==========================================================================
   4. ULTRA-FAST INBOX BATCH STREAMING ENGINE (6 PARALLEL)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request Data" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 3000);

  const transporter = getPort587Transporter(email, appPassword);
  const BATCH_SIZE = 6; // Strictly 6 Mails Parallel

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const currentBatch = recipients.slice(i, i + BATCH_SIZE);

    // Parallel execution for maximum speed and exact 6-batch sending
    await Promise.allSettled(
      currentBatch.map(async (rawRecipient, idx) => {
        if (globalSession.stopRequested) return;

        const recipient = parseRecipientData(rawRecipient);
        if (!recipient.email) return;

        try {
          // Micro stagger (30ms) to ensure distinct connection timestamps
          if (idx > 0) {
            await new Promise(resolve => setTimeout(resolve, idx * 30));
          }

          const personalizedSubject = personalizeContent(subject, recipient);
          const personalizedBody = personalizeContent(messageBody, recipient);
          const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);
          const customCTA = getOrganicCallToAction();

          const mailOptions = {
            from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
            to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
            replyTo: cleanEmail,
            date: new Date(),
            subject: personalizedSubject || 'Important Notice'
          };

          if (isHtml) {
            mailOptions.html = `
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
              </head>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #222222; line-height: 1.6; padding: 10px; margin: 0;">
                <div>${personalizedBody}</div>
                <br>
                <p style="font-size: 14px; color: #333333; margin-top: 10px;">${customCTA}</p>
              </body>
              </html>
            `;
            mailOptions.text = createPlainTextFromHtml(personalizedBody) + `\n\n${customCTA}`;
          } else {
            mailOptions.text = personalizedBody + `\n\n${customCTA}`;
          }

          await transporter.sendMail(mailOptions);
          res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email, name: recipient.name })}\n\n`);

        } catch (err) {
          console.error(`Send Failure [${recipient.email}]:`, err.message);
          res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
        }
      })
    );

    // Rest delay between 6-mail batches (800ms - 1200ms)
    if (i + BATCH_SIZE < recipients.length) {
      const batchDelay = Math.floor(800 + Math.random() * 400);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Sending process stopped" });
});

// Vercel / Production UI Static Handler
app.get('*', (req, res) => {
  const filePath1 = path.join(__dirname, 'public', 'index.html');
  const filePath2 = path.join(process.cwd(), 'public', 'index.html');

  if (fs.existsSync(filePath1)) {
    return res.sendFile(filePath1);
  } else if (fs.existsSync(filePath2)) {
    return res.sendFile(filePath2);
  }
  return res.status(200).send('<h1>Server Running</h1>');
});

// Start Server for Local Execution; Export for Vercel Serverless
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on Port ${PORT} [High-Speed Inbox Engine Ready]`);
  });
}

export default app;
