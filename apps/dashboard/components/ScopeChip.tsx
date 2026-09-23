export default function ScopeChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 6px',
        borderRadius: 4,
        border: '1px solid var(--lm-border)',
        background: 'var(--lm-surface)',
        fontFamily: 'var(--lm-font-mono)',
        fontSize: 11,
        color: 'var(--lm-text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
