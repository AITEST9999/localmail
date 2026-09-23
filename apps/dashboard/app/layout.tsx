import './globals.css';
import Link from 'next/link';

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><nav style={{ padding: '1rem 2rem', borderBottom: '1px solid #ddd', display: 'flex', gap: '1rem' }}><strong>LocalMail</strong><Link href="/inboxes">Inboxes</Link><Link href="/search">Search</Link><Link href="/webhooks">Webhooks</Link><Link href="/domains">Domains</Link><Link href="/settings/api-keys">API keys</Link><form action="/api/session/logout" method="post" style={{ marginLeft: 'auto' }}><button>Log out</button></form></nav>{children}</body></html>;
}
