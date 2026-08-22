/**
 * Хуки коллекции изображений (Э2-05, Э2-06): что происходит при загрузке, при
 * сохранении БЕЗ нового файла и при замене байтов.
 *
 * Проверяется то, что нельзя проверить конфигурацией:
 *   - сохранение записи без нового файла НЕ пересчитывает ключи (условие C1) и
 *     не трогает хранилище — иначе правка названия переписывала бы пути;
 *   - имя занимается через реестр: занятое имя даёт суффикс `-N`;
 *   - замена байтов изображения, стоящего на публиковавшейся карточке, —
 *     действие человека, и отказ ГРОМКИЙ (403), а не молчаливый;
 *   - объекты прежней версии удаляются ПОСЛЕ фиксации записи, в `afterChange`.
 */
import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import { createPngFixture } from './png-fixture';
import type { ImageStorage } from './storage';
import { cardImageUploadHooks } from './upload-hooks';

type Doc = Record<string, unknown>;

interface HookArgs {
  readonly data?: Doc;
  readonly doc?: Doc;
  readonly operation?: string;
  readonly originalDoc?: Doc;
  readonly req: PayloadRequest;
}

type LooseHook = (args: HookArgs) => unknown;

function memoryStorage(): ImageStorage & {
  readonly derivatives: Map<string, Buffer>;
  readonly originals: Map<string, Buffer>;
} {
  const derivatives = new Map<string, Buffer>();
  const originals = new Map<string, Buffer>();
  return {
    derivatives,
    kind: 'memory',
    originals,
    deleteDerivative: (key) => Promise.resolve(void derivatives.delete(key)),
    deleteOriginal: (key) => Promise.resolve(void originals.delete(key)),
    hasDerivative: (key) => Promise.resolve(derivatives.has(key)),
    hasOriginal: (key) => Promise.resolve(originals.has(key)),
    putDerivative: (key, data) => Promise.resolve(void derivatives.set(key, data)),
    putOriginal: (key, data) => Promise.resolve(void originals.set(key, data)),
    readOriginal: (key) => {
      const data = originals.get(key);
      return data === undefined
        ? Promise.reject(new Error(`нет оригинала ${key}`))
        : Promise.resolve(data);
    },
  };
}

const SOURCE = createPngFixture({ height: 400, width: 660 });
const REPLACEMENT = createPngFixture({ composition: 'rings', height: 400, width: 660 });

const ADMIN = { collection: 'users', id: 1, role: 'admin' };
const AI_EDITOR = { collection: 'users', id: 2, role: 'ai-editor' };

interface Stand {
  readonly claims: string[];
  readonly req: PayloadRequest;
  readonly storage: ReturnType<typeof memoryStorage>;
}

function stand(options: {
  readonly file?: Buffer;
  /** Имена, которые реестр считает занятыми. */
  readonly takenStems?: readonly string[];
  /** Сколько публиковавшихся карточек ссылается на изображение. */
  readonly usedByPublished?: number;
  readonly user: Doc | null;
}): Stand {
  const storage = memoryStorage();
  const claims: string[] = [];
  const taken = new Set(options.takenStems ?? []);

  const req = {
    context: {},
    file:
      options.file === undefined
        ? undefined
        : {
            data: options.file,
            mimetype: 'image/png',
            name: 'IMG_0001.png',
            size: options.file.byteLength,
          },
    payload: {
      count: () => Promise.resolve({ totalDocs: options.usedByPublished ?? 0 }),
      create: ({ collection, data }: { collection: string; data: Doc }) => {
        if (collection !== 'image-name-claims') {
          return Promise.reject(new Error(`неожиданная коллекция ${collection}`));
        }
        const stem = String(data.stem);
        if (taken.has(stem)) {
          return Promise.reject(new Error('duplicate key value violates unique constraint'));
        }
        taken.add(stem);
        claims.push(stem);
        return Promise.resolve({ id: claims.length });
      },
      find: ({ collection }: { collection: string }) =>
        collection === 'image-name-claims'
          ? Promise.resolve({ docs: [...taken].map((stem) => ({ stem })) })
          : Promise.resolve({ docs: [] }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    user: options.user,
  } as unknown as PayloadRequest;

  return { claims, req, storage };
}

function hooksFor(storage: ImageStorage): {
  readonly afterChange: LooseHook;
  readonly beforeChange: LooseHook;
  readonly afterDelete: LooseHook;
} {
  const hooks = cardImageUploadHooks({ storage });
  return {
    // afterChange — цепочка из двух хуков (запись новых файлов, потом уборка
    // прежних), и порядок в ней значим. Стенд прогоняет её целиком: проверять
    // первый хук в отрыве значило бы проверять не то, что делает Payload.
    afterChange: async (args) => {
      let result: unknown;
      for (const hook of hooks.afterChange) {
        result = await (hook as unknown as LooseHook)(args);
      }
      return result;
    },
    afterDelete: hooks.afterDelete[0] as unknown as LooseHook,
    beforeChange: hooks.beforeChange[0] as unknown as LooseHook,
  };
}

const STORED: Doc = {
  id: 5,
  keyBase: 'cards/aaaaaaaa/otkrytka-mame',
  nameStem: 'otkrytka-mame',
  nameSuffix: null,
  originalKey: 'originals/0123456789abcdef0123456789abcdef.png',
  pHash: 'ffffffffffffffff',
  revision: 'aaaaaaaa',
  storageId: '0123456789abcdef0123456789abcdef',
  variants: [{ key: 'cards/aaaaaaaa/otkrytka-mame-320.webp' }],
};

describe('сохранение без нового файла (условие C1)', () => {
  it('ключи не пересчитываются, хранилище не трогается', async () => {
    const { req, storage } = stand({ user: ADMIN });
    const hooks = hooksFor(storage);

    const result = (await hooks.beforeChange({
      data: { title: 'Совсем другое название изображения' },
      operation: 'update',
      originalDoc: STORED,
      req,
    })) as Doc;

    expect(result.nameStem).toBe('otkrytka-mame');
    expect(result.revision).toBe('aaaaaaaa');
    expect(result.keyBase).toBe('cards/aaaaaaaa/otkrytka-mame');
    expect(result.originalKey).toBe(STORED.originalKey);
    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  });
});

describe('первая загрузка', () => {
  it('имя занимается в реестре; занятое даёт суффикс -2', async () => {
    const { claims, req, storage } = stand({
      file: SOURCE,
      takenStems: ['otkrytka-mame-na-8-marta'],
      user: AI_EDITOR,
    });
    const hooks = hooksFor(storage);

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме на 8 марта' },
      operation: 'create',
      req,
    })) as Doc;

    expect(result.nameStem).toBe('otkrytka-mame-na-8-marta-2');
    expect(result.nameSuffix).toBe(2);
    expect(claims).toEqual(['otkrytka-mame-na-8-marta-2']);
    expect(result.pHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.filename).toBe('otkrytka-mame-na-8-marta-2.png');

    // Файлов ещё НЕТ: пока документ не записан, в публичном пространстве не
    // должно быть ни одного объекта (находка ревизии от 2026-08-22).
    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);

    await hooks.afterChange({ doc: { ...result, id: 9 }, req });

    expect(storage.derivatives.size).toBe(6);
    expect(storage.originals.size).toBe(1);
  }, 60_000);

  it('отказ ПОСЛЕ пайплайна не оставляет файлов: запись отложена до afterChange', async () => {
    // Именно этот случай раньше оставлял мусор: пайплайн писал файлы в
    // beforeChange, а операция могла провалиться позже (валидация поля, ошибка
    // базы, откат транзакции). Хука «операция провалилась» у Payload нет,
    // поэтому запись отложена до фазы, где документ уже существует.
    const { req, storage } = stand({ file: SOURCE, user: AI_EDITOR });
    const hooks = hooksFor(storage);

    await hooks.beforeChange({
      data: { title: 'Открытка маме на 8 марта' },
      operation: 'create',
      req,
    });

    // afterChange не вызывается — операция «провалилась».
    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  }, 60_000);

  it('ошибка записи производной убирает за собой и валит операцию', async () => {
    const { req, storage } = stand({ file: SOURCE, user: AI_EDITOR });
    const failing: ImageStorage = {
      ...storage,
      putDerivative: (key, data) =>
        key.endsWith('-640.avif')
          ? Promise.reject(new Error('диск переполнен'))
          : storage.putDerivative(key, data),
    };
    const hooks = hooksFor(failing);

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме на 8 марта' },
      operation: 'create',
      req,
    })) as Doc;

    await expect(
      hooks.afterChange({ doc: { ...result, id: 9 }, req }) as Promise<unknown>,
    ).rejects.toThrow(/диск переполнен/);

    // Ни одного файла: половина набора в публичном пространстве — это адрес,
    // который отдаётся наружу, а записи о нём нет ни у кого.
    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  }, 60_000);
});

describe('замена байтов: право и уборка', () => {
  it('сервисный аккаунт не заменяет файл публиковавшейся карточки', async () => {
    const { req, storage } = stand({ file: REPLACEMENT, usedByPublished: 1, user: AI_EDITOR });
    const hooks = hooksFor(storage);

    const error = await (hooks.beforeChange({
      data: { title: 'Открытка маме' },
      operation: 'update',
      originalDoc: STORED,
      req,
    }) as Promise<unknown>).catch((caught: unknown) => caught);

    const refusal = error as { data?: { rule?: unknown }; status?: unknown };
    expect(refusal.status).toBe(403);
    expect(refusal.data?.rule).toBe('image-change-requires-admin');
    // Отказ произошёл ДО пайплайна: ни одного файла не записано.
    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  });

  it('сервисный аккаунт заменяет файл, не стоящий на публиковавшейся карточке', async () => {
    const { req, storage } = stand({ file: REPLACEMENT, usedByPublished: 0, user: AI_EDITOR });
    const hooks = hooksFor(storage);

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме' },
      operation: 'update',
      originalDoc: STORED,
      req,
    })) as Doc;

    expect(result.revision).not.toBe('aaaaaaaa');
    expect(result.nameStem).toBe('otkrytka-mame');
  }, 60_000);

  it('прежние объекты удаляются в afterChange, а не до записи', async () => {
    const { req, storage } = stand({ file: REPLACEMENT, user: ADMIN });
    const hooks = hooksFor(storage);

    // Прежние файлы «уже лежат» в хранилище.
    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('old'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('old'));

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме' },
      operation: 'update',
      originalDoc: STORED,
      req,
    })) as Doc;

    // До фиксации записи прежние объекты ещё на месте: иначе запись какое-то
    // время ссылалась бы на файлы, которых нет.
    expect(storage.derivatives.has('cards/aaaaaaaa/otkrytka-mame-320.webp')).toBe(true);
    expect(storage.originals.has(String(STORED.originalKey))).toBe(true);

    await hooks.afterChange({ doc: { ...STORED, ...result }, req });

    expect(storage.derivatives.has('cards/aaaaaaaa/otkrytka-mame-320.webp')).toBe(false);
    expect(storage.originals.has(String(STORED.originalKey))).toBe(false);
  }, 60_000);
});

describe('удаление записи', () => {
  it('убирает и производные, и оригинал', async () => {
    const { req, storage } = stand({ user: ADMIN });
    const hooks = hooksFor(storage);

    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('x'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('x'));

    await hooks.afterDelete({ doc: STORED, req });

    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  });
});
