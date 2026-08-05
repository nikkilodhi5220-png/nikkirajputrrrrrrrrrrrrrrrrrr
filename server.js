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
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const transporterPool = new Map();

/* ==========================================================================
   ADVANCED TRANSPORTER POOL
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const poolKey = `${cleanEmail}_${appPassword}`;

  if (!transporterPool.has(poolKey)) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cleanEmail, pass: appPassword },
      pool: true,
      maxConnections: 1, // Rate limiting control
      maxMessages: 50,
      rateLimit: 1, // 1 message per second max socket rate
      socketTimeout: 30000
    });
    transporterPool.set(poolKey, transporter);
  }

  return transporterPool.get(poolKey);
}

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

function stripHtmlToPlain(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   QUEUE-BASED IN-MEMORY ENGINE
   ========================================================================== */
class EmailQueueEngine {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.isStopped = false;
  }

  addJobs(payload) {
    const { email, appPassword, senderName, subject, messageBody, recipients } = payload;
    this.queue = recipients.map(r => ({
      recipient: r.trim(),
      email,
      appPassword,
      senderName,
      subject,
      messageBody
    })).filter(item => item.recipient !== "");

    this.isStopped = false;
  }

  stop() {
    this.isStopped = true;
    this.queue = [];
  }

  async process(onProgress) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    let sentCount = 0;

    while (this.queue.length > 0 && !this.isStopped) {
      const job = this.queue.shift();
      const { email, appPassword, senderName, subject, messageBody, recipient } = job;
      const senderEmail = email.toLowerCase().trim();
      const cleanSenderName = (senderName || "").replace(/"/g, "").trim();

      try {
        const transporter = getTransporter(email, appPassword);
        const spunSubject = parseSpintax(subject);
        const spunBody = parseSpintax(messageBody);
        const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
          to: recipient,
          replyTo: senderEmail,
          subject: spunSubject,
          headers: {
            'List-Unsubscribe': `<mailto:${senderEmail}?subject=Unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).substring(7)}`
          }
        };

        if (isHtml) {
          mailOptions.html = spunBody;
          mailOptions.text = stripHtmlToPlain(spunBody);
        } else {
          mailOptions.text = spunBody;
        }

        await transporter.sendMail(mailOptions);
        sentCount++;
        onProgress({ success: true, recipient, sentCount });

      } catch (err) {
        onProgress({ success: false, recipient, error: err.message });
      }

      // Dynamic Intelligent Delay (1 to 1.2 Seconds + Cooloff)
      if (this.queue.length > 0 && !this.isStopped) {
        let baseDelay = Math.floor(2000 + Math.random() * 2000);
        if (sentCount % 10 === 0) {
          baseDelay += 10000; // 10 सेकंड का कूल-ऑफ ब्रेक
        }
        await new Promise(res => setTimeout(res, baseDelay));
      }
    }

    this.isProcessing = false;
  }
}

const activeEngine = new EmailQueueEngine();

/* ==========================================================================
   ROUTES
   ========================================================================== */
app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Unauthorized" });
});

app.post('/api/send-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, recipients } = req.body;
  if (!email || !appPassword || !Array.isArray(recipients)) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Data" })}\n\n`);
    return res.end();
  }

  activeEngine.addJobs(req.body);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 10000);

  activeEngine.process((result) => {
    res.write(`data: ${JSON.stringify(result)}\n\n`);
  }).then(() => {
    clearInterval(heartbeat);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

app.post('/api/stop', (req, res) => {
  activeEngine.stop();
  res.json({ success: true, message: "Queue stopped" });
});

app.listen(PORT, () => console.log(`Worker Server running on port ${PORT}`));
export default app;
