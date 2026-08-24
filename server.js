const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HTML से स्पैम ट्रिगर्स हटाने और प्लेन टेक्स्ट तैयार करने का फ़ंक्शन
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style([\s\S]*?)<\/style>/gi, '')
        .replace(/<script([\s\S]*?)<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/send-emails', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const { smtp, senderName, subject, htmlBody, recipients } = req.body;

    // अगर फ्रंटएंड से Host/Port न भी आए तो ऑटोमैटिक Gmail SMTP यूज़ होगा
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

        const plainText = stripHtml(htmlBody);

        const mailOptions = {
            from: `"${senderName.trim()}" <${smtp.user.trim()}>`,
            to: recipient,
            subject: subject.trim(),
            text: plainText,             // Plain-text Fallback (Primary Inbox के लिए अत्यंत महत्वपूर्ण)
            html: htmlBody,
            headers: {
                'X-Entity-Ref-ID': Date.now().toString() // प्रत्येक ईमेल को यूनिक बनाता है
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

        // हर ईमेल के बाद 1 से 2 सेकंड का रैंडम गैप (Spam Filter bypass करने के लिए)
        if (i < recipients.length - 1) {
            const randomDelay = Math.floor(Math.random() * 500) + 700;
            await delay(randomDelay);
        }
    }

    res.write(`data: ${JSON.stringify({ type: 'complete', sentCount, failCount, total })}\n\n`);
    res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
