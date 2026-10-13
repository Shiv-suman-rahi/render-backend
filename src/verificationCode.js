const crypto = require('crypto');

function generateVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashVerificationCode(salt, code) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function verifyVerificationCode(salt, code, storedHash) {
  const submittedHash = Buffer.from(hashVerificationCode(salt, code), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');
  return submittedHash.length === expectedHash.length
    && crypto.timingSafeEqual(submittedHash, expectedHash);
}

module.exports = {
  generateVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
};
