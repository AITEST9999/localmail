import type { WebSocket as WsSocket } from 'ws';
import { WebSocket } from 'ws';
import type { Redis } from 'ioredis';

import {
  wsChannelForPod,
  type WebhookEventEnvelope,
} from '@localmail/events';

/** Documented Phase 0–5 event types (design §2) — webhook.test excluded. */
export const KNOWN_EVENT_TYPES = new Set([
  'message.received',
  'message.sent',
  'message.delivered',
  'message.bounced',
  'message.labeled',
  'thread.created',
  'domain.verified',
]);

export const WS_PING_INTERVAL_MS = 30_000;
export const WS_PONG_TIMEOUT_MS = 10_000;
export const WS_CLOSE_KEEPALIVE_TIMEOUT = 4000;

export interface ConnectionFilter {
  /** null = all inboxes; [] = none; otherwise exact allow-list. */
  inboxIds: string[] | null;
  /** null = all known types; [] = none; otherwise exact allow-list. */
  eventTypes: string[] | null;
}

export interface WsConnectionState {
  socket: WsSocket;
  podId: string;
  filter: ConnectionFilter | null;
  pingTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
  alive: boolean;
}

export interface WsHub {
  addConnection(podId: string, socket: WsSocket): WsConnectionState;
  removeConnection(state: WsConnectionState): Promise<void>;
  handleClientMessage(
    state: WsConnectionState,
    raw: string,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface CreateWsHubOptions {
  subscriber: Redis;
  findInboxById(
    podId: string,
    inboxId: string,
  ): Promise<{ id: string } | null>;
}

export function matchesFilter(
  envelope: WebhookEventEnvelope,
  filter: ConnectionFilter,
): boolean {
  const inboxId =
    typeof envelope.data.inbox_id === 'string' ? envelope.data.inbox_id : null;

  if (filter.inboxIds !== null) {
    if (filter.inboxIds.length === 0) return false;
    if (!inboxId || !filter.inboxIds.includes(inboxId)) return false;
  }

  if (filter.eventTypes !== null) {
    if (filter.eventTypes.length === 0) return false;
    if (!filter.eventTypes.includes(envelope.type)) return false;
  }

  return true;
}

export function createWsHub(options: CreateWsHubOptions): WsHub {
  const connectionsByPod = new Map<string, Set<WsConnectionState>>();
  const lookupInbox = (podId: string, inboxId: string) =>
    options.findInboxById(podId, inboxId);

  options.subscriber.on('message', (channel, message) => {
    const prefix = 'localmail:ws:';
    if (!channel.startsWith(prefix)) return;
    const podId = channel.slice(prefix.length);
    const sockets = connectionsByPod.get(podId);
    if (!sockets || sockets.size === 0) return;

    let envelope: WebhookEventEnvelope;
    try {
      envelope = JSON.parse(message) as WebhookEventEnvelope;
    } catch {
      return;
    }

    for (const state of sockets) {
      if (!state.filter) continue;
      if (!matchesFilter(envelope, state.filter)) continue;
      if (state.socket.readyState !== WebSocket.OPEN) continue;
      state.socket.send(JSON.stringify({ type: 'event', event: envelope }));
    }
  });

  return {
    addConnection(podId, socket) {
      const state: WsConnectionState = {
        socket,
        podId,
        filter: null,
        alive: true,
      };
      let set = connectionsByPod.get(podId);
      if (!set) {
        set = new Set();
        connectionsByPod.set(podId, set);
        void options.subscriber.subscribe(wsChannelForPod(podId));
      }
      set.add(state);
      startKeepalive(state);
      return state;
    },

    async removeConnection(state) {
      stopKeepalive(state);
      const set = connectionsByPod.get(state.podId);
      if (!set) return;
      set.delete(state);
      if (set.size === 0) {
        connectionsByPod.delete(state.podId);
        await options.subscriber.unsubscribe(wsChannelForPod(state.podId));
      }
    },

    async handleClientMessage(state, raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendError(state, 'invalid_message', 'Frame must be valid JSON.');
        return;
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('type' in parsed) ||
        (parsed as { type?: unknown }).type !== 'subscribe'
      ) {
        sendError(
          state,
          'invalid_message',
          'Unrecognized message type; expected subscribe.',
        );
        return;
      }

      const message = parsed as {
        type: 'subscribe';
        inbox_ids?: unknown;
        event_types?: unknown;
      };

      const resolved = await resolveSubscribeFilter(
        state.podId,
        message,
        lookupInbox,
      );
      if ('error' in resolved) {
        sendError(state, resolved.error.code, resolved.error.message);
        return;
      }

      state.filter = resolved.filter;
      state.socket.send(
        JSON.stringify({
          type: 'subscribed',
          inbox_ids: resolved.filter.inboxIds,
          event_types: resolved.filter.eventTypes,
        }),
      );
    },

    close() {
      for (const set of connectionsByPod.values()) {
        for (const state of set) {
          stopKeepalive(state);
          if (state.socket.readyState === WebSocket.OPEN) {
            state.socket.close(1001, 'server shutting down');
          }
        }
      }
      connectionsByPod.clear();
      return Promise.resolve();
    },
  };
}

export async function resolveSubscribeFilter(
  podId: string,
  message: { inbox_ids?: unknown; event_types?: unknown },
  findInboxById: (
    podId: string,
    inboxId: string,
  ) => Promise<{ id: string } | null>,
): Promise<
  | { filter: ConnectionFilter }
  | {
      error: {
        code: 'invalid_inbox_id' | 'invalid_event_type';
        message: string;
      };
    }
> {
  let inboxIds: string[] | null;
  if (message.inbox_ids === undefined || message.inbox_ids === null) {
    inboxIds = null;
  } else if (!Array.isArray(message.inbox_ids)) {
    return {
      error: {
        code: 'invalid_inbox_id',
        message: 'inbox_ids must be an array, null, or omitted.',
      },
    };
  } else {
    const ids = message.inbox_ids.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (ids.length !== message.inbox_ids.length) {
      return {
        error: {
          code: 'invalid_inbox_id',
          message: 'inbox_ids entries must be non-empty strings.',
        },
      };
    }
    for (const inboxId of ids) {
      const found = await findInboxById(podId, inboxId);
      if (!found) {
        return {
          error: {
            code: 'invalid_inbox_id',
            message: `Inbox ${inboxId} was not found.`,
          },
        };
      }
    }
    inboxIds = ids;
  }

  let eventTypes: string[] | null;
  if (message.event_types === undefined || message.event_types === null) {
    eventTypes = null;
  } else if (!Array.isArray(message.event_types)) {
    return {
      error: {
        code: 'invalid_event_type',
        message: 'event_types must be an array, null, or omitted.',
      },
    };
  } else {
    const types = message.event_types.filter(
      (type): type is string => typeof type === 'string',
    );
    if (types.length !== message.event_types.length) {
      return {
        error: {
          code: 'invalid_event_type',
          message: 'event_types entries must be strings.',
        },
      };
    }
    for (const type of types) {
      if (!KNOWN_EVENT_TYPES.has(type)) {
        return {
          error: {
            code: 'invalid_event_type',
            message: `Unknown event type: ${type}`,
          },
        };
      }
    }
    eventTypes = types;
  }

  return { filter: { inboxIds, eventTypes } };
}

function sendError(
  state: WsConnectionState,
  code: string,
  message: string,
): void {
  if (state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: 'error', code, message }));
}

function startKeepalive(state: WsConnectionState): void {
  state.alive = true;
  state.socket.on('pong', () => {
    state.alive = true;
    if (state.pongTimer) {
      clearTimeout(state.pongTimer);
      state.pongTimer = undefined;
    }
  });

  state.pingTimer = setInterval(() => {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    state.alive = false;
    state.socket.ping();
    state.pongTimer = setTimeout(() => {
      if (!state.alive && state.socket.readyState === WebSocket.OPEN) {
        state.socket.close(WS_CLOSE_KEEPALIVE_TIMEOUT, 'keepalive timeout');
      }
    }, WS_PONG_TIMEOUT_MS);
  }, WS_PING_INTERVAL_MS);
}

function stopKeepalive(state: WsConnectionState): void {
  if (state.pingTimer) clearInterval(state.pingTimer);
  if (state.pongTimer) clearTimeout(state.pongTimer);
  state.pingTimer = undefined;
  state.pongTimer = undefined;
}
