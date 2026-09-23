import { NextResponse } from 'next/server';
import { LocalMail } from '@localmail/sdk';
import { COOKIE, seal } from '../../../lib/session';
export async function POST(request: Request) { const form = await request.formData(); const value = form.get('api_key'); const apiKey = typeof value === 'string' ? value : ''; try { const me = await new LocalMail({ baseUrl: process.env.LOCALMAIL_API_URL, apiKey }).me(); const response = NextResponse.redirect(new URL('/inboxes', request.url)); response.cookies.set(COOKIE, seal({ apiKey, podId: me.pod_id, issuedAt: Date.now() }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400, path: '/' }); return response; } catch { return NextResponse.redirect(new URL('/login?error=invalid_api_key', request.url)); } }
