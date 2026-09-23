import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { ObjectStore, RawObjectReader } from './inbound-contracts.js';

export interface S3ObjectStoreOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createS3ObjectStore(options: S3ObjectStoreOptions): {
  client: S3Client;
  store: ObjectStore & RawObjectReader;
} {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    client,
    store: {
      async put(key, body, contentType) {
        await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        );
      },
      async delete(key) {
        await client.send(
          new DeleteObjectCommand({ Bucket: options.bucket, Key: key }),
        );
      },
      async getStream(key) {
        const response = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        if (!(response.Body instanceof Readable))
          throw new Error('S3 object body is not a Node.js readable stream.');
        return response.Body;
      },
    },
  };
}
