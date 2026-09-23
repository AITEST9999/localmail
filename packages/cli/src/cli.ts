import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { Command, CommanderError } from 'commander';

import { LocalMailError, LocalMailTimeoutError } from '@localmail/sdk';

import type { CliSdk } from './cli-sdk.js';
import {
  formatEvent,
  formatInbox,
  formatInboxList,
  formatSentMessage,
  formatThreadDetail,
  formatThreadList,
} from './format.js';

export interface CliOutput {
  write(chunk: string): void;
}

export interface CliDeps {
  sdkFactory: (opts: { apiUrl?: string; apiKey: string }) => CliSdk;
  stdout: CliOutput;
  stderr: CliOutput;
  env: Record<string, string | undefined>;
}

interface GlobalOpts {
  apiUrl?: string;
  apiKey?: string;
  json?: boolean;
}

/** A missing/invalid argument or flag — exit code 2, per P4-19 DoD. */
export class UsageError extends Error {}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function handleError(error: unknown, stderr: CliOutput, setExitCode: (code: number) => void): void {
  if (error instanceof UsageError) {
    stderr.write(`${error.message}\n`);
    setExitCode(2);
    return;
  }
  if (error instanceof LocalMailError) {
    stderr.write(`${error.code}: ${error.message}\n`);
    setExitCode(1);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  setExitCode(1);
}

function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name('localmail')
    .description('LocalMail CLI — inboxes, threads, and messages for agents')
    .option('--api-url <url>', 'API base URL (default: LOCALMAIL_API_URL or http://127.0.0.1:8080)')
    .option('--api-key <key>', 'API key (default: LOCALMAIL_API_KEY)')
    .option('--json', 'Print machine-readable JSON instead of human-readable text', false)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => deps.stdout.write(str),
      writeErr: (str) => deps.stderr.write(str),
    });

  function connect(command: Command): CliSdk {
    const opts = command.optsWithGlobals<GlobalOpts>();
    const apiUrl = opts.apiUrl ?? deps.env.LOCALMAIL_API_URL;
    const apiKey = opts.apiKey ?? deps.env.LOCALMAIL_API_KEY;
    if (!apiKey) {
      throw new UsageError('Missing API key. Pass --api-key or set LOCALMAIL_API_KEY.');
    }
    return deps.sdkFactory({ apiUrl, apiKey });
  }

  function output(command: Command, data: unknown, human: () => string): void {
    const opts = command.optsWithGlobals<GlobalOpts>();
    if (opts.json) {
      deps.stdout.write(`${JSON.stringify(data)}\n`);
    } else {
      deps.stdout.write(`${human()}\n`);
    }
  }

  const inbox = program.command('inbox').description('Manage inboxes');

  inbox
    .command('create')
    .description('Create an inbox')
    .option('--username <username>')
    .option('--display-name <name>')
    .option('--client-id <id>', 'Idempotency key — reuse it to get the same inbox back')
    .action(
      async (opts: { username?: string; displayName?: string; clientId?: string }, command: Command) => {
        try {
          const sdk = connect(command);
          const created = await sdk.inboxes.create({
            username: opts.username,
            display_name: opts.displayName,
            client_id: opts.clientId,
          });
          output(command, created, () => `Created inbox ${formatInbox(created)}`);
        } catch (error) {
          handleError(error, deps.stderr, setExitCode);
        }
      },
    );

  inbox
    .command('list')
    .description('List inboxes')
    .option('--limit <n>', 'Max results', (value) => Number(value))
    .action(async (opts: { limit?: number }, command: Command) => {
      try {
        const sdk = connect(command);
        const page = await sdk.inboxes.list({ limit: opts.limit });
        output(command, page.data, () => formatInboxList(page.data));
      } catch (error) {
        handleError(error, deps.stderr, setExitCode);
      }
    });

  program
    .command('send')
    .description('Send a new message from an inbox')
    .argument('<inbox>', 'Inbox ID or address')
    .requiredOption('--subject <subject>', 'Subject')
    .option('--to <address>', 'Recipient (repeatable)', collect, [] as string[])
    .option('--cc <address>', 'CC recipient (repeatable)', collect, [] as string[])
    .option('--text <text>', 'Plain-text body')
    .option('--html <html>', 'HTML body')
    .option('--text-file <path>', 'Read the plain-text body from a file')
    .option('--attach <path>', 'Attach a file (repeatable)', collect, [] as string[])
    .action(
      async (
        inboxArg: string,
        opts: {
          subject: string;
          to: string[];
          cc: string[];
          text?: string;
          html?: string;
          textFile?: string;
          attach: string[];
        },
        command: Command,
      ) => {
        try {
          const sdk = connect(command);
          if (opts.to.length === 0) throw new UsageError('At least one --to is required.');
          const text = opts.textFile ? readFileSync(opts.textFile, 'utf8') : opts.text;
          if (!text && !opts.html) throw new UsageError('Provide --text, --html, or --text-file.');
          const inboxRecord = await sdk.inboxes.resolve(inboxArg);
          const attachments = opts.attach.map((path) => ({
            filename: basename(path),
            content: readFileSync(path),
          }));
          const message = await sdk.messages.send(inboxRecord.id, {
            to: opts.to,
            cc: opts.cc.length ? opts.cc : undefined,
            subject: opts.subject,
            text: text ?? undefined,
            html: opts.html ?? undefined,
            attachments: attachments.length ? attachments : undefined,
          });
          output(command, { id: message.id, thread_id: message.thread_id }, () =>
            formatSentMessage(message, 'Sent'),
          );
        } catch (error) {
          handleError(error, deps.stderr, setExitCode);
        }
      },
    );

  program
    .command('reply')
    .description('Reply to a specific message')
    .argument('<inbox>', 'Inbox ID or address')
    .argument('<messageId>', 'Message ID to reply to')
    .option('--text <text>', 'Plain-text body')
    .option('--html <html>', 'HTML body')
    .option('--all', 'Reply to all recipients', false)
    .action(
      async (
        inboxArg: string,
        messageId: string,
        opts: { text?: string; html?: string; all?: boolean },
        command: Command,
      ) => {
        try {
          const sdk = connect(command);
          if (!opts.text && !opts.html) throw new UsageError('Provide --text or --html.');
          const inboxRecord = await sdk.inboxes.resolve(inboxArg);
          const message = await sdk.messages.reply(inboxRecord.id, messageId, {
            text: opts.text,
            html: opts.html,
            replyAll: opts.all,
          });
          output(command, { id: message.id, thread_id: message.thread_id }, () =>
            formatSentMessage(message, 'Replied with'),
          );
        } catch (error) {
          handleError(error, deps.stderr, setExitCode);
        }
      },
    );

  program
    .command('threads')
    .description('List threads in an inbox, or show one thread')
    .argument('<inbox>', 'Inbox ID or address')
    .argument('[threadId]', 'Show this thread instead of listing')
    .option('--labels <labels>', 'Comma-separated label filter')
    .option('--limit <n>', 'Max results', (value) => Number(value))
    .action(
      async (
        inboxArg: string,
        threadId: string | undefined,
        opts: { labels?: string; limit?: number },
        command: Command,
      ) => {
        try {
          const sdk = connect(command);
          const inboxRecord = await sdk.inboxes.resolve(inboxArg);
          if (threadId) {
            const { thread, messages } = await sdk.threads.get(inboxRecord.id, threadId);
            output(command, { thread, messages }, () => formatThreadDetail(thread, messages));
          } else {
            const labels = opts.labels ? opts.labels.split(',') : undefined;
            const page = await sdk.threads.list(inboxRecord.id, { labels, limit: opts.limit });
            output(command, page.data, () => formatThreadList(page.data));
          }
        } catch (error) {
          handleError(error, deps.stderr, setExitCode);
        }
      },
    );

  program
    .command('tail')
    .description('Stream events for an inbox until interrupted')
    .argument('<inbox>', 'Inbox ID or address')
    .option('--events <types>', 'Comma-separated event types (default: all)')
    .action(async (inboxArg: string, opts: { events?: string }, command: Command) => {
      try {
        const sdk = connect(command);
        const inboxRecord = await sdk.inboxes.resolve(inboxArg);
        const eventTypes = opts.events ? opts.events.split(',') : undefined;
        const { events, close, ready } = await sdk.subscribe({ inboxIds: [inboxRecord.id], eventTypes });
        await ready;
        const globalOpts = command.optsWithGlobals<GlobalOpts>();
        const onSignal = () => close();
        process.once('SIGINT', onSignal);
        try {
          for await (const event of events) {
            if (globalOpts.json) {
              deps.stdout.write(`${JSON.stringify(event)}\n`);
            } else {
              deps.stdout.write(`${formatEvent(event)}\n`);
            }
          }
        } finally {
          process.off('SIGINT', onSignal);
        }
      } catch (error) {
        handleError(error, deps.stderr, setExitCode);
      }
    });

  program
    .command('wait')
    .description('Wait for a matching email to arrive')
    .argument('<inbox>', 'Inbox ID or address')
    .option('--from <address>', 'Substring match against the sender address')
    .option('--subject <text>', 'Substring match against the subject')
    .option('--timeout <seconds>', 'Timeout in seconds', (value) => Number(value), 60)
    .action(
      async (
        inboxArg: string,
        opts: { from?: string; subject?: string; timeout: number },
        command: Command,
      ) => {
        try {
          const sdk = connect(command);
          const inboxRecord = await sdk.inboxes.resolve(inboxArg);
          try {
            const message = await sdk.waitForEmail(inboxRecord.id, {
              from: opts.from,
              subject: opts.subject,
              timeoutMs: opts.timeout * 1000,
            });
            output(command, { status: 'found', id: message.id, thread_id: message.thread_id }, () =>
              `Found message ${message.id} in thread ${message.thread_id}`,
            );
          } catch (error) {
            if (error instanceof LocalMailTimeoutError) {
              output(command, { status: 'timeout' }, () => 'Timed out waiting for a matching email.');
              setExitCode(1);
              return;
            }
            throw error;
          }
        } catch (error) {
          handleError(error, deps.stderr, setExitCode);
        }
      },
    );

  return program;
}

/** Parses `argv` (no leading node/script entries) and returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode = 0;
  const setExitCode = (code: number): void => {
    exitCode = code;
  };
  const program = buildProgram(deps, setExitCode);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
  return exitCode;
}
