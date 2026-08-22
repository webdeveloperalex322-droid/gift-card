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
 * Задел на Э2-04b ИСПОЛЬЗОВАН: корень отдачи, отображение «путь → файл» и
 * заголовки приходят параметрами, поэтому производные изображений
 * (`/media/<ключ>`, решение Ч-03) отдаются этим же слоем и той же единственной
 * проверкой «остались ли мы внутри корня». Правила самой раздачи `/media`
 * (форма ключа, `Cache-Control`, `Content-Type`) живут в `./media-files.ts` и в
 * `@otkritka/images/media` — здесь только чтение файла и HTTP.
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
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

interface StaticRequestBase {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Абсолютный путь каталога отдачи в файловой системе, без завершающего разделителя. */
  readonly root: string;
  /**
   * Заголовки ответа, заданные вызывающим. Переданные значения имеют приоритет
   * над вычисленными здесь (`Content-Type`, `Cache-Control`). Параметр
   * существует ровно для того, чтобы правило кеширования производных не
   * переписывалось второй раз: оно приходит из `derivativeCacheHeaders`.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Что именно отдавать: либо канонический путь страницы или файла сборки (имя
 * файла выводит `clientFileForPath`, и от пути же зависит `Cache-Control`
 * артефактов), либо готовый путь ОТНОСИТЕЛЬНО корня — так отдаются производные
 * изображений, у которых своё пространство и своё отображение «URL → файл».
 *
 * Размеченное объединение, а не два необязательных поля: «оба заданы» и «ни
 * одного» не должны компилироваться. Иначе однажды окажется, что отдаётся файл
 * из одного отображения с заголовками из другого.
 */
export type StaticRequest =
  | (StaticRequestBase & { readonly pathname: string; readonly relativePath?: undefined })
  | (StaticRequestBase & { readonly pathname?: undefined; readonly relativePath: string });

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? OCTET_STREAM;
}

/**
 * Разрешает путь внутри корня отдачи ЛЕКСИЧЕСКИ.
 *
 * Выход за корень к этому моменту уже невозможен: dot-сегменты и любые формы
 * `%2F` отклонены политикой пути, а ключ производной — форма которого проверена
 * в `@otkritka/images/media`. Проверка всё равно есть, и это не перестраховка
 * ради вида: она держит инвариант «отдаётся только то, что лежит под корнем»
 * независимо от того, кто и как изменит правила выше. Стоимость — одно сравнение
 * строк.
 */
function resolveInsideRoot(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

/**
 * Настоящие пути корней отдачи. Их два (`dist/client` и корень производных),
 * поэтому запоминаются: `realpath` на каждый ответ — лишний syscall на горячем
 * пути, а меняться корень за время жизни процесса не может.
 */
const realRoots = new Map<string, string>();

async function realRootOf(root: string): Promise<string> {
  const known = realRoots.get(root);
  if (known !== undefined) {
    return known;
  }
  const real = await realpath(root);
  realRoots.set(root, real);
  return real;
}

/**
 * Тот же вопрос «остались ли мы внутри корня», но заданный файловой системе.
 *
 * Лексическая проверка работает со строкой и поэтому не видит СИМВОЛЬНУЮ ССЫЛКУ
 * внутри корня, указывающую наружу: `dist/client/x.webp -> ../../uploads/...`
 * прошёл бы её. Для корня производных это прямой путь к оригиналу, который по
 * HTTP не отдаётся никогда (ТЗ §6.1, условие C4 решения Ч-03), поэтому проверка
 * стоит здесь, в единственном месте отдачи файлов, а не отдельным правилом в
 * слое `/media`: правило одно — «за корень нельзя».
 *
 * Цена — один `realpath` на успешный ответ. Ссылок в обоих корнях не бывает: в
 * `dist/client` пишет сборка, в корень производных — адаптер хранилища
 * `writeFile`; проверка нужна не от них, а от того, кто однажды разложит файлы
 * иначе.
 */
async function isInsideRootOnDisk(root: string, filePath: string): Promise<boolean> {
  const [realRoot, real] = await Promise.all([realRootOf(root), realpath(filePath)]);
  return real === realRoot || real.startsWith(realRoot + path.sep);
}

/** Слабый ETag по размеру и времени изменения — того же вида, что у `send`. */
function weakETag(size: number, modifiedMs: number): string {
  return `W/"${size.toString(16)}-${modifiedMs.toString(16)}"`;
}

/** Файл, который можно отдать: абсолютный путь и то, из чего строятся заголовки. */
export interface ServableFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
}

/**
 * Единственное место, где путь превращается в РАЗРЕШЁННЫЙ к отдаче файл.
 *
 * Обе проверки границы корня (лексическая и на диске) и отказ от каталогов живут
 * здесь, поэтому у второго потребителя — ветки `/media` в middleware Astro,
 * которая нужна только `astro dev`, — своей проверки нет и быть не может.
 *
 * @returns `null`, если файла нет, это не файл или он лежит за корнем. Причины
 *   не различаются намеренно: наружу они дают один и тот же ответ, а различение
 *   превратило бы отказ в подсказку о содержимом файловой системы.
 */
export async function resolveServableFile(
  root: string,
  relative: string,
): Promise<ServableFile | null> {
  const filePath = resolveInsideRoot(root, relative);
  if (filePath === null) {
    return null;
  }

  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      // Каталог, симлинк на каталог, устройство — не файл, значит не ответ.
      // Редиректа здесь не бывает: ровно он и давал находки 1–3.
      return null;
    }
    if (!(await isInsideRootOnDisk(root, filePath))) {
      return null;
    }
    return { modifiedMs: Math.floor(stats.mtimeMs), path: filePath, size: stats.size };
  } catch {
    return null;
  }
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

  const relative =
    request.pathname === undefined ? request.relativePath : clientFileForPath(request.pathname);
  const file = await resolveServableFile(request.root, relative);
  if (file === null) {
    return false;
  }
  const { path: filePath, size, modifiedMs } = file;

  const etag = weakETag(size, modifiedMs);
  const cacheControl =
    request.pathname === undefined ? undefined : immutableCacheControlFor(request.pathname);

  request.res.setHeader('Content-Type', contentTypeFor(filePath));
  request.res.setHeader('Last-Modified', new Date(modifiedMs).toUTCString());
  request.res.setHeader('ETag', etag);
  if (cacheControl !== undefined) {
    request.res.setHeader('Cache-Control', cacheControl);
  }
  // Заданные вызывающим заголовки ставятся ПОСЛЕ вычисленных и перекрывают их:
  // для производных изображений источником `Content-Type` и `Cache-Control`
  // является контракт хранилища, а не таблица расширений этого модуля.
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    request.res.setHeader(name, value);
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
