import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
import PageHeader from '../../../components/PageHeader';
import EmptyState from '../../../components/EmptyState';

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const response = q ? await api(`/v1/search?q=${encodeURIComponent(q)}`) : null;
  if (response === null && q) redirect('/login');
  const body = response
    ? (await response.json() as { data: Array<{ id: string; subject: string | null; rank: number }> })
    : { data: [] };

  return (
    <div style={{ padding: 24, maxWidth: 1280 }}>
      <PageHeader title="Search" />

      {/* Search field */}
      <form method="get" action="/search" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 8, maxWidth: 560 }}>
          <input
            name="q"
            defaultValue={q}
            placeholder="Search messages…"
            autoFocus={!q}
            style={{
              flex: 1,
              height: 40,
              padding: '0 12px',
              background: 'var(--lm-surface)',
              border: '1px solid var(--lm-border)',
              borderRadius: 'var(--lm-radius-sm)',
              color: 'var(--lm-text)',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <button
            type="submit"
            style={{
              height: 40,
              padding: '0 16px',
              background: 'var(--lm-surface)',
              border: '1px solid var(--lm-border)',
              borderRadius: 'var(--lm-radius-sm)',
              color: 'var(--lm-text-muted)',
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Search
          </button>
        </div>
      </form>

      {/* Results */}
      {!q ? (
        <EmptyState title="Search your messages" body="Enter a query above to search across all inboxes." />
      ) : body.data.length === 0 ? (
        <EmptyState title="No messages matched" body={`No results for "${q}".`} />
      ) : (
        <div style={{ border: '1px solid var(--lm-border)', borderRadius: 'var(--lm-radius)', overflow: 'hidden' }}>
          {body.data.map((item, i) => (
            <div
              key={item.id}
              style={{
                padding: '12px 16px',
                background: 'var(--lm-surface)',
                borderBottom: i < body.data.length - 1 ? '1px solid var(--lm-border)' : 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
              className="table-row-hover"
            >
              <span style={{ fontSize: 13, color: 'var(--lm-text)', fontWeight: 500 }}>
                {item.subject ?? '(no subject)'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
