import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
export default async function Webhooks() { const response = await api('/v1/webhooks'); if (!response) redirect('/login'); const body = await response.json() as { data: Array<{ id: string; url: string; enabled: boolean }> }; return <main><h1>Webhooks</h1><ul>{body.data.map((hook) => <li key={hook.id}>{hook.url} — {hook.enabled ? 'enabled' : 'disabled'}</li>)}</ul></main>; }
