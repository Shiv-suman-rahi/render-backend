const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, serializeUser, validateCsrf, verifyPassword } = require('../src/auth');
const { Participant, ROLE_TYPES } = require('../src/roomManager');

test('password hashes are salted and verification rejects incorrect passwords', async () => {
  const password = 'a-long-password-value';
  const firstHash = await hashPassword(password);
  const secondHash = await hashPassword(password);

  assert.notEqual(firstHash, password);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword(password, firstHash), true);
  assert.equal(await verifyPassword('another-password', firstHash), false);
});

test('password verification rejects unsupported or malformed hashes', async () => {
  assert.equal(await verifyPassword('password', 'not-a-password-hash'), false);
  assert.equal(await verifyPassword('password', 'bcrypt$salt$hash'), false);
  assert.equal(await verifyPassword('password', 'scrypt$not-hex$short'), false);
});

test('CSRF validation requires an exact token match', () => {
  const session = { csrfToken: 'session-csrf-token' };
  assert.equal(validateCsrf(session, 'session-csrf-token'), true);
  assert.equal(validateCsrf(session, 'wrong-token'), false);
  assert.equal(validateCsrf(session, undefined), false);
});

test('serialized account data never contains the password hash', () => {
  const serialized = serializeUser({
    _id: 'database-user-id',
    username: 'Taylor',
    email: 'taylor@example.test',
    passwordHash: 'private-hash',
    avatarUrl: '',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  assert.equal(serialized.id, 'database-user-id');
  assert.equal(Object.hasOwn(serialized, 'passwordHash'), false);
});

test('room participant identity is stable while socket IDs remain private and temporary', () => {
  const participant = new Participant('database-user-id', 'Taylor', 'temporary-socket-id', ROLE_TYPES.HOST);
  const serialized = participant.toJSON();

  assert.equal(serialized.userId, 'database-user-id');
  assert.equal(serialized.online, true);
  assert.equal(Object.hasOwn(serialized, 'socketId'), false);
});
