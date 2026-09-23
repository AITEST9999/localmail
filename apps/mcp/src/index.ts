#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { LocalMail, LocalMailConfigError } from '@localmail/sdk';

import { createServer } from './server.js';

/**
 * Config comes from LOCALMAIL_API_URL / LOCALMAIL_API_KEY env only (§P4-20).
 * stdout is reserved for the MCP protocol — every log line here goes to
 * stderr instead.
 */
async function main(): Promise<void> {
  let client: LocalMail;
  try {
    client = new LocalMail();
  } catch (error) {
    if (error instanceof LocalMailConfigError) {
      console.error(`localmail-mcp: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`localmail-mcp: connected over stdio (${client.baseUrl})`);
}

main().catch((error: unknown) => {
  console.error('localmail-mcp: fatal error', error);
  process.exitCode = 1;
});
