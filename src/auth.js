const crypto = require('crypto');
const { promisify } = require('util');
const AuthSession = require('./models/AuthSession');
const User = require('./models/User');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'wp_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function serializeUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return ['', ''];
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, ''];
      }
    }).filter(([key]) => key),
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(response, token) {
  const production = process.env.NODE_ENV === 'production';
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

function clearSessionCookie(response) {
  const production = process.env.NODE_ENV === 'production';
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: '/',
  });
}

async function createSession(user, response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE);
  const session = await AuthSession.create({
    tokenHash: hashToken(token),
    userId: user._id,
    csrfToken,
    expiresAt,
  });

  setSessionCookie(response, token);
  return { session, csrfToken };
}

async function resolveSession(cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;

  const session = await AuthSession.findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await User.findById(session.userId);
  if (!user) {
    await AuthSession.deleteOne({ _id: session._id });
    return null;
  }

  return { session, user };
}

async function resolveSocketSession(csrfToken) {
  if (typeof csrfToken !== 'string' || !csrfToken) return null;

  const session = await AuthSession.findOne({
    csrfToken,
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;

  const user = await User.findById(session.userId);
  if (!user) {
    await AuthSession.deleteOne({ _id: session._id });
    return null;
  }

  return { session, user };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = String(storedHash || '').split('$');
  if (
    algorithm !== 'scrypt'
    || !/^[a-f0-9]{32}$/i.test(saltHex || '')
    || !/^[a-f0-9]{128}$/i.test(hashHex || '')
  ) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function validateCsrf(session, suppliedToken) {
  if (typeof suppliedToken !== 'string') return false;
  const expected = Buffer.from(session.csrfToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  clearSessionCookie,
  createSession,
  hashPassword,
  hashToken,
  resolveSession,
  resolveSocketSession,
  serializeUser,
  validateCsrf,
  verifyPassword,
};
