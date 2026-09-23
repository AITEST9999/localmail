'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Props {
  href: string;
  children: React.ReactNode;
}

export default function SidebarLink({ href, children }: Props) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(href + '/');

  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 36,
        padding: '0 12px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 400,
        borderLeft: isActive ? '2px solid var(--lm-accent)' : '2px solid transparent',
        background: isActive ? 'var(--lm-accent-muted)' : 'transparent',
        color: isActive ? 'var(--lm-accent)' : 'var(--lm-text-muted)',
        textDecoration: 'none',
        transition: 'background 0.1s, color 0.1s',
      }}
      className={isActive ? '' : 'sidebar-link-hover'}
    >
      {children}
    </Link>
  );
}
