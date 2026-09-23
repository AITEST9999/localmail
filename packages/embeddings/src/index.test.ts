import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSION, embed } from './index.js';
describe('embeddings', () => { it('returns a normalized 384-dimensional vector offline', async () => { const vector = await embed('refund request'); expect(vector).toHaveLength(EMBEDDING_DIMENSION); expect(vector.every(Number.isFinite)).toBe(true); expect(Math.hypot(...vector)).toBeCloseTo(1); }); });
