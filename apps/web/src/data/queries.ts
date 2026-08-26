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

/**
 * Сколько открыток выводит блок «Похожие открытки» (ТЗ §5.4: 6–12 шт.).
 *
 * Верхняя граница — предел ЗАПРОСА, поэтому она здесь: лишние строки, которые
 * шаблон всё равно не покажет, не читаются вовсе.
 */
export const SIMILAR_CARDS_MAX = 12;

/**
 * Нижняя граница того же диапазона — ОРИЕНТИР, а не условие запроса.
 *
 * Добить блок до шести открытками из других тем нельзя: заголовок «Похожие
 * открытки» стал бы неправдой, а разметка и видимое содержимое обязаны
 * соответствовать друг другу. Поэтому нижняя граница обеспечивается ДАННЫМИ: у
 * темы минимум 20 опубликованных открыток (решение Ч-06), значит у любой
 * карточки внутри такой темы похожих не меньше 19. Меньше шести в блоке —
 * сигнал о неполноте темы, а не о дефекте шаблона; страницу это не ломает.
 */
export const SIMILAR_CARDS_TARGET_MIN = 6;

/**
 * Сколько смежных подборок выводит блок перелинковки (ТЗ §5.3: 3–6 вбок).
 *
 * Ограничение стоит на запросе, а не на шаблоне: связь `related` редактор может
 * заполнить любым числом узлов, и без предела страница выводила бы их все.
 * Порядок при этом задаёт запрос (по заголовку), а не редактор, — блок
 * перелинковки не имеет главного элемента, в отличие от связи `collections` у
 * карточки, где первая подборка основная.
 */
export const RELATED_COLLECTIONS_MAX = 6;

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

export interface CatalogCardsQueryInput {
  /** Номер страницы, начиная с 1. `/page/1` не существует (решение Ч-05). */
  readonly page: number;
  readonly perPage?: number;
}

/**
 * Карточки КАТАЛОГА `/otkrytki`, страница за страницей (задача Э3-08).
 *
 * Отличается от {@link collectionCardsQuery} ровно отсутствием фильтра по
 * подборке: каталог перечисляет всё опубликованное. Порядок тот же и это
 * обязательно — иначе одна и та же карточка попадала бы на две страницы каталога.
 *
 * Почему это не {@link recentCardsQuery} с параметром: у того пагинации нет
 * вовсе (`pagination: false`, предел строк), он отвечает на другой вопрос —
 * «свежие для блока», где число известно заранее. Один запрос на две роли
 * означал бы, что блок главной однажды поедет по страницам, а каталог перестанет
 * знать общее число открыток.
 */
export function catalogCardsQuery(input: CatalogCardsQueryInput): PublicFindQuery<'cards'> {
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'cards',
    limit: input.perPage ?? DEFAULT_CARDS_PER_PAGE,
    page: assertPageNumber(input.page),
    sort: [...CARD_ORDER],
  };
}

/**
 * Узлы верхнего уровня таксономии — содержание каталога `/podborki` (Э3-08).
 *
 * «Верхний уровень» — это отсутствие родителя, а не вид узла: группирующие узлы
 * (`prazdniki`, `adresaty`) и адресаты без праздника лежат на первом уровне
 * одинаково, а завязка на `nodeKind` означала бы, что каталог теряет раздел при
 * первом же новом виде узла.
 *
 * Предел — {@link MAX_LIST_ROWS}: это не пагинация, а граница SSR-запроса.
 * Каталог `/podborki` пагинации не имеет намеренно — узлов верхнего уровня
 * единицы, и страница со списком разделов постранично не разбивается.
 */
export function rootCollectionsQuery(): PublicFindQuery<'collections'> {
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: MAX_LIST_ROWS,
    pagination: false,
    sort: [...COLLECTION_ORDER],
    where: { parent: { exists: false } },
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

/**
 * Подборки по набору идентификаторов.
 *
 * Потребителей два, и предел у них разный, поэтому он аргумент, а не константа
 * внутри: блок смежных подборок выводит не больше {@link RELATED_COLLECTIONS_MAX}
 * узлов (ТЗ §5.3), а связь `collections` карточки читается ЦЕЛИКОМ — из неё
 * получаются видимые атрибуты-ссылки (повод, адресат), и обрезать их числом
 * значило бы спрятать часть привязок открытки.
 *
 * Порядок ответа — по заголовку. Там, где значим порядок, заданный редактором
 * (связь `collections` карточки: первая подборка — основная), его восстанавливает
 * `orderByIds` из `./relations.ts`: сортировать по списку идентификаторов на
 * стороне БД нечем.
 */
export function collectionsByIdsQuery(
  ids: readonly RecordId[],
  limit?: number,
): PublicFindQuery<'collections'> | null {
  if (ids.length === 0) {
    return null;
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'collections',
    limit: limit === undefined ? ids.length : Math.min(ids.length, limit),
    pagination: false,
    sort: [...COLLECTION_ORDER],
    where: { id: { in: [...ids] } },
  };
}

/** Смежные подборки для блока перелинковки: не больше шести (ТЗ §5.3). */
export function relatedCollectionsQuery(
  ids: readonly RecordId[],
): PublicFindQuery<'collections'> | null {
  return collectionsByIdsQuery(ids, RELATED_COLLECTIONS_MAX);
}

export interface SimilarCardsQueryInput {
  /** Подборки, по которым ищется похожее: связь `collections` самой карточки. */
  readonly collectionIds: readonly RecordId[];
  /** Идентификатор самой карточки: на себя блок «Похожие» не ссылается. */
  readonly excludeCardId: RecordId;
  readonly limit?: number;
}

/**
 * Похожие открытки: карточки из ТЕХ ЖЕ подборок, кроме самой карточки (ТЗ §5.4).
 *
 * «По общим подборкам и атрибутам» из ТЗ здесь означает ровно общие подборки:
 * отдельных полей стиля и настроения у карточки в схеме нет — по решению Ч-04-3
 * это фильтр без собственных URL, а привязка к поводу и адресату выражена именно
 * связью `collections`.
 *
 * Блок обязателен не для украшения: им обеспечивается достижимость карточек за
 * первой страницей списка (решение Ч-04-8), поэтому исключение самой карточки
 * делает запрос, а не шаблон — карточка, отфильтрованная после выборки,
 * уменьшала бы блок на одну позицию непредсказуемо.
 *
 * `null` при пустом наборе подборок: `{ in: [] }` часть адаптеров трактует как
 * отсутствие условия, то есть в блок «похожих» попал бы весь каталог.
 */
export function similarCardsQuery(
  input: SimilarCardsQueryInput,
): PublicFindQuery<'cards'> | null {
  if (input.collectionIds.length === 0) {
    return null;
  }
  return {
    ...PUBLIC_READ_SCOPE,
    collection: 'cards',
    limit: input.limit ?? SIMILAR_CARDS_MAX,
    pagination: false,
    sort: [...CARD_ORDER],
    where: {
      and: [
        { collections: { in: [...input.collectionIds] } },
        { id: { not_equals: input.excludeCardId } },
      ],
    },
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
