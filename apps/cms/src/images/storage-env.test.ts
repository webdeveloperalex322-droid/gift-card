/**
 * Корни хранилища из окружения (задача Э2-04).
 *
 * TDD: тест написан до реализации. Проверяется:
 *   - имена переменных зафиксированы: они уходят в `.env.example` и в отчёт,
 *     поэтому переименование обязано ломать тест, а не тихо оставлять пустой
 *     каталог;
 *   - незаданное значение НЕ подменяется дефолтом: загрузка отказывает с
 *     внятной ошибкой. Дефолт здесь означал бы, что на новом стенде файлы
 *     молча пишутся в каталог, которого никто не отдаёт (или, хуже, оригиналы
 *     оказываются под раздачей);
 *   - относительный путь разрешается от корня монорепозитория, а не от рабочего
 *     каталога процесса: у CMS два входа (`next dev` и `payload run`) с разными
 *     cwd, и одно и то же значение не должно давать два разных дерева.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_DERIVATIVES_ROOT_ENV_KEY,
  IMAGE_ORIGINALS_ROOT_ENV_KEY,
  createImageStorageFromEnv,
  resolveImageStorageRoots,
} from './storage-env';

const WORKSPACE = path.resolve(import.meta.dirname, '../../../..');

describe('имена переменных окружения', () => {
  it('зафиксированы: значения этих ключей идут в .env.example', () => {
    expect(IMAGE_DERIVATIVES_ROOT_ENV_KEY).toBe('IMAGE_STORAGE_DERIVATIVES_ROOT');
    expect(IMAGE_ORIGINALS_ROOT_ENV_KEY).toBe('IMAGE_STORAGE_ORIGINALS_ROOT');
  });
});

describe('resolveImageStorageRoots', () => {
  it('разрешает относительные значения от корня монорепозитория', () => {
    const roots = resolveImageStorageRoots({
      IMAGE_STORAGE_DERIVATIVES_ROOT: 'media',
      IMAGE_STORAGE_ORIGINALS_ROOT: 'uploads',
    });

    expect(roots.derivativesRoot).toBe(path.join(WORKSPACE, 'media'));
    expect(roots.originalsRoot).toBe(path.join(WORKSPACE, 'uploads'));
  });

  it('абсолютное значение оставляет как есть', () => {
    const absolute = path.resolve(path.sep, 'srv', 'otkritka', 'media');
    const roots = resolveImageStorageRoots({
      IMAGE_STORAGE_DERIVATIVES_ROOT: absolute,
      IMAGE_STORAGE_ORIGINALS_ROOT: path.resolve(path.sep, 'srv', 'otkritka-originals'),
    });
    expect(roots.derivativesRoot).toBe(absolute);
  });

  it('без значения — громкий отказ с именем переменной, без дефолта', () => {
    expect(() => resolveImageStorageRoots({})).toThrow(/IMAGE_STORAGE_DERIVATIVES_ROOT/);
    expect(() =>
      resolveImageStorageRoots({ IMAGE_STORAGE_DERIVATIVES_ROOT: 'media' }),
    ).toThrow(/IMAGE_STORAGE_ORIGINALS_ROOT/);
    expect(() =>
      resolveImageStorageRoots({
        IMAGE_STORAGE_DERIVATIVES_ROOT: '   ',
        IMAGE_STORAGE_ORIGINALS_ROOT: 'uploads',
      }),
    ).toThrow(/IMAGE_STORAGE_DERIVATIVES_ROOT/);
  });
});

describe('createImageStorageFromEnv', () => {
  it('собирает локальный адаптер по значениям окружения', () => {
    const storage = createImageStorageFromEnv({
      IMAGE_STORAGE_DERIVATIVES_ROOT: path.join(WORKSPACE, 'media'),
      IMAGE_STORAGE_ORIGINALS_ROOT: path.join(WORKSPACE, 'uploads'),
    });
    expect(storage.kind).toBe('local-fs');
  });

  it('оригиналы под корнем раздачи — отказ, а не предупреждение', () => {
    expect(() =>
      createImageStorageFromEnv({
        IMAGE_STORAGE_DERIVATIVES_ROOT: 'media',
        IMAGE_STORAGE_ORIGINALS_ROOT: 'media/originals',
      }),
    ).toThrow(/вне/i);
  });
});
