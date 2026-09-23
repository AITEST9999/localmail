import sanitizeHtml from 'sanitize-html';

interface Message {
  id: string;
  from: string;
  text: string | null;
  html: string | null;
  message_id: string;
  received_at?: string;
  date?: string;
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export default function MessageCard({ message }: { message: Message }) {
  const dateStr = formatDate(message.received_at ?? message.date);
  const cleanHtml = message.html ? sanitizeHtml(message.html) : null;

  return (
    <article
      style={{
        background: 'var(--lm-surface)',
        border: '1px solid var(--lm-border)',
        borderRadius: 'var(--lm-radius)',
        padding: 16,
      }}
    >
      {/* Meta row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span
          style={{
            fontFamily: 'var(--lm-font-mono)',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--lm-text)',
          }}
        >
          {message.from}
        </span>
        {dateStr && (
          <span style={{ fontSize: 12, color: 'var(--lm-text-faint)' }}>{dateStr}</span>
        )}
      </div>

      {/* Body — prefer text; show html island if text absent */}
      {message.text && (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--lm-text)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.text}
        </p>
      )}

      {cleanHtml && !message.text && (
        <div
          className="lm-email-island"
          dangerouslySetInnerHTML={{ __html: cleanHtml }}
        />
      )}

      {cleanHtml && message.text && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, color: 'var(--lm-text-faint)', cursor: 'pointer' }}>
            HTML version
          </summary>
          <div className="lm-email-island" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: cleanHtml }} />
        </details>
      )}

      {/* Raw headers */}
      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: 12, color: 'var(--lm-text-faint)', cursor: 'pointer' }}>
          Raw headers
        </summary>
        <code
          style={{
            display: 'block',
            marginTop: 8,
            fontFamily: 'var(--lm-font-mono)',
            fontSize: 12,
            color: 'var(--lm-text-muted)',
            wordBreak: 'break-all',
            background: 'var(--lm-bg)',
            border: '1px solid var(--lm-border)',
            borderRadius: 4,
            padding: '8px 10px',
          }}
        >
          {message.message_id}
        </code>
      </details>
    </article>
  );
}
