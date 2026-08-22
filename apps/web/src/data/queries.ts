/**
 * Запросы публичного рендера — ЧИСТЫЕ функции (задача Э3-02).
 *
 * Разделение «сборка запроса / его выполнение» сделано ради проверяемости:
 * ответы на вопросы «выключен ли access control», «не дублируется ли фильтр по
 * статусу», «устойчив ли порядок при пагинации» — это свойства ЗНАЧЕНИЙ, и
 * проверять их поднятой базой значило бы проверять редко. Выполнение живёт в
 * `./content.ts` и состоит из вызова Payload и приведения результата.
 *
 * ## Чего в этих запросах нет намеренно
 *
 *   - **фильтра по статусу.** Его ставит access control CMS
 *     (`contentReadAccess` возвращает `Where` для анонима), потому что
 *     `overrideAccess` здесь false. Написать `status: { equals: 'published' }`
 *     ещё и тут — значит завести второй источник защитного правила: пока они
 *     совпадают, лишняя строка безобидна, а когда разойдутся, разойдутся молча.
 *     Постусловие проверяется отказом (`assertPublicallyReadable`), а не
 *     фильтром;
 *   - **пересчёта путей.** Путь подборки считает и хранит CMS (поле `path` с
 *     уникальным индексом БД), путь карточки собирается из slug единственной
 *     функцией `buildCardPath` (`@otkritka/cms/seo/paths`). Здесь пути только
 *     сравниваются со СОХРАНЁННЫМ значением;
 *   - **условий индексации.** `robots`, `canonical` и право страницы быть в
 *     индексе — дело шаблона и sitemap (этап 4), а не выборки. Запрос отдаёт всё
 *     опубликованное: страница с `noindex` существует и отвечает 200, просто не
 *     идёт в индекс.
 *
 * ## Про сортировку
 *
 * У всех списков сортировка ПОЛНАЯ — последним ключом идёт `id`. Неоднозначный
 * порядок при постраничном обходе означает, что одна запись попадает на две
 * страницы, а другая не попадает ни на одну: для пагинации с постоянными URL
 * (`/page/N`) это потерянная из индекса карточка.
 */

import type { Where } from 'payload';

import { canonicalizePath } from '@otkritka/shared';
import { COLLECTION_PATH_PREFIX } from '@otkritka/cms/seo/paths';

import { assertPageNumber, DEFAULT_CARDS_PER_PAGE, PUBLIC_READ_SCOPE } from './read-scope.js';

/** Коллекции, которые читает публичный рендер. */
export type PublicCollectionSlug = 'cards' | 'collections';

/** Идентификатор записи в том виде, в каком его отдаёт Payload. */
export type RecordId = number | string;

/**
 * Запрос к коллекции в области чтения публичного рендера.
 *
 * Форма совпадает с параметрами `payload.find`, поэтому объект передаётся туда
 * как есть: промежуточного «перевода» нет, и параметр не может потеряться по
 * пути.
 */
export interface PublicFindQuery<TSlug extends PublicCollectionSlug> {
  collection: TSlug;
  depth: 0;
  limit?: number;
  overrideAccess: false;
  page?: number;
  pagination?: boolean;
  sort?: string[];
  where?: Where;
}

/**
 * Порядок карточек в любом списке: сначала свежие по дате ПЕРВОЙ публикации,
 * затем по идентификатору.
 *
 * Почему `publishedAt`, а не `updatedAt`: правка опечатки не должна
 * перетасовывать выдачу и тем самым менять состав страниц пагинации. Почему
 * `id` вторым ключом — см. шапку модуля.
 */
const CARD_ORDER: readonly string[] = ['-publishedAt', '-id'];

/**
 * Потолок числа строк у списков БЕЗ пагинации (дети узла, смежные, сезонные).
 *
 * Это не пагинация, а предел: `limit: 0` в Payload означает «без предела», и
 * страница со SSR однажды прочитала бы весь каталог одним запросом. Значение —
 * выбор агента (кандидат в реестр решений): столько узлов в одном блоке
 * перелинковки на странице всё равно не выводится, а превышение означает, что
 * блоку нужна своя страница со списком, а не больший предел.
 */
export const MAX_LIST_ROWS = 200;

/** Порядок узлов подборок: по заголовку, затем по идентификатору. */
const COLLECTION_ORDER: readonly string[] = ['title', 'id'];

/** Карточка по slug. Slug уникален в коллекции, поэтому документ ровно один. */
export function cardBySlugQuery(slug: string): PublicFindQuery<'cards'> {
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'cards',
    limit: 1,
    pagination: false,
    where: { slug: { equals: slug } },
  };
}

/**
 * Подборка по ИТОГОВОМУ пути.
 *
 * Путь приводится к канонической форме (решение Ч-21 — без завершающего слеша)
 * единственным хелпером `canonicalizePath`, а не сравнивается «как пришло»:
 * иначе `/podborki/8-marta/` не нашёл бы запись, у которой в поле `path` лежит
 * `/podborki/8-marta`.
 *
 * @throws Error если путь лежит вне пространства подборок. Пространства имён
 *   разведены решением человека от 2026-08-22, и путь карточки здесь — ошибка
 *   вызывающего, а не пустой результат: пустой результат выглядел бы как «такой
 *   подборки нет» и прятал бы перепутанный маршрут.
 */
export function collectionByPathQuery(path: string): PublicFindQuery<'collections'> {
  const canonical = canonicalizePath(path);
  if (canonical !== COLLECTION_PATH_PREFIX && !canonical.startsWith(`${COLLECTION_PATH_PREFIX}/`)) {
    throw new Error(
      `«${canonical}» не является путём подборки: узлы таксономии живут под ` +
        `${COLLECTION_PATH_PREFIX}, карточки — под /otkrytki (решение человека от ` +
        '2026-08-22). Запрос не отправлен: коллизия пространств имён невозможна ' +
        'структурно, поэтому чужой путь здесь означает ошибку маршрута.',
    );
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: 1,
    pagination: false,
    where: { path: { equals: canonical } },
  };
}

export interface CollectionCardsQueryInput {
  readonly collectionId: RecordId;
  /** Номер страницы, начиная с 1. `/page/1` не существует (решение Ч-05). */
  readonly page: number;
  readonly perPage?: number;
}

/**
 * Карточки подборки, страница за страницей.
 *
 * Связь m:n живёт в карточке (`cards.collections`), поэтому фильтр идёт по ней —
 * копий карточки внутри подборок не существует, и канонический адрес карточки
 * остаётся один (`/otkrytki/<slug>`).
 */
export function collectionCardsQuery(input: CollectionCardsQueryInput): PublicFindQuery<'cards'> {
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'cards',
    limit: input.perPage ?? DEFAULT_CARDS_PER_PAGE,
    page: assertPageNumber(input.page),
    sort: [...CARD_ORDER],
    where: { collections: { in: [input.collectionId] } },
  };
}

/**
 * Дочерние узлы подборки.
 *
 * `null` вместо запроса, если родителя нет: `{ in: [] }` часть адаптеров
 * трактует как отсутствие условия, то есть отдала бы ВСЕ подборки. Пустой набор
 * обязан быть пустым ответом, а не выборкой каталога.
 */
export function childCollectionsQuery(
  parentId: RecordId | null,
): PublicFindQuery<'collections'> | null {
  if (parentId === null) {
    return null;
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: MAX_LIST_ROWS,
    pagination: false,
    sort: [...COLLECTION_ORDER],
    where: { parent: { in: [parentId] } },
  };
}

/**
 * Подборка по идентификатору.
 *
 * Запрос списком, а не `findByID`, ровно по одной причине: неопубликованная
 * запись обязана прийти ПУСТЫМ результатом, а не исключением о запрете доступа.
 * Различать «нет записи» и «нельзя читать» публичному рендеру нечем и незачем:
 * ссылки на неё всё равно не будет.
 *
 * Потребителей два, и оба — крошки (Э3-03): родитель узла при обходе цепочки и
 * ОСНОВНАЯ подборка карточки (первая в связи `cards.collections`, ТЗ §5.4).
 * Поэтому запрос назван по тому, что он делает, а не по одному из двух случаев:
 * имя «родительский узел» заставило бы второго потребителя либо звать функцию
 * не по смыслу, либо завести рядом её копию.
 */
export function collectionByIdQuery(
  id: RecordId | null,
): PublicFindQuery<'collections'> | null {
  if (id === null) {
    return null;
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: 1,
    pagination: false,
    where: { id: { in: [id] } },
  };
}

/** Смежные подборки для блока перелинковки. */
export function relatedCollectionsQuery(
  ids: readonly RecordId[],
): PublicFindQuery<'collections'> | null {
  if (ids.length === 0) {
    return null;
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: ids.length,
    pagination: false,
    sort: [...COLLECTION_ORDER],
    where: { id: { in: [...ids] } },
  };
}

/** Свежие карточки: блок главной и перелинковка. Порядок тот же, что в списках. */
export function recentCardsQuery(limit: number): PublicFindQuery<'cards'> {
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'cards',
    limit,
    pagination: false,
    sort: [...CARD_ORDER],
  };
}

/**
 * Сезонные подборки: те, чьё окно показа накрывает указанный день.
 *
 * Окно переключает БЛОК на главной (ТЗ §8.1) и не создаёт отдельных URL — ни
 * `/2026/`, ни года в адресе (решение Ч-04-4). Узел без обеих дат в блок не
 * попадает: пустое поле здесь означает «показывать не по календарю», а
 * догадываться за редактора нельзя.
 */
export function seasonalCollectionsQuery(today: Date): PublicFindQuery<'collections'> {
  const day = today.toISOString();
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: MAX_LIST_ROWS,
    pagination: false,
    sort: ['seasonal.holidayDate', 'id'],
    where: {
      and: [
        { 'seasonal.showFrom': { less_than_equal: day } },
        { 'seasonal.showUntil': { greater_than_equal: day } },
      ],
    },
  };
}
