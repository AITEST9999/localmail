import type { OutboundMessageService } from './outbound.js';
import type { DraftSendTarget, DraftRow } from './store.js';

export interface DraftStatusStore {
  markDraftStatus(draftId: string, status: DraftRow['status']): Promise<void>;
}

/** Shared by the API manual-send route and the scheduled-send worker. */
export async function sendClaimedDraft(
  target: DraftSendTarget,
  outbound: OutboundMessageService,
  store: DraftStatusStore,
): Promise<Awaited<ReturnType<OutboundMessageService['send']>>> {
  const message = await outbound.send({
    sender: target.inbox,
    to: target.draft.to,
    cc: target.draft.cc,
    subject: target.draft.subject ?? '',
    text: target.draft.text,
    html: target.draft.html,
    existingThreadId: target.draft.threadId,
  });
  await store.markDraftStatus(target.draft.id, 'sent');
  return message;
}
