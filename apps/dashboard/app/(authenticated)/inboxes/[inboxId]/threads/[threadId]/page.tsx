import { redirect } from 'next/navigation';
import { api } from '../../../../../../lib/api';
import PageHeader from '../../../../../../components/PageHeader';
import MessageCard from '../../../../../../components/MessageCard';
import EmptyState from '../../../../../../components/EmptyState';

export default async function Thread({ params }: { params: Promise<{ inboxId: string; threadId: string }> }) {
  const { inboxId, threadId } = await params;

  const [threadRes, inboxRes] = await Promise.allSettled([
    api(`/v1/inboxes/${inboxId}/threads/${threadId}`),
    api(`/v1/inboxes/${inboxId}`),
  ]);

  if (threadRes.status === 'rejected' || threadRes.value === null) redirect('/login');
  const response = threadRes.value;

  const body = await response.json() as {
    thread: { subject_normalized: string };
    messages: Array<{
      id: string;
      from: string;
      text: string | null;
      html: string | null;
      message_id: string;
      received_at?: string;
      date?: string;
    }>;
  };

  let inboxAddress: string | null = null;
  if (inboxRes.status === 'fulfilled' && inboxRes.value) {
    try {
      const inbox = await inboxRes.value.json() as { address?: string };
      inboxAddress = inbox.address ?? null;
    } catch { /* ignore */ }
  }

  const subject = body.thread.subject_normalized || '(no subject)';

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <PageHeader
        title={subject}
        breadcrumb={[
          { label: 'Inboxes', href: '/inboxes' },
          { label: inboxAddress ?? 'Inbox', href: `/inboxes/${inboxId}/threads` },
          { label: 'Threads', href: `/inboxes/${inboxId}/threads` },
        ]}
        meta={`${body.messages.length} message${body.messages.length !== 1 ? 's' : ''}`}
      />

      {body.messages.length === 0 ? (
        <EmptyState title="No messages in this thread" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {body.messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}
