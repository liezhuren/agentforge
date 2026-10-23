import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;

/** 生成 scrypt 口令散列，格式：scrypt:<salt>:<hash>。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/** 校验口令；散列格式非法时返回 false，不抛异常。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const scheme = parts[0];
  const salt = parts[1];
  const expectedHex = parts[2];
  if (scheme !== 'scrypt' || typeof salt !== 'string' || typeof expectedHex !== 'string') return false;
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(derived, expected);
}
