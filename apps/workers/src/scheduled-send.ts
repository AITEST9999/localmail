import {
  sendClaimedDraft,
  type DraftStatusStore,
} from '@localmail/api/draft-service';
import type {
  DraftSendTarget,
  DraftRow,
} from '@localmail/api/store';
import type { OutboundMessageService } from '@localmail/api/outbound';

export const DEFAULT_SCHEDULED_SEND_POLL_INTERVAL_MS = 5_000;
export const SCHEDULED_SEND_BATCH_SIZE = 20;

export interface ScheduledDraftStore extends DraftStatusStore {
  listDueDraftIds(limit: number): Promise<string[]>;
  claimScheduledDraft(draftId: string): Promise<DraftSendTarget | null>;
}

export interface ScheduledSendPoller {
  tick(): Promise<number>;
  close(): Promise<void>;
}

export interface ScheduledSendPollerOptions {
  store: ScheduledDraftStore;
  outbound: OutboundMessageService;
  intervalMs?: number;
  batchSize?: number;
  onError?: (draftId: string, error: unknown) => void;
}

export function createScheduledSendPoller(
  options: ScheduledSendPollerOptions,
): ScheduledSendPoller {
  const intervalMs =
    options.intervalMs ?? DEFAULT_SCHEDULED_SEND_POLL_INTERVAL_MS;
  const batchSize = options.batchSize ?? SCHEDULED_SEND_BATCH_SIZE;
  let activeTick: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<number> => {
    if (activeTick) return activeTick;
    activeTick = runScheduledSendTick(options, batchSize).finally(() => {
      activeTick = null;
    });
    return activeTick;
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    tick,
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      if (activeTick) await activeTick;
    },
  };
}

export async function runScheduledSendTick(
  options: ScheduledSendPollerOptions,
  batchSize = SCHEDULED_SEND_BATCH_SIZE,
): Promise<number> {
  const ids = await options.store.listDueDraftIds(batchSize);
  let sent = 0;
  for (const draftId of ids) {
    const target = await options.store.claimScheduledDraft(draftId);
    if (!target) continue;
    try {
      await sendClaimedDraft(target, options.outbound, options.store);
      sent += 1;
    } catch (error) {
      await options.store.markDraftStatus(draftId, 'failed');
      options.onError?.(draftId, error);
    }
  }
  return sent;
}

export type { DraftRow };
