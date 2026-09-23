interface Props {
  status: string;
}

const STATUS_MAP: Record<string, { bg: string; color: string; border?: string; label: string }> = {
  enabled:  { bg: 'var(--lm-success-muted)',  color: 'var(--lm-success)',      label: 'Enabled'  },
  verified: { bg: 'var(--lm-success-muted)',  color: 'var(--lm-success)',      label: 'Verified' },
  active:   { bg: 'var(--lm-success-muted)',  color: 'var(--lm-success)',      label: 'Active'   },
  pending:  { bg: 'var(--lm-warning-muted)',  color: 'var(--lm-warning)',      label: 'Pending'  },
  disabled: { bg: 'transparent',              color: 'var(--lm-text-faint)',   border: '1px solid var(--lm-border)', label: 'Disabled' },
  failed:   { bg: 'var(--lm-danger-muted)',   color: 'var(--lm-danger)',       label: 'Failed'   },
  error:    { bg: 'var(--lm-danger-muted)',   color: 'var(--lm-danger)',       label: 'Error'    },
};

export default function StatusPill({ status }: Props) {
  const key = status.toLowerCase();
  const v = STATUS_MAP[key] ?? { bg: 'transparent', color: 'var(--lm-text-muted)', border: '1px solid var(--lm-border)', label: status };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 500,
        background: v.bg,
        color: v.color,
        border: v.border ?? 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {v.label}
    </span>
  );
}
