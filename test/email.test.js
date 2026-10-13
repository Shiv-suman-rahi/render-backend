const test = require('node:test');
const assert = require('node:assert/strict');
const { getEmailDeliveryErrorMessage } = require('../src/email');

test('Gmail authentication failures explain the required app password without exposing secrets', () => {
  const originalHost = process.env.SMTP_HOST;
  process.env.SMTP_HOST = 'smtp.gmail.com';
  try {
    const message = getEmailDeliveryErrorMessage({ code: 'EAUTH', responseCode: 535 });
    assert.match(message, /Google App Password/);
    assert.doesNotMatch(message, /password is secret/i);
  } finally {
    if (originalHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = originalHost;
  }
});

test('SMTP connectivity and sender errors identify configuration areas', () => {
  assert.match(
    getEmailDeliveryErrorMessage({ code: 'ETIMEDOUT' }),
    /Render Free.*SMTP ports are blocked.*RESEND_API_KEY/,
  );
  assert.match(
    getEmailDeliveryErrorMessage({ responseCode: 550 }),
    /SMTP_FROM/,
  );
});
