/**
 * Адаптер хранилища на S3 (`./s3-storage.ts`) — на бакете в памяти.
 *
 * Главное здесь: при ОБЩЕМ бакете пространства разведены только префиксом
 * ключа, поэтому адаптер обязан отклонять производную вне `cards/` и оригинал
 * вне `originals/` — иначе запись одного пространства перезаписала бы другое.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryObjectStore } from '../../../../tests/unit/support/memory-object-store';
import { createS3ImageStorage } from './s3-storage';
import { IMMUTABLE_CACHE_CONTROL } from './storage';

const DERIVATIVE = 'cards/a1b2c3d4/otkrytka-mame-640.webp';
const ORIGINAL = 'originals/0123456789abcdef0123456789abcdef.jpg';

function sharedBucket() {
  const store = createMemoryObjectStore();
  return { storage: createS3ImageStorage({ derivatives: store, originals: store }), store };
}

describe('createS3ImageStorage', () => {
  it('производная пишется по тому же ключу и с заголовками контракта отдачи', async () => {
    const { storage, store } = sharedBucket();
    await storage.putDerivative(DERIVATIVE, Buffer.from('webp'));

    const object = store.objects.get(DERIVATIVE);
    expect(object?.data.toString()).toBe('webp');
    expect(object?.options).toEqual({
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: 'image/webp',
    });
    expect(storage.kind).toBe('s3');
  });

  it('чтение, проверка наличия и удаление — в своём пространстве', async () => {
    const { storage } = sharedBucket();
    await storage.putOriginal(ORIGINAL, Buffer.from('jpeg'));
    await storage.putDerivative(DERIVATIVE, Buffer.from('webp'));

    expect((await storage.readOriginal(ORIGINAL)).toString()).toBe('jpeg');
    expect((await storage.readDerivative(DERIVATIVE)).toString()).toBe('webp');
    expect(await storage.hasOriginal(ORIGINAL)).toBe(true);
    expect(await storage.hasDerivative(DERIVATIVE)).toBe(true);

    await storage.deleteDerivative(DERIVATIVE);
    await storage.deleteOriginal(ORIGINAL);
    expect(await storage.hasDerivative(DERIVATIVE)).toBe(false);
    expect(await storage.hasOriginal(ORIGINAL)).toBe(false);
  });

  it('удаление отсутствующего объекта — не ошибка (уборка повторяема)', async () => {
    const { storage } = sharedBucket();
    await expect(storage.deleteDerivative(DERIVATIVE)).resolves.toBeUndefined();
  });

  it('отсутствующий оригинал — внятный отказ', async () => {
    const { storage } = sharedBucket();
    await expect(storage.readOriginal(ORIGINAL)).rejects.toThrow(/не читается/);
  });

  it('пространства не пересекаются: чужой префикс отклоняется до обращения к бакету', async () => {
    const { storage, store } = sharedBucket();

    await expect(storage.putDerivative(ORIGINAL, Buffer.from('x'))).rejects.toThrow(/cards/);
    await expect(storage.putOriginal(DERIVATIVE, Buffer.from('x'))).rejects.toThrow(/originals/);
    await expect(storage.readDerivative(ORIGINAL)).rejects.toThrow(/cards/);
    await expect(storage.deleteDerivative(ORIGINAL)).rejects.toThrow(/cards/);
    await expect(storage.hasOriginal(DERIVATIVE)).rejects.toThrow(/originals/);
    await expect(storage.putDerivative('cards/../originals/x.jpg', Buffer.from('x'))).rejects.toThrow();

    expect(store.calls).toEqual([]);
  });
});
