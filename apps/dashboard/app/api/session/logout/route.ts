import { NextResponse } from 'next/server';
import { COOKIE } from '../../../../lib/session';
import { buildRedirectUrl } from '../../../../lib/redirect';

export function POST(request: Request) {
  const response = NextResponse.redirect(buildRedirectUrl(request, '/login'));
  response.cookies.set(COOKIE, '', { expires: new Date(0), httpOnly: true, path: '/' });
  return response;
}
