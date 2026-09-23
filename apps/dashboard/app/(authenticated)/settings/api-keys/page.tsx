import { redirect } from 'next/navigation';
import { api } from '../../../../lib/api';
import PageHeader from '../../../../components/PageHeader';
import EmptyState from '../../../../components/EmptyState';
import ScopeChip from '../../../../components/ScopeChip';

const cellStyle: React.CSSProperties = {
  padding: '0 16px',
  height: 48,
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--lm-border)',
  fontSize: 13,
};

export default async function ApiKeys() {
  const response = await api('/v1/api-keys');
  if (!response) redirect('/login');
  const body = await response.json() as {
    data: Array<{ id: string; prefix: string; scopes: string[] }>;
  };

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader
        title="API keys"
        meta={body.data.length > 0 ? `${body.data.length}` : undefined}
      />

      {body.data.length === 0 ? (
        <EmptyState title="No API keys" body="Create API keys via the API to authenticate SDK clients." />
      ) : (
        <div style={{ border: '1px solid var(--lm-border)', borderRadius: 'var(--lm-radius)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--lm-bg-elevated)' }}>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>Prefix</th>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>Scopes</th>
              </tr>
            </thead>
            <tbody>
              {body.data.map((key) => (
                <tr key={key.id} style={{ background: 'var(--lm-surface)' }} className="table-row-hover">
                  <td style={{ ...cellStyle, fontFamily: 'var(--lm-font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--lm-text)' }}>
                    {key.prefix}
                  </td>
                  <td style={cellStyle}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {key.scopes.map((scope) => (
                        <ScopeChip key={scope} label={scope} />
                      ))}
                    </div>
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
