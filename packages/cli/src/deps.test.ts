import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Decision 2.4: packages/cli depends on the SDK only', () => {
  it('package.json declares only the allowed dependencies', async () => {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    expect(deps).toEqual(['@localmail/sdk', 'commander']);
  });
});
