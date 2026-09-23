export default function Login() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--lm-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Subtle radial cyan glow */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 600,
          height: 400,
          background: 'radial-gradient(ellipse at top, rgba(34, 211, 238, 0.08) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: 'var(--lm-surface)',
          border: '1px solid var(--lm-border)',
          borderRadius: 'var(--lm-radius-lg)',
          padding: '2rem',
          position: 'relative',
        }}
      >
        <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 600, color: 'var(--lm-text)' }}>
          LocalMail
        </h1>
        <p style={{ margin: '0 0 24px', fontSize: 13, color: 'var(--lm-text-muted)' }}>
          Sign in with a pod-scoped API key.
        </p>

        <form action="/api/session" method="post" style={{ display: 'grid', gap: 16 }}>
          <div>
            <label
              htmlFor="api_key"
              style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--lm-text-muted)', marginBottom: 6 }}
            >
              API key
            </label>
            <input
              id="api_key"
              name="api_key"
              type="password"
              required
              placeholder="lm_…"
              style={{
                display: 'block',
                width: '100%',
                height: 38,
                padding: '0 12px',
                background: 'var(--lm-bg-elevated)',
                border: '1px solid var(--lm-border)',
                borderRadius: 'var(--lm-radius-sm)',
                color: 'var(--lm-text)',
                fontSize: 13,
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: 'var(--lm-font-mono)',
              }}
            />
          </div>

          <button
            type="submit"
            style={{
              width: '100%',
              height: 36,
              background: 'var(--lm-accent)',
              color: '#06090f',
              border: 'none',
              borderRadius: 'var(--lm-radius-sm)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </form>

        <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--lm-text-faint)', textAlign: 'center' }}>
          Keys never leave this browser session cookie.
        </p>
      </div>
    </div>
  );
}
