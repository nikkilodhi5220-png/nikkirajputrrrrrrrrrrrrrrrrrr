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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : '';
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
    : '';

  const firstName = formattedName ? formattedName.split(' ')[0] : '';
  const domain = email.includes('@') ? email.split('@')[1] : '';

  return { email: email.toLowerCase(), name: formattedName, firstName, domain };
}

function parseSpintax(text) {
  if (!text) return '';
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
  if (!template) return '';
  let content = parseSpintax(template);
  const displayName = recipient.name || recipient.firstName || 'there';
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content.trim();
}

function stripHtmlTags(htmlString) {
  return htmlString
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
    return res.status(401).json({ success: false, message: 'Unauthorized Password' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { email, appPassword } = req.body || {};
    if (!email || !appPassword) return res.status(400).json({ success: false, message: 'Credentials required' });

    const cleanEmail = email.toLowerCase().trim();
    const cleanPass = appPassword.replace(/\s+/g, '').trim();

    if (cleanPass.length !== 16) return res.status(400).json({ success: false, message: 'App Password must be 16 characters' });

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: cleanEmail, pass: cleanPass },
      connectionTimeout: 5000
    });

    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Ready' });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'SMTP Auth Failed' });
  }
});

// Fast & Safe Sending Endpoint (Vercel Timeout Proof)
app.post('/api/send-stream', async (req, res) => {
  try {
    const { email, appPassword, senderName, subject, messageBody, recipients } = req.body || {};

    if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid Request Data' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanPass = appPassword.replace(/\s+/g, '').trim();
    const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: cleanEmail, pass: cleanPass },
      pool: true,
      maxConnections: 5, // High speed parallel connections
      socketTimeout: 10000
    });

    const defaultSubject = '{Quick question|Site Overview|Quick note}';
    const defaultBody = `Your site looks great, but a small issue is keeping it from showing in the top results.`;

    const finalSubjectTemplate = (subject && subject.trim()) ? subject : defaultSubject;
    const rawBodyTemplate = (messageBody && messageBody.trim()) ? messageBody : defaultBody;
    const domain = cleanEmail.split('@')[1] || 'gmail.com';

    // Parallel Processing for Maximum Speed
    const sendPromises = recipients.map(async (rawRecipient) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, error: 'Invalid recipient email' };

      try {
        const personalizedSubject = personalizeContent(finalSubjectTemplate, recipient);
        const personalizedBody = personalizeContent(rawBodyTemplate, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: personalizedSubject,
          text: isHtml ? stripHtmlTags(personalizedBody) : personalizedBody,
          html: isHtml 
            ? `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333333; line-height: 1.5;">${personalizedBody}</div>` 
            : `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333333; line-height: 1.5;">${personalizedBody.replace(/\n/g, '<br>')}</div>`,
          headers: {
            'Message-ID': `<${Date.now()}.${Math.random().toString(36).substring(2, 8)}@${domain}>`,
            'X-Mailer': 'Microsoft Outlook 16.0',
            'Precedence': 'bulk',
            'List-Unsubscribe': `<mailto:${cleanEmail}?subject=unsubscribe>`
          }
        };

        await transporter.sendMail(mailOptions);
        return { success: true, recipient: recipient.email };
      } catch (err) {
        return { success: false, recipient: recipient.email, error: err.message };
      }
    });

    const results = await Promise.allSettled(sendPromises);
    transporter.close();

    // Stream log compatible response
    res.setHeader('Content-Type', 'text/event-stream');
    results.forEach((resItem) => {
      if (resItem.status === 'fulfilled') {
        res.write(`data
