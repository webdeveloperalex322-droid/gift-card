/**
 * Хуки коллекции изображений (Э2-05, Э2-06, Э3-03a): что происходит при
 * загрузке, при сохранении БЕЗ нового файла, при замене байтов и при удалении.
 *
 * Проверяется то, что нельзя проверить конфигурацией:
 *   - сохранение записи без нового файла НЕ пересчитывает ключи (условие C1) и
 *     не трогает хранилище — иначе правка названия переписывала бы пути;
 *   - имя занимается через реестр: занятое имя даёт суффикс `-N`;
 *   - замена байтов изображения, стоящего на публиковавшейся карточке, —
 *     действие человека, и отказ ГРОМКИЙ (403), а не молчаливый;
 *   - объекты прежней версии удаляются ПОСЛЕ фиксации записи, в `afterChange`,
 *     и ПОСЛЕ пересинхронизации зеркала — порядок фаз проверяется протоколом
 *     вызовов, а не только числом хуков в конфиге;
 *   - пересинхронизация зеркала трогает ТОЛЬКО карточки, ссылающиеся на это
 *     изображение, идёт по всем страницам выборки и при обрыве по пределу
 *     оставляет прежние файлы на месте;
 *   - удаление изображения, на которое ссылается карточка, ОТКЛОНЯЕТСЯ: связь в
 *     базе каскадная, поэтому иначе зеркало карточки осталось бы с ключами
 *     удалённых файлов.
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
  readonly id?: number | string;
  readonly operation?: string;
  readonly originalDoc?: Doc;
  readonly previousDoc?: Doc;
  readonly req: PayloadRequest;
}

type LooseHook = (args: HookArgs) => unknown;

/**
 * Хранилище в памяти с ПРОТОКОЛОМ обращений.
 *
 * Протокол нужен не для отладки: порядок «записать новое → перевести зеркало →
 * убрать прежнее» объявлен значимым, и без последовательности вызовов
 * перестановка хуков при рефакторинге не уронила бы ни один тест (находка
 * ревизии от 2026-08-22).
 */
function memoryStorage(events: string[] = []): ImageStorage & {
  readonly derivatives: Map<string, Buffer>;
  readonly events: string[];
  readonly originals: Map<string, Buffer>;
} {
  const derivatives = new Map<string, Buffer>();
  const originals = new Map<string, Buffer>();
  return {
    derivatives,
    events,
    kind: 'memory',
    originals,
    deleteDerivative: (key) => {
      events.push(`delete-derivative:${key}`);
      return Promise.resolve(void derivatives.delete(key));
    },
    deleteOriginal: (key) => {
      events.push(`delete-original:${key}`);
      return Promise.resolve(void originals.delete(key));
    },
    hasDerivative: (key) => Promise.resolve(derivatives.has(key)),
    hasOriginal: (key) => Promise.resolve(originals.has(key)),
    putDerivative: (key, data) => {
      events.push(`put-derivative:${key}`);
      return Promise.resolve(void derivatives.set(key, data));
    },
    putOriginal: (key, data) => {
      events.push(`put-original:${key}`);
      return Promise.resolve(void originals.set(key, data));
    },
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
  /** Протокол обращений к хранилищу и к карточкам — в порядке вызова. */
  readonly events: string[];
  /** Сообщения журнала по уровням: «громко, а не молча» проверяется по ним. */
  readonly logs: { level: string; message: string }[];
  /** Идентификаторы карточек, которые хук пересохранил, в порядке вызова. */
  readonly resaved: (number | string)[];
  readonly req: PayloadRequest;
  readonly storage: ReturnType<typeof memoryStorage>;
  /** Условия `where`, с которыми хуки обращались к коллекции `cards`. */
  readonly whereCards: unknown[];
}

/** Условие вида `{ поле: { оператор: значение } }` в разобранном виде. */
function readCondition(where: unknown): { field: string; op: string; value: unknown }[] {
  const record = typeof where === 'object' && where !== null ? (where as Record<string, unknown>) : {};
  const parts = Array.isArray(record.and) ? record.and : [record];
  const conditions: { field: string; op: string; value: unknown }[] = [];
  for (const part of parts) {
    const entry = typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : {};
    for (const [field, raw] of Object.entries(entry)) {
      const ops = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      for (const [op, value] of Object.entries(ops)) {
        conditions.push({ field, op, value });
      }
    }
  }
  return conditions;
}

function stand(options: {
  /**
   * Карточки в «базе» стенда. Поле `image` ОБЯЗАТЕЛЬНО: стенд честно применяет
   * `where`, поэтому ошибочный фильтр (например, обход всех карточек вместо
   * ссылающихся на это изображение) роняет тест, а не проходит незамеченным
   * (находка ревизии от 2026-08-22).
   */
  readonly cards?: readonly Doc[];
  readonly file?: Buffer;
  /** Имена, которые реестр считает занятыми. */
  readonly takenStems?: readonly string[];
  /** Сколько публиковавшихся карточек ссылается на изображение. */
  readonly usedByPublished?: number;
  readonly user: Doc | null;
}): Stand {
  const events: string[] = [];
  const storage = memoryStorage(events);
  const claims: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const resaved: (number | string)[] = [];
  const whereCards: unknown[] = [];
  const taken = new Set(options.takenStems ?? []);
  const cards = [...(options.cards ?? [])];

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
      find: ({
        collection,
        limit,
        where,
      }: {
        collection: string;
        limit?: number;
        where?: unknown;
      }) => {
        if (collection === 'image-name-claims') {
          return Promise.resolve({ docs: [...taken].map((stem) => ({ stem })) });
        }
        if (collection === 'cards') {
          whereCards.push(where);
          const conditions = readCondition(where);
          const imageEquals = conditions.find(
            (condition) => condition.field === 'image' && condition.op === 'equals',
          );
          const after = conditions.find(
            (condition) => condition.field === 'id' && condition.op === 'greater_than',
          );
          let matching = [...cards].sort((left, right) => Number(left.id) - Number(right.id));
          if (imageEquals !== undefined) {
            matching = matching.filter((card) => card.image === imageEquals.value);
          }
          const remaining =
            after === undefined
              ? matching
              : matching.filter((card) => Number(card.id) > Number(after.value));
          const size = limit ?? remaining.length;
          return Promise.resolve({
            docs: remaining.slice(0, size),
            hasNextPage: remaining.length > size,
            totalDocs: matching.length,
          });
        }
        return Promise.resolve({ docs: [], hasNextPage: false, totalDocs: 0 });
      },
      logger: {
        error: (message: string) => void logs.push({ level: 'error', message }),
        info: (message: string) => void logs.push({ level: 'info', message }),
        warn: (message: string) => void logs.push({ level: 'warn', message }),
      },
      update: ({ collection, data, id }: { collection: string; data: Doc; id: number | string }) => {
        if (collection !== 'cards') {
          return Promise.reject(new Error(`неожиданная коллекция ${collection}`));
        }
        // Данные пустые НАМЕРЕННО: зеркало пишет хук карточки, перечитывая
        // запись изображения. Стенд это фиксирует — второй автор зеркала был бы
        // ошибкой.
        if (Object.keys(data).length > 0) {
          return Promise.reject(
            new Error(`пересинхронизация передала данные: ${JSON.stringify(data)}`),
          );
        }
        resaved.push(id);
        events.push(`resync-card:${String(id)}`);
        return Promise.resolve({ id });
      },
    },
    user: options.user,
  } as unknown as PayloadRequest;

  return { claims, events, logs, req, resaved, storage, whereCards };
}

function hooksFor(
  storage: ImageStorage,
  resync?: { readonly maxCards?: number; readonly pageSize?: number },
): {
  readonly afterChange: LooseHook;
  readonly beforeChange: LooseHook;
  readonly afterDelete: LooseHook;
  readonly beforeDelete: LooseHook;
} {
  const hooks = cardImageUploadHooks(
    resync === undefined ? { storage } : { resync, storage },
  );
  return {
    // afterChange — цепочка из трёх хуков (запись новых файлов, пересинхронизация
    // зеркала, уборка прежних), и порядок в ней значим. Стенд прогоняет её
    // целиком: проверять первый хук в отрыве значило бы проверять не то, что
    // делает Payload.
    afterChange: async (args) => {
      let result: unknown;
      for (const hook of hooks.afterChange) {
        result = await (hook as unknown as LooseHook)(args);
      }
      return result;
    },
    afterDelete: hooks.afterDelete[0] as unknown as LooseHook,
    beforeChange: hooks.beforeChange[0] as unknown as LooseHook,
    beforeDelete: hooks.beforeDelete[0] as unknown as LooseHook,
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

/**
 * Пересинхронизация зеркала в карточках (задача Э3-03a).
 *
 * Зеркало (`cards.derivative.*`, `cards.derivative.variants[]`) заполняет хук
 * КАРТОЧКИ при её сохранении. Значит, замена байтов изображения сама по себе его
 * не обновляет: прежние файлы удаляются, а опубликованная карточка продолжает
 * ссылаться на удалённые ключи — до следующего сохранения карточки, которого
 * может не случиться никогда. Именно это и проверяется здесь.
 */
describe('зеркало в карточках после сохранения изображения', () => {
  const OLD_STATE: Doc = {
    ...STORED,
    variants: [
      { byteSize: 100, format: 'webp', height: 200, key: 'cards/aaaaaaaa/otkrytka-mame-320.webp', width: 320 },
    ],
  };
  const NEW_STATE: Doc = {
    ...STORED,
    keyBase: 'cards/bbbbbbbb/otkrytka-mame',
    revision: 'bbbbbbbb',
    variants: [
      { byteSize: 100, format: 'webp', height: 200, key: 'cards/bbbbbbbb/otkrytka-mame-320.webp', width: 320 },
    ],
  };

  it('новые ключи после замены байтов доводятся до карточек сразу', async () => {
    const { req, resaved, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'otkrytka-mame' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await hooks.afterChange({
      doc: NEW_STATE,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([11]);
  });

  it('чужая карточка не пересохраняется: область — только ссылающиеся', async () => {
    // Стенд честно применяет `where`. Без этого проверка была бы пустой:
    // ошибочный фильтр превратил бы пересинхронизацию в пересохранение ВСЕХ
    // карточек каталога и остался бы зелёным (находка ревизии от 2026-08-22).
    const { req, resaved, storage, whereCards } = stand({
      cards: [
        { id: 11, image: 5, slug: 'otkrytka-mame' },
        { id: 12, image: 6, slug: 'chuzhaya-otkrytka' },
      ],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await hooks.afterChange({
      doc: NEW_STATE,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([11]);
    expect(resaved).not.toContain(12);
    // И сам фильтр: обход обязан спрашивать именно про это изображение.
    expect(JSON.stringify(whereCards[0])).toContain('"image"');
  });

  it('обход идёт по ВСЕМ страницам выборки, а не только по первой', async () => {
    // Пять карточек при странице из двух: без курсорного обхода зеркало
    // обновилось бы у двух, а три опубликованные страницы остались бы со
    // ссылками на удалённые файлы.
    const { req, resaved, storage } = stand({
      cards: [11, 12, 13, 14, 15].map((id) => ({ id, image: 5, slug: `otkrytka-${String(id)}` })),
      user: ADMIN,
    });
    const hooks = hooksFor(storage, { pageSize: 2 });

    await hooks.afterChange({
      doc: NEW_STATE,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([11, 12, 13, 14, 15]);
  });

  it('число карточек, КРАТНОЕ странице, не считается обрывом', async () => {
    // Ложная тревога прежней версии: при ровно `pageSize` карточек последняя
    // страница приходит полной, и правило «полная страница ⇒ есть ещё» давало
    // logger.error о несогласованности, которой нет.
    const { logs, req, resaved, storage } = stand({
      cards: [11, 12, 13, 14].map((id) => ({ id, image: 5, slug: `otkrytka-${String(id)}` })),
      user: ADMIN,
    });
    const hooks = hooksFor(storage, { maxCards: 4, pageSize: 2 });

    await hooks.afterChange({
      doc: NEW_STATE,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([11, 12, 13, 14]);
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('обрыв по пределу: громкая ошибка в журнале и прежние файлы НЕ удаляются', async () => {
    // Ключевая часть — вторая. Убрав прежние файлы при неполном обходе, мы
    // оставили бы часть опубликованных страниц вовсе без изображений: у них
    // зеркало ещё на прежних ключах.
    const { logs, req, resaved, storage } = stand({
      cards: [11, 12, 13, 14, 15].map((id) => ({ id, image: 5, slug: `otkrytka-${String(id)}` })),
      file: REPLACEMENT,
      user: ADMIN,
    });
    const hooks = hooksFor(storage, { maxCards: 2, pageSize: 2 });

    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('old'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('old'));

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме' },
      operation: 'update',
      originalDoc: STORED,
      req,
    })) as Doc;

    await hooks.afterChange({
      doc: { ...STORED, ...result },
      operation: 'update',
      previousDoc: STORED,
      req,
    });

    expect(resaved).toEqual([11, 12]);
    const errors = logs.filter((entry) => entry.level === 'error');
    expect(errors.length).toBe(2);
    expect(errors[0]?.message).toContain('ОБОРВАН');
    expect(errors[1]?.message).toContain('ПРОПУЩЕНА');
    // Прежние объекты на месте: страницы с необновлённым зеркалом продолжают
    // показывать старую картинку, а не пустое место.
    expect(storage.derivatives.has('cards/aaaaaaaa/otkrytka-mame-320.webp')).toBe(true);
    expect(storage.originals.has(String(STORED.originalKey))).toBe(true);
  }, 60_000);

  it('несодержательное сохранение изображения карточки не трогает (условие C1)', async () => {
    // Правка названия изображения: ключи те же. Пересохранение карточек здесь
    // было бы не «безвредным», а лишним изменением записи, которое попадает в
    // updatedAt опубликованной страницы.
    const { req, resaved, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'otkrytka-mame' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await hooks.afterChange({
      doc: { ...OLD_STATE, title: 'Другое название' },
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([]);
  });

  it('первая загрузка карточек не касается: ссылок на новое изображение ещё нет', async () => {
    const { req, resaved, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'otkrytka-mame' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await hooks.afterChange({ doc: NEW_STATE, operation: 'create', req });

    expect(resaved).toEqual([]);
  });

  it('изменившаяся высота одного варианта — уже причина обновить зеркало', async () => {
    // Не только ключи: разметка резервирует место по height, и расхождение на
    // пиксель — это CLS.
    const nudged: Doc = {
      ...OLD_STATE,
      variants: [
        { byteSize: 100, format: 'webp', height: 201, key: 'cards/aaaaaaaa/otkrytka-mame-320.webp', width: 320 },
      ],
    };
    const { req, resaved, storage } = stand({ cards: [{ id: 11, image: 5 }], user: ADMIN });
    const hooks = hooksFor(storage);

    await hooks.afterChange({
      doc: nudged,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([11]);
  });

  it('карточек нет — пересинхронизировать нечего, и это не ошибка', async () => {
    const { req, resaved, storage } = stand({ user: ADMIN });
    const hooks = hooksFor(storage);

    await hooks.afterChange({
      doc: NEW_STATE,
      operation: 'update',
      previousDoc: OLD_STATE,
      req,
    });

    expect(resaved).toEqual([]);
  });

  it('порядок фаз: новые файлы → зеркало → уборка прежних', async () => {
    // Порядок объявлен значимым в конфиге коллекции, но конфиг проверяет только
    // ЧИСЛО хуков: перестановка при рефакторинге тест не уронила бы (находка
    // ревизии от 2026-08-22). Здесь проверяется сам протокол вызовов.
    const { events, req, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'otkrytka-mame' }],
      file: REPLACEMENT,
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('old'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('old'));
    events.length = 0;

    const result = (await hooks.beforeChange({
      data: { title: 'Открытка маме' },
      operation: 'update',
      originalDoc: STORED,
      req,
    })) as Doc;

    await hooks.afterChange({
      doc: { ...STORED, ...result },
      operation: 'update',
      previousDoc: STORED,
      req,
    });

    const firstPut = events.findIndex((event) => event.startsWith('put-derivative:'));
    const resync = events.indexOf('resync-card:11');
    const firstDelete = events.findIndex((event) => event.startsWith('delete-'));

    expect(firstPut).toBeGreaterThanOrEqual(0);
    expect(resync).toBeGreaterThan(firstPut);
    expect(firstDelete).toBeGreaterThan(resync);
  }, 60_000);
});

/**
 * Удаление записи изображения (Э3-03a, находка ревизии от 2026-08-22).
 *
 * Связь `cards.image` живёт в `cards_rels` с `onDelete: 'cascade'`, поэтому
 * удаление записи изображения обнуляет поле у карточки МОЛЧА, минуя все хуки
 * карточки, — а зеркало `derivative.variants[]` остаётся заполненным ключами
 * файлов, которых уже нет. Опубликованная страница после этого отдаёт 200 с
 * `<img src>` в никуда.
 */
describe('удаление записи', () => {
  it('убирает и производные, и оригинал, когда на файл никто не ссылается', async () => {
    const { req, storage } = stand({ user: ADMIN });
    const hooks = hooksFor(storage);

    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('x'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('x'));

    // Отказа нет: ни одна карточка на изображение не ссылается.
    await hooks.beforeDelete({ id: 5, req });
    await hooks.afterDelete({ doc: STORED, req });

    expect(storage.derivatives.size).toBe(0);
    expect(storage.originals.size).toBe(0);
  });

  it('ОТКАЗ, если на изображение ссылается опубликованная карточка', async () => {
    const { req, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'otkrytka-mame', status: 'published' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await storage.putDerivative('cards/aaaaaaaa/otkrytka-mame-320.webp', Buffer.from('x'));
    await storage.putOriginal(String(STORED.originalKey), Buffer.from('x'));

    const error = await (hooks.beforeDelete({ id: 5, req }) as Promise<unknown>).catch(
      (caught: unknown) => caught,
    );

    const refusal = error as { data?: { rule?: unknown }; message?: string; status?: unknown };
    expect(refusal.status).toBe(400);
    expect(refusal.data?.rule).toBe('image-in-use');
    // Отказ обязан назвать карточку и сказать, куда идти: иначе редактор знает
    // только «нельзя».
    expect(refusal.message).toContain('otkrytka-mame');
    expect(refusal.message).toContain('published');
    // Файлы на месте: отказ сработал ДО фазы удаления объектов.
    expect(storage.derivatives.size).toBe(1);
    expect(storage.originals.size).toBe(1);
  });

  it('ОТКАЗ и для черновика: у него зеркало осталось бы таким же мёртвым', async () => {
    const { req, storage } = stand({
      cards: [{ id: 11, image: 5, slug: 'chernovik', status: 'draft' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await expect(hooks.beforeDelete({ id: 5, req }) as Promise<unknown>).rejects.toThrow(
      /ссылаются карточки/,
    );
  });

  it('чужая карточка удалению не мешает: считаются только ссылки на ЭТО изображение', async () => {
    const { req, storage } = stand({
      cards: [{ id: 12, image: 6, slug: 'chuzhaya-otkrytka', status: 'published' }],
      user: ADMIN,
    });
    const hooks = hooksFor(storage);

    await expect(hooks.beforeDelete({ id: 5, req }) as Promise<unknown>).resolves.toBeUndefined();
  });
});
