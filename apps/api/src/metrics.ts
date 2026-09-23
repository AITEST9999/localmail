import { Counter, Histogram, Registry } from 'prom-client';

export const metricsRegistry = new Registry();
export const httpRequests = new Counter({ name: 'localmail_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status_code'], registers: [metricsRegistry] });
export const httpDuration = new Histogram({ name: 'localmail_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status_code'], registers: [metricsRegistry] });
export const rateLimited = new Counter({ name: 'localmail_http_requests_rate_limited_total', help: 'Rate limited requests', labelNames: ['scope'], registers: [metricsRegistry] });
