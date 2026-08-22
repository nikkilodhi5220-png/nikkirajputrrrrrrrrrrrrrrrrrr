const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML से टेक्स्ट निकालने और स्पैम टैग साफ़ करने का फ़ंक्शन
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// रैंडम यूनिक नंबर जनरेट करने का फ़ंक्शन (हर टेम्पलेट को डिफ़रेंट बनाने के लिए)
function generateUniqueId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/send-emails', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const { smtp, senderName, subject, htmlBody, recipients } = req.body;

    const smtpHost = (smtp && smtp.host && smtp.host.trim()) ? smtp.host.trim() : 'smtp.gmail.com';
    const smtpPort = (smtp && smtp.port && parseInt(smtp.port)) ? parseInt(smtp.port) : 465;

    if (!smtp || !smtp.user || !smtp.pass || !recipients || recipients.length === 0) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Gmail ID या App Password दर्ज करना अनिवार्य है!' })}\n\n`);
        return res.end();
    }

    const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
            user: smtp.user.trim(),
            pass: smtp.pass.trim().replace(/\s+/g, '') // पासवर्ड के स्पेस स्वतः हटाएँ
        },
        tls: {
            rejectUnauthorized: false
        },
        pool: false
    });

    try {
        await transporter.verify();
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `Gmail/SMTP कनेक्शन त्रुटि: ${err.message}` })}\n\n`);
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failCount = 0;

    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

    // 🔴 Anti-Spam Direct Inboxing Loop (1-By-1)
    for (let i = 0; i < recipients.length; i++) {
        const recipient = recipients[i].trim();
        if (!recipient) continue;

        // हर मैसेज के अंत में अलग यूनिक नंबर जोड़ा जाएगा ताकि Gmail हर ईमेल को यूनिक माने
        const uniqueId = generateUniqueId();
        const customHtmlBody = `${htmlBody}\n\n<div style="display:none;font-size:1px;color:#ffffff;">Ref ID: #${uniqueId}</div>`;
        const plainText = `${stripHtml(htmlBody)}\n\n[Ref ID: #${uniqueId}]`;

        const mailOptions = {
            from: `"${senderName.trim()}" <${smtp.user.trim()}>`,
            to: recipient,
            subject: subject.trim(),
            text: plainText,
            html: customHtmlBody,
            headers: {
                'X-Entity-Ref-ID': `${Date.now()}-${uniqueId}`,
                'Message-ID': `<${uniqueId}.${Date.now()}@gmail.com>`
            }
        };

        try {
            await transporter.sendMail(mailOptions);
            sentCount++;
            res.write(`data: ${JSON.stringify({ 
                type: 'progress', 
                status: 'success', 
                recipient, 
                sentCount, 
                failCount, 
                index: i + 1, 
                total 
            })}\n\n`);
        } catch (error) {
            failCount++;
            res.write(`data: ${JSON.stringify({ 
                type: 'progress', 
                status: 'failed', 
                recipient, 
                error: error.message, 
                sentCount, 
                failCount, 
                index: i + 1, 
                total 
            })}\n\n`);
        }

        // Safe Inboxing Speed: 2.5 से 4.5 सेकंड का रैंडम गैप (Gmail Limit & Spam Filter Prevention)
        if (i < recipients.length - 1) {
            const randomDelay = Math.floor(Math.random() * 2000) + 2500;
            await delay(randomDelay);
        }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete', sentCount, failCount, total })}\n\n`);
    res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
