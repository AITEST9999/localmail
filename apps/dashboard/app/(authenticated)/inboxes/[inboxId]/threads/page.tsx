import { redirect } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../../../lib/api';
import PageHeader from '../../../../../components/PageHeader';
import EmptyState from '../../../../../components/EmptyState';

const cellStyle: React.CSSProperties = {
  padding: '0 16px',
  height: 52,
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--lm-border)',
  fontSize: 13,
};

export default async function Threads({ params }: { params: Promise<{ inboxId: string }> }) {
  const { inboxId } = await params;

  const [threadsRes, inboxRes] = await Promise.allSettled([
    api(`/v1/inboxes/${inboxId}/threads`),
    api(`/v1/inboxes/${inboxId}`),
  ]);

  if (threadsRes.status === 'rejected' || threadsRes.value === null) redirect('/login');
  const response = threadsRes.value;

  const body = await response.json() as {
    data: Array<{ id: string; subject_normalized: string; preview: string | null; message_count: number; updated_at?: string }>;
  };

  let inboxAddress: string | null = null;
  if (inboxRes.status === 'fulfilled' && inboxRes.value) {
    try {
      const inbox = await inboxRes.value.json() as { address?: string };
      inboxAddress = inbox.address ?? null;
    } catch { /* ignore */ }
  }

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader
        title="Threads"
        breadcrumb={[
          { label: 'Inboxes', href: '/inboxes' },
          ...(inboxAddress ? [{ label: inboxAddress, href: `/inboxes/${inboxId}/threads` }] : []),
        ]}
        meta={body.data.length > 0 ? `${body.data.length}` : undefined}
      />

      {body.data.length === 0 ? (
        <EmptyState title="No threads in this inbox" />
      ) : (
        <div style={{ border: '1px solid var(--lm-border)', borderRadius: 'var(--lm-radius)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--lm-bg-elevated)' }}>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)' }}>Subject</th>
                <th style={{ padding: '0 16px', height: 40, textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-faint)', borderBottom: '1px solid var(--lm-border)', whiteSpace: 'nowrap' }}>Messages</th>
              </tr>
            </thead>
            <tbody>
              {body.data.map((thread) => (
                <tr key={thread.id} style={{ background: 'var(--lm-surface)' }} className="table-row-hover">
                  <td style={{ ...cellStyle, color: 'var(--lm-text)' }}>
                    <Link
                      href={`/inboxes/${inboxId}/threads/${thread.id}`}
                      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
                      className="address-link"
                    >
                      <span style={{ fontWeight: 500 }}>{thread.subject_normalized || '(no subject)'}</span>
                      {thread.preview && (
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--lm-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 600 }}>
                          {thread.preview}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td style={{ ...cellStyle, color: 'var(--lm-text-muted)', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 20,
                        padding: '0 8px',
                        background: 'var(--lm-bg)',
                        border: '1px solid var(--lm-border)',
                        borderRadius: 9999,
                        fontSize: 11,
                        fontWeight: 500,
                      }}
                    >
                      {thread.message_count}
                    </span>
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
