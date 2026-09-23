import Link from 'next/link';

interface Crumb {
  label: string;
  href: string;
}

interface Props {
  title: string;
  breadcrumb?: Crumb[];
  meta?: string;
  action?: React.ReactNode;
}

export default function PageHeader({ title, breadcrumb, meta, action }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
      <div>
        {breadcrumb && breadcrumb.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, fontSize: 12, color: 'var(--lm-text-faint)' }}>
            {breadcrumb.map((crumb, i) => (
              <span key={crumb.href} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <span>/</span>}
                <Link href={crumb.href} style={{ color: 'var(--lm-text-muted)' }}>{crumb.label}</Link>
              </span>
            ))}
          </div>
        )}
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--lm-text)', lineHeight: '28px' }}>
          {title}
          {meta && (
            <span style={{ marginLeft: 10, fontSize: 14, fontWeight: 400, color: 'var(--lm-text-muted)' }}>
              {meta}
            </span>
          )}
        </h1>
      </div>
      {action}
    </div>
  );
}
