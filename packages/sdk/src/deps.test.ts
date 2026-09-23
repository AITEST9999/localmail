import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Decision 2.4: packages/sdk has zero @localmail/* dependencies', () => {
  it('package.json declares no workspace deps', async () => {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const localmailDeps = Object.keys(allDeps).filter((name) => name.startsWith('@localmail/'));
    expect(localmailDeps).toEqual([]);
  });
});
