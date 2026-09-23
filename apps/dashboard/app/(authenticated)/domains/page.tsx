import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
import PageHeader from '../../../components/PageHeader';
import EmptyState from '../../../components/EmptyState';
import StatusPill from '../../../components/StatusPill';

export default async function Domains() {
  const response = await api('/v1/domains');
  if (!response) redirect('/login');
  const body = await response.json() as {
    data: Array<{ id: string; domain: string; status: string; dns_records: unknown }>;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader
        title="Domains"
        meta={body.data.length > 0 ? `${body.data.length}` : undefined}
      />

      {body.data.length === 0 ? (
        <EmptyState title="No domains configured" body="Add a custom domain via the API to send from your own addresses." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {body.data.map((domain) => (
            <details
              key={domain.id}
              style={{
                background: 'var(--lm-surface)',
                border: '1px solid var(--lm-border)',
                borderRadius: 'var(--lm-radius)',
                overflow: 'hidden',
              }}
            >
              <summary
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  cursor: 'pointer',
                  listStyle: 'none',
                  userSelect: 'none',
                }}
                className="details-summary-hover"
              >
                <span
                  style={{
                    fontFamily: 'var(--lm-font-mono)',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--lm-text)',
                    flex: 1,
                  }}
                >
                  {domain.domain}
                </span>
                <StatusPill status={domain.status} />
                <span style={{ fontSize: 11, color: 'var(--lm-text-faint)' }}>DNS records ▾</span>
              </summary>
              <div
                style={{
                  borderTop: '1px solid var(--lm-border)',
                  padding: 16,
                }}
              >
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    padding: '12px 14px',
                    background: 'var(--lm-bg)',
                    border: '1px solid var(--lm-border)',
                    borderRadius: 6,
                    fontSize: 12,
                    color: 'var(--lm-text-muted)',
                    overflowX: 'auto',
                    lineHeight: 1.6,
                  }}
                >
                  {JSON.stringify(domain.dns_records, null, 2)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
