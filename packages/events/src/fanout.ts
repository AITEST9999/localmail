import type { MessageEvent } from '@localmail/core';

/**
 * P3-17 fan-out plan for a durable event.
 *
 * Suppression point: `createDurableEventPublisher.emit()` — when
 * `message.received` carries `suppressAgentTriggers: true` (set by inbound
 * ingest on Auto-Submitted short-circuit), webhooks, WS, and jev-classify are
 * all skipped. The `events` row is still inserted for audit.
 *
 * Limitation (Jev `auto` fallback): classify runs *after* a normal
 * `message.received` has already fan-out. We cannot retract that delivery;
 * `message.labeled` with `auto` is the post-hoc signal. Agents that auto-reply
 * on `message.received` should also ignore messages later labeled `auto`, or
 * prefer waiting for labels.
 */
export function planEventFanout(event: MessageEvent): {
  webhooks: boolean;
  ws: boolean;
  jevClassify: boolean;
} {
  if (
    event.type === 'message.received' &&
    event.suppressAgentTriggers === true
  ) {
    return { webhooks: false, ws: false, jevClassify: false };
  }
  return {
    webhooks: true,
    ws: true,
    jevClassify: event.type === 'message.received',
  };
}
