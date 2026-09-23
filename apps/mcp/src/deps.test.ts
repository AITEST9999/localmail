import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Decision 2.4: apps/mcp depends on the SDK + MCP SDK + zod only', () => {
  it('package.json declares only the allowed dependencies', async () => {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    expect(deps).toEqual(['@localmail/sdk', '@modelcontextprotocol/sdk', 'zod']);
  });
});
