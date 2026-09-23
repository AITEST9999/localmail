import { loadEnv } from '@localmail/config';

import { createWorkerRuntime, workerService } from './runtime.js';

const env = loadEnv();
const runtime = createWorkerRuntime(env);

console.log(
  `${workerService.name} listening on queues: ${workerService.queues.join(', ')}`,
);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
