import { redirect } from 'next/navigation';
import { api } from '../../../lib/api';
export default async function Domains() { const response = await api('/v1/domains'); if (!response) redirect('/login'); const body = await response.json() as { data: Array<{ id: string; domain: string; status: string; dns_records: unknown }> }; return <main><h1>Domains</h1>{body.data.map((domain) => <details key={domain.id}><summary>{domain.domain} — {domain.status}</summary><pre>{JSON.stringify(domain.dns_records, null, 2)}</pre></details>)}</main>; }
