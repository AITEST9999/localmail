import { redirect } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../../../lib/api';
export default async function Threads({ params }: { params: Promise<{ inboxId: string }> }) { const { inboxId } = await params; const response = await api(`/v1/inboxes/${inboxId}/threads`); if (!response) redirect('/login'); const body = await response.json() as { data: Array<{ id: string; subject_normalized: string; preview: string | null; message_count: number }> }; return <main><h1>Threads</h1><ul>{body.data.map((thread) => <li key={thread.id}><Link href={`/inboxes/${inboxId}/threads/${thread.id}`}>{thread.subject_normalized || '(no subject)'}</Link> — {thread.message_count} messages — {thread.preview ?? ''}</li>)}</ul></main>; }
