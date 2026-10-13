const nodemailer = require('nodemailer');

let transporter;

function getEmailDeliveryErrorMessage(error) {
  if (error.code === 'EAUTH' || error.responseCode === 535) {
    if (process.env.SMTP_HOST?.toLowerCase() === 'smtp.gmail.com') {
      return 'Gmail rejected the SMTP login. Set SMTP_USER to the full Gmail address and SMTP_PASS to a Google App Password (not your normal Gmail password). App Passwords require 2-Step Verification. Update these values in the backend environment and retry.';
    }
    return 'Your email provider rejected the SMTP login. Check the backend SMTP_USER and SMTP_PASS values and confirm SMTP access is enabled for the account.';
  }

  if (error.code === 'ESOCKET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNECTION') {
    return 'Could not connect to the email provider. If this backend runs on Render Free, SMTP ports are blocked; configure RESEND_API_KEY and use an authorized sender with SMTP_FROM.';
  }

  if (error.code === 'EENVELOPE' || error.responseCode === 550 || error.responseCode === 553) {
    return 'The email provider rejected the sender or recipient. Check SMTP_FROM and make sure it is an authorized sender for your email account.';
  }

  if (error.code === 'ERESEND_AUTH') {
    return 'Resend rejected the API key. Check RESEND_API_KEY in the backend environment.';
  }

  if (error.code === 'ERESEND_SENDER') {
    return 'Resend rejected the sender address. Verify its domain with Resend and set SMTP_FROM to an authorized address.';
  }

  return 'Unable to send the verification email. Check the backend email provider configuration and logs.';
}

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !process.env.SMTP_FROM) {
    throw new Error('Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
  }

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid port number.');
  }

  const isGmail = SMTP_HOST.toLowerCase() === 'smtp.gmail.com';
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: SMTP_USER.trim(),
      pass: isGmail ? SMTP_PASS.replace(/\s+/g, '') : SMTP_PASS,
    },
  });
  return transporter;
}

async function sendWithResend(email, code, fetchImpl) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.SMTP_FROM,
      to: [email],
      subject: 'Your Watch Party verification code',
      text: `Your Watch Party verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Watch Party verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (response.ok) return;

  const result = await response.json().catch(() => ({}));
  const error = new Error('Resend rejected the verification email.');
  error.code = response.status === 401 || response.status === 403
    ? 'ERESEND_AUTH'
    : response.status === 400 || response.status === 422
      ? 'ERESEND_SENDER'
      : 'ERESEND_REQUEST';
  error.responseMessage = result.message;
  throw error;
}

async function sendVerificationCode(email, code, { fetchImpl = fetch } = {}) {
  if (process.env.RESEND_API_KEY) {
    if (!process.env.SMTP_FROM) {
      throw new Error('SMTP_FROM must be set to a sender authorized in Resend.');
    }
    await sendWithResend(email, code, fetchImpl);
    return;
  }

  const mailer = getTransporter();
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Your Watch Party verification code',
    text: `Your Watch Party verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your Watch Party verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>`,
  });
}

module.exports = { getEmailDeliveryErrorMessage, sendVerificationCode };
