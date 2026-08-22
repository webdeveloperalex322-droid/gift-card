/**
 * Отдача файлов из `dist/client` собственным кодом.
 *
 * ## Почему не статический обработчик адаптера
 *
 * `@astrojs/node/dist/serve-static.js` на пути, который отображается в КАТАЛОГ
 * внутри `dist/client`, отдаёт 301 «минус один слеш» (ветка
 * `isDirectory && hasSlash`). Отсюда три беды, замеренные контролёром
 * `url-guard`: цикл на `/%2F`, три перехода на `////` и зависимость поведения от
 * платформы — `lstat` на каталоге с завершающим слешем в Windows даёт `ENOENT`,
 * а в Linux успех, поэтому зелёный локальный смоук про production ничего не
 * доказывал.
 *
 * Здесь этого класса ошибок нет по построению: имя файла вычисляет чистая
 * функция `clientFileForPath`, каталог не отдаётся НИКОГДА и редиректов этот
 * слой не порождает вовсе. Промах по файлу — не 404 и не 301, а передача
 * запроса приложению Astro: так работают и SSR-маршруты, и будущие
 * `robots.txt`/`sitemap.xml` (этап 4).
 *
 * ## Что этот слой умеет и чего намеренно не умеет
 *
 * Умеет: `GET`/`HEAD`, `Content-Type` по расширению, `Content-Length`,
 * `Last-Modified`, слабый `ETag` и 304 по `If-None-Match`, `Cache-Control:
 * immutable` для артефактов сборки с хешем в имени.
 *
 * Не умеет: `Range` (частичные запросы) и сжатие на лету. Оба сознательно
 * отложены: brotli и HTTP/2 — задача обратного прокси (`CLAUDE.md`,
 * «Производительность»), а частичные запросы нужны видео и аудио, которых на
 * сайте нет. Появятся — это отдельная задача, а не тихая доработка здесь.
 *
 * Задел на Э2-04b (отдача `/media/<ключ>` с `Cache-Control: public,
 * max-age=31536000, immutable`): корень отдачи и правило `Cache-Control`
 * приходят сюда параметрами, поэтому второй корень добавляется без переписывания
 * слоя. Сама раздача `/media` здесь НЕ реализуется — это чужая задача.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { clientFileForPath, immutableCacheControlFor } from '../routing/path-policy.js';

/**
 * Соответствие расширения и `Content-Type`. Список закрытый: неизвестное
 * расширение получает `application/octet-stream`, то есть скачивается, а не
 * интерпретируется. Догадка о типе по содержимому здесь опаснее отсутствия
 * догадки.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

const OCTET_STREAM = 'application/octet-stream';

/** Методы, на которые отвечает статика. Остальные уходят приложению Astro. */
const READ_METHODS: readonly string[] = ['GET', 'HEAD'];

export interface StaticRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Абсолютный путь каталога отдачи в файловой системе, без завершающего разделителя. */
  readonly root: string;
  /** Канонический путь из решения `serve`. */
  readonly pathname: string;
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? OCTET_STREAM;
}

/**
 * Разрешает путь внутри корня отдачи.
 *
 * Выход за корень к этому моменту уже невозможен: dot-сегменты и любые формы
 * `%2F` отклонены политикой пути. Проверка всё равно есть, и это не
 * перестраховка ради вида: она держит инвариант «отдаётся только то, что лежит
 * под корнем» независимо от того, кто и как изменит политику выше. Стоимость
 * проверки — одно сравнение строк.
 */
function resolveInsideRoot(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

/** Слабый ETag по размеру и времени изменения — того же вида, что у `send`. */
function weakETag(size: number, modifiedMs: number): string {
  return `W/"${size.toString(16)}-${modifiedMs.toString(16)}"`;
}

/**
 * Пытается отдать файл из корня статики.
 *
 * @returns `true` — ответ отправлен полностью; `false` — файла нет, запрос
 *   обязан уйти дальше приложению Astro.
 */
export async function tryServeStaticFile(request: StaticRequest): Promise<boolean> {
  const method = request.req.method ?? 'GET';
  if (!READ_METHODS.includes(method)) {
    return false;
  }

  const relative = clientFileForPath(request.pathname);
  const filePath = resolveInsideRoot(request.root, relative);
  if (filePath === null) {
    return false;
  }

  let size: number;
  let modifiedMs: number;
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      // Каталог, симлинк на каталог, устройство — не файл, значит не ответ.
      // Редиректа здесь не бывает: ровно он и давал находки 1–3.
      return false;
    }
    size = stats.size;
    modifiedMs = Math.floor(stats.mtimeMs);
  } catch {
    return false;
  }

  const etag = weakETag(size, modifiedMs);
  const cacheControl = immutableCacheControlFor(request.pathname);

  request.res.setHeader('Content-Type', contentTypeFor(filePath));
  request.res.setHeader('Last-Modified', new Date(modifiedMs).toUTCString());
  request.res.setHeader('ETag', etag);
  if (cacheControl !== undefined) {
    request.res.setHeader('Cache-Control', cacheControl);
  }

  if (request.req.headers['if-none-match'] === etag) {
    request.res.statusCode = 304;
    request.res.end();
    return true;
  }

  request.res.setHeader('Content-Length', String(size));
  request.res.statusCode = 200;

  if (method === 'HEAD') {
    request.res.end();
    return true;
  }

  await pipeline(createReadStream(filePath), request.res);
  return true;
}
