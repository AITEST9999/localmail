import type { Readable } from 'node:stream';

import {
  SMTPServer,
  type SMTPServerSession,
} from 'smtp-server';

import type {
  InboxRecipient,
  InboundIngestOverrides,
  RecipientDirectory,
  RecipientPolicy,
} from './contracts.js';
import type { InboundIngestor } from './ingest.js';

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

interface AcceptedRecipient {
  inbox: InboxRecipient;
  ingest?: InboundIngestOverrides;
}

export interface CreateLocalMailSmtpServerOptions {
  directory: RecipientDirectory;
  policy: RecipientPolicy;
  ingestor: InboundIngestor;
}

export function createLocalMailSmtpServer({
  directory,
  policy,
  ingestor,
}: CreateLocalMailSmtpServerOptions): SMTPServer {
  const recipientsBySession = new Map<string, Map<string, AcceptedRecipient>>();

  return new SMTPServer({
    name: 'localmail',
    banner: 'LocalMail inbound SMTP',
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: MAX_MESSAGE_BYTES,

    onMailFrom(_address, session, callback) {
      recipientsBySession.set(session.id, new Map());
      callback();
    },

    onRcptTo(address, session, callback) {
      void validateRecipient(address.address, session)
        .then((accepted) => {
          const recipients =
            recipientsBySession.get(session.id) ??
            new Map<string, AcceptedRecipient>();
          recipients.set(accepted.inbox.address.toLowerCase(), accepted);
          recipientsBySession.set(session.id, recipients);
          callback();
        })
        .catch((error: unknown) => callback(toError(error)));
    },

    onData(stream, session, callback) {
      void handleData(stream, session)
        .then(() => callback(null, 'Message accepted for delivery'))
        .catch((error: unknown) => {
          const smtpError = toError(error);
          if (!('responseCode' in smtpError))
            Object.assign(smtpError, { responseCode: 451 });
          callback(smtpError);
        })
        .finally(() => recipientsBySession.delete(session.id));
    },

    onClose(session) {
      recipientsBySession.delete(session.id);
    },
  });

  async function validateRecipient(
    rawAddress: string,
    session: SMTPServerSession,
  ): Promise<AcceptedRecipient> {
    const address = rawAddress.trim().toLowerCase();
    const inbox = await directory.findByAddress(address);
    if (!inbox)
      throw smtpError(550, `Mailbox unavailable: ${address}`);

    const decision = await policy.evaluate({
      inbox,
      mailFrom:
        session.envelope.mailFrom === false
          ? null
          : session.envelope.mailFrom.address,
      remoteAddress: session.remoteAddress,
    });
    if (!decision.allowed)
      throw smtpError(550, decision.reason ?? 'Recipient blocked by policy');
    return { inbox, ingest: decision.ingest };
  }

  async function handleData(
    stream: Readable,
    session: SMTPServerSession,
  ): Promise<void> {
    const recipients = [...(recipientsBySession.get(session.id)?.values() ?? [])];
    if (recipients.length === 0)
      throw smtpError(554, 'No valid recipients supplied');

    const raw = await readStream(stream);
    for (const recipient of recipients) {
      await ingestor.ingest(raw, recipient.inbox, recipient.ingest);
    }
  }
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function smtpError(responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
