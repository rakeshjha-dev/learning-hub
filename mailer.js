// Sends email through Resend (RESEND_API_KEY) or any SMTP server, e.g. a Google Workspace mailbox with an
// app password (SMTP_USER + SMTP_PASS). With neither set, email is simply off and nothing is sent.
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MODE = RESEND_KEY ? 'resend' : SMTP_USER && SMTP_PASS ? 'smtp' : '';
const FROM = process.env.MAIL_FROM || (SMTP_USER ? `Learning Hub <${SMTP_USER}>` : '');

let transport;
function smtp() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      maxConnections: 3,
    });
  }
  return transport;
}

async function sendMail({ to, subject, html, text }) {
  if (MODE === 'resend') {
    const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (MODE === 'smtp') {
    await smtp().sendMail({ from: FROM, to, subject, html, text });
    return;
  }
  throw new Error('Email is not set up');
}

module.exports = { MAIL_MODE: MODE, MAIL_FROM: FROM, sendMail };
