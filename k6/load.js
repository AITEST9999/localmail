import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const base = __ENV.LOCALMAIL_API_URL || 'http://127.0.0.1:8080';
const key = __ENV.LOCALMAIL_API_KEY;
const inboxTarget = Number(__ENV.K6_INBOXES || 1000);
const messageTarget = Number(__ENV.K6_MESSAGES || 10000);
const errors = new Rate('localmail_errors');
export const options = {
  scenarios: { traffic: { executor: 'constant-arrival-rate', rate: Number(__ENV.K6_RPS || 20), timeUnit: '1s', duration: __ENV.K6_DURATION || '5m', preAllocatedVUs: 20, maxVUs: 200 } },
  thresholds: { 'http_req_duration{endpoint:send}': ['p(95)<500'], 'http_req_duration{endpoint:search}': ['p(95)<300'], http_req_failed: ['rate<0.01'], localmail_errors: ['rate<0.01'] },
};
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
export function setup() {
  const ids = [];
  for (let i = 0; i < inboxTarget; i++) {
    const response = http.post(`${base}/v1/inboxes`, JSON.stringify({ client_id: `k6-${i}`, username: `k6-${i}` }), { headers, tags: { endpoint: 'create_inbox' } });
    if (response.status === 201 || response.status === 200) ids.push(response.json('id'));
  }
  return { ids };
}
export default function (data) {
  if (!data.ids.length) return;
  const inbox = data.ids[(__ITER + __VU) % data.ids.length];
  const send = http.post(`${base}/v1/inboxes/${inbox}/messages/send`, JSON.stringify({ to: [`load-${__ITER}@example.test`], subject: 'k6 load', text: 'LocalMail load test' }), { headers, tags: { endpoint: 'send' } });
  errors.add(send.status >= 400); check(send, { 'send accepted': (r) => r.status < 400 });
  if (__ITER % 5 === 0) http.get(`${base}/v1/search?q=load`, { headers, tags: { endpoint: 'search' } });
  if (__ITER % 3 === 0) http.get(`${base}/v1/inboxes/${inbox}/threads`, { headers, tags: { endpoint: 'threads' } });
}
