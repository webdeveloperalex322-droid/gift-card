/**
 * Хуки карточки, связанные с изображением (Э2-05, Э2-06): права и блокировки.
 *
 * Тесты негативные по построению: право «заменить изображение публиковавшейся
 * карточки только человеком» подтверждается не тем, что админ смог, а тем, что
 * сервисный аккаунт получил ГРОМКИЙ отказ. Молчаливого отказа на уровне поля для
 * этого недостаточно: внешний клиент видит 200 и считает подмену применённой —
 * ровно это и обнаружил смоук до появления хука `beforeOperation`.
 */
import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import { cardImageHooks } from './card-image-hooks';

type Doc = Record<string, unknown>;

interface HookArgs {
  readonly args?: object;
  readonly data?: Doc;
  readonly operation?: string;
  readonly originalDoc?: Doc;
  readonly req: PayloadRequest;
}

type LooseHook = (args: HookArgs) => unknown;

const hooks = cardImageHooks();

function asHook(hook: unknown): LooseHook {
  return hook as LooseHook;
}

const beforeOperation = asHook(hooks.beforeOperation[0]);
const beforeValidate = asHook(hooks.beforeValidate[0]);
const beforeChange = asHook(hooks.beforeChange[0]);

interface Stand {
  readonly findByIdCalls: string[];
  readonly req: PayloadRequest;
}

/** Условие выборки в том виде, в каком его строит хук. */
interface FindArgs {
  readonly collection: string;
  readonly limit?: number;
  readonly where?: unknown;
}

/**
 * Курсор из условия: стенд обязан вести себя как база, иначе постраничный обход
 * проверялся бы против собственных ожиданий. Читается `{ id: { greater_than } }`
 * внутри `and`.
 */
function readCursor(where: unknown): number {
  const field = (source: unknown, name: string): unknown => {
    if (typeof source !== 'object' || source === null || !(name in source)) {
      return undefined;
    }
    const record: Record<string, unknown> = { ...source };
    return record[name];
  };

  const clauses = field(where, 'and');
  if (!Array.isArray(clauses)) {
    return 0;
  }
  for (const clause of clauses) {
    const value = field(field(clause, 'id'), 'greater_than');
    if (typeof value === 'number') {
      return value;
    }
  }
  return 0;
}

function stand(options: {
  readonly cards?: readonly Doc[];
  readonly images?: Readonly<Record<string, Doc>>;
  readonly stored?: Doc | null;
  readonly user: Doc | null;
}): Stand {
  const findByIdCalls: string[] = [];
  const req = {
    context: {},
    payload: {
      find: ({ collection, limit, where }: FindArgs) => {
        if (collection !== 'cards') {
          return Promise.resolve({ docs: [] });
        }
        const cursor = readCursor(where);
        const docs = [...(options.cards ?? [])]
          .filter((doc) => typeof doc.id === 'number' && doc.id > cursor)
          .sort((left, right) => Number(left.id) - Number(right.id))
          .slice(0, limit ?? undefined);
        return Promise.resolve({ docs });
      },
      findByID: ({ collection, id }: { collection: string; id: number | string }) => {
        findByIdCalls.push(`${collection}#${String(id)}`);
        if (collection === 'cards') {
          return Promise.resolve(options.stored ?? null);
        }
        return Promise.resolve(options.images?.[String(id)] ?? null);
      },
      logger: { info: () => undefined, warn: () => undefined },
    },
    user: options.user,
  } as unknown as PayloadRequest;

  return { findByIdCalls, req };
}

const ADMIN = { collection: 'users', id: 1, role: 'admin' };
const AI_EDITOR = { collection: 'users', id: 2, role: 'ai-editor' };

const PUBLISHED_CARD: Doc = {
  id: 7,
  image: 100,
  publishedAt: '2026-01-10T00:00:00.000Z',
  slug: 'otkrytka',
  status: 'published',
};

const DRAFT_CARD: Doc = { id: 8, image: 100, slug: 'chernovik', status: 'draft' };

function refusalOf(error: unknown): { rule?: unknown; status?: unknown } {
  const record = error as { data?: { rule?: unknown }; status?: unknown };
  return { rule: record.data?.rule, status: record.status };
}

describe('смена изображения: громкий отказ на сырых данных', () => {
  it('сервисный аккаунт не меняет изображение публиковавшейся карточки', async () => {
    const { req } = stand({ stored: PUBLISHED_CARD, user: AI_EDITOR });

    await expect(
      beforeOperation({
        args: { data: { image: 200 }, id: 7 },
        operation: 'update',
        req,
      }) as Promise<unknown>,
    ).rejects.toThrow(/admin/);

    const error = await (beforeOperation({
      args: { data: { image: 200 }, id: 7 },
      operation: 'update',
      req,
    }) as Promise<unknown>).catch((caught: unknown) => caught);
    expect(refusalOf(error)).toEqual({ rule: 'image-change-requires-admin', status: 403 });
  });

  it('до первой публикации сервисный аккаунт изображение меняет', async () => {
    const { req } = stand({ stored: DRAFT_CARD, user: AI_EDITOR });
    await expect(
      beforeOperation({ args: { data: { image: 200 }, id: 8 }, operation: 'update', req }),
    ).resolves.toBeUndefined();
  });

  it('администратор меняет изображение и после публикации (ТЗ §6.7)', async () => {
    const { req } = stand({ stored: PUBLISHED_CARD, user: ADMIN });
    await expect(
      beforeOperation({ args: { data: { image: 200 }, id: 7 }, operation: 'update', req }),
    ).resolves.toBeUndefined();
  });

  it('то же самое изображение сменой не считается', async () => {
    const { req } = stand({ stored: PUBLISHED_CARD, user: AI_EDITOR });
    await expect(
      beforeOperation({ args: { data: { image: 100 }, id: 7 }, operation: 'update', req }),
    ).resolves.toBeUndefined();
  });

  it('операция без поля image записи не читает', async () => {
    const { findByIdCalls, req } = stand({ stored: PUBLISHED_CARD, user: AI_EDITOR });
    await beforeOperation({ args: { data: { caption: 'Другая подпись' }, id: 7 }, operation: 'update', req });
    expect(findByIdCalls).toEqual([]);
  });
});

describe('зеркало служебных полей пути', () => {
  const image: Doc = {
    id: 100,
    keyBase: 'cards/a1b2c3d4/otkrytka-mame',
    nameStem: 'otkrytka-mame',
    nameSuffix: null,
    pHash: 'ffffffffffffffff',
    revision: 'a1b2c3d4',
  };

  it('переносит pHash и служебные поля из связанной записи изображения', async () => {
    const { req } = stand({ images: { '100': image }, user: ADMIN });
    const result = (await beforeValidate({
      data: { image: 100, status: 'draft' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    expect(result.pHash).toBe('ffffffffffffffff');
    expect(result.derivative).toEqual({
      keyBase: 'cards/a1b2c3d4/otkrytka-mame',
      nameStem: 'otkrytka-mame',
      nameSuffix: null,
      revision: 'a1b2c3d4',
    });
  });

  it('без изображения зеркало и набор похожих очищаются', async () => {
    const { req } = stand({ user: ADMIN });
    const result = (await beforeValidate({
      data: { image: null, status: 'draft' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    expect(result.pHash).toBeNull();
    expect((result.visualDuplicate as Doc).similar).toEqual([]);
    expect((result.visualDuplicate as Doc).decisionFor).toBeNull();
  });
});

describe('блокировка перевода в review при похожем изображении', () => {
  const image: Doc = { id: 100, pHash: 'ffffffffffffffff' };
  const similarCard: Doc = { id: 42, pHash: 'fffffffffffffff0' };

  it('без явного решения переход не проходит', async () => {
    const { req } = stand({ cards: [similarCard], images: { '100': image }, user: ADMIN });

    const error = await (beforeValidate({
      data: { image: 100, status: 'review' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    }) as Promise<unknown>).catch((caught: unknown) => caught);

    expect(refusalOf(error)).toEqual({ rule: 'visual-duplicate-unresolved', status: 400 });
  });

  it('подтверждённое решение «уникально» переход открывает и записывает отпечаток', async () => {
    const { req } = stand({ cards: [similarCard], images: { '100': image }, user: ADMIN });

    const result = (await beforeValidate({
      data: {
        image: 100,
        status: 'review',
        visualDuplicate: { confirm: true, decision: 'unique' },
      },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    const gate = result.visualDuplicate as Doc;
    expect(gate.decision).toBe('unique');
    expect(typeof gate.decisionFor).toBe('string');
    expect(gate.similar).toEqual([{ card: 42, distance: 4 }]);
  });

  it('решение без подтверждения не продлевает устаревшую визу', async () => {
    // В форме админки значение решения приходит в каждом запросе. Если бы
    // отпечаток переписывался при каждом сохранении, виза, выданная прежней
    // картинке, действовала бы и для новой.
    const { req } = stand({ cards: [similarCard], images: { '100': image }, user: ADMIN });

    const error = await (beforeValidate({
      data: { image: 100, status: 'review', visualDuplicate: { decision: 'unique' } },
      operation: 'update',
      originalDoc: {
        ...DRAFT_CARD,
        status: 'draft',
        visualDuplicate: { decision: 'unique', decisionFor: 'ustarevshiy-otpechatok' },
      },
      req,
    }) as Promise<unknown>).catch((caught: unknown) => caught);

    expect(refusalOf(error)).toEqual({ rule: 'visual-duplicate-unresolved', status: 400 });
  });

  it('своя же запись похожей не считается', async () => {
    const { req } = stand({
      cards: [{ id: 8, pHash: 'ffffffffffffffff' }],
      images: { '100': image },
      user: ADMIN,
    });

    const result = (await beforeValidate({
      data: { image: 100, status: 'review' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    expect((result.visualDuplicate as Doc).similar).toEqual([]);
  });
});

/**
 * Полнота круга поиска (находка ревизии от 2026-08-22).
 *
 * Раньше стоял один `limit: 500` без сортировки и курсора: после 500 карточек в
 * `published`/`review` проверка ТЗ §6.7 п. 4 переставала покрывать каталог, и
 * «похожих не найдено» означало «искали не везде» — без записи в журнал и без
 * признака в ответе.
 */
describe('обход каталога при поиске похожих', () => {
  const image: Doc = { id: 100, pHash: 'ffffffffffffffff' };

  /** Записи-«шум»: далёкие хеши, чтобы похожей была ровно одна карточка. */
  function noise(count: number, fromId: number): Doc[] {
    return Array.from({ length: count }, (_, index) => ({
      id: fromId + index,
      pHash: '0000000000000000',
    }));
  }

  it('похожая запись за пределами первой страницы всё равно находится', async () => {
    // Похожая карточка стоит ПОСЛЕ конца первой страницы: при прежнем поведении
    // (один запрос с limit) она в выборку не попадала вовсе.
    const cards: Doc[] = [
      ...noise(5, 1),
      { id: 999, pHash: 'fffffffffffffff0' },
    ];
    const { req } = stand({ cards, images: { '100': image }, user: ADMIN });
    const scanning = cardImageHooks({ scan: { maxRecords: 100, pageSize: 2 } });

    const result = (await asHook(scanning.beforeValidate[0])({
      data: { image: 100, status: 'draft' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    const gate = result.visualDuplicate as Doc;
    expect(gate.similar).toEqual([{ card: 999, distance: 4 }]);
    expect(gate.scanned).toBe(6);
    expect(gate.scanTruncated).toBe(false);
  });

  it('усечение обхода попадает в ответ редактору и в журнал', async () => {
    const warnings: string[] = [];
    const { req } = stand({
      cards: noise(20, 1),
      images: { '100': image },
      user: ADMIN,
    });
    // Логгер стенда молчит, поэтому предупреждение перехватывается здесь.
    (req.payload as unknown as { logger: { warn: (message: unknown) => void } }).logger.warn = (
      message: unknown,
    ) => {
      warnings.push(String(message));
    };

    const scanning = cardImageHooks({ scan: { maxRecords: 4, pageSize: 2 } });
    const result = (await asHook(scanning.beforeValidate[0])({
      data: { image: 100, status: 'draft' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    const gate = result.visualDuplicate as Doc;
    expect(gate.scanTruncated).toBe(true);
    expect(gate.scanned).toBe(4);
    expect(gate.similar).toEqual([]);
    // «Похожих не найдено» здесь означает «дальше не искали» — и это сказано.
    expect(warnings.some((line) => line.includes('ОБОРВАН'))).toBe(true);
  });

  it('без изображения признаки полноты обнуляются вместе с набором похожих', async () => {
    const { req } = stand({ user: ADMIN });
    const result = (await beforeValidate({
      data: { image: null, status: 'draft' },
      operation: 'update',
      originalDoc: { ...DRAFT_CARD, status: 'draft' },
      req,
    })) as Doc;

    const gate = result.visualDuplicate as Doc;
    expect(gate.scanned).toBe(0);
    expect(gate.scanTruncated).toBe(false);
  });
});

describe('одноразовое подтверждение', () => {
  it('сбрасывается на каждом сохранении', () => {
    const { req } = stand({ user: ADMIN });
    const result = beforeChange({
      data: { visualDuplicate: { confirm: true, decision: 'unique' } },
      operation: 'update',
      req,
    }) as Doc;

    expect((result.visualDuplicate as Doc).confirm).toBe(false);
    expect((result.visualDuplicate as Doc).decision).toBe('unique');
  });
});
