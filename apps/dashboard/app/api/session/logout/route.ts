import { NextResponse } from 'next/server';
import { COOKIE } from '../../../../lib/session';
export function POST(request: Request) { const response = NextResponse.redirect(new URL('/login', request.url)); response.cookies.set(COOKIE, '', { expires: new Date(0), httpOnly: true, path: '/' }); return response; }
