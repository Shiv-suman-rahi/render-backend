const test = require('node:test');
const assert = require('node:assert/strict');
const { sendVerificationCode, getEmailDeliveryErrorMessage } = require('../src/email');

function setEnv(values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('verification email uses Resend HTTPS API when its API key is configured', async () => {
  const restore = setEnv({
    RESEND_API_KEY: 'test-api-key',
    SMTP_FROM: 'Watch Party <verify@example.test>',
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
  });
  let request;
  try {
    await sendVerificationCode('person@example.test', '012345', {
      fetchImpl: async (...args) => {
        request = args;
        return { ok: true };
      },
    });
  } finally {
    restore();
  }

  assert.equal(request[0], 'https://api.resend.com/emails');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].headers.Authorization, 'Bearer test-api-key');
  const body = JSON.parse(request[1].body);
  assert.equal(body.to[0], 'person@example.test');
  assert.match(body.text, /012345/);
});

test('Resend rejection maps to actionable, credential-safe guidance', async () => {
  const restore = setEnv({
    RESEND_API_KEY: 'test-api-key',
    SMTP_FROM: 'verify@example.test',
    SMTP_HOST: undefined,
  });
  try {
    await assert.rejects(
      sendVerificationCode('person@example.test', '012345', {
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          json: async () => ({ message: 'forbidden' }),
        }),
      }),
      (error) => getEmailDeliveryErrorMessage(error).includes('RESEND_API_KEY'),
    );
  } finally {
    restore();
  }
});
