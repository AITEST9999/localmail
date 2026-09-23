/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
const DIMENSION = 384;
export const EMBEDDING_DIMENSION = DIMENSION;

/** Deterministic offline-friendly baseline. Set EMBEDDINGS_USE_ONNX=true when the optional model runtime is installed. */
export async function embed(text: string): Promise<number[]> {
  if (process.env.EMBEDDINGS_USE_ONNX === 'true') {
    // Kept lazy so the default local install has no model download requirement.
    try {
      const transformers = await import('./xenova-runtime.js');
      const extractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data as Float32Array).map(Number);
      if (vector.length === DIMENSION) return vector;
    } catch { /* fallback below keeps tests and offline development deterministic */ }
  }
  const vector = new Array<number>(DIMENSION).fill(0);
  for (let index = 0; index < text.length; index++) {
    const slot = (text.charCodeAt(index) * 31 + index) % DIMENSION;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
