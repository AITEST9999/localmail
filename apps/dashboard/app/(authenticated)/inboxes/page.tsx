import { redirect } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
export default async function Inboxes() { const response = await api('/v1/inboxes'); if (!response) redirect('/login'); const body = await response.json() as { data: Array<{ id: string; address: string; display_name: string | null; created_at: string }> }; return <main><h1>Inboxes</h1><ul>{body.data.map((inbox) => <li key={inbox.id}><Link href={`/inboxes/${inbox.id}/threads`}>{inbox.address}</Link> — {inbox.display_name ?? 'Unnamed'}</li>)}</ul></main>; }
