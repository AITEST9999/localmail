import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

const COOKIE = 'localmail_session';
const secret = () => createHash('sha256').update(process.env.DASHBOARD_SESSION_SECRET ?? 'local-dev-dashboard-secret-change-me').digest();
export function seal(value: { apiKey: string; podId: string; issuedAt: number }): string { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', secret(), iv); const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.'); }
export function unseal(value: string): { apiKey: string; podId: string; issuedAt: number } | null { try { const [iv, tag, body] = value.split('.'); if (!iv || !tag || !body) return null; const decipher = createDecipheriv('aes-256-gcm', secret(), Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')) as { apiKey: string; podId: string; issuedAt: number }; return Date.now() - parsed.issuedAt < 24 * 60 * 60 * 1000 ? parsed : null; } catch { return null; } }
export async function getSession() { const value = (await cookies()).get(COOKIE)?.value; return value ? unseal(value) : null; }
export { COOKIE };
