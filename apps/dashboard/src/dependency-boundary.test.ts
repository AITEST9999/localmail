import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('dashboard dependency boundary', () => {
  it('depends on SDK only, never database or Jev packages', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    expect(names).not.toContain('@localmail/db');
    expect(names).not.toContain('@localmail/jev');
    expect(names).toContain('@localmail/sdk');
  });
});
