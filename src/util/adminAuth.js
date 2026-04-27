// Admin auth — password hashing + signed session tokens.
// Token format: base64url(payload) + '.' + base64url(hmac-sha256(secret, payload))
// Payload JSON: { sub: admin_id, u: username, iat, exp }
// No JWT lib used — we control both sides and want to avoid extra deps.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const SECRET = process.env.ADMIN_JWT_SECRET;
if (!SECRET) {
  console.warn('[admin] WARNING: ADMIN_JWT_SECRET not set — admin login is disabled');
}
const TTL_HOURS = Number(process.env.ADMIN_TOKEN_TTL_HOURS) || 8;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) throw new Error('Password must be at least 8 chars');
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

export function generatePassword(len = 16) {
  // 16 chars ~= 80 bits of entropy from base32-ish alphabet. Human-typeable.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

export function signAdminToken({ id, username }) {
  if (!SECRET) throw new Error('ADMIN_JWT_SECRET not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: id, u: username, iat: now, exp: now + TTL_HOURS * 3600 };
  const payloadStr = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payloadStr).digest());
  return `${payloadStr}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, givenSig] = parts;
  const expectedSig = b64url(crypto.createHmac('sha256', SECRET).update(payloadStr).digest());
  // Constant-time compare
  const a = Buffer.from(givenSig); const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadStr).toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// Express middleware — expects `Authorization: Bearer <token>`.
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.admin = payload;
  next();
}
