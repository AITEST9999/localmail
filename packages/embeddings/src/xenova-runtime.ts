/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-implied-eval */
// Optional peer runtime. Keeping this adapter local lets the package compile
// and run hermetically without downloading a model; install @xenova/transformers
// and set EMBEDDINGS_USE_ONNX=true to activate it.
export async function pipeline(task: string, model: string): Promise<any> {
  const moduleName = '@xenova/transformers';
  const loader = new Function('name', 'return import(name)') as (name: string) => Promise<any>;
  const runtime = await loader(moduleName);
  return runtime.pipeline(task, model);
}
