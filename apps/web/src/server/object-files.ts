/**
 * Отдача производной изображения из бакета S3 по `/media/<ключ>`.
 *
 * Пара к `./static-files.ts` для драйвера `s3`: тот же набор возможностей —
 * `GET`/`HEAD`, `Content-Length`, `Last-Modified`, `ETag` и 304 по
 * `If-None-Match` (сверку делает сам бакет) — и та же граница: `Range` и
 * сжатие на лету не делаются (см. шапку `static-files.ts`).
 *
 * Ключ сюда приходит уже проверенным (`decideMediaRequest` → форма ключа и
 * префикс пространства производных), заголовки — из контракта отдачи
 * `derivativeCacheHeaders`. Своих правил у модуля нет.
 *
 * `ETag` — тот, что отдал бакет (кавычки уже на месте). Он сильный и меняется
 * только с байтами объекта, а байты по постоянному ключу не меняются вовсе.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import type { ObjectInfo, ObjectStore } from '@otkritka/images/s3';

const READ_METHODS: readonly string[] = ['GET', 'HEAD'];

export interface ObjectRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: ObjectStore;
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
}

function setInfoHeaders(request: ObjectRequest, info: ObjectInfo): void {
  if (info.lastModified !== undefined) {
    request.res.setHeader('Last-Modified', info.lastModified.toUTCString());
  }
  if (info.etag !== undefined) {
    request.res.setHeader('ETag', info.etag);
  }
  for (const [name, value] of Object.entries(request.headers)) {
    request.res.setHeader(name, value);
  }
}

/**
 * @returns `true` — ответ отправлен; `false` — объекта нет (или метод не тот),
 *   вызывающий отвечает 404.
 * @throws ошибку хранилища (сеть, таймаут, 5xx, отказ в доступе) — вызывающий
 *   отвечает 503 + Retry-After, если заголовки ещё не ушли.
 */
export async function tryServeObject(request: ObjectRequest): Promise<boolean> {
  const method = request.req.method ?? 'GET';
  if (!READ_METHODS.includes(method)) {
    return false;
  }

  if (method === 'HEAD') {
    const info = await request.store.head(request.key);
    if (info === null) {
      return false;
    }
    setInfoHeaders(request, info);
    request.res.setHeader('Content-Length', String(info.size));
    request.res.statusCode = 200;
    request.res.end();
    return true;
  }

  // Условный GET — одним запросом: бакет сам сверяет ETag и отвечает 304, тело
  // при совпадении не тянется.
  const condition = request.req.headers['if-none-match'];
  const object = await request.store.open(request.key, condition);
  if (object === null) {
    return false;
  }
  if (object === 'not-modified') {
    for (const [name, value] of Object.entries(request.headers)) {
      request.res.setHeader(name, value);
    }
    // Бакет совпадение подтвердил; ETag возвращаем, только если условие — одно
    // значение (из списка «a, b» не понять, какое совпало).
    if (condition !== undefined && !condition.includes(',')) {
      request.res.setHeader('ETag', condition);
    }
    request.res.statusCode = 304;
    request.res.end();
    return true;
  }
  setInfoHeaders(request, object);
  request.res.setHeader('Content-Length', String(object.size));
  request.res.statusCode = 200;
  await pipeline(object.body, request.res);
  return true;
}
