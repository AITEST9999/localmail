interface Props {
  title: string;
  body?: string;
  action?: React.ReactNode;
}

export default function EmptyState({ title, body, action }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        textAlign: 'center',
      }}
    >
      <img src="/empty-inbox.svg" alt="" width={80} height={80} style={{ marginBottom: 20, opacity: 0.8 }} />
      <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: 'var(--lm-text)' }}>{title}</p>
      {body && (
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--lm-text-muted)', maxWidth: 360 }}>{body}</p>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
