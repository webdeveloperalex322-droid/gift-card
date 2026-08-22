/**
 * Локальная ФС за интерфейсом хранилища (задача Э2-04, условие C4 в новой
 * формулировке: раздельные каталоги и оригиналы ВНЕ корня раздачи).
 *
 * TDD: тест написан до реализации. Главная проверка здесь — не «файл записался»,
 * а «оригинал структурно недостижим из публичного пространства»:
 *
 *   - корень оригиналов не может лежать внутри корня производных (и наоборот),
 *     и это отказ при создании адаптера, а не настройка сервера. Настройку
 *     забывают, отказ — нет;
 *   - из публичного пути производной путь оригинала не выводится: у адаптера нет
 *     ни такой функции, ни общего с производными каталога;
 *   - ключ с `..` не открывает файл за пределами корня даже если проверка формы
 *     ключа однажды ослабнет: путь проверяется ещё и после разрешения.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalFsImageStorage } from './local-fs-storage';
import { DERIVATIVE_KEY_PREFIX, ORIGINAL_KEY_PREFIX } from './storage';

const DERIVATIVE_KEY = `${DERIVATIVE_KEY_PREFIX}/a1b2c3d4/otkrytka-mame-640.webp`;
const ORIGINAL_KEY = `${ORIGINAL_KEY_PREFIX}/0123456789abcdef0123456789abcdef.jpg`;

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'otkritka-storage-'));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function storageAt(): ReturnType<typeof createLocalFsImageStorage> {
  return createLocalFsImageStorage({
    derivativesRoot: path.join(root, 'media'),
    originalsRoot: path.join(root, 'uploads'),
  });
}

describe('раздельность пространств (условие C4)', () => {
  it('оригиналы внутри корня производных — отказ при создании адаптера', () => {
    expect(() =>
      createLocalFsImageStorage({
        derivativesRoot: path.join(root, 'media'),
        originalsRoot: path.join(root, 'media', 'originals'),
      }),
    ).toThrow(/вне/i);
  });

  it('корень производных внутри корня оригиналов — тоже отказ', () => {
    // Обратный случай не безобиднее: тогда публичный каталог отдавал бы всё
    // дерево оригиналов.
    expect(() =>
      createLocalFsImageStorage({
        derivativesRoot: path.join(root, 'uploads', 'media'),
        originalsRoot: path.join(root, 'uploads'),
      }),
    ).toThrow(/вне/i);
  });

  it('один и тот же каталог для обоих пространств — отказ', () => {
    expect(() =>
      createLocalFsImageStorage({
        derivativesRoot: path.join(root, 'media'),
        originalsRoot: path.join(root, 'media'),
      }),
    ).toThrow(/вне/i);
  });

  it('оригинал не лежит в дереве, которое отдаётся по /media', async () => {
    const storage = storageAt();
    await storage.putOriginal(ORIGINAL_KEY, Buffer.from('original-bytes'));
    await storage.putDerivative(DERIVATIVE_KEY, Buffer.from('derivative-bytes'));

    // Прямой запрос к оригиналу по угадываемому публичному URL не проходит:
    // в корне раздачи такого файла нет ни под своим ключом, ни под ключом
    // производной.
    const insidePublicRoot = path.join(root, 'media', ORIGINAL_KEY);
    await expect(readFile(insidePublicRoot)).rejects.toThrow();

    // А в непубличном корне он есть — то есть отсутствие в публичном не
    // означает, что файл просто не сохранился.
    const inPrivateRoot = path.join(root, 'uploads', ORIGINAL_KEY);
    expect((await readFile(inPrivateRoot)).toString()).toBe('original-bytes');
  });
});

describe('запись, чтение и удаление', () => {
  it('производная сохраняется по своему ключу и читается обратно', async () => {
    const storage = storageAt();
    expect(await storage.hasDerivative(DERIVATIVE_KEY)).toBe(false);

    await storage.putDerivative(DERIVATIVE_KEY, Buffer.from('bytes'));

    expect(await storage.hasDerivative(DERIVATIVE_KEY)).toBe(true);
    const onDisk = await readFile(path.join(root, 'media', DERIVATIVE_KEY));
    expect(onDisk.toString()).toBe('bytes');
  });

  it('оригинал читается из непубличного пространства', async () => {
    const storage = storageAt();
    await storage.putOriginal(ORIGINAL_KEY, Buffer.from('original'));
    expect((await storage.readOriginal(ORIGINAL_KEY)).toString()).toBe('original');
    expect(await storage.hasOriginal(ORIGINAL_KEY)).toBe(true);
  });

  it('удаление отсутствующего объекта не считается ошибкой', async () => {
    // Уборка после замены изображения (Э2-06) идёт по сохранённым ключам:
    // повторный проход не должен валить операцию.
    const storage = storageAt();
    await expect(storage.deleteDerivative(DERIVATIVE_KEY)).resolves.toBeUndefined();
    await expect(storage.deleteOriginal(ORIGINAL_KEY)).resolves.toBeUndefined();
  });

  it('удаление убирает файл из своего пространства', async () => {
    const storage = storageAt();
    await storage.putDerivative(DERIVATIVE_KEY, Buffer.from('bytes'));
    await storage.deleteDerivative(DERIVATIVE_KEY);
    expect(await storage.hasDerivative(DERIVATIVE_KEY)).toBe(false);
  });

  it('опустевшие каталоги ревизии убираются, корень остаётся', async () => {
    // Каталог производной — это сегмент revision, то есть хеш содержимого:
    // каждая замена изображения оставляла бы за собой пустую папку.
    const storage = storageAt();
    await storage.putDerivative(DERIVATIVE_KEY, Buffer.from('bytes'));
    await storage.deleteDerivative(DERIVATIVE_KEY);

    await expect(stat(path.join(root, 'media', 'cards', 'a1b2c3d4'))).rejects.toThrow();
    await expect(stat(path.join(root, 'media'))).resolves.toBeTruthy();
  });

  it('каталог с другими файлами не удаляется', async () => {
    const storage = storageAt();
    const neighbour = `${DERIVATIVE_KEY_PREFIX}/a1b2c3d4/otkrytka-mame-320.webp`;
    await storage.putDerivative(DERIVATIVE_KEY, Buffer.from('bytes'));
    await storage.putDerivative(neighbour, Buffer.from('bytes'));
    await storage.deleteDerivative(DERIVATIVE_KEY);

    expect(await storage.hasDerivative(neighbour)).toBe(true);
  });

  it('чтение отсутствующего оригинала даёт внятную ошибку с ключом', async () => {
    const storage = storageAt();
    await expect(storage.readOriginal(ORIGINAL_KEY)).rejects.toThrow(new RegExp(ORIGINAL_KEY));
  });
});

describe('выход за пределы корня', () => {
  it('ключ с ../ отклоняется, а не открывает соседний каталог', async () => {
    const storage = storageAt();
    const secret = path.join(root, 'secret.txt');
    await writeFile(secret, 'nope');

    await expect(storage.readOriginal('originals/../../secret.txt')).rejects.toThrow();
    await expect(
      storage.putDerivative('cards/../../secret.txt', Buffer.from('x')),
    ).rejects.toThrow();
    expect((await readFile(secret)).toString()).toBe('nope');
  });

  it('относительные корни отклоняются: адаптер работает по абсолютным путям', () => {
    expect(() =>
      createLocalFsImageStorage({ derivativesRoot: 'media', originalsRoot: 'uploads' }),
    ).toThrow(/абсолютн/i);
  });
});
