/**
 * Чтение опубликованного контента для шаблонов (задача Э3-02).
 *
 * Здесь только выполнение запросов из `./queries.ts` и приведение результата.
 * Правил в этом файле нет — ни фильтров, ни путей, ни условий индексации; их
 * место названо в шапке `./queries.ts`. Типы — СГЕНЕРИРОВАННЫЕ (`Card`,
 * `Collection`, `SiteSetting` из `@otkritka/cms/types`), вручную не описаны:
 * ручная копия расходится со схемой при первом же новом поле, а расхождение в
 * типах SEO-полей означает страницу без title или без canonical.
 *
 * ## Что этот слой умеет
 *
 * Ровно то, что нужно шаблонам Э3-05…Э3-09, и ничего «на будущее»: карточка по
 * slug, подборка по итоговому пути, страница карточек подборки, дети, родитель и
 * смежные узлы, свежие карточки, сезонные подборки, настройки сайта.
 *
 * ## Откуда берутся метаданные изображения (важно для Э3-05…Э3-09)
 *
 * Из САМОЙ КАРТОЧКИ — из зеркала `derivative.variants[]`: ключ, формат и
 * фактические ширина и высота каждого файла. Связь `card.image` для этого не
 * годится и населять её незачем: у коллекции `card-images` доступ на чтение —
 * `authenticatedAccess` (см. `apps/cms/src/collections/card-images.ts`), поэтому
 * анонимному запросу она не отдаётся ни напрямую, ни населением связи (`depth >
 * 0` в этом случае подставляет идентификатор — проверено по
 * `payload/dist/fields/hooks/afterRead/relationshipPopulationPromise.js`). Обойти
 * это можно было бы только включением `overrideAccess`, что задачей Э3-02 прямо
 * запрещено, или чтением под пользователем — а обе роли проекта видят черновики.
 *
 * Ровно поэтому CMS переносит нужные разметке поля в карточку хуком (коммит
 * зеркала, `apps/cms/src/images/image-mirror.ts`): публичный рендер читает
 * карточку правами анонима и на `depth: 0`, и этого ему достаточно. Читает
 * зеркало ОДИН модуль — `./card-image.ts` (задача Э3-04); он же и мост типов.
 * Шаблонам разбирать `variants[]` самостоятельно нельзя: `srcset`, `width` и
 * ширина в имени файла обязаны собираться из одного значения (условие C8).
 *
 * Служебные поля той же группы — `keyBase`, `nameStem`, `nameSuffix`,
 * `revision` — для сборки адресов НЕ используются вовсе: они обеспечивают
 * постоянство пути внутри пайплайна, а авторитетен для разметки `variant.key`.
 */

import type { Card, Collection, SiteSetting } from '@otkritka/cms/types';
import { SITE_SETTINGS_SLUG } from '@otkritka/shared';
import { buildCardPath } from '@otkritka/cms/seo/paths';

import { payloadClient } from './payload-client.js';
import {
  cardBySlugQuery,
  catalogCardsQuery,
  childCollectionsQuery,
  collectionByIdQuery,
  collectionByPathQuery,
  collectionCardsCountQuery,
  collectionCardsQuery,
  collectionsByIdsQuery,
  type PublicCountQuery,
  type PublicFindQuery,
  recentCardsQuery,
  type RecordId,
  relatedCollectionsQuery,
  rootCollectionsQuery,
  searchCardsQuery,
  searchCollectionsQuery,
  seasonalCollectionsQuery,
  similarCardsQueries,
  type SimilarCardsQueryInput,
  similarCardsWindow,
} from './queries.js';
import { orderByIds } from './relations.js';
import { assertPublicallyReadable, PUBLIC_READ_SCOPE } from './read-scope.js';

/** Страница списка: документы плюс всё, что нужно ссылкам пагинации. */
export interface CardsPage {
  readonly cards: readonly Card[];
  /** Номер текущей страницы, начиная с 1. */
  readonly page: number;
  readonly pageCount: number;
  readonly totalCards: number;
}

/**
 * Разбор значений связей переехал в `./relations.ts` (задача Э3-03): он чистый,
 * а этот модуль на загрузке тянет конфиг Payload. Реэкспорт сохранён, чтобы
 * прежние импорты из слоя данных не менялись.
 */
export { relationId, relationIds } from './relations.js';

/**
 * Канонический путь карточки. Собирается ЕДИНСТВЕННОЙ функцией проекта
 * (`buildCardPath` из `@otkritka/cms/seo/paths`) — второй сборки пути в шаблонах
 * быть не должно, иначе canonical и sitemap разойдутся в форме.
 */
export function cardPath(card: Pick<Card, 'slug'>): string {
  return buildCardPath(card.slug);
}

async function findMany<TSlug extends 'cards' | 'collections'>(
  query: PublicFindQuery<TSlug> | null,
): Promise<{ docs: unknown[]; totalDocs: number; totalPages: number }> {
  if (query === null) {
    return { docs: [], totalDocs: 0, totalPages: 0 };
  }
  const payload = await payloadClient();
  const result = await payload.find(query);
  return { docs: result.docs, totalDocs: result.totalDocs, totalPages: result.totalPages };
}

async function countMany<TSlug extends 'cards' | 'collections'>(
  query: PublicCountQuery<TSlug>,
): Promise<number> {
  const payload = await payloadClient();
  const { totalDocs } = await payload.count(query);
  return totalDocs;
}

/* ------------------------------------------------------------------ */
/* Предикат «опубликован И непуст» (условие Э3-13-A)                  */
/* ------------------------------------------------------------------ */

/**
 * ПОЧЕМУ СПИСКИ УЗЛОВ ОТБИРАЮТ ПО СОДЕРЖАНИЮ, А НЕ ПО СТАТУСУ.
 *
 * «Опубликовано» не равно «отвечает 200». CMS отказывает в публикации пустого
 * узла (`assertNotEmptyForPublish`), но граница ОДНОСТОРОННЯЯ — она сторожит
 * переход вперёд: снятие с публикации последней открытки, её отвязка, её
 * удаление, а у группы снятие последнего дочернего узла оставляют узел
 * опубликованным и ПУСТЫМ. Это принятый риск Э3-13-A
 * (`docs/otkrytye-voprosy.md`), и закрывать его отказами в CMS решено не было:
 * ТЗ §8.2 оставляет снятие с публикации правом администратора и требует не
 * отказа, а решения о судьбе URL.
 *
 * Цена риска лежит здесь: страница пустого узла законно отдаёт 404 (пустая
 * посадочная не отдаёт 200), а родительская подборка продолжала его показывать —
 * то есть возвращалась битая внутренняя ссылка, ради которой вводилось вето V5.
 * Условие снятия риска, записанное в реестре: списки узлов обязаны отбирать их
 * предикатом «опубликован И непуст», ТЕМ ЖЕ, которым решает шаблон. Тогда пустой
 * опубликованный узел становится записью, на которую нигде нет ссылки, и ссылки
 * на 404 не существует ни при каком состоянии данных.
 *
 * ## Определение и почему оно рекурсивное
 *
 * Шаблон отдаёт 200, если у узла есть хотя бы одна опубликованная открытка ЛИБО
 * хотя бы один показанный дочерний узел (`collectionPageContent`). Дочерние узлы
 * приходят из этой же выборки, поэтому определение замыкается само на себя:
 *
 *   непуст(N) = есть опубликованная открытка у N, ИЛИ есть опубликованный
 *               ребёнок C, для которого непуст(C).
 *
 * Одноуровневая проверка («есть открытка ИЛИ есть опубликованный ребёнок»)
 * закрыла бы дефект только на листьях и сдвинула бы его на уровень выше: узел
 * без открыток с единственным ПУСТЫМ ребёнком сам отдаёт 404, а в списке
 * родителя остался бы. Поэтому предикат рекурсивный — и ровно поэтому он
 * совпадает с решением шаблона, а не приближает его.
 *
 * ## Чего он стоит, и почему это названо, а не скрыто
 *
 * Дешёвого запроса «непуст» у Payload нет: связь m:n живёт в карточке, и
 * существование открытки у КАЖДОГО узла набора одним запросом не получить —
 * выборка карточек с пределом дала бы ложное «пусто» у тех узлов, чьи карточки в
 * предел не попали, то есть скрывала бы живые страницы. Поэтому цена — один
 * `count` на узел, у которого своих открыток нет и который приходится раскрывать
 * вглубь. Порядок величины: у узла с открытками — 1 `count`; у группирующего узла
 * без своих открыток — 1 `count` плюс по одному на каждого ребёнка. Глубина
 * таксономии ограничена тремя уровнями (решение Ч-04-5), поэтому рекурсия
 * заканчивается быстро, но ШИРИНА не ограничена ничем: группа с тридцатью
 * праздниками стоит тридцать `count` при каждом рендере страницы, где она
 * упомянута, — включая страницу карточки, где группа стоит атрибутом «Раздел».
 *
 * Правильное лекарство — денормализованный признак наполненности в записи
 * подборки, поддерживаемый хуками CMS (владелец предложил взять серверную часть).
 * До него запросы мемоизируются в пределах одного рендера {@link NodeContentMemo},
 * и это единственная оптимизация здесь: кеш между запросами означал бы, что
 * ссылка живёт дольше содержания.
 */
export interface NodeContentMemo {
  readonly resolved: Map<string, Promise<boolean>>;
}

/** Свежий мемоизатор предиката. Один на рендер страницы, не на процесс. */
export function newNodeContentMemo(): NodeContentMemo {
  return { resolved: new Map() };
}

/**
 * Предел глубины раскрытия — защита от цикла в связях `parent`.
 *
 * Цикл в данных CMS не создаётся (путь узла собирается из цепочки родителей и
 * зациклиться не может), но рекурсия по данным без предела — это способ уронить
 * рендер на состоянии базы, а не на коде. Значение с запасом к трём уровням
 * таксономии.
 */
const MAX_CONTENT_DEPTH = 8;

async function hasContent(
  id: RecordId,
  memo: NodeContentMemo,
  depth: number,
): Promise<boolean> {
  const key = String(id);
  const known = memo.resolved.get(key);
  if (known !== undefined) {
    return known;
  }
  const computing = computeHasContent(id, memo, depth);
  // Обещание кладётся в мемо ДО его разрешения: параллельные ветви обхода
  // (`Promise.all` ниже) обязаны ждать один и тот же счёт, а не запускать свой.
  memo.resolved.set(key, computing);
  return computing;
}

async function computeHasContent(
  id: RecordId,
  memo: NodeContentMemo,
  depth: number,
): Promise<boolean> {
  if ((await countMany(collectionCardsCountQuery(id))) > 0) {
    return true;
  }
  if (depth >= MAX_CONTENT_DEPTH) {
    return false;
  }
  const { docs } = await findMany(childCollectionsQuery(id));
  const children = docs as Collection[];
  if (children.length === 0) {
    return false;
  }
  const flags = await Promise.all(
    children.map((child) => hasContent(child.id, memo, depth + 1)),
  );
  return flags.includes(true);
}

/**
 * Оставляет из набора те узлы, страница которых отвечает 200.
 *
 * Порядок сохраняется: его задаёт запрос, и менять его отбор не вправе.
 *
 * @param memo мемоизатор на один рендер. Не передан — создаётся свой; передавать
 *   стоит там, где на одной странице отбираются пересекающиеся наборы (каталог
 *   `/podborki` и главная считают и корни, и их детей).
 */
export async function nodesWithContent(
  nodes: readonly Collection[],
  memo: NodeContentMemo = newNodeContentMemo(),
): Promise<readonly Collection[]> {
  if (nodes.length === 0) {
    return nodes;
  }
  const flags = await Promise.all(nodes.map((node) => hasContent(node.id, memo, 0)));
  return nodes.filter((_node, index) => flags[index] === true);
}

/** Опубликованная карточка по slug. `null` — записи нет либо она не опубликована. */
export async function findCardBySlug(slug: string): Promise<Card | null> {
  const { docs } = await findMany(cardBySlugQuery(slug));
  const card = docs.at(0) as Card | undefined;
  return card === undefined ? null : assertPublicallyReadable(card, 'карточку');
}

/**
 * Опубликованная подборка по ИТОГОВОМУ пути.
 *
 * Путь берётся из адреса страницы и сравнивается с сохранённым полем `path`.
 * Пересчёта пути из цепочки родителей здесь нет и быть не может: авторитетное
 * значение живёт в записи (уникальный индекс БД), и второй способ его вычислить
 * означал бы, что страница и sitemap могут разойтись в адресе.
 */
export async function findCollectionByPath(path: string): Promise<Collection | null> {
  const { docs } = await findMany(collectionByPathQuery(path));
  const node = docs.at(0) as Collection | undefined;
  return node === undefined ? null : assertPublicallyReadable(node, 'подборку');
}

/** Страница карточек подборки. Первая страница — по базовому URL (решение Ч-05). */
export async function listCollectionCards(input: {
  readonly collectionId: RecordId;
  readonly page: number;
  readonly perPage?: number;
}): Promise<CardsPage> {
  const query = collectionCardsQuery(
    input.perPage === undefined
      ? { collectionId: input.collectionId, page: input.page }
      : { collectionId: input.collectionId, page: input.page, perPage: input.perPage },
  );
  const { docs, totalDocs, totalPages } = await findMany(query);
  return {
    cards: (docs as Card[]).map((card) => assertPublicallyReadable(card, 'карточку списка')),
    page: input.page,
    pageCount: totalPages,
    totalCards: totalDocs,
  };
}

/**
 * Страница карточек КАТАЛОГА `/otkrytki` (задача Э3-08).
 *
 * Та же форма результата, что у списка подборки, и это не совпадение: страницы
 * пагинации у обоих списков считаются одним правилом (`../routing/pagination.ts`),
 * а два разных типа результата означали бы два расчёта числа страниц.
 */
export async function listCatalogCards(input: {
  readonly page: number;
  readonly perPage?: number;
}): Promise<CardsPage> {
  const query = catalogCardsQuery(
    input.perPage === undefined ? { page: input.page } : { page: input.page, perPage: input.perPage },
  );
  const { docs, totalDocs, totalPages } = await findMany(query);
  return {
    cards: (docs as Card[]).map((card) => assertPublicallyReadable(card, 'карточку каталога')),
    page: input.page,
    pageCount: totalPages,
    totalCards: totalDocs,
  };
}

/**
 * Узлы верхнего уровня таксономии — содержание каталога `/podborki` (Э3-08).
 *
 * Неопубликованные не приходят, поэтому ссылок на черновик каталог не выводит. А
 * с условия Э3-13-A не приходят и опубликованные ПУСТЫЕ узлы: отбор идёт
 * предикатом {@link nodesWithContent}, то есть тем же условием, по которому
 * шаблон решает отдать 200. Обоснование — в шапке предиката.
 *
 * Пустой результат означает, что каталогу нечего показывать, и маршрут отвечает
 * 404: пустая страница не отдаёт 200 как посадочная (ТЗ §5.3).
 */
export async function listRootCollections(
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(rootCollectionsQuery());
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'узел каталога'),
  );
  return nodesWithContent(nodes, memo);
}

/**
 * Дочерние узлы подборки. Неопубликованные не приходят — ссылок на них не будет.
 *
 * Пустые опубликованные узлы тоже не приходят (условие Э3-13-A, предикат
 * {@link nodesWithContent}). Для этой функции отбор значим дважды: из её
 * результата собирается и видимый блок «Разделы подборки», и решение шаблона
 * «страница пуста → 404». Поэтому отбор здесь делает определение шаблона
 * рекурсивным ровно в том смысле, в каком оно записано у предиката, — и ссылка
 * на узел печатается тогда и только тогда, когда его адрес отвечает 200.
 */
export async function listChildCollections(
  parentId: RecordId | null,
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(childCollectionsQuery(parentId));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'дочернюю подборку'),
  );
  return nodesWithContent(nodes, memo);
}

/**
 * Опубликованная подборка по идентификатору — родитель узла в крошках и
 * ссылке «вверх», а также ОСНОВНАЯ подборка карточки (ТЗ §5.4).
 *
 * `null` означает сразу три вещи: идентификатора не передали (узел верхнего
 * уровня, карточка без подборок), записи нет, запись не опубликована. Разница
 * для публичной страницы отсутствует: ссылки нет во всех случаях. Для человека
 * это разные ситуации, и «опубликованный узел под неопубликованным родителем» —
 * сигнал о состоянии контента, но решать его публикацией родителя может только
 * он.
 */
export async function findCollectionById(id: RecordId | null): Promise<Collection | null> {
  const { docs } = await findMany(collectionByIdQuery(id));
  const node = docs.at(0) as Collection | undefined;
  return node === undefined ? null : assertPublicallyReadable(node, 'подборку по идентификатору');
}

/**
 * Смежные подборки для обязательного блока перелинковки (решение Ч-04-8).
 *
 * Пустые опубликованные узлы отсеиваются (условие Э3-13-A): связь `related`
 * заполняет редактор, и узел, опустевший после снятия открыток, остался бы в ней
 * ссылкой на 404 — притом в блоке, на который решение Ч-04-8 возлагает
 * достижимость.
 */
export async function listRelatedCollections(
  ids: readonly RecordId[],
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(relatedCollectionsQuery(ids));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'смежную подборку'),
  );
  return nodesWithContent(nodes, memo);
}

/**
 * Подборки карточки в порядке, заданном редактором (первая — основная).
 *
 * Из них шаблон карточки делает видимые атрибуты-ссылки (повод, адресат —
 * ТЗ §5.4). Неопубликованные узлы не приходят, поэтому ссылки на черновик не
 * появляется (про «опубликовано ≠ 200» — оговорка у {@link listRootCollections});
 * порядок восстанавливает `orderByIds` — обоснование в `./relations.ts`.
 */
export async function listCollectionsByIds(
  ids: readonly RecordId[],
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(collectionsByIdsQuery(ids));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'подборку карточки'),
  );
  // Отбор по содержанию (условие Э3-13-A) стоит ДО восстановления порядка:
  // порядок задаёт редактор, и выпадение узла его не перетасовывает.
  return orderByIds(await nodesWithContent(nodes, memo), ids);
}

/**
 * Похожие открытки для блока на карточке (ТЗ §5.4, решение Ч-04-8).
 *
 * ДВА запроса, а не один: блок — окно соседей карточки в общем порядке, и его
 * половины читаются с разных сторон. Обоснование окна и распределения предела
 * между половинами — в шапках `similarCardsQueries` и `similarCardsWindow`;
 * здесь только выполнение и склейка.
 *
 * Пустой набор подборок даёт пустой список, а не выборку каталога: правило живёт
 * в `similarCardsQueries`.
 */
export async function listSimilarCards(
  input: SimilarCardsQueryInput,
): Promise<readonly Card[]> {
  const queries = similarCardsQueries(input);
  const [newer, older] = await Promise.all([findMany(queries.newer), findMany(queries.older)]);
  const readable = (docs: readonly unknown[]): readonly Card[] =>
    (docs as Card[]).map((card) => assertPublicallyReadable(card, 'похожую карточку'));

  return similarCardsWindow({
    newer: readable(newer.docs),
    older: readable(older.docs),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

/**
 * Внутренний поиск по открыткам (ТЗ §5.5).
 *
 * Возвращает не больше `limit` записей: страницы результатов у поиска нет — её
 * отсутствие обосновано в `../seo/search-page.ts`.
 */
export async function searchCards(query: string, limit: number): Promise<readonly Card[]> {
  const { docs } = await findMany(searchCardsQuery({ limit, query }));
  return (docs as Card[]).map((card) => assertPublicallyReadable(card, 'найденную карточку'));
}

/** Внутренний поиск по подборкам — поиск «по атрибутам» из ТЗ §5.5. */
export async function searchCollections(
  query: string,
  limit: number,
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(searchCollectionsQuery({ limit, query }));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'найденную подборку'),
  );
  // Выдача поиска сама неиндексируема, но ссылка на 404 — это ссылка на 404 и в
  // ней: отбор по содержанию (условие Э3-13-A) один на все списки узлов.
  return nodesWithContent(nodes, memo);
}

/** Свежие опубликованные карточки. */
export async function listRecentCards(limit: number): Promise<readonly Card[]> {
  const { docs } = await findMany(recentCardsQuery(limit));
  return (docs as Card[]).map((card) => assertPublicallyReadable(card, 'свежую карточку'));
}

/**
 * Подборки, попадающие в сезонный блок на указанный день.
 *
 * День — аргумент, а не `new Date()` внутри: страница главной кешируется и
 * рендерится в разное время, а тест обязан задавать день сам.
 */
export async function listSeasonalCollections(
  today: Date,
  memo?: NodeContentMemo,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(seasonalCollectionsQuery(today));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'сезонную подборку'),
  );
  // Сезонный блок главной — самое видное место сайта, и ссылка на 404 в нём
  // дороже всего: отбор по содержанию тот же (условие Э3-13-A).
  return nodesWithContent(nodes, memo);
}

/**
 * Глобал «Настройки сайта» (Э3-00).
 *
 * Читается той же областью, что контент: у глобала доступ на чтение открыт всем,
 * но группа аудита закрыта на уровне ПОЛЯ — и закрыта она только при
 * работающем access control. Прочитать настройки с включённым `overrideAccess`
 * значило бы получить служебные поля вместе с содержательными.
 *
 * Пустые поля здесь НЕ заполняются значениями по умолчанию: пустое поле —
 * команда шаблону промолчать (решения Ч-10, Ч-17, Ч-19), а предикаты «выводить
 * или промолчать» живут в `@otkritka/shared` (`site-settings-rules.ts`).
 */
export async function readSiteSettings(): Promise<SiteSetting> {
  const payload = await payloadClient();
  return payload.findGlobal({
    slug: SITE_SETTINGS_SLUG,
    depth: PUBLIC_READ_SCOPE.depth,
    overrideAccess: PUBLIC_READ_SCOPE.overrideAccess,
  });
}
