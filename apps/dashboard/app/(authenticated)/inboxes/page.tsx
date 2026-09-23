import { redirect } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
import PageHeader from '../../../components/PageHeader';
import EmptyState from '../../../components/EmptyState';

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

const cellStyle: React.CSSProperties = {
  padding: '0 16px',
  height: 48,
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--lm-border)',
  fontSize: 13,
  color: 'var(--lm-text)',
};

const headerCellStyle: React.CSSProperties = {
  padding: '0 16px',
  height: 40,
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--lm-text-faint)',
  borderBottom: '1px solid var(--lm-border)',
  whiteSpace: 'nowrap',
};

export default async function Inboxes() {
  const response = await api('/v1/inboxes');
  if (!response) redirect('/login');
  const body = await response.json() as {
    data: Array<{ id: string; address: string; display_name: string | null; created_at: string }>;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader
        title="Inboxes"
        meta={body.data.length > 0 ? `${body.data.length} inbox${body.data.length !== 1 ? 'es' : ''}` : undefined}
      />

      {body.data.length === 0 ? (
        <EmptyState
          title="No inboxes yet"
          body="Create one via the API or SDK."
        />
      ) : (
        <div style={{ border: '1px solid var(--lm-border)', borderRadius: 'var(--lm-radius)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--lm-bg-elevated)' }}>
                <th style={headerCellStyle}>Address</th>
                <th style={headerCellStyle}>Display name</th>
                <th style={headerCellStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {body.data.map((inbox) => (
                <tr
                  key={inbox.id}
                  style={{ background: 'var(--lm-surface)' }}
                  className="table-row-hover"
                >
                  <td style={cellStyle}>
                    <Link
                      href={`/inboxes/${inbox.id}/threads`}
                      style={{
                        fontFamily: 'var(--lm-font-mono)',
                        fontSize: 12,
                        fontWeight: 500,
                        color: 'var(--lm-text)',
                      }}
                      className="address-link"
                    >
                      {inbox.address}
                    </Link>
                  </td>
                  <td style={{ ...cellStyle, color: inbox.display_name ? 'var(--lm-text)' : 'var(--lm-text-faint)' }}>
                    {inbox.display_name ?? 'Unnamed'}
                  </td>
                  <td style={{ ...cellStyle, color: 'var(--lm-text-muted)' }}>
                    {fmtDate(inbox.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
