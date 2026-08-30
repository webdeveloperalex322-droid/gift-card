/**
 * Слой доступа к данным apps/web (задача Э3-02): запросы, которыми публичный
 * рендер читает опубликованный контент.
 *
 * Что здесь проверяется и почему именно это. Ответ на вопрос «увидит ли
 * публичный рендер черновик» состоит из двух частей:
 *
 *   1. запрос уходит в Payload с `overrideAccess` в значении false и без
 *      пользователя — тогда фильтр «только published» ставит access control CMS,
 *      а не web. Это проверяется здесь: параметры запроса — чистые значения;
 *   2. Payload при таких параметрах действительно не отдаёт `draft` и `review`.
 *      Это проверяется на ЖИВОЙ базе смоуком `apps/web/scripts/smoke-data.ts`:
 *      фазы access control работают только в поднятом ядре, и юнит-тест здесь
 *      доказал бы лишь то, что мы передали правильные аргументы.
 *
 * Дублирования фильтра по статусу в запросах НЕТ намеренно (см. шапку
 * `./queries.ts`): два источника одного правила расходятся, и расходятся молча.
 * Поэтому тест проверяет ОТСУТСТВИЕ такого условия — если оно появится, значит
 * правило начали писать во втором месте.
 *
 * ## Почему этот файл лежит рядом с исходниками, а не в `tests/unit/`
 *
 * Модули `src/data/` работают только внутри сборки Astro: они импортируют конфиг
 * Payload — файл `.ts` из другого пакета, — поэтому в composite-проект
 * `apps/web/tsconfig.node.json` (настоящий Node ESM, реальный emit) они входить
 * не могут. А тест из `tests/unit/` обязан импортировать модуль, который входит
 * в один из проектов, на которые тесты ссылаются, иначе `tsc -b` отказывает
 * (TS6307). Значит выбор такой: либо владельцем проверки типов слоя данных
 * становится ЧУЖОЙ проект тестов (ровно та ошибка, которую здесь уже исправляли
 * для `src/routing`), либо тест живёт внутри `apps/web` и проверяется тем же
 * `astro check`, что и сам слой. Выбрано второе — так же, как в `apps/cms`, где
 * тесты лежат рядом с модулями. Vitest подхватывает файл шаблоном для тестов
 * внутри приложений, объявленным в `vitest.config.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  cardBySlugQuery,
  catalogCardsQuery,
  childCollectionsQuery,
  collectionByIdQuery,
  collectionByPathQuery,
  collectionCardsCountQuery,
  collectionCardsQuery,
  collectionsByIdsQuery,
  MAX_LIST_ROWS,
  type PublicCollectionSlug,
  type PublicFindQuery,
  recentCardsQuery,
  relatedCollectionsQuery,
  RELATED_COLLECTIONS_MAX,
  rootCollectionsQuery,
  seasonalCollectionsQuery,
  SIMILAR_CARDS_MAX,
  SIMILAR_CARDS_TARGET_MIN,
  similarCardsQueries,
  similarCardsWindow,
} from './queries.js';
import { orderByIds } from './relations.js';
import {
  assertPageNumber,
  assertPublicallyReadable,
  DEFAULT_CARDS_PER_PAGE,
  PUBLIC_READ_SCOPE,
} from './read-scope.js';

const WEB_SRC = fileURLToPath(new URL('../', import.meta.url));

/** Запрос, который обязан существовать. Иначе тест проверял бы `null`. */
function required<TSlug extends PublicCollectionSlug>(
  query: PublicFindQuery<TSlug> | null,
): PublicFindQuery<TSlug> {
  if (query === null) {
    throw new Error('Запрос не собран, хотя должен был.');
  }
  return query;
}

/** Все `.ts`/`.astro`/`.mts` файлы apps/web — для проверок «ни одного вхождения». */
function webSourceFiles(dir = WEB_SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...webSourceFiles(full));
      continue;
    }
    if (/\.(astro|mts|ts)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('область чтения публичного рендера', () => {
  it('access control CMS не выключается: overrideAccess ложно и пользователя нет', () => {
    expect(PUBLIC_READ_SCOPE.overrideAccess).toBe(false);
    // Пользователь не передаётся вовсе: любой пользователь — это роль, а обе
    // роли проекта (`admin`, `ai-editor`) видят черновики. Публичный рендер
    // обязан читать как аноним.
    expect('user' in PUBLIC_READ_SCOPE).toBe(false);
  });

  it('в apps/web нет ни одного включения overrideAccess', () => {
    // Требование задачи Э3-02: `overrideAccess` в значении true отключает и
    // access control коллекций, и проверки доступа к полям — то есть публичный
    // рендер получил бы черновики и служебные поля. Проверка текстовая
    // намеренно: она ловит и вызов, которого ещё нет, и вызов в шаблоне .astro,
    // который типами не покрыт.
    const offenders = webSourceFiles().filter((file) =>
      /overrideAccess\s*:\s*true/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('глубина населения связей нулевая: связь — это идентификатор', () => {
    // depth: 0 делает результат предсказуемым. При depth > 0 Payload населяет
    // связь ТОЛЬКО если её разрешено читать: неопубликованная подборка молча
    // превратилась бы в число, и шаблон получал бы то объект, то идентификатор
    // в зависимости от статуса чужой записи.
    expect(PUBLIC_READ_SCOPE.depth).toBe(0);
  });
});

describe('запреты по статусу', () => {
  it('запись не в published до шаблона не доходит', () => {
    // Это не второй фильтр, а проверка постусловия: фильтр ставит CMS. Если
    // сюда пришла запись со статусом draft или review, значит правило доступа
    // сломано — и об этом надо узнать падением, а не страницей в индексе.
    for (const status of ['draft', 'review']) {
      expect(() => assertPublicallyReadable({ id: 1, status }, 'карточка')).toThrow(/status/);
    }
    expect(() => assertPublicallyReadable({ id: 1, status: 'published' }, 'карточка')).not.toThrow();
  });

  it('запись без статуса тоже отклоняется', () => {
    expect(() => assertPublicallyReadable({ id: 1 }, 'карточка')).toThrow(/status/);
  });
});

describe('номер страницы пагинации', () => {
  it('первая страница — 1: /page/1 не существует ни на одном уровне', () => {
    expect(assertPageNumber(1)).toBe(1);
    expect(assertPageNumber(2)).toBe(2);
  });

  it('нецелые и неположительные номера — ошибка вызывающего, а не пустая страница', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertPageNumber(value)).toThrow();
    }
  });
});

describe('запросы к коллекциям', () => {
  it('карточка по slug: один документ, фильтра по статусу в запросе нет', () => {
    const query = cardBySlugQuery('otkrytka-mame');
    expect(query.collection).toBe('cards');
    expect(query.limit).toBe(1);
    expect(query.overrideAccess).toBe(false);
    expect(JSON.stringify(query.where)).toBe(JSON.stringify({ slug: { equals: 'otkrytka-mame' } }));
    expect(JSON.stringify(query)).not.toContain('published');
  });

  it('счётчик открыток узла: та же область чтения, фильтра по статусу нет', () => {
    // Половина предиката «непуст» (условие Э3-13-A). `overrideAccess: false`
    // здесь так же обязателен, как в чтении: со включённым счётчик считал бы и
    // черновики, и узел без ни одной ОПУБЛИКОВАННОЙ открытки выглядел бы
    // наполненным — то есть ссылка на 404 вернулась бы через счётчик.
    const query = collectionCardsCountQuery(7);

    expect(query.collection).toBe('cards');
    expect(query.overrideAccess).toBe(false);
    expect(query.where).toEqual({ collections: { in: [7] } });
    expect(JSON.stringify(query)).not.toContain('published');
    // Ни `depth`, ни `sort`, ни `limit`: у `payload.count` их нет, и передавать
    // их значило бы делать вид, что они на что-то влияют.
    expect(Object.keys(query).sort()).toEqual(['collection', 'overrideAccess', 'where']);
  });

  it('подборка по итоговому пути: путь приводится к каноническому виду', () => {
    // Путь подборки считает и хранит CMS (поле `path` с уникальным индексом).
    // Пересчитывать его в web запрещено, поэтому запрос идёт по значению как
    // есть — но каноническая форма у пути одна (решение Ч-21).
    expect(collectionByPathQuery('/podborki/prazdniki/8-marta/').where).toEqual({
      path: { equals: '/podborki/prazdniki/8-marta' },
    });
  });

  it('подборка вне пространства /podborki не запрашивается вовсе', () => {
    // Пространства имён разведены (решение человека от 2026-08-22): подборки
    // живут под /podborki, карточки под /otkrytki. Запрос по чужому пути — это
    // ошибка вызывающего, а не пустой результат.
    expect(() => collectionByPathQuery('/otkrytki/8-marta')).toThrow(/podborki/);
    expect(() => collectionByPathQuery('otkrytki')).toThrow(/podborki/);
  });

  it('список карточек подборки: постраничный, с устойчивым порядком', () => {
    const query = collectionCardsQuery({ collectionId: 7, page: 3 });
    expect(query.collection).toBe('cards');
    expect(query.page).toBe(3);
    expect(query.limit).toBe(DEFAULT_CARDS_PER_PAGE);
    expect(query.where).toEqual({ collections: { in: [7] } });
    // Сортировка обязана быть полной: при неоднозначном порядке одна и та же
    // карточка попадает на две страницы, а другая — ни на одну.
    expect(query.sort).toEqual(['-publishedAt', '-id']);
  });

  it('каталог открыток: та же пагинация и тот же порядок, но без фильтра по подборке', () => {
    // Каталог `/otkrytki` (задача Э3-08) перечисляет всё опубликованное. Порядок
    // обязан совпадать с порядком списка подборки: иначе одна карточка попадала
    // бы на две страницы каталога, а другая ни на одну.
    const query = catalogCardsQuery({ page: 2 });

    expect(query.collection).toBe('cards');
    expect(query.page).toBe(2);
    expect(query.limit).toBe(DEFAULT_CARDS_PER_PAGE);
    expect(query.where).toBeUndefined();
    expect(query.sort).toEqual(['-publishedAt', '-id']);
    expect(catalogCardsQuery({ page: 1, perPage: 6 }).limit).toBe(6);
    // Номер страницы проверяется тем же предикатом, что у списка подборки:
    // /page/1 не существует, а /page/0 обязан отвечать 404 в маршруте.
    expect(() => catalogCardsQuery({ page: 0 })).toThrow();
  });

  it('каталог подборок: узлы верхнего уровня — те, у которых нет родителя', () => {
    // «Верхний уровень» — отсутствие родителя, а не вид узла: завязка на
    // nodeKind означала бы, что каталог теряет раздел при новом виде узла.
    const query = rootCollectionsQuery();

    expect(query.collection).toBe('collections');
    expect(query.where).toEqual({ parent: { exists: false } });
    expect(query.limit).toBe(MAX_LIST_ROWS);
    expect(query.pagination).toBe(false);
    expect(query.sort).toEqual(['title', 'id']);
  });

  it('дети, родитель и смежные подборки читаются по идентификаторам', () => {
    expect(required(childCollectionsQuery(7)).where).toEqual({ parent: { in: [7] } });
    expect(required(collectionByIdQuery(7)).where).toEqual({ id: { in: [7] } });
    expect(required(relatedCollectionsQuery([7, 9])).where).toEqual({ id: { in: [7, 9] } });
  });

  it('пустой список смежных подборок не превращается в запрос «все»', () => {
    // `{ id: { in: [] } }` в некоторых адаптерах означает «без условия», то есть
    // отдал бы весь каталог. Поэтому пустой набор — это null, а не запрос.
    expect(relatedCollectionsQuery([])).toBeNull();
    expect(childCollectionsQuery(null)).toBeNull();
  });

  it('свежие карточки: тот же порядок, что в списке подборки', () => {
    const query = recentCardsQuery(8);
    expect(query.limit).toBe(8);
    expect(query.sort).toEqual(['-publishedAt', '-id']);
    expect(query.where).toBeUndefined();
  });

  it('сезонные подборки: окно показа, а не отдельный URL', () => {
    // Даты показа переключают БЛОК на главной (ТЗ §8.1) и не создают URL.
    const query = seasonalCollectionsQuery(new Date('2026-03-01T00:00:00.000Z'));
    expect(query.where).toEqual({
      and: [
        { 'seasonal.showFrom': { less_than_equal: '2026-03-01T00:00:00.000Z' } },
        { 'seasonal.showUntil': { greater_than_equal: '2026-03-01T00:00:00.000Z' } },
      ],
    });
  });

  it('похожие открытки: окно соседей той же темы, кроме самой карточки (ТЗ §5.4)', () => {
    // Исключение самой карточки делает ЗАПРОС, а не шаблон: отфильтрованная
    // после выборки карточка уменьшала бы блок на одну позицию непредсказуемо.
    const queries = similarCardsQueries({
      collectionIds: [7, 9],
      excludeCardId: 3,
      publishedAt: '2026-03-01T10:00:00.000Z',
    });
    const older = required(queries.older);
    const newer = required(queries.newer);

    expect(older.collection).toBe('cards');
    expect(older.limit).toBe(SIMILAR_CARDS_MAX);
    // Половина «старше» читается порядком показа, половина «новее» — обратным:
    // предел обязан отрезать дальних соседей, а не ближних.
    expect(older.sort).toEqual(['-publishedAt', '-id']);
    expect(newer.sort).toEqual(['publishedAt', 'id']);

    const theme = { and: [{ collections: { in: [7, 9] } }, { id: { not_equals: 3 } }] };
    // Сравнение с карточкой СОСТАВНОЕ: у пачки, опубликованной одной операцией
    // (пакетная публикация — решение Ч-07), `publishedAt` совпадает, и сравнение
    // по одной дате разрезало бы пачку целиком в одну сторону.
    expect(older.where).toEqual({
      and: [
        theme,
        {
          or: [
            { publishedAt: { less_than: '2026-03-01T10:00:00.000Z' } },
            {
              and: [
                { publishedAt: { equals: '2026-03-01T10:00:00.000Z' } },
                { id: { less_than: 3 } },
              ],
            },
          ],
        },
      ],
    });
  });

  it('блок «Похожие» держится в границах 6–12 из ТЗ', () => {
    expect(SIMILAR_CARDS_MAX).toBe(12);
    expect(SIMILAR_CARDS_TARGET_MIN).toBe(6);
    expect(SIMILAR_CARDS_TARGET_MIN).toBeLessThan(SIMILAR_CARDS_MAX);
  });

  it('карточка без подборок не превращает «похожие» в весь каталог', () => {
    const queries = similarCardsQueries({
      collectionIds: [],
      excludeCardId: 3,
      publishedAt: '2026-03-01T10:00:00.000Z',
    });

    expect(queries.newer).toBeNull();
    expect(queries.older).toBeNull();
  });

  it('карточка без publishedAt: окна нет, но страница не падает', () => {
    // У опубликованной записи поле ставит хук первой публикации, поэтому пустое
    // значение означает повреждённую запись. Осознанная деградация до прежнего
    // поведения (свежие по теме) лучше 500 на странице, которую человек
    // опубликовал; достижимость при этом держит пагинация списка.
    const queries = similarCardsQueries({
      collectionIds: [7],
      excludeCardId: 3,
      publishedAt: null,
    });

    expect(queries.newer).toBeNull();
    expect(required(queries.older).where).toEqual({
      and: [{ collections: { in: [7] } }, { id: { not_equals: 3 } }],
    });
  });

  it('смежные подборки ограничены шестью, а подборки карточки читаются целиком', () => {
    // У блока перелинковки предел из ТЗ §5.3 (3–6 вбок); у связи `collections`
    // карточки предела нет: из неё получаются видимые атрибуты, и обрезать их
    // числом значило бы спрятать часть привязок открытки.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];

    expect(required(relatedCollectionsQuery(ids)).limit).toBe(RELATED_COLLECTIONS_MAX);
    expect(required(collectionsByIdsQuery(ids)).limit).toBe(ids.length);
    expect(required(collectionsByIdsQuery(ids)).where).toEqual({ id: { in: ids } });
    expect(collectionsByIdsQuery([])).toBeNull();
  });

  it('порядок редактора восстанавливается по списку идентификаторов', () => {
    // Первая подборка карточки — основная, и порядок задаёт редактор. Запрос
    // возвращает записи по заголовку, потому что сортировать «по списку
    // идентификаторов» на стороне БД нечем.
    const docs = [
      { id: 9, title: 'А' },
      { id: 7, title: 'Б' },
    ];

    expect(orderByIds(docs, [7, 9]).map((doc) => doc.id)).toEqual([7, 9]);
    // Записи, которой в ответе нет (неопубликованная), в результате не будет:
    // ссылки на неё не существует.
    expect(orderByIds(docs, [7, 100, 9]).map((doc) => doc.id)).toEqual([7, 9]);
    // Повтор идентификатора не даёт вторую одинаковую ссылку.
    expect(orderByIds(docs, [7, 7, 9]).map((doc) => doc.id)).toEqual([7, 9]);
    expect(orderByIds(docs, [])).toEqual([]);
  });

  it('каждый запрос уходит с областью чтения публичного рендера', () => {
    const queries = [
      cardBySlugQuery('x'),
      collectionByPathQuery('/podborki/prazdniki/8-marta'),
      collectionCardsQuery({ collectionId: 1, page: 1 }),
      required(childCollectionsQuery(1)),
      required(collectionByIdQuery(1)),
      required(relatedCollectionsQuery([1])),
      required(collectionsByIdsQuery([1])),
      required(
        similarCardsQueries({ collectionIds: [1], excludeCardId: 2, publishedAt: '2026-01-01' })
          .newer,
      ),
      required(
        similarCardsQueries({ collectionIds: [1], excludeCardId: 2, publishedAt: '2026-01-01' })
          .older,
      ),
      recentCardsQuery(4),
      catalogCardsQuery({ page: 2 }),
      rootCollectionsQuery(),
      seasonalCollectionsQuery(new Date()),
    ];
    for (const query of queries) {
      expect(query.overrideAccess).toBe(false);
      expect(query.depth).toBe(0);
      expect('user' in query).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Достижимость через блок «Похожие открытки» (решение Ч-04-8)         */
/* ------------------------------------------------------------------ */

/**
 * Мини-СУБД: применяет запрос к набору карточек в памяти.
 *
 * Зачем она нужна, а не просто проверка формы `where`. Проверяемое здесь
 * свойство — «ЛЮБАЯ карточка темы попадает хотя бы в один блок „Похожие“» — это
 * свойство ВЫБОРКИ, а не текста условия: оно складывается из предиката, порядка
 * сортировки, предела и склейки половин. Проверка формы `where` (она есть выше)
 * доказывает, что мы отправили то, что хотели; здесь доказывается, что
 * отправленное даёт нужный результат. Живой базой это же утверждение проверялось
 * бы 74 запросами на каждый прогон — то есть почти никогда.
 *
 * Поддержан ровно тот набор операторов, который порождают наши запросы.
 * Неизвестный оператор — отказ, а не «не совпало»: молчаливое false здесь
 * означало бы тест, который проверяет не тот запрос, что уходит в Payload.
 */
interface FakeCard {
  readonly id: number;
  readonly publishedAt: string;
  readonly collections: readonly number[];
}

function compareOperator(
  card: FakeCard,
  field: string,
  operator: string,
  operand: unknown,
): boolean {
  if (field === 'collections') {
    if (operator !== 'in') {
      throw new Error(`Оператор «${operator}» по связи мини-СУБД теста не поддерживает.`);
    }
    return (operand as readonly number[]).some((id) => card.collections.includes(id));
  }

  const value: number | string = field === 'id' ? card.id : card.publishedAt;
  switch (operator) {
    case 'equals':
      return value === operand;
    case 'not_equals':
      return value !== operand;
    case 'greater_than':
      return value > (operand as number | string);
    case 'less_than':
      return value < (operand as number | string);
    default:
      throw new Error(
        `Оператор «${operator}» мини-СУБД теста не поддержан. Запрос изменился — проверка ` +
          'обязана либо научиться его исполнять, либо перестать притворяться, что проверила.',
      );
  }
}

function matchesWhere(card: FakeCard, where: unknown): boolean {
  const record = where as Record<string, unknown>;
  const and = record['and'];
  if (Array.isArray(and)) {
    return and.every((nested) => matchesWhere(card, nested));
  }
  const or = record['or'];
  if (Array.isArray(or)) {
    return or.some((nested) => matchesWhere(card, nested));
  }
  return Object.entries(record).every(([field, condition]) =>
    Object.entries(condition as Record<string, unknown>).every(([operator, operand]) =>
      compareOperator(card, field, operator, operand),
    ),
  );
}

/** Сортировка по ключам Payload (`-поле` — по убыванию). Порядок полный. */
function sortByKeys(cards: readonly FakeCard[], keys: readonly string[]): readonly FakeCard[] {
  return [...cards].sort((left, right) => {
    for (const key of keys) {
      const descending = key.startsWith('-');
      const field = descending ? key.slice(1) : key;
      const a: number | string = field === 'id' ? left.id : left.publishedAt;
      const b: number | string = field === 'id' ? right.id : right.publishedAt;
      if (a !== b) {
        return (a < b ? -1 : 1) * (descending ? -1 : 1);
      }
    }
    return 0;
  });
}

function runQuery(
  cards: readonly FakeCard[],
  query: PublicFindQuery<'cards'> | null,
): readonly FakeCard[] {
  if (query === null) {
    return [];
  }
  const matched = cards.filter((card) => matchesWhere(card, query.where));
  const sorted = sortByKeys(matched, query.sort ?? []);
  return query.limit === undefined ? sorted : sorted.slice(0, query.limit);
}

/**
 * Тема из 37 открыток — заметно больше предела блока (12), иначе свойство
 * выполнялось бы тривиально. Дата публикации повторяется тройками: так в наборе
 * есть пачки, опубликованные одной операцией (решение Ч-07), и составное
 * сравнение по `(publishedAt, id)` действительно работает, а не проверяется на
 * идеально различных датах.
 */
const THEME_ID = 7;
const THEME: readonly FakeCard[] = Array.from({ length: 37 }, (_, index) => ({
  collections: [THEME_ID],
  id: index + 1,
  publishedAt: `2026-03-${String(1 + Math.floor(index / 3)).padStart(2, '0')}T10:00:00.000Z`,
}));

function blockIn(theme: readonly FakeCard[], card: FakeCard): readonly FakeCard[] {
  const queries = similarCardsQueries({
    collectionIds: [THEME_ID],
    excludeCardId: card.id,
    publishedAt: card.publishedAt,
  });
  return similarCardsWindow({
    newer: runQuery(theme, queries.newer),
    older: runQuery(theme, queries.older),
  });
}

function similarBlockFor(card: FakeCard): readonly FakeCard[] {
  return blockIn(THEME, card);
}

/**
 * Блок карточки, посчитанный по ЕЁ набору подборок, а не по одной общей теме.
 *
 * Нужен для случая с разными наборами: запрос темизует ОБЪЕДИНЕНИЕМ подборок
 * карточки (`collections: { in: [...] }`), поэтому у двух карточек с разными
 * наборами разные пулы соседей, и `blockIn` с фиксированным `[THEME_ID]` этого
 * состояния не воспроизводит.
 */
function blockByOwnCollections(
  pool: readonly FakeCard[],
  card: FakeCard,
): readonly FakeCard[] {
  const queries = similarCardsQueries({
    collectionIds: card.collections,
    excludeCardId: card.id,
    publishedAt: card.publishedAt,
  });
  return similarCardsWindow({
    newer: runQuery(pool, queries.newer),
    older: runQuery(pool, queries.older),
  });
}

describe('блок «Похожие открытки» как средство достижимости (Ч-04-8)', () => {
  it('в теме с ОДНИМ набором подборок любая карточка попадает в чей-то блок', () => {
    // ГРАНИЦА УТВЕРЖДЕНИЯ (сужена по вердикту `reviewer`, MINOR 6): свойство
    // доказано для карточек с ОДИНАКОВЫМ набором подборок — то есть для одного
    // пула соседей. Причина ограничения и случай, на котором свойство перестаёт
    // держаться, разобраны ниже отдельным тестом.
    //
    // Прежняя выборка («свежие 12 минус сама») давала всем карточкам темы ОДИН
    // список, и карточка с тринадцатой по счёту не входила ни в один блок — то
    // есть за первой страницей списка была недостижима ссылками.
    const covered = new Set<number>();
    for (const card of THEME) {
      for (const similar of similarBlockFor(card)) {
        covered.add(similar.id);
      }
    }

    expect([...covered].sort((a, b) => a - b)).toEqual(THEME.map((card) => card.id));
  });

  it('при РАЗНЫХ наборах подборок «быть соседом» перестаёт быть взаимным', () => {
    // ЧТО ЗДЕСЬ ЗАФИКСИРОВАНО. Пул соседей карточки — объединение её подборок.
    // Поэтому у карточки малой подборки пул мал, а у её соседа, входящего ещё и в
    // большую подборку, пул велик: карточка малой подборки не попадает в его
    // двенадцать позиций, хотя он попадает в её. Взаимность отношения «быть
    // соседом» держится только внутри ОДНОГО пула, и вместе с ней — покрытие.
    //
    // Набор: подборка SMALL из двух карточек, одна из которых входит ещё и в
    // BIG с плотным корпусом вокруг. Карточка `lonely` есть только в SMALL.
    const SMALL = 100;
    const BIG = 200;
    const lonely: FakeCard = {
      collections: [SMALL],
      id: 1000,
      publishedAt: '2026-01-01T10:00:00.000Z',
    };
    const bridge: FakeCard = {
      collections: [SMALL, BIG],
      id: 1001,
      publishedAt: '2026-06-15T10:00:00.000Z',
    };
    // Корпус BIG обступает `bridge` с ОБЕИХ сторон по десять карточек: обе
    // половины окна (по шесть позиций) заполняются им целиком, и дальний по дате
    // `lonely` в них не попадает. Односторонний корпус свойства не показал бы —
    // недобранная половина отдаёт позиции второй, и `lonely` прошла бы.
    const bigCorpus: readonly FakeCard[] = Array.from({ length: 20 }, (_, index) => ({
      collections: [BIG],
      id: 1100 + index,
      publishedAt: `2026-06-${String(index < 10 ? 16 + index : 14 - (index - 10)).padStart(2, '0')}T10:00:00.000Z`,
    }));
    const pool = [lonely, bridge, ...bigCorpus];

    // Со стороны `lonely` сосед виден: её пул — только SMALL.
    expect(blockByOwnCollections(pool, lonely).map((card) => card.id)).toEqual([bridge.id]);

    // А со стороны `bridge` её нет: двенадцать ближайших в объединении SMALL ∪ BIG
    // заняты корпусом BIG. Входящей ссылки «Похожие» у `lonely` не остаётся ни от
    // кого — других карточек в SMALL нет.
    const fromBridge = blockByOwnCollections(pool, bridge).map((card) => card.id);
    expect(fromBridge).not.toContain(lonely.id);

    // Отсюда и суженная формулировка: блок гарантирует ИСХОДЯЩИЕ ссылки на
    // непосредственных соседей карточки в её собственном пуле, а «каждая карточка
    // имеет входящую ссылку» верно там, где пул у соседей общий. Полное покрытие
    // при разнородных наборах требует считать окно по КАЖДОЙ подборке карточки
    // отдельно (тогда взаимность восстанавливается внутри каждой), и это
    // изменение запроса, а не формулировки, — вынесено в отчёт задачи.
    const covered = new Set<number>();
    for (const card of pool) {
      for (const similar of blockByOwnCollections(pool, card)) {
        covered.add(similar.id);
      }
    }
    expect(covered.has(lonely.id)).toBe(false);
  });

  it('блок зависит от карточки, а не одинаков у всей темы', () => {
    const blocks = THEME.map((card) =>
      similarBlockFor(card)
        .map((similar) => similar.id)
        .join(','),
    );

    expect(new Set(blocks).size).toBe(THEME.length);
  });

  it('на себя блок не ссылается и предел не превышает', () => {
    for (const card of THEME) {
      const block = similarBlockFor(card);
      expect(block.map((similar) => similar.id)).not.toContain(card.id);
      expect(block).toHaveLength(SIMILAR_CARDS_MAX);
    }
  });

  it('блок — непрерывный отрезок общего порядка вокруг карточки', () => {
    // Из непрерывности и следует взаимность «быть соседом», а из неё —
    // достижимость. Свойство проверяется отдельно от неё: покрытие может
    // сложиться и на рваной выборке, а непрерывность — это причина.
    const order = sortByKeys(THEME, ['-publishedAt', '-id']).map((card) => card.id);

    for (const card of THEME) {
      const shown = similarBlockFor(card).map((similar) => similar.id);
      const positions = [...shown, card.id].map((id) => order.indexOf(id)).sort((a, b) => a - b);
      const last = positions.at(-1) ?? 0;
      const first = positions.at(0) ?? 0;

      expect(last - first).toBe(positions.length - 1);
    }
  });

  it('у самой свежей и у самой старой открытки темы блок полный', () => {
    // Половина окна у них пуста, и предел обязан целиком уйти второй половине:
    // иначе крайние карточки темы получали бы вдвое меньше ссылок, а вместе с
    // ними — вдвое меньше входящих ссылок их соседи.
    const order = sortByKeys(THEME, ['-publishedAt', '-id']);
    const freshest = order[0];
    const oldest = order.at(-1);
    if (freshest === undefined || oldest === undefined) {
      throw new Error('Набор темы пуст — проверять нечего.');
    }

    expect(similarBlockFor(freshest)).toHaveLength(SIMILAR_CARDS_MAX);
    expect(similarBlockFor(oldest)).toHaveLength(SIMILAR_CARDS_MAX);
    // У самой свежей соседей «новее» нет вовсе — весь блок приходит из «старше».
    const queries = similarCardsQueries({
      collectionIds: [THEME_ID],
      excludeCardId: freshest.id,
      publishedAt: freshest.publishedAt,
    });
    expect(runQuery(THEME, queries.newer)).toEqual([]);
  });

  it('тема из двух открыток: каждая видит другую', () => {
    // Нижняя граница, при которой требование ещё выполнимо. Ниже (одна открытка
    // в теме) блок пуст, и достижимость держится только списком — это состояние
    // неполной темы, а не дефект (порог 20 открыток — решение Ч-06).
    const pair = THEME.slice(0, 2);
    const left = pair[0];
    const right = pair[1];
    if (left === undefined || right === undefined) {
      throw new Error('Паре нужны две карточки.');
    }

    expect(blockIn(pair, left).map((card) => card.id)).toEqual([right.id]);
    expect(blockIn(pair, right).map((card) => card.id)).toEqual([left.id]);
  });

  it('предел 1 отклоняется: он ломает взаимность «быть соседом»', () => {
    expect(() => similarCardsWindow({ limit: 1, newer: [{ id: 1 }], older: [{ id: 2 }] })).toThrow(
      /Ч-04-8/,
    );
  });
});
