/**
 * Корни хранилища изображений из окружения (задача Э2-04).
 *
 * Почему у этих параметров НЕТ значений по умолчанию. Дефолт означал бы, что на
 * новом стенде загрузка молча пишет файлы в каталог, который никто не отдаёт (и
 * тогда все производные битые), либо — что хуже — в каталог, который отдаётся
 * целиком (и тогда оригиналы доступны по угадываемому URL, ТЗ §6.1). Оба
 * варианта обнаруживаются не при развёртывании, а по факту, поэтому здесь
 * действует то же правило fail-fast, что у `SITE_URL` и `PAYLOAD_ADMIN_PATH`.
 *
 * Почему отказ ЛЕНИВЫЙ (при первом обращении к хранилищу), а не при старте CMS:
 * без изображений админка, коллекции и правки текстов работоспособны, и валить
 * весь процесс из-за незаполненного параметра значило бы блокировать работу,
 * которая от него не зависит. Загрузка изображения без корней отказывает громко
 * и называет обе переменные.
 *
 * Значение может быть относительным — оно разрешается от корня монорепозитория
 * (см. `workspaceRoot` в `../env.mjs`), а не от рабочего каталога процесса.
 */
import path from 'node:path';

import {
  createS3ImageBuckets,
  resolveImageStorageDriver,
  resolveS3StorageConfig,
} from '@otkritka/images/s3';

import { loadEnvFiles, workspaceRoot } from '../env.mjs';
import { createLocalFsImageStorage } from './local-fs-storage';
import { createS3ImageStorage } from './s3-storage';
import type { ImageStorage } from './storage';

/** Корень ПУБЛИЧНЫХ производных: это дерево `apps/web` отдаёт по `/media/...`. */
export const IMAGE_DERIVATIVES_ROOT_ENV_KEY = 'IMAGE_STORAGE_DERIVATIVES_ROOT';

/** Корень оригиналов. Обязан лежать ВНЕ корня производных (условие C4). */
export const IMAGE_ORIGINALS_ROOT_ENV_KEY = 'IMAGE_STORAGE_ORIGINALS_ROOT';

export type StorageEnv = Readonly<Record<string, string | undefined>>;

export interface ImageStorageRoots {
  readonly derivativesRoot: string;
  readonly originalsRoot: string;
}

function requirePath(env: StorageEnv, key: string, purpose: string): string {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `Переменная окружения ${key} не задана, поэтому ${purpose} неизвестен. ` +
        'Значения по умолчанию у корней хранилища нет намеренно: дефолт означал бы либо ' +
        'производные в каталоге, который никто не отдаёт, либо оригиналы под раздачей — ' +
        'и то и другое обнаруживается уже в проде. Заполните .env по шаблону .env.example ' +
        `(нужны ${IMAGE_DERIVATIVES_ROOT_ENV_KEY} и ${IMAGE_ORIGINALS_ROOT_ENV_KEY}).`,
    );
  }
  const value = raw.trim();
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot(), value);
}

/**
 * Разрешает оба корня. Порядок проверок фиксирован: сначала производные, потом
 * оригиналы — чтобы сообщение об ошибке всегда называло первую незаполненную
 * переменную, а не случайную.
 */
export function resolveImageStorageRoots(env: StorageEnv): ImageStorageRoots {
  return {
    derivativesRoot: requirePath(
      env,
      IMAGE_DERIVATIVES_ROOT_ENV_KEY,
      'корень публичных производных',
    ),
    originalsRoot: requirePath(env, IMAGE_ORIGINALS_ROOT_ENV_KEY, 'корень оригиналов'),
  };
}

/**
 * Собирает адаптер хранилища по окружению.
 *
 * Реализацию выбирает `IMAGE_STORAGE_DRIVER` (`local-fs` | `s3`, пусто —
 * `local-fs`). Выбор живёт здесь и только здесь: вызывающий код знает лишь
 * интерфейс {@link ImageStorage}, поэтому переезд не трогает ни хуки, ни
 * коллекции. При `s3` корни локальной ФС не читаются вовсе.
 */
export function createImageStorageFromEnv(env: StorageEnv): ImageStorage {
  if (resolveImageStorageDriver(env) === 's3') {
    return createS3ImageStorage(createS3ImageBuckets(resolveS3StorageConfig(env)));
  }
  return createLocalFsImageStorage(resolveImageStorageRoots(env));
}

let cached: ImageStorage | null = null;

/**
 * Хранилище процесса. Ленивое и кешированное: адаптер без состояния, а вот
 * проверка корней при каждой загрузке — лишняя работа и лишний шум в журнале.
 */
export function imageStorage(): ImageStorage {
  if (cached === null) {
    loadEnvFiles();
    cached = createImageStorageFromEnv(process.env);
  }
  return cached;
}
