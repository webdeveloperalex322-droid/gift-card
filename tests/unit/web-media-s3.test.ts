/**
 * Отдача `/media/<ключ>` из бакета S3 через входной обработчик `apps/web`.
 *
 * Сервер настоящий (`node:http` на случайном порту), бакет — в памяти. Что
 * проверяется:
 *   - публичный путь тот же, что у локальной ФС, заголовки — из контракта;
 *   - `HEAD` и условный `GET` (304) не тянут тело объекта;
 *   - в ОБЩЕМ бакете оригинал по `/media/originals/...` не отдаётся, даже если
 *     объект с таким ключом существует (ТЗ §6.1);
 *   - промах — 404 страницей сборки, не 500.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IMMUTABLE_CACHE_CONTROL } from '@otkritka/images/media';

import { createFrontDoor } from '../../apps/web/src/server/front-door.js';
import { maintenanceMode } from '../../apps/web/src/server/maintenance.js';
import {
  createMediaSourceResolver,
  resolveMediaSource,
} from '../../apps/web/src/server/media-files.js';
import { createMemoryObjectStore } from './support/memory-object-store.js';

const DERIVATIVE = 'cards/a1b2c3d4/otkrytka-mame-640.webp';
const ORIGINAL = 'originals/0123456789abcdef0123456789abcdef.jpg';

const store = createMemoryObjectStore();
let server: http.Server;
let origin = '';

beforeAll(async () => {
  await store.put(DERIVATIVE, Buffer.from('webp-bytes'));
  await store.put(ORIGINAL, Buffer.from('original-bytes'));

  const clientRoot = await mkdtemp(join(tmpdir(), 'otkritka-media-s3-'));
  await writeFile(join(clientRoot, '404.html'), '<!doctype html><p>404 из сборки</p>', 'utf8');

  const handler = createFrontDoor({
    adminPath: '/admin',
    astroHandler: (_req, res) => {
      res.statusCode = 404;
      res.end('astro');
    },
    clientRoot,
    logError: () => undefined,
    maintenance: () => maintenanceMode({}),
    mediaSource: () => ({ kind: 's3', store }),
  });
  server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('отдача /media из бакета', () => {
  it('GET отдаёт объект с заголовками контракта', async () => {
    const response = await fetch(`${origin}/media/${DERIVATIVE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(response.headers.get('etag')).toBe(store.objects.get(DERIVATIVE)?.etag);
    expect(response.headers.get('content-length')).toBe('10');
    expect(await response.text()).toBe('webp-bytes');
  });

  it('HEAD обходится метаданными, без чтения тела', async () => {
    store.calls.length = 0;
    const head = await fetch(`${origin}/media/${DERIVATIVE}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(store.calls).toEqual([`head ${DERIVATIVE}`]);
  });

  it('условный GET — один запрос к бакету, 304 с ETag и заголовками контракта', async () => {
    store.calls.length = 0;
    const etag = store.objects.get(DERIVATIVE)?.etag ?? '';
    const conditional = await fetch(`${origin}/media/${DERIVATIVE}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(conditional.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(store.calls).toEqual([`open ${DERIVATIVE}`]);

    const stale = await fetch(`${origin}/media/${DERIVATIVE}`, {
      headers: { 'If-None-Match': '"other"' },
    });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('webp-bytes');
  });

  it('оригинал из общего бакета по /media не отдаётся', async () => {
    store.calls.length = 0;
    const response = await fetch(`${origin}/media/${ORIGINAL}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('original-bytes');
    expect(store.calls).toEqual([]);
  });

  it('отсутствующий объект — 404 страницей сборки', async () => {
    const response = await fetch(`${origin}/media/cards/a1b2c3d4/net-takogo-640.webp`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('404 из сборки');
  });

  it('запись по /media не принимается', async () => {
    const response = await fetch(`${origin}/media/${DERIVATIVE}`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('бакет недоступен', () => {
  it('ошибка хранилища — 503 с Retry-After, а не 500 и не 404', async () => {
    const broken = createMemoryObjectStore();
    broken.open = () => Promise.reject(new Error('connect ETIMEDOUT'));
    broken.head = () => Promise.reject(new Error('connect ETIMEDOUT'));
    const logged: string[] = [];
    const clientRoot = await mkdtemp(join(tmpdir(), 'otkritka-media-s3-broken-'));
    await writeFile(join(clientRoot, '404.html'), '404', 'utf8');
    const handler = createFrontDoor({
      adminPath: '/admin',
      astroHandler: () => undefined,
      clientRoot,
      logError: (message) => logged.push(message),
      maintenance: () => maintenanceMode({}),
      mediaSource: () => ({ kind: 's3', store: broken }),
    });
    const brokenServer = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => brokenServer.listen(0, '127.0.0.1', resolve));
    const brokenOrigin = `http://127.0.0.1:${String((brokenServer.address() as AddressInfo).port)}`;
    try {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${brokenOrigin}/media/${DERIVATIVE}`, { method });
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('60');
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(logged.some((line) => line.includes('ETIMEDOUT'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
    }
  });
});

describe('resolveMediaSource', () => {
  it('без драйвера — корень локальной ФС, как до переезда', () => {
    const source = resolveMediaSource({ IMAGE_STORAGE_DERIVATIVES_ROOT: 'media' }, '/srv/otkritka');
    expect(source.kind).toBe('local-fs');
  });

  it('s3 — бакет производных, корень ФС не требуется', () => {
    const source = resolveMediaSource(
      {
        IMAGE_STORAGE_DRIVER: 's3',
        S3_ACCESS_KEY: 'key',
        S3_BUCKET_DERIVATIVES: 'derivatives-bucket',
        S3_BUCKET_ORIGINALS: 'originals-bucket',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_REGION: 'ru1',
        S3_SECRET_KEY: 'secret',
      },
      '/srv/otkritka',
      (config) => createMemoryObjectStore(config.bucketDerivatives),
    );
    expect(source.kind === 's3' ? source.store.bucket : null).toBe('derivatives-bucket');
  });

  it('кеширует успех, но не отказ', () => {
    let calls = 0;
    const failing = createMediaSourceResolver(() => {
      calls += 1;
      throw new Error('нет параметров');
    });
    expect(failing).toThrow();
    expect(failing).toThrow();
    expect(calls).toBe(2);

    let built = 0;
    const ok = createMediaSourceResolver(() => {
      built += 1;
      return { kind: 'local-fs', root: '/srv/media' };
    });
    ok();
    ok();
    expect(built).toBe(1);
  });
});
