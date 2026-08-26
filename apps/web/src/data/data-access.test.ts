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
  childCollectionsQuery,
  collectionByIdQuery,
  collectionByPathQuery,
  collectionCardsQuery,
  collectionsByIdsQuery,
  type PublicCollectionSlug,
  type PublicFindQuery,
  recentCardsQuery,
  relatedCollectionsQuery,
  RELATED_COLLECTIONS_MAX,
  seasonalCollectionsQuery,
  SIMILAR_CARDS_MAX,
  SIMILAR_CARDS_TARGET_MIN,
  similarCardsQuery,
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

  it('похожие открытки: те же подборки, кроме самой карточки (ТЗ §5.4)', () => {
    // Исключение самой карточки делает ЗАПРОС, а не шаблон: отфильтрованная
    // после выборки карточка уменьшала бы блок на одну позицию непредсказуемо.
    const query = required(similarCardsQuery({ collectionIds: [7, 9], excludeCardId: 3 }));

    expect(query.collection).toBe('cards');
    expect(query.limit).toBe(SIMILAR_CARDS_MAX);
    expect(query.sort).toEqual(['-publishedAt', '-id']);
    expect(query.where).toEqual({
      and: [{ collections: { in: [7, 9] } }, { id: { not_equals: 3 } }],
    });
  });

  it('блок «Похожие» держится в границах 6–12 из ТЗ', () => {
    expect(SIMILAR_CARDS_MAX).toBe(12);
    expect(SIMILAR_CARDS_TARGET_MIN).toBe(6);
    expect(SIMILAR_CARDS_TARGET_MIN).toBeLessThan(SIMILAR_CARDS_MAX);
  });

  it('карточка без подборок не превращает «похожие» в весь каталог', () => {
    expect(similarCardsQuery({ collectionIds: [], excludeCardId: 3 })).toBeNull();
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
      required(similarCardsQuery({ collectionIds: [1], excludeCardId: 2 })),
      recentCardsQuery(4),
      seasonalCollectionsQuery(new Date()),
    ];
    for (const query of queries) {
      expect(query.overrideAccess).toBe(false);
      expect(query.depth).toBe(0);
      expect('user' in query).toBe(false);
    }
  });
});
