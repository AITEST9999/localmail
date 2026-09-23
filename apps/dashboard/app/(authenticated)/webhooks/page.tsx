import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
import PageHeader from '../../../components/PageHeader';
import EmptyState from '../../../components/EmptyState';
import StatusPill from '../../../components/StatusPill';

const cellStyle: React.CSSProperties = {
  padding: '0 16px',
  height: 48,
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--lm-border)',
  fontSize: 13,
  color: 'var(--lm-text)',
};

export default async function Webhooks() {
  const response = await api('/v1/webhooks');
  if (!response) redirect('/login');
  const body = await response.json() as {
    data: Array<{ id: string; url: string; enabled: boolean }>;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader
        title="Webhooks"
        meta={body.data.length > 0 ? `${body.data.length}` : undefined}
      />

      {body.data.length === 0 ? (
        <EmptyState title="No webhooks configured" body="Register a webhook via the API to receive event notifications." />
      ) : (
        <div style={{ border: '1px solid var(--lm-border)', borderRadius: 'var(--lm-radius)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--lm-bg-elevated)' }}>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>URL</th>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>Status</th>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>ID</th>
              </tr>
            </thead>
            <tbody>
              {body.data.map((hook) => (
                <tr key={hook.id} style={{ background: 'var(--lm-surface)' }} className="table-row-hover">
                  <td style={{ ...cellStyle, maxWidth: 400 }}>
                    <span
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={hook.url}
                    >
                      {hook.url}
                    </span>
                  </td>
                  <td style={cellStyle}>
                    <StatusPill status={hook.enabled ? 'enabled' : 'disabled'} />
                  </td>
                  <td style={{ ...cellStyle, fontFamily: 'var(--lm-font-mono)', fontSize: 12, color: 'var(--lm-text-faint)' }}>
                    {hook.id}
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
