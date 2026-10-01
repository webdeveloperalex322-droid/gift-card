/**
 * Бакет в памяти для юнит-тестов: тот же интерфейс `ObjectStore`, что у
 * клиента S3, без сети. Метаданные записи сохраняются, чтобы тест видел, с
 * какими `Content-Type`/`Cache-Control` объект был положен.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ObjectStore, PutObjectOptions } from '@otkritka/images/s3';

export interface StoredObject {
  readonly data: Buffer;
  readonly options: PutObjectOptions;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface MemoryObjectStore extends ObjectStore {
  readonly objects: Map<string, StoredObject>;
  readonly calls: string[];
}

export function createMemoryObjectStore(bucket = 'test-bucket'): MemoryObjectStore {
  const objects = new Map<string, StoredObject>();
  const calls: string[] = [];

  return {
    bucket,
    calls,
    objects,

    put(key, data, options = {}) {
      calls.push(`put ${key}`);
      objects.set(key, {
        data: Buffer.from(data),
        etag: `"${createHash('md5').update(data).digest('hex')}"`,
        lastModified: new Date('2026-10-01T00:00:00Z'),
        options,
      });
      return Promise.resolve();
    },

    read(key) {
      calls.push(`read ${key}`);
      return Promise.resolve(objects.get(key)?.data ?? null);
    },

    open(key, ifNoneMatch) {
      calls.push(`open ${key}`);
      const object = objects.get(key);
      if (object === undefined) {
        return Promise.resolve(null);
      }
      if (ifNoneMatch !== undefined && ifNoneMatch === object.etag) {
        return Promise.resolve('not-modified' as const);
      }
      return Promise.resolve({
        body: Readable.from([object.data]),
        etag: object.etag,
        lastModified: object.lastModified,
        size: object.data.length,
      });
    },

    head(key) {
      calls.push(`head ${key}`);
      const object = objects.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : { etag: object.etag, lastModified: object.lastModified, size: object.data.length },
      );
    },

    delete(key) {
      calls.push(`delete ${key}`);
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
