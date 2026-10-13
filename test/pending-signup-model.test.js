const test = require('node:test');
const assert = require('node:assert/strict');
const PendingSignup = require('../src/models/PendingSignup');

test('pending signups store hashed verification state with automatic expiry', () => {
  assert.equal(PendingSignup.schema.path('email').options.unique, true);
  assert.equal(PendingSignup.schema.path('codeHash').options.required, true);
  assert.equal(PendingSignup.schema.path('passwordHash').options.required, true);
  assert.equal(PendingSignup.schema.path('expiresAt').options.expires, 0);
  assert.equal(PendingSignup.schema.path('code'), undefined);
});
