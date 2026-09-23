export function buildRedirectUrl(request: Request, path: string): URL {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = request.headers.get('host') ?? 'localhost:3000';
  const resolvedHost = forwardedHost ?? (host.startsWith('0.0.0.0') ? 'localhost:3000' : host);
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return new URL(path, `${proto}://${resolvedHost}`);
}
