import crypto from 'crypto';

// Separate from app JWTs: a media URL must never authorize account/log APIs.
const mediaKey = crypto.randomBytes(32);
const MAX_AGE_SECONDS = 24 * 60 * 60;

function signature(bookId: string, expires: string): string {
  return crypto.createHmac('sha256', mediaKey)
    .update(`local-stream:${bookId}:${expires}`).digest('base64url');
}

export function createMediaAccess(bookId: string, now = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + MAX_AGE_SECONDS);
  return `${expires}.${signature(bookId, expires)}`;
}

export function verifyMediaAccess(bookId: string, token: unknown, now = Date.now()): boolean {
  if (typeof token !== 'string' || !/^\d{10,12}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [expires, supplied] = token.split('.');
  const remaining = Number(expires) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > MAX_AGE_SECONDS) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(bookId, expires)));
}
