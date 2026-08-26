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
  childCollectionsQuery,
  collectionByIdQuery,
  collectionByPathQuery,
  collectionCardsQuery,
  collectionsByIdsQuery,
  type PublicFindQuery,
  recentCardsQuery,
  type RecordId,
  relatedCollectionsQuery,
  seasonalCollectionsQuery,
  similarCardsQuery,
  type SimilarCardsQueryInput,
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

/** Дочерние узлы подборки. Неопубликованные не приходят — ссылок на них не будет. */
export async function listChildCollections(
  parentId: RecordId | null,
): Promise<readonly Collection[]> {
  const { docs } = await findMany(childCollectionsQuery(parentId));
  return (docs as Collection[]).map((node) => assertPublicallyReadable(node, 'дочернюю подборку'));
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

/** Смежные подборки для обязательного блока перелинковки (решение Ч-04-8). */
export async function listRelatedCollections(
  ids: readonly RecordId[],
): Promise<readonly Collection[]> {
  const { docs } = await findMany(relatedCollectionsQuery(ids));
  return (docs as Collection[]).map((node) => assertPublicallyReadable(node, 'смежную подборку'));
}

/**
 * Подборки карточки в порядке, заданном редактором (первая — основная).
 *
 * Из них шаблон карточки делает видимые атрибуты-ссылки (повод, адресат —
 * ТЗ §5.4). Неопубликованные узлы не приходят, поэтому ссылки на страницу без
 * 200 не появляется; порядок восстанавливает `orderByIds` — обоснование в
 * `./relations.ts`.
 */
export async function listCollectionsByIds(
  ids: readonly RecordId[],
): Promise<readonly Collection[]> {
  const { docs } = await findMany(collectionsByIdsQuery(ids));
  const nodes = (docs as Collection[]).map((node) =>
    assertPublicallyReadable(node, 'подборку карточки'),
  );
  return orderByIds(nodes, ids);
}

/**
 * Похожие открытки для блока на карточке (ТЗ §5.4, решение Ч-04-8).
 *
 * Пустой набор подборок даёт пустой список, а не выборку каталога: правило
 * живёт в `similarCardsQuery`.
 */
export async function listSimilarCards(
  input: SimilarCardsQueryInput,
): Promise<readonly Card[]> {
  const { docs } = await findMany(similarCardsQuery(input));
  return (docs as Card[]).map((card) => assertPublicallyReadable(card, 'похожую карточку'));
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
export async function listSeasonalCollections(today: Date): Promise<readonly Collection[]> {
  const { docs } = await findMany(seasonalCollectionsQuery(today));
  return (docs as Collection[]).map((node) => assertPublicallyReadable(node, 'сезонную подборку'));
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
