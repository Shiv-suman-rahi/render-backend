const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
} = require('../src/verificationCode');

test('verification codes are six digits and match only their salted hash', () => {
  const code = generateVerificationCode();
  const salt = 'a-random-per-request-salt';
  const hash = hashVerificationCode(salt, code);
  const wrongCode = code === '000000' ? '000001' : '000000';

  assert.match(code, /^\d{6}$/);
  assert.equal(verifyVerificationCode(salt, code, hash), true);
  assert.equal(verifyVerificationCode(salt, wrongCode, hash), false);
  assert.equal(verifyVerificationCode('different-salt', code, hash), false);
});
