/**
 * S3-совместимое хранилище изображений: параметры из окружения и клиент бакета.
 *
 * ## Почему это здесь, а не в `apps/cms`
 *
 * Бакет нужен ДВУМ приложениям: `apps/cms` в него пишет, входной сервер
 * `apps/web` из него отдаёт `/media/<ключ>`. Входной сервер — настоящий Node ESM
 * из `dist/` и импортировать `.ts` из `apps/cms` не может (та же причина, по
 * которой сюда переехал контракт `./media.ts`). Отдельный подпуть
 * `@otkritka/images/s3`, а не часть `index.ts`: веб-серверу не нужен sharp.
 *
 * ## Условие переезда (решение Ч-03) — «тот же путь, другой origin»
 *
 * Ключ объекта в бакете — ровно тот же относительный ключ, что и на локальной ФС
 * (`cards/<revision>/<имя>.<ext>`, `originals/<id>.<ext>`). Префикса бакета
 * поверх ключа нет: иначе перенос файлов перестал бы быть копированием один в
 * один, а публичный путь `/media/<ключ>` — переводом ключа.
 *
 * Публичный адрес производной НЕ меняется вовсе: `/media/...` по-прежнему отдаёт
 * наш сервер с собственного домена (`SITE_URL`), читая объект из бакета. Прямой
 * публичной ссылки на бакет нет нигде, поэтому бакет обязан быть ПРИВАТНЫМ.
 *
 * ## Один бакет или два
 *
 * Допустимы оба варианта. Пространства разведены префиксами ключей (`cards/` и
 * `originals/`), а наружу отдаются только ключи, прошедшие
 * `derivativeKeyFromPublicPath` и лежащие под префиксом производных. Условие C4
 * («оригиналы недоступны по угадываемому URL») держится приватностью бакета и
 * тем, что отдача идёт через наш сервер. Если однажды производные понадобится
 * отдавать из бакета напрямую (публичное чтение, CDN), бакеты обязаны стать
 * раздельными — иначе публичным станет и пространство оригиналов.
 */
import { Agent } from 'node:https';
import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { assertStorageKey, derivativeCacheHeaders } from './media.js';

/** Выбор реализации хранилища. */
export const IMAGE_STORAGE_DRIVER_ENV_KEY = 'IMAGE_STORAGE_DRIVER';

export const S3_ENDPOINT_ENV_KEY = 'S3_ENDPOINT';
export const S3_REGION_ENV_KEY = 'S3_REGION';
export const S3_BUCKET_ORIGINALS_ENV_KEY = 'S3_BUCKET_ORIGINALS';
export const S3_BUCKET_DERIVATIVES_ENV_KEY = 'S3_BUCKET_DERIVATIVES';
export const S3_ACCESS_KEY_ENV_KEY = 'S3_ACCESS_KEY';
export const S3_SECRET_KEY_ENV_KEY = 'S3_SECRET_KEY';
export const S3_FORCE_PATH_STYLE_ENV_KEY = 'S3_FORCE_PATH_STYLE';

export type ImageStorageDriver = 'local-fs' | 's3';

export type S3Env = Readonly<Record<string, string | undefined>>;

/**
 * Реализация хранилища по окружению.
 *
 * Пустое значение — `local-fs`: так работал проект до переезда, и стенды без
 * этой переменной не должны поменять поведение. Непонятное значение — отказ, а
 * не возврат к локальной ФС: опечатка в `s3` молча писала бы файлы на диск
 * сервера, где их никто не отдаёт.
 */
export function resolveImageStorageDriver(env: S3Env): ImageStorageDriver {
  const raw = (env[IMAGE_STORAGE_DRIVER_ENV_KEY] ?? '').trim();
  if (raw === '' || raw === 'local-fs') {
    return 'local-fs';
  }
  if (raw === 's3') {
    return 's3';
  }
  throw new Error(
    `${IMAGE_STORAGE_DRIVER_ENV_KEY}=«${raw}» не распознан. Допустимо: local-fs (или пусто) | s3.`,
  );
}

export interface S3StorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucketOriginals: string;
  readonly bucketDerivatives: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

function requireValue(env: S3Env, key: string): string {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Переменная окружения ${key} не задана, а без неё к хранилищу S3 не подключиться. ` +
        'Значения по умолчанию у параметров S3 нет намеренно: дефолтный бакет или эндпоинт ' +
        'означал бы запись изображений не туда, откуда их отдаёт сайт. Заполните .env по ' +
        'шаблону .env.example.',
    );
  }
  return raw.trim();
}

/** Имя бакета по правилам S3: 3–63 символа, строчные буквы, цифры, точка, дефис. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function requireBucket(env: S3Env, key: string): string {
  const value = requireValue(env, key);
  if (!BUCKET_NAME.test(value)) {
    throw new Error(`${key}=«${value}» не является именем бакета S3.`);
  }
  return value;
}

function parsePathStyle(env: S3Env): boolean {
  const raw = (env[S3_FORCE_PATH_STYLE_ENV_KEY] ?? '').trim().toLowerCase();
  // Пусто — path-style: его понимают все S3-совместимые хранилища (Beget,
  // Yandex, Selectel, MinIO), а virtual-hosted требует DNS-имени на бакет.
  if (raw === '' || raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new Error(`${S3_FORCE_PATH_STYLE_ENV_KEY}=«${raw}» не распознан. Допустимо: true | false.`);
}

/**
 * Параметры S3 из окружения. Все обязательные, кроме `S3_FORCE_PATH_STYLE`.
 *
 * `S3_ENDPOINT` — только схема и хост: путь в нём означал бы бакет, вписанный в
 * эндпоинт, и тогда SDK добавил бы имя бакета второй раз.
 */
export function resolveS3StorageConfig(env: S3Env): S3StorageConfig {
  const endpointRaw = requireValue(env, S3_ENDPOINT_ENV_KEY);
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    throw new Error(`${S3_ENDPOINT_ENV_KEY}=«${endpointRaw}» не является URL.`);
  }
  if (
    (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '') ||
    endpoint.search !== '' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new Error(
      `${S3_ENDPOINT_ENV_KEY}=«${endpointRaw}»: ожидается схема и хост без пути, например ` +
        '«https://s3.ru1.storage.beget.cloud». Имя бакета задаётся отдельно.',
    );
  }

  return {
    accessKeyId: requireValue(env, S3_ACCESS_KEY_ENV_KEY),
    bucketDerivatives: requireBucket(env, S3_BUCKET_DERIVATIVES_ENV_KEY),
    bucketOriginals: requireBucket(env, S3_BUCKET_ORIGINALS_ENV_KEY),
    endpoint: endpoint.origin,
    forcePathStyle: parsePathStyle(env),
    region: requireValue(env, S3_REGION_ENV_KEY),
    secretAccessKey: requireValue(env, S3_SECRET_KEY_ENV_KEY),
  };
}

/** Установка соединения с бакетом, мс. */
export const S3_CONNECTION_TIMEOUT_MS = 2_000;
/** Ожидание ответа бакета (до первых байтов и между ними), мс. */
export const S3_REQUEST_TIMEOUT_MS = 10_000;
/** Одновременных соединений с бакетом на процесс. */
export const S3_MAX_SOCKETS = 200;

export function createS3Client(config: S3StorageConfig): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
    // Таймауты обязательны: по умолчанию у SDK их нет вовсе, и подвисший бакет
    // держал бы запрос `/media` (в том числе LCP-изображение) без верхней
    // границы вместо быстрого отказа. Пул сокетов шире дефолтных 50: сокет занят,
    // пока тело объекта уходит медленному клиенту.
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      httpsAgent: new Agent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS }),
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    },
    // Контрольные суммы CRC32 по умолчанию (SDK ≥ 3.729) понимает не каждое
    // S3-совместимое хранилище; MD5/ETag достаточно.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Метаданные объекта: из них строятся заголовки ответа `/media`. */
export interface ObjectInfo {
  readonly size: number;
  readonly etag: string | undefined;
  readonly lastModified: Date | undefined;
}

export interface ObjectBody extends ObjectInfo {
  readonly body: Readable;
}

export interface PutObjectOptions {
  readonly contentType?: string;
  readonly cacheControl?: string;
}

/**
 * Метаданные объекта производной — из контракта отдачи `derivativeCacheHeaders`,
 * а не своей строкой: объект с верными заголовками остаётся верным и при отдаче
 * из бакета напрямую.
 */
export function derivativePutOptions(key: string): PutObjectOptions {
  const headers = derivativeCacheHeaders(key);
  const contentType = headers['Content-Type'];
  const cacheControl = headers['Cache-Control'];
  if (contentType === undefined || cacheControl === undefined) {
    throw new Error(`Контракт отдачи не дал заголовков для «${key}».`);
  }
  return { cacheControl, contentType };
}

/**
 * Бакет как хранилище объектов по ключу. Ключ проверяется ДО обращения к сети
 * той же функцией, что и у локальной ФС ({@link assertStorageKey}).
 *
 * Интерфейс, а не класс над SDK, чтобы потребители (адаптер CMS, отдача `/media`)
 * проверялись юнит-тестом на объекте в памяти.
 */
export interface ObjectStore {
  readonly bucket: string;
  put(key: string, data: Buffer, options?: PutObjectOptions): Promise<void>;
  /** Байты объекта целиком или `null`, если объекта нет. */
  read(key: string): Promise<Buffer | null>;
  /**
   * Поток объекта, `null` — объекта нет, `'not-modified'` — передан
   * `ifNoneMatch`, и он совпал с ETag объекта (условный GET одним запросом).
   */
  open(key: string, ifNoneMatch?: string): Promise<ObjectBody | 'not-modified' | null>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Отсутствие объекта — не ошибка: уборка обязана быть повторяемой. */
  delete(key: string): Promise<void>;
}

/**
 * Ошибка SDK означает «объекта нет». 403 сюда НЕ входит намеренно: S3 отвечает
 * им и на отсутствующий ключ при ключе доступа без права ListBucket, но и на
 * неверные учётные данные — превратить второе в 404 значило бы спрятать
 * поломку конфигурации за «битыми картинками». Ключу доступа нужно право
 * ListBucket.
 */
export function isNotFound(error: unknown): boolean {
  const status = sdkErrorStatus(error);
  if (status === null) {
    return false;
  }
  const name = (error as Error).name;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/** Ответ 304 на условный запрос: SDK сообщает его исключением. */
export function isNotModified(error: unknown): boolean {
  return sdkErrorStatus(error) === 304;
}

/**
 * HTTP-статус ошибки SDK или `null`, если это не ответ сервиса (сеть, таймаут).
 * Проверка по форме (`$metadata.httpStatusCode`), а не `instanceof`: класс
 * исключения у нескольких копий SDK в дереве зависимостей разный.
 */
function sdkErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !('$metadata' in error)) {
    return null;
  }
  const metadata = (error as { $metadata: unknown }).$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return null;
  }
  const status = metadata.httpStatusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * Длина объекта обязательна: без неё ответ `/media` ушёл бы с неверным
 * `Content-Length` и оборвался. Отсутствие — отказ, а не молчаливый ноль.
 */
function requireLength(length: number | undefined, key: string): number {
  if (length === undefined) {
    throw new Error(`Хранилище не сообщило длину объекта «${key}».`);
  }
  return length;
}

export function createS3ObjectStore(client: S3Client, bucket: string): ObjectStore {
  const open = async (
    key: string,
    ifNoneMatch?: string,
  ): Promise<ObjectBody | 'not-modified' | null> => {
    assertStorageKey(key);
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, IfNoneMatch: ifNoneMatch, Key: key }),
      );
      if (result.Body === undefined) {
        return null;
      }
      return {
        body: result.Body as Readable,
        etag: result.ETag,
        lastModified: result.LastModified,
        size: requireLength(result.ContentLength, key),
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      if (ifNoneMatch !== undefined && isNotModified(error)) {
        return 'not-modified';
      }
      throw error;
    }
  };

  return {
    bucket,

    async put(key, data, options = {}) {
      assertStorageKey(key);
      await client.send(
        new PutObjectCommand({
          Body: data,
          Bucket: bucket,
          CacheControl: options.cacheControl,
          ContentLength: data.length,
          ContentType: options.contentType,
          Key: key,
        }),
      );
    },

    async read(key) {
      const object = await open(key);
      if (object === null || object === 'not-modified') {
        return null;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    },

    open,

    async head(key) {
      assertStorageKey(key);
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          etag: result.ETag,
          lastModified: result.LastModified,
          size: requireLength(result.ContentLength, key),
        };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async delete(key) {
      assertStorageKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/** Два пространства хранилища поверх одного клиента. */
export interface S3ImageBuckets {
  readonly originals: ObjectStore;
  readonly derivatives: ObjectStore;
}

export function createS3ImageBuckets(config: S3StorageConfig): S3ImageBuckets {
  const client = createS3Client(config);
  return {
    derivatives: createS3ObjectStore(client, config.bucketDerivatives),
    originals: createS3ObjectStore(client, config.bucketOriginals),
  };
}
