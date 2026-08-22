/**
 * Хуки контентных коллекций (Э1-07, Э1-08, Э1-09) на прогоне через фазы Payload.
 *
 * Зачем понадобился стенд, а не только тесты чистого ядра. Правила статусной
 * модели проверены в `status-model.test.ts` как функции; здесь проверяется
 * ПРОВОДКА: что запрещённая попытка ловится в той фазе, где данные ещё сырые;
 * что `publishedAt` доживает до записи (в другой фазе его срезало бы правило
 * «снаружи не пишется»); что запись в `seo-history` и одиночный 301 действительно
 * появляются, причём на КАЖДЫЙ переехавший путь поддерева. Ни одно из этих
 * утверждений не проверяется чистой функцией — они про порядок фаз и про
 * побочные операции.
 *
 * Стенд повторяет порядок фаз Payload (сверено с
 * `payload/dist/collections/operations/utilities/update.js`):
 *
 *   beforeOperation → слияние входных данных с документом → beforeValidate
 *   (коллекция) → beforeChange (коллекция) → запись → afterChange (коллекция)
 *
 * Чего стенд НЕ повторяет сознательно: access control полей. Молчаливое
 * срезание запрещённого поля — это как раз то поведение Payload, ПОВЕРХ которого
 * добавлена громкая ошибка, и здесь проверяется именно она. Что срезание тоже
 * работает, проверяется на живом API (смоук) и негативными API-тестами Э6-02.
 */
import type { CollectionConfig, Field, PayloadRequest } from 'payload';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLES } from '../access/roles';
import { Cards } from './cards';
import { Collections } from './collections';
import { Redirects } from './redirects';
import { SeoHistory } from './seo-history';

type Doc = Record<string, unknown>;

type HookArgs = Record<string, unknown>;

type LooseHook = (args: HookArgs) => unknown;

const CONFIGS: Readonly<Record<string, CollectionConfig>> = {
  cards: Cards,
  collections: Collections,
  redirects: Redirects,
  'seo-history': SeoHistory,
};

/**
 * Путь админки в окружении процесса.
 *
 * Хук сборки пути подборки (Э1-05) читает `PAYLOAD_ADMIN_PATH` из настоящего
 * окружения — и обязан читать: без него нельзя сказать, не занимает ли запись
 * адрес админки, а дефолта у параметра нет намеренно. Поэтому стенд задаёт
 * значение явно и возвращает прежнее после прогона: мутация process.env здесь
 * не удобство, а единственный способ проверить хук в том виде, в каком он
 * работает в проде.
 */
const ADMIN_PATH_KEY = 'PAYLOAD_ADMIN_PATH';
let savedAdminPath: string | undefined;

beforeAll(() => {
  savedAdminPath = process.env[ADMIN_PATH_KEY];
  process.env[ADMIN_PATH_KEY] = '/admin';
});

afterAll(() => {
  if (savedAdminPath === undefined) {
    delete process.env[ADMIN_PATH_KEY];
  } else {
    process.env[ADMIN_PATH_KEY] = savedAdminPath;
  }
});

const admin = { collection: 'users', id: 1, role: ROLES.admin };
const aiEditor = {
  _strategy: 'api-key',
  collection: 'users',
  id: 2,
  role: ROLES.aiEditor,
};

function asHook(hook: unknown): LooseHook {
  return hook as LooseHook;
}

function hooksOf(config: CollectionConfig, phase: string): readonly unknown[] {
  const hooks: unknown = (config.hooks as Record<string, unknown> | undefined)?.[phase];
  return Array.isArray(hooks) ? (hooks as readonly unknown[]) : [];
}

function isPlainObject(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Дефолты полей коллекции: стенд обязан рождать запись такой же, как Payload. */
function defaultsOf(fields: readonly Field[]): Doc {
  const defaults: Doc = {};
  for (const field of fields) {
    if ('name' in field && typeof field.name === 'string' && 'defaultValue' in field) {
      const { defaultValue } = field;
      if (defaultValue !== undefined) {
        defaults[field.name] = defaultValue;
      }
    }
  }
  return defaults;
}

/** Слияние входных данных с документом — как на фазе полей beforeValidate. */
function mergeData(stored: Doc, incoming: Doc): Doc {
  const merged: Doc = { ...stored };
  for (const [key, value] of Object.entries(incoming)) {
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
  }
  return merged;
}

/** Сравнение значений условия: только скаляры — других в стенде не встречается. */
function asComparable(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

function matchesWhere(doc: Doc, where: unknown): boolean {
  if (!isPlainObject(where)) {
    return true;
  }
  return Object.entries(where).every(([field, condition]) => {
    if (!isPlainObject(condition)) {
      return true;
    }
    if ('equals' in condition) {
      return asComparable(doc[field]) === asComparable(condition.equals);
    }
    return true;
  });
}

interface Harness {
  readonly create: (slug: string, data: Doc, user: unknown) => Promise<Doc>;
  readonly docs: (slug: string) => readonly Doc[];
  readonly runBulk: (
    slug: string,
    where: unknown,
    data: Doc,
    user: unknown,
  ) => Promise<{ readonly errors: readonly string[]; readonly updated: readonly Doc[] }>;
  readonly seed: (slug: string, doc: Doc) => Doc;
  readonly update: (slug: string, id: number, data: Doc, user: unknown) => Promise<Doc>;
  readonly warnings: readonly string[];
}

function createHarness(): Harness {
  const store = new Map<string, Map<number, Doc>>();
  const warnings: string[] = [];
  let nextId = 1;

  const collectionStore = (slug: string): Map<number, Doc> => {
    const existing = store.get(slug);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<number, Doc>();
    store.set(slug, created);
    return created;
  };

  const logger = {
    debug: () => undefined,
    error: (message: unknown) => warnings.push(String(message)),
    info: () => undefined,
    warn: (message: unknown) => warnings.push(String(message)),
  };

  const requestFor = (user: unknown): PayloadRequest =>
    ({ context: {}, payload, user } as unknown as PayloadRequest);

  async function runPipeline(args: {
    readonly data: Doc;
    readonly id: number | null;
    readonly slug: string;
    readonly user: unknown;
  }): Promise<Doc> {
    const config = CONFIGS[args.slug];
    if (config === undefined) {
      throw new Error(`Коллекция «${args.slug}» в стенде не объявлена`);
    }
    const req = requestFor(args.user);
    const operation = args.id === null ? 'create' : 'update';
    const docs = collectionStore(args.slug);
    const stored = args.id === null ? {} : (docs.get(args.id) ?? {});

    for (const hook of hooksOf(config, 'beforeOperation')) {
      await asHook(hook)({
        args: args.id === null ? { data: args.data } : { data: args.data, id: args.id },
        collection: config,
        context: {},
        // Payload 3.88 передаёт 'update' и для одиночного обновления, и для
        // обновления по where: одиночное отличается наличием id. Стенд повторяет
        // это буквально — иначе он проверял бы поведение, которого нет.
        operation: args.id === null ? 'create' : 'update',
        req,
      });
    }

    let working =
      args.id === null
        ? mergeData(defaultsOf(config.fields), args.data)
        : mergeData(stored, args.data);

    for (const phase of ['beforeValidate', 'beforeChange']) {
      for (const hook of hooksOf(config, phase)) {
        const result: unknown = await asHook(hook)({
          collection: config,
          context: {},
          data: working,
          operation,
          originalDoc: args.id === null ? undefined : stored,
          req,
        });
        if (isPlainObject(result)) {
          working = result;
        }
      }
    }

    const id = args.id ?? nextId++;
    const previous: Doc = { ...stored };
    const doc: Doc = { ...working, id };
    docs.set(id, doc);

    for (const hook of hooksOf(config, 'afterChange')) {
      await asHook(hook)({
        collection: config,
        context: {},
        data: working,
        doc,
        operation,
        previousDoc: args.id === null ? doc : previous,
        req,
      });
    }

    return docs.get(id) ?? doc;
  }

  const payload = {
    count: ({ collection, where }: { collection: string; where?: unknown }) => {
      const docs = [...collectionStore(collection).values()].filter((doc) =>
        matchesWhere(doc, where),
      );
      return Promise.resolve({ totalDocs: docs.length });
    },
    create: ({ collection, data }: { collection: string; data: Doc }) =>
      runPipeline({ data, id: null, slug: collection, user: null }),
    delete: ({ collection, id }: { collection: string; id: number }) => {
      collectionStore(collection).delete(id);
      return Promise.resolve({ id });
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
      let docs = [...collectionStore(collection).values()].filter((doc) =>
        matchesWhere(doc, where),
      );
      if (typeof limit === 'number' && limit > 0) {
        docs = docs.slice(0, limit);
      }
      return Promise.resolve({ docs, totalDocs: docs.length });
    },
    findByID: ({ collection, id }: { collection: string; id: number }) =>
      Promise.resolve(collectionStore(collection).get(id) ?? null),
    logger,
    update: ({ collection, data, id }: { collection: string; data: Doc; id: number }) =>
      runPipeline({ data, id, slug: collection, user: null }),
  };

  return {
    create: (slug, data, user) => runPipeline({ data, id: null, slug, user }),
    docs: (slug) => [...collectionStore(slug).values()],
    runBulk: async (slug, where, data, user) => {
      const config = CONFIGS[slug];
      if (config === undefined) {
        throw new Error(`Коллекция «${slug}» в стенде не объявлена`);
      }
      const req = requestFor(user);
      for (const hook of hooksOf(config, 'beforeOperation')) {
        await asHook(hook)({
          args: { data, where },
          collection: config,
          context: {},
          operation: 'update',
          req,
        });
      }
      // Пакет = те же поштучные операции: Payload прогоняет хуки на каждую
      // запись выборки по отдельности и собирает ошибки, а не прерывает всё.
      const targets = [...collectionStore(slug).values()].filter((doc) =>
        matchesWhere(doc, where),
      );
      const updated: Doc[] = [];
      const errors: string[] = [];
      for (const target of targets) {
        const id = target.id;
        if (typeof id !== 'number') {
          continue;
        }
        try {
          updated.push(await runPipeline({ data, id, slug, user }));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { errors, updated };
    },
    seed: (slug, doc) => {
      const id = typeof doc.id === 'number' ? doc.id : nextId++;
      const stored: Doc = { ...doc, id };
      collectionStore(slug).set(id, stored);
      return stored;
    },
    update: (slug, id, data, user) => runPipeline({ data, id, slug, user }),
    warnings,
  };
}

/**
 * Готовая к переводу в review карточка: все обязательные поля заполнены.
 *
 * `image` появился в схеме на Э2-04, и требование полноты включилось само (см.
 * `CARD_REVIEW_REQUIREMENTS`). Идентификатор указывает на запись `card-images`,
 * которой в стенде нет: хук изображения на это отвечает пустым состоянием
 * пайплайна, а проверяются здесь правила статусной модели, а не производные —
 * их проверяет `../images/pipeline.test.ts`.
 */
function completeCard(slug: string): Doc {
  return {
    alt: 'Тюльпаны и открытка',
    caption: 'С 8 Марта!',
    collections: [10],
    image: 500,
    robots: 'noindex,follow',
    slug,
    status: 'draft',
    title: `Открытка ${slug}`,
    urlChange: { confirm: false },
    withdrawal: { mode: null, redirectTo: null },
  };
}

function publishedCard(slug: string, id: number): Doc {
  return {
    ...completeCard(slug),
    id,
    publishedAt: '2026-01-10T00:00:00.000Z',
    status: 'published',
  };
}

function historyFor(harness: Harness, field: string): readonly Doc[] {
  return harness.docs('seo-history').filter((entry) => entry.field === field);
}

async function expectRejected(run: () => Promise<unknown>, fragment: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(fragment);
    return;
  }
  throw new Error(`Ожидался отказ со словами «${fragment}», но операция прошла`);
}

/* ------------------------------------------------------------------ */
/* Э1-07: история изменений                                            */
/* ------------------------------------------------------------------ */

describe('Э1-07: seo-history заполняется хуками', () => {
  it('создание карточки фиксирует начальные значения SEO-полей с автором', async () => {
    const harness = createHarness();
    await harness.create('cards', completeCard('mame'), admin);

    const entries = harness.docs('seo-history');
    expect(entries.map((entry) => entry.field)).toEqual([
      'title',
      'slug',
      'robots',
      'status',
    ]);
    for (const entry of entries) {
      expect(entry.documentCollection).toBe('cards');
      expect(entry.documentPath).toBe('/otkrytki/mame');
      expect(entry.operation).toBe('create');
      expect(entry.authorRole).toBe('admin');
      expect(entry.changedBy).toBe(1);
      expect(entry.previousValue).toBeNull();
    }
  });

  it('изменение SEO-поля даёт запись «старое → новое»', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));

    await harness.update('cards', card.id as number, { title: 'Новый заголовок' }, aiEditor);

    expect(historyFor(harness, 'title')).toEqual([
      expect.objectContaining({
        authorRole: 'ai-editor',
        changedBy: 2,
        documentPath: '/otkrytki/mame',
        nextValue: 'Новый заголовок',
        operation: 'update',
        previousValue: 'Открытка mame',
        viaApiKey: true,
      }),
    ]);
  });

  it('правка не-SEO поля историю не пишет', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));

    await harness.update('cards', card.id as number, { caption: 'Другая подпись' }, aiEditor);

    expect(harness.docs('seo-history')).toEqual([]);
  });

  it('запись истории нельзя отредактировать даже изнутри', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));
    await harness.update('cards', card.id as number, { title: 'Другой' }, admin);

    const entry = harness.docs('seo-history')[0];
    expect(entry).toBeDefined();

    await expectRejected(
      () => harness.update('seo-history', entry?.id as number, { nextValue: 'подмена' }, admin),
      'неизменяема',
    );
  });

  it('коллекция закрыта для записи и удаления снаружи', () => {
    expect(SeoHistory.access?.create?.({} as never)).toBe(false);
    expect(SeoHistory.access?.update?.({} as never)).toBe(false);
    expect(SeoHistory.access?.delete?.({} as never)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Э1-08: статусная модель                                             */
/* ------------------------------------------------------------------ */

describe('Э1-08: создание только в draft', () => {
  it('создание сразу в review отклоняется громко, а не тихо игнорируется', async () => {
    const harness = createHarness();
    await expectRejected(
      () => harness.create('cards', { ...completeCard('mame'), status: 'review' }, aiEditor),
      'только в статусе draft',
    );
    expect(harness.docs('cards')).toEqual([]);
  });

  it('создание сразу в published отклоняется даже у администратора', async () => {
    const harness = createHarness();
    await expectRejected(
      () => harness.create('cards', { ...completeCard('mame'), status: 'published' }, admin),
      'только в статусе draft',
    );
  });

  it('новая запись рождается черновиком с noindex и без publishedAt', async () => {
    const harness = createHarness();
    const card = await harness.create('cards', { slug: 'mame', title: 'Открытка' }, aiEditor);
    expect(card.status).toBe('draft');
    expect(card.robots).toBe('noindex,follow');
    expect(card.publishedAt).toBeUndefined();
  });
});

describe('Э1-08: draft → review с валидацией полноты', () => {
  it('карточка без alt, подписи и подборок в review не уходит', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', {
      robots: 'noindex,follow',
      slug: 'mame',
      status: 'draft',
      title: 'Открытка',
    });

    await expectRejected(
      () => harness.update('cards', card.id as number, { status: 'review' }, aiEditor),
      'не заполнено',
    );
    expect(harness.docs('cards')[0]?.status).toBe('draft');
  });

  it('заполненная карточка переводится в review сервисным аккаунтом', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));

    const updated = await harness.update('cards', card.id as number, { status: 'review' }, aiEditor);
    expect(updated.status).toBe('review');
    expect(historyFor(harness, 'status')).toHaveLength(1);
  });

  it('подборка без вводного текста и перелинковки в review не уходит', async () => {
    const harness = createHarness();
    const node = harness.seed('collections', {
      nodeKind: 'group',
      parent: null,
      path: '/podborki/prazdniki',
      robots: 'noindex,follow',
      slug: 'prazdniki',
      status: 'draft',
      title: 'Праздники',
    });

    await expectRejected(
      () => harness.update('collections', node.id as number, { status: 'review' }, aiEditor),
      'вводный текст',
    );
  });
});

describe('Э1-08: review → published только admin', () => {
  const reviewed = (): Doc => ({ ...completeCard('mame'), status: 'review' });

  it('сервисный аккаунт получает отказ, а не 200 с прежним статусом', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', reviewed());

    await expectRejected(
      () => harness.update('cards', card.id as number, { status: 'published' }, aiEditor),
      'только человек с ролью admin',
    );
    expect(harness.docs('cards')[0]?.status).toBe('review');
  });

  it('публикация без пользователя (код, расписание) отклоняется', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', reviewed());

    await expectRejected(
      () => harness.update('cards', card.id as number, { status: 'published' }, null),
      'только человек с ролью admin',
    );
  });

  it('администратор публикует, publishedAt проставляется хуком', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', reviewed());

    const published = await harness.update(
      'cards',
      card.id as number,
      { status: 'published' },
      admin,
    );

    expect(published.status).toBe('published');
    expect(typeof published.publishedAt).toBe('string');
    expect(published.robots).toBe('noindex,follow');
  });

  it('повторная публикация не переписывает дату первой', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', {
      ...completeCard('mame'),
      publishedAt: '2026-01-01T00:00:00.000Z',
      status: 'review',
    });

    const published = await harness.update(
      'cards',
      card.id as number,
      { status: 'published' },
      admin,
    );
    expect(published.publishedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('Э1-08: index,follow — отдельное действие администратора', () => {
  it('публикация с index,follow в одной операции отклоняется', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', { ...completeCard('mame'), status: 'review' });

    await expectRejected(
      () =>
        harness.update(
          'cards',
          card.id as number,
          { robots: 'index,follow', status: 'published' },
          admin,
        ),
      'ОТДЕЛЬНЫМ действием',
    );
  });

  it('вторым действием администратор открывает индексацию', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', publishedCard('mame', 5));

    const opened = await harness.update('cards', 5, { robots: 'index,follow' }, admin);
    expect(opened.robots).toBe('index,follow');
    expect(historyFor(harness, 'robots')).toHaveLength(1);
    expect(card.id).toBe(5);
  });

  it('ai-editor не открывает индексацию: отказ, а не молчание', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await expectRejected(
      () => harness.update('cards', 5, { robots: 'index,follow' }, aiEditor),
      'только admin',
    );
    expect(harness.docs('cards')[0]?.robots).toBe('noindex,follow');
  });
});

describe('Э1-08: снятие с публикации — с решением 301 или 404', () => {
  it('без решения переход вниз отклоняется', async () => {
    const harness = createHarness();
    harness.seed('cards', { ...publishedCard('mame', 5), robots: 'index,follow' });

    await expectRejected(
      () => harness.update('cards', 5, { status: 'draft' }, admin),
      'Решение о судьбе URL',
    );
  });

  it('решение 301 создаёт одиночный редирект и понижает robots', async () => {
    const harness = createHarness();
    harness.seed('cards', { ...publishedCard('mame', 5), robots: 'index,follow' });

    const withdrawn = await harness.update(
      'cards',
      5,
      { status: 'draft', withdrawal: { mode: '301', redirectTo: '/otkrytki/mame-tyulpany' } },
      admin,
    );

    expect(withdrawn.robots).toBe('noindex,follow');
    expect(harness.docs('redirects')).toEqual([
      expect.objectContaining({ code: '301', from: '/otkrytki/mame', to: '/otkrytki/mame-tyulpany' }),
    ]);
  });

  it('решение 410 создаёт запись «удалено без замены»', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await harness.update('cards', 5, { status: 'draft', withdrawal: { mode: '410' } }, admin);

    expect(harness.docs('redirects')).toEqual([
      expect.objectContaining({ code: '410', from: '/otkrytki/mame', to: null }),
    ]);
  });

  it('решение 404 не создаёт записи в redirects — это тоже осознанный выбор', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await harness.update('cards', 5, { status: 'draft', withdrawal: { mode: '404' } }, admin);

    expect(harness.docs('redirects')).toEqual([]);
  });

  it('возврат в публикацию снимает редирект со своего пути', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));
    await harness.update(
      'cards',
      5,
      { status: 'review', withdrawal: { mode: '301', redirectTo: '/otkrytki/drugaya' } },
      admin,
    );
    expect(harness.docs('redirects')).toHaveLength(1);

    await harness.update('cards', 5, { status: 'published' }, admin);

    // Иначе middleware уводило бы запрос со страницы, которая снова отвечает 200.
    expect(harness.docs('redirects')).toEqual([]);
  });
});

describe('Э1-08: одиночная операция отличается от пакетной по аргументам', () => {
  it('Payload передаёт operation «update» и для одной записи: различие — наличие id', async () => {
    // Проверено на живом ядре: updateByID вызывает beforeOperation со строкой
    // 'update', хотя объявление типа обещает 'updateByID'. Если различать
    // операции по строке, поштучная публикация будет отклонена как «массовая по
    // фильтру» — этот тест держит рабочую трактовку.
    const harness = createHarness();
    const card = harness.seed('cards', { ...completeCard('mame'), status: 'review' });
    const guard = Cards.hooks?.beforeOperation?.[0];
    expect(guard).toBeTypeOf('function');

    const published = await harness.update(
      'cards',
      card.id as number,
      { status: 'published' },
      admin,
    );
    expect(published.status).toBe('published');
  });

  it('операция без id и без where ничего не проверяет и не падает', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));
    const updated = await harness.update('cards', card.id as number, {}, admin);
    expect(updated.status).toBe('draft');
  });
});

describe('Э1-08: пакетная операция (Ч-07) и точка вето V11', () => {
  const seedReviewed = (harness: Harness): readonly number[] => {
    const ids: number[] = [];
    for (const slug of ['mame', 'pape', 'bratu']) {
      const doc = harness.seed('cards', { ...completeCard(slug), status: 'review' });
      ids.push(doc.id as number);
    }
    return ids;
  };

  it('admin применяет решение к выбранной им выборке одной операцией', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    const result = await harness.runBulk(
      'cards',
      { id: { in: [...ids] } },
      { status: 'published' },
      admin,
    );

    expect(result.errors).toEqual([]);
    expect(result.updated).toHaveLength(3);
    for (const doc of result.updated) {
      expect(doc.status).toBe('published');
      expect(typeof doc.publishedAt).toBe('string');
    }
    // История пишется по КАЖДОЙ записи выборки, а не одной строкой на пакет.
    expect(historyFor(harness, 'status')).toHaveLength(3);
  });

  it('пакет прогоняет те же валидации: неготовая запись остаётся неопубликованной', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);
    const broken = harness.seed('cards', {
      robots: 'noindex,follow',
      slug: 'pustaya',
      status: 'review',
      title: 'Пустая',
    });

    const result = await harness.runBulk(
      'cards',
      { id: { in: [...ids, broken.id as number] } },
      { status: 'published' },
      admin,
    );

    expect(result.updated).toHaveLength(3);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('не заполнено');
    expect(harness.docs('cards').find((doc) => doc.slug === 'pustaya')?.status).toBe('review');
  });

  it('ai-editor не публикует пакетно', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    await expectRejected(
      () => harness.runBulk('cards', { id: { in: [...ids] } }, { status: 'published' }, aiEditor),
      'только роли admin',
    );
    expect(harness.docs('cards').every((doc) => doc.status === 'review')).toBe(true);
  });

  it('пакетная публикация по фильтру из кода отклоняется даже у администратора', async () => {
    const harness = createHarness();
    seedReviewed(harness);

    await expectRejected(
      () => harness.runBulk('cards', { status: { equals: 'review' } }, { status: 'published' }, admin),
      'ЯВНО выбранным записям',
    );
  });

  it('пакетная публикация без пользователя (расписание, воркер) отклоняется', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    await expectRejected(
      () => harness.runBulk('cards', { id: { in: [...ids] } }, { status: 'published' }, null),
      'только роли admin',
    );
  });

  it('пакетное включение index,follow — отдельная операция от публикации', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    await expectRejected(
      () =>
        harness.runBulk(
          'cards',
          { id: { in: [...ids] } },
          { robots: 'index,follow', status: 'published' },
          admin,
        ),
      'отдельное явное действие',
    );

    await harness.runBulk('cards', { id: { in: [...ids] } }, { status: 'published' }, admin);
    const opened = await harness.runBulk(
      'cards',
      { id: { in: [...ids] } },
      { robots: 'index,follow' },
      admin,
    );
    expect(opened.errors).toEqual([]);
    expect(opened.updated.every((doc) => doc.robots === 'index,follow')).toBe(true);
  });

  it('пакетное включение index,follow сервисным аккаунтом отклоняется', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);
    await harness.runBulk('cards', { id: { in: [...ids] } }, { status: 'published' }, admin);

    await expectRejected(
      () =>
        harness.runBulk('cards', { id: { in: [...ids] } }, { robots: 'index,follow' }, aiEditor),
      'только роли admin',
    );
  });

  it('пакетная смена URL запрещена: 301 создаётся на каждый путь по отдельности', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    await expectRejected(
      () => harness.runBulk('cards', { id: { in: [...ids] } }, { slug: 'obshchiy' }, admin),
      'Пакетная смена полей URL',
    );
  });

  it('пакетная смена draft ↔ review остаётся доступной (ТЗ §8.5) по явной выборке', async () => {
    const harness = createHarness();
    const ids = seedReviewed(harness);

    const result = await harness.runBulk(
      'cards',
      { id: { in: [...ids] } },
      { status: 'draft' },
      aiEditor,
    );
    expect(result.errors).toEqual([]);
    expect(result.updated.every((doc) => doc.status === 'draft')).toBe(true);
  });

  /**
   * Блокирующая находка ревизии от 2026-08-22: пакетное СНЯТИЕ с публикации.
   *
   * Прежний гейт смотрел только на `status: published` во входных данных и на
   * индексируемую robots-директиву, поэтому уход ИЗ published до проверок не
   * доходил вовсе. Одна операция по фильтру «все опубликованные» с общим
   * решением `withdrawal = { mode: '301', redirectTo: '/' }` создавала по 301 с
   * каждого снятого пути на главную — прямой запрет п. 23 и раздела
   * «HTTP-статусы» `CLAUDE.md`.
   */
  describe('пакетное снятие с публикации', () => {
    const seedPublished = (harness: Harness): readonly number[] => {
      const ids: number[] = [];
      for (const slug of ['mame', 'pape']) {
        const doc = harness.seed('cards', {
          ...completeCard(slug),
          publishedAt: '2026-08-01T00:00:00.000Z',
          robots: 'index,follow',
          status: 'published',
        });
        ids.push(doc.id as number);
      }
      return ids;
    };

    it('фильтр «все опубликованные» отклоняется целиком, ни один 301 не создаётся', async () => {
      const harness = createHarness();
      seedPublished(harness);

      await expectRejected(
        () =>
          harness.runBulk(
            'cards',
            { status: { equals: 'published' } },
            { status: 'draft', withdrawal: { mode: '301', redirectTo: '/' } },
            admin,
          ),
        'Решение о судьбе URL нельзя применить к выборке',
      );

      expect(harness.docs('redirects')).toHaveLength(0);
      expect(harness.docs('cards').every((doc) => doc.status === 'published')).toBe(true);
    });

    it('явная выборка с общим решением отклоняется тоже: судьба URL — у каждого своя', async () => {
      const harness = createHarness();
      const ids = seedPublished(harness);

      await expectRejected(
        () =>
          harness.runBulk(
            'cards',
            { id: { in: [...ids] } },
            { status: 'draft', withdrawal: { mode: '410' } },
            admin,
          ),
        'Решение о судьбе URL нельзя применить к выборке',
      );
      expect(harness.docs('redirects')).toHaveLength(0);
    });

    it('снятие по фильтру без решения отклоняется на сыром слое, а не по записи', async () => {
      const harness = createHarness();
      seedPublished(harness);

      await expectRejected(
        () => harness.runBulk('cards', { status: { equals: 'published' } }, { status: 'draft' }, admin),
        'ЯВНО выбранным',
      );
      expect(harness.docs('cards').every((doc) => doc.status === 'published')).toBe(true);
    });

    it('поштучное снятие с решением 301 работает как раньше: ровно один редирект', async () => {
      const harness = createHarness();
      const [id] = seedPublished(harness);
      if (id === undefined) {
        throw new Error('запись не создана');
      }

      const doc = await harness.update(
        'cards',
        id,
        { status: 'draft', withdrawal: { mode: '301', redirectTo: '/otkrytki/pape' } },
        admin,
      );

      expect(doc.status).toBe('draft');
      expect(doc.robots).toBe('noindex,follow');
      const redirects = harness.docs('redirects');
      expect(redirects).toHaveLength(1);
      expect(redirects[0]?.to).toBe('/otkrytki/pape');
    });
  });
});

/**
 * Год в адресе карточки (условие C3, блокирующая находка ревизии от 2026-08-22).
 *
 * Проверяется ХУК, а не только валидатор поля: валидацию полей Payload умеет
 * пропускать (`skipValidation` при сохранении черновика версии), а хук
 * `beforeValidate` коллекции выполняется всегда — и для админки, и для REST, и
 * для GraphQL.
 */
describe('условие C3: год не попадает в адрес карточки', () => {
  it('создание карточки с годом в slug отклоняется', async () => {
    const harness = createHarness();
    await expectRejected(
      () =>
        harness.create(
          'cards',
          { ...completeCard('novyy-god-2027'), status: 'draft' },
          aiEditor,
        ),
      'есть год 2027',
    );
    expect(harness.docs('cards')).toHaveLength(0);
  });

  it('смена slug на адрес с годом отклоняется у обеих ролей', async () => {
    const harness = createHarness();
    const doc = harness.seed('cards', { ...completeCard('novyy-god'), status: 'draft' });

    for (const user of [aiEditor, admin]) {
      await expectRejected(
        () => harness.update('cards', doc.id as number, { slug: 'novyy-god-2027' }, user),
        'есть год 2027',
      );
    }
  });

  it('адрес с числом даты праздника проходит', async () => {
    const harness = createHarness();
    const created = await harness.create(
      'cards',
      { ...completeCard('8-marta-mame'), status: 'draft' },
      aiEditor,
    );
    expect(created.slug).toBe('8-marta-mame');
  });

  it('подборка: год отклоняется у повода и у пары под ним', async () => {
    const harness = createHarness();
    const group = harness.seed('collections', {
      nodeKind: 'group',
      path: '/podborki/prazdniki',
      robots: 'noindex,follow',
      slug: 'prazdniki',
      status: 'draft',
      title: 'Праздники',
    });

    await expectRejected(
      () =>
        harness.create(
          'collections',
          {
            nodeKind: 'occasion',
            parent: group.id,
            robots: 'noindex,follow',
            slug: 'novyy-god-2027',
            status: 'draft',
            title: 'Новый год 2027',
          },
          aiEditor,
        ),
      'есть год 2027',
    );

    const occasion = harness.seed('collections', {
      nodeKind: 'occasion',
      path: '/podborki/prazdniki/novyy-god',
      robots: 'noindex,follow',
      slug: 'novyy-god',
      status: 'draft',
      title: 'Новый год',
    });

    await expectRejected(
      () =>
        harness.create(
          'collections',
          {
            nodeKind: 'recipient',
            parent: occasion.id,
            robots: 'noindex,follow',
            slug: 'mame-2027',
            status: 'draft',
            title: 'Маме на Новый год',
          },
          aiEditor,
        ),
      'есть год 2027',
    );
  });

  it('подборка: группа с годом и recipient прямо под группой отклоняются (вердикт url-guard)', async () => {
    const harness = createHarness();

    // Путь (а): сегмент группы входит в адрес каждого повода под ней.
    await expectRejected(
      () =>
        harness.create(
          'collections',
          {
            nodeKind: 'group',
            robots: 'noindex,follow',
            slug: 'prazdniki-2027',
            status: 'draft',
            title: 'Праздники 2027',
          },
          admin,
        ),
      'есть год 2027',
    );
    expect(harness.docs('collections')).toHaveLength(0);

    const group = harness.seed('collections', {
      nodeKind: 'group',
      path: '/podborki/prazdniki',
      robots: 'noindex,follow',
      slug: 'prazdniki',
      status: 'draft',
      title: 'Праздники',
    });

    // Путь (б): вид узла recipient, родитель — группа; прежняя проверка по
    // своему сегменту с видом узла это пропускала.
    await expectRejected(
      () =>
        harness.create(
          'collections',
          {
            nodeKind: 'recipient',
            parent: group.id,
            robots: 'noindex,follow',
            slug: 'novyy-god-2027',
            status: 'draft',
            title: 'Новый год 2027',
          },
          admin,
        ),
      'есть год 2027',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Э1-09: неизменяемость URL и атомарный 301                           */
/* ------------------------------------------------------------------ */

describe('Э1-09: карточка — смена URL только вместе с 301', () => {
  it('смена slug опубликованной карточки без подтверждения отклоняется', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await expectRejected(
      () => harness.update('cards', 5, { slug: 'mame-tyulpany' }, admin),
      'неизменяем после первой публикации',
    );
    expect(harness.docs('cards')[0]?.slug).toBe('mame');
    expect(harness.docs('redirects')).toEqual([]);
  });

  it('сервисный аккаунт не меняет URL опубликованной карточки даже с подтверждением', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await expectRejected(
      () =>
        harness.update(
          'cards',
          5,
          { slug: 'mame-tyulpany', urlChange: { confirm: true } },
          aiEditor,
        ),
      'меняет только admin',
    );
  });

  it('до первой публикации slug меняется свободно и редиректов не создаёт', async () => {
    const harness = createHarness();
    const card = harness.seed('cards', completeCard('mame'));

    const updated = await harness.update('cards', card.id as number, { slug: 'mame-2' }, aiEditor);
    expect(updated.slug).toBe('mame-2');
    expect(harness.docs('redirects')).toEqual([]);
  });

  it('операция «сменить URL с 301» создаёт ровно одну запись в redirects', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    const moved = await harness.update(
      'cards',
      5,
      { slug: 'mame-tyulpany', urlChange: { confirm: true, reason: 'уточнён интент' } },
      admin,
    );

    expect(moved.slug).toBe('mame-tyulpany');
    expect(harness.docs('redirects')).toEqual([
      expect.objectContaining({ code: '301', from: '/otkrytki/mame', to: '/otkrytki/mame-tyulpany' }),
    ]);
    expect(String(harness.docs('redirects')[0]?.comment)).toContain('уточнён интент');
  });

  it('подтверждение одноразовое: после сохранения флаг снят', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    const moved = await harness.update(
      'cards',
      5,
      { slug: 'mame-tyulpany', urlChange: { confirm: true } },
      admin,
    );
    expect(moved.urlChange).toEqual(expect.objectContaining({ confirm: false }));

    await expectRejected(
      () => harness.update('cards', 5, { slug: 'mame-rozy' }, admin),
      'неизменяем после первой публикации',
    );
  });

  it('цепочка не возникает: прежний редирект переписывается на конечную цель', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));
    harness.seed('redirects', {
      code: '301',
      from: '/otkrytki/staraya',
      to: '/otkrytki/mame',
    });

    await harness.update('cards', 5, { slug: 'mame-tyulpany', urlChange: { confirm: true } }, admin);

    const redirects = harness.docs('redirects');
    expect(redirects).toHaveLength(2);
    expect(redirects.every((redirect) => redirect.to === '/otkrytki/mame-tyulpany')).toBe(true);
  });

  it('переезд на путь, с которого стоял редирект, освобождает этот путь', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));
    harness.seed('redirects', { code: '301', from: '/otkrytki/mame-tyulpany', to: '/otkrytki/mame' });

    await harness.update('cards', 5, { slug: 'mame-tyulpany', urlChange: { confirm: true } }, admin);

    expect(harness.docs('redirects')).toEqual([
      expect.objectContaining({ from: '/otkrytki/mame', to: '/otkrytki/mame-tyulpany' }),
    ]);
  });

  it('смена slug пишется в историю', async () => {
    const harness = createHarness();
    harness.seed('cards', publishedCard('mame', 5));

    await harness.update('cards', 5, { slug: 'mame-tyulpany', urlChange: { confirm: true } }, admin);

    expect(historyFor(harness, 'slug')).toEqual([
      expect.objectContaining({ nextValue: 'mame-tyulpany', previousValue: 'mame' }),
    ]);
  });
});

describe('Э1-09: перенос поддерева подборок', () => {
  /** Опубликованное дерево: группа → повод → адресат. */
  function seedTree(harness: Harness): { readonly child: Doc; readonly grandChild: Doc; readonly root: Doc } {
    const common = {
      intro: { root: { children: [{ children: [{ text: 'Текст', type: 'text' }], type: 'paragraph' }], type: 'root' } },
      metaDescription: 'Описание',
      publishedAt: '2026-01-10T00:00:00.000Z',
      related: [999],
      responsibleEditor: 1,
      robots: 'noindex,follow',
      status: 'published',
      urlChange: { confirm: false },
      withdrawal: { mode: null, redirectTo: null },
    };
    const root = harness.seed('collections', {
      ...common,
      id: 100,
      nodeKind: 'group',
      parent: null,
      path: '/podborki/prazdniki',
      slug: 'prazdniki',
      title: 'Праздники',
    });
    const child = harness.seed('collections', {
      ...common,
      id: 101,
      nodeKind: 'occasion',
      parent: 100,
      path: '/podborki/prazdniki/8-marta',
      slug: '8-marta',
      title: '8 Марта',
    });
    const grandChild = harness.seed('collections', {
      ...common,
      id: 102,
      nodeKind: 'recipient',
      parent: 101,
      path: '/podborki/prazdniki/8-marta/mame',
      slug: 'mame',
      title: 'Маме на 8 Марта',
    });
    return { child, grandChild, root };
  }

  it('переезд узла даёт по одному 301 на каждый переехавший путь', async () => {
    const harness = createHarness();
    seedTree(harness);

    await harness.update(
      'collections',
      100,
      { slug: 'prazdnichnye', urlChange: { confirm: true } },
      admin,
    );

    const redirects = harness
      .docs('redirects')
      .map((redirect) => [redirect.from, redirect.to, redirect.code]);

    expect(redirects).toEqual(
      expect.arrayContaining([
        ['/podborki/prazdniki/8-marta', '/podborki/prazdnichnye/8-marta', '301'],
        ['/podborki/prazdniki/8-marta/mame', '/podborki/prazdnichnye/8-marta/mame', '301'],
        ['/podborki/prazdniki', '/podborki/prazdnichnye', '301'],
      ]),
    );
    expect(redirects).toHaveLength(3);
  });

  it('ни один из созданных 301 не образует цепочку', async () => {
    const harness = createHarness();
    seedTree(harness);

    await harness.update(
      'collections',
      100,
      { slug: 'prazdnichnye', urlChange: { confirm: true } },
      admin,
    );

    const redirects = harness.docs('redirects');
    const sources = new Set(redirects.map((redirect) => redirect.from));
    for (const redirect of redirects) {
      expect(sources.has(redirect.to)).toBe(false);
    }
  });

  it('пути потомков переписаны, а история фиксирует переезд каждого', async () => {
    const harness = createHarness();
    seedTree(harness);

    await harness.update(
      'collections',
      100,
      { slug: 'prazdnichnye', urlChange: { confirm: true } },
      admin,
    );

    const paths = harness.docs('collections').map((doc) => doc.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/podborki/prazdnichnye',
        '/podborki/prazdnichnye/8-marta',
        '/podborki/prazdnichnye/8-marta/mame',
      ]),
    );
    expect(historyFor(harness, 'path')).toHaveLength(3);
  });

  it('перенос опубликованного узла без подтверждения отклонён целиком', async () => {
    const harness = createHarness();
    seedTree(harness);

    await expectRejected(
      () => harness.update('collections', 101, { parent: null, nodeKind: 'group' }, admin),
      'неизменяем после первой публикации',
    );
    expect(harness.docs('redirects')).toEqual([]);
    expect(harness.docs('collections').map((doc) => doc.path)).toEqual([
      '/podborki/prazdniki',
      '/podborki/prazdniki/8-marta',
      '/podborki/prazdniki/8-marta/mame',
    ]);
  });
});
