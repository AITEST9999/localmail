import type { Env } from '@localmail/config';
import { createS3ObjectStore as createCoreS3ObjectStore } from '@localmail/core';

export function createS3ObjectStore(env: Env) {
  return createCoreS3ObjectStore({
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
  });
}
