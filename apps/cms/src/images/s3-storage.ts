/**
 * Реализация {@link ImageStorage} на S3-совместимом хранилище.
 *
 * Тот же интерфейс, что у `./local-fs-storage.ts`: хуки загрузки и коллекции
 * про выбор реализации не знают (выбор — в `./storage-env.ts`).
 *
 * Ключ объекта в бакете равен ключу на локальной ФС один в один (условие Ч-03
 * «тот же путь, другой origin»): `cards/...` — производные, `originals/...` —
 * оригиналы. Префикс пространства проверяется на КАЖДОЙ операции, а не только
 * форма ключа: бакет может быть общим на оба пространства, и производная с
 * ключом `originals/...` перезаписала бы оригинал.
 *
 * Производные пишутся с `Content-Type` и `Cache-Control` из контракта отдачи
 * (`derivativeCacheHeaders`): сегодня их отдаёт наш сервер со своими
 * заголовками, но объект с верными метаданными остаётся верным и при отдаче из
 * бакета напрямую.
 */
import { derivativePutOptions, type ObjectStore, type S3ImageBuckets } from '@otkritka/images/s3';

import {
  type ImageStorage,
  DERIVATIVE_KEY_PREFIX,
  ORIGINAL_KEY_PREFIX,
  isDerivativeKey,
  isOriginalKey,
} from './storage';

function assertSpace(key: string, isInSpace: (key: string) => boolean, prefix: string): string {
  if (!isInSpace(key)) {
    throw new Error(
      `Ключ «${key}» не лежит в пространстве «${prefix}/» или имеет недопустимую форму. ` +
        'Операция отклонена: в общем бакете пространства разведены только префиксом ключа.',
    );
  }
  return key;
}

const derivative = (key: string): string =>
  assertSpace(key, isDerivativeKey, DERIVATIVE_KEY_PREFIX);
const original = (key: string): string => assertSpace(key, isOriginalKey, ORIGINAL_KEY_PREFIX);

async function readRequired(store: ObjectStore, key: string, what: string): Promise<Buffer> {
  const data = await store.read(key);
  if (data === null) {
    throw new Error(`${what} «${key}» не найден в бакете «${store.bucket}».`);
  }
  return data;
}

export function createS3ImageStorage(buckets: S3ImageBuckets): ImageStorage {
  return {
    kind: 's3',

    async putDerivative(key, data) {
      await buckets.derivatives.put(derivative(key), data, derivativePutOptions(key));
    },

    async putOriginal(key, data) {
      await buckets.originals.put(original(key), data);
    },

    async readOriginal(key) {
      try {
        return await readRequired(buckets.originals, original(key), 'Оригинал');
      } catch (error) {
        throw new Error(
          `Оригинал «${key}» не читается из хранилища: ${error instanceof Error ? error.message : String(error)}. ` +
            'Без оригинала перегенерация производных невозможна — файл восстанавливают из ' +
            'резервной копии, а не пересоздают из производной.',
        );
      }
    },

    async readDerivative(key) {
      return readRequired(buckets.derivatives, derivative(key), 'Производная');
    },

    async deleteDerivative(key) {
      await buckets.derivatives.delete(derivative(key));
    },

    async deleteOriginal(key) {
      await buckets.originals.delete(original(key));
    },

    async hasDerivative(key) {
      return (await buckets.derivatives.head(derivative(key))) !== null;
    },

    async hasOriginal(key) {
      return (await buckets.originals.head(original(key))) !== null;
    },
  };
}
