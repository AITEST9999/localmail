export const WEBHOOK_DELIVER_QUEUE = 'webhook-deliver' as const;
export const WEBHOOK_DELIVER_JOB = 'deliver-webhook' as const;

export interface WebhookDeliverJobData {
  deliveryId: string;
}

export const WEBHOOK_DELIVER_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'custom' as const },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const JEV_CLASSIFY_QUEUE = 'jev-classify' as const;
export const JEV_CLASSIFY_JOB = 'classify-message' as const;

export interface JevClassifyJobData {
  messageId: string;
}

export const JEV_CLASSIFY_JOB_OPTIONS = {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const EMBED_MESSAGE_QUEUE = 'embed-message' as const;
export const EMBED_MESSAGE_JOB = 'embed-message' as const;
export interface EmbedMessageJobData { messageId: string }
export const EMBED_MESSAGE_JOB_OPTIONS = {
  attempts: 3,
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
