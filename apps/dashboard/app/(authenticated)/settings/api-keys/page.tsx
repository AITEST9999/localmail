import { redirect } from 'next/navigation';
import { api } from '../../../../lib/api';
export default async function ApiKeys() { const response = await api('/v1/api-keys'); if (!response) redirect('/login'); const body = await response.json() as { data: Array<{ id: string; prefix: string; scopes: string[] }> }; return <main><h1>API keys</h1><ul>{body.data.map((key) => <li key={key.id}>{key.prefix} — {key.scopes.join(', ')}</li>)}</ul></main>; }
