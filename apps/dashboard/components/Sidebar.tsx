import SidebarLink from './SidebarLink';

export default function Sidebar() {
  return (
    <aside
      style={{
        width: 'var(--lm-sidebar-w)',
        flexShrink: 0,
        background: 'var(--lm-bg-elevated)',
        borderRight: '1px solid var(--lm-border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {/* Logo row */}
      <div
        style={{
          height: 56,
          borderBottom: '1px solid var(--lm-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--lm-text)' }}>LocalMail</span>
      </div>

      {/* Nav */}
      <nav
        style={{
          flex: 1,
          padding: '12px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflowY: 'auto',
        }}
      >
        <SidebarLink href="/inboxes">Inboxes</SidebarLink>
        <SidebarLink href="/search">Search</SidebarLink>
        <SidebarLink href="/webhooks">Webhooks</SidebarLink>
        <SidebarLink href="/domains">Domains</SidebarLink>
        <SidebarLink href="/settings/api-keys">API keys</SidebarLink>
      </nav>

      {/* Footer */}
      <div style={{ borderTop: '1px solid var(--lm-border)', padding: 16 }}>
        <form action="/api/session/logout" method="post">
          <button
            type="submit"
            style={{
              width: '100%',
              height: 34,
              borderRadius: 6,
              border: '1px solid var(--lm-border)',
              background: 'transparent',
              color: 'var(--lm-text-muted)',
              fontSize: 13,
              cursor: 'pointer',
              transition: 'background 0.1s, color 0.1s',
            }}
            className="logout-btn-hover"
          >
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
