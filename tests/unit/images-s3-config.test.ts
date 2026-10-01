/**
 * Параметры S3 из окружения (`@otkritka/images/s3`).
 *
 * Проверяется: выбор драйвера (пусто — локальная ФС, мусор — отказ), отсутствие
 * дефолтов у обязательных параметров, форма эндпоинта и имени бакета,
 * разбор path-style. Секреты в сообщения об ошибках не попадают.
 */
import { describe, expect, it } from 'vitest';

import {
  isNotFound,
  isNotModified,
  resolveImageStorageDriver,
  resolveS3StorageConfig,
} from '@otkritka/images/s3';

/** Ошибка той формы, что бросает SDK: имя и `$metadata.httpStatusCode`. */
function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { $metadata: { httpStatusCode: status }, name });
}

const FULL = {
  IMAGE_STORAGE_DRIVER: 's3',
  S3_ACCESS_KEY: 'AKIAEXAMPLE',
  S3_BUCKET_DERIVATIVES: 'example-bucket',
  S3_BUCKET_ORIGINALS: 'example-bucket',
  S3_ENDPOINT: 'https://s3.example.test',
  S3_REGION: 'ru1',
  S3_SECRET_KEY: 'secret-value-not-in-messages',
} as const;

describe('resolveImageStorageDriver', () => {
  it('пусто и local-fs — локальная ФС, s3 — бакет', () => {
    expect(resolveImageStorageDriver({})).toBe('local-fs');
    expect(resolveImageStorageDriver({ IMAGE_STORAGE_DRIVER: ' ' })).toBe('local-fs');
    expect(resolveImageStorageDriver({ IMAGE_STORAGE_DRIVER: 'local-fs' })).toBe('local-fs');
    expect(resolveImageStorageDriver({ IMAGE_STORAGE_DRIVER: 's3' })).toBe('s3');
  });

  it('непонятное значение — отказ, а не молчаливая локальная ФС', () => {
    expect(() => resolveImageStorageDriver({ IMAGE_STORAGE_DRIVER: 'S3 ' })).toThrow(
      /IMAGE_STORAGE_DRIVER/,
    );
    expect(() => resolveImageStorageDriver({ IMAGE_STORAGE_DRIVER: 'minio' })).toThrow();
  });
});

describe('resolveS3StorageConfig', () => {
  it('собирает конфиг; path-style по умолчанию включён', () => {
    const config = resolveS3StorageConfig(FULL);
    expect(config).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      bucketDerivatives: 'example-bucket',
      bucketOriginals: 'example-bucket',
      endpoint: 'https://s3.example.test',
      forcePathStyle: true,
      region: 'ru1',
      secretAccessKey: 'secret-value-not-in-messages',
    });
  });

  it('завершающий слеш эндпоинта снимается', () => {
    expect(resolveS3StorageConfig({ ...FULL, S3_ENDPOINT: 'https://s3.example.test/' }).endpoint).toBe(
      'https://s3.example.test',
    );
  });

  it('каждый обязательный параметр без значения — отказ с его именем', () => {
    for (const key of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET_ORIGINALS',
      'S3_BUCKET_DERIVATIVES',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
    ] as const) {
      expect(() => resolveS3StorageConfig({ ...FULL, [key]: '' })).toThrow(new RegExp(key));
    }
  });

  it('эндпоинт с путём (бакет внутри адреса) отклоняется', () => {
    expect(() =>
      resolveS3StorageConfig({ ...FULL, S3_ENDPOINT: 'https://s3.example.test/example-bucket' }),
    ).toThrow(/без пути/);
    expect(() => resolveS3StorageConfig({ ...FULL, S3_ENDPOINT: 'ftp://s3.example.test' })).toThrow();
    expect(() => resolveS3StorageConfig({ ...FULL, S3_ENDPOINT: 's3.example.test' })).toThrow();
  });

  it('недопустимое имя бакета отклоняется', () => {
    expect(() => resolveS3StorageConfig({ ...FULL, S3_BUCKET_ORIGINALS: 'Bucket_Name' })).toThrow(
      /S3_BUCKET_ORIGINALS/,
    );
  });

  it('S3_FORCE_PATH_STYLE: true/false/1/0, мусор — отказ', () => {
    expect(resolveS3StorageConfig({ ...FULL, S3_FORCE_PATH_STYLE: 'false' }).forcePathStyle).toBe(false);
    expect(resolveS3StorageConfig({ ...FULL, S3_FORCE_PATH_STYLE: '0' }).forcePathStyle).toBe(false);
    expect(resolveS3StorageConfig({ ...FULL, S3_FORCE_PATH_STYLE: 'TRUE' }).forcePathStyle).toBe(true);
    expect(() => resolveS3StorageConfig({ ...FULL, S3_FORCE_PATH_STYLE: 'yes' })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    );
  });

  it('секрет не попадает в сообщения об ошибках', () => {
    try {
      resolveS3StorageConfig({ ...FULL, S3_REGION: '' });
    } catch (error) {
      expect(String(error)).not.toContain(FULL.S3_SECRET_KEY);
    }
  });
});

describe('классификация ошибок SDK', () => {
  it('404, NoSuchKey и NotFound — «объекта нет»', () => {
    expect(isNotFound(s3Error('NoSuchKey', 404))).toBe(true);
    expect(isNotFound(s3Error('NotFound', 404))).toBe(true);
    expect(isNotFound(s3Error('Unknown', 404))).toBe(true);
  });

  it('403 и 5xx — НЕ «объекта нет»: поломка доступа не прячется за 404', () => {
    expect(isNotFound(s3Error('AccessDenied', 403))).toBe(false);
    expect(isNotFound(s3Error('InternalError', 500))).toBe(false);
    expect(isNotFound(new Error('connect ETIMEDOUT'))).toBe(false);
  });

  it('304 распознаётся как «не изменился»', () => {
    expect(isNotModified(s3Error('NotModified', 304))).toBe(true);
    expect(isNotModified(s3Error('NoSuchKey', 404))).toBe(false);
  });
});
