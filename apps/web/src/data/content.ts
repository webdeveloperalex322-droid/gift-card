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
 * ## Чего он НЕ умеет и почему (важно для Э3-05…Э3-09)
 *
 * Метаданных изображения (`card-images`: `variants[]` с ключами, ширинами и
 * высотами) здесь нет и получить их этим слоем нельзя. Причина не в лени: у
 * коллекции `card-images` доступ на чтение — `authenticatedAccess` (см.
 * `apps/cms/src/collections/card-images.ts`), поэтому анонимному запросу она не
 * отдаётся ни напрямую, ни населением связи (`depth > 0` в этом случае
 * подставляет идентификатор — проверено по
 * `payload/dist/fields/hooks/afterRead/relationshipPopulationPromise.js`).
 * Обойти это можно было бы только включением `overrideAccess`, что задачей
 * Э3-02 прямо запрещено, или чтением под пользователем — а обе роли проекта
 * видят черновики.
 *
 * Следствие: `<img>` с `srcset` из сохранённых `variants[]` (условие C8) пока
 * собрать нечем. Это блокирующий вопрос к владельцу `apps/cms`, он вынесен в
 * отчёт задачи; в карточке уже есть ЗЕРКАЛО части полей файла
 * (`derivative.keyBase`, `nameStem`, `nameSuffix`, `revision`), но ширин и высот
 * производных в нём нет, а выводить их из настроек пайплайна запрещено тем же
 * условием C8.
 */

import type { Card, Collection, SiteSetting } from '@otkritka/cms/types';
import { SITE_SETTINGS_SLUG } from '@otkritka/shared';
import { buildCardPath } from '@otkritka/cms/seo/paths';

import { payloadClient } from './payload-client.js';
import {
  cardBySlugQuery,
  childCollectionsQuery,
  collectionByPathQuery,
  collectionCardsQuery,
  parentCollectionQuery,
  type PublicFindQuery,
  recentCardsQuery,
  type RecordId,
  relatedCollectionsQuery,
  seasonalCollectionsQuery,
} from './queries.js';
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
 * Идентификатор связи из значения, которое отдаёт Payload.
 *
 * При `depth: 0` это число или строка; форма «объект с id» тоже разбирается —
 * тогда вызывающий не обязан знать, каким запросом получена запись.
 */
export function relationId(value: unknown): RecordId | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const { id } = value;
    if (typeof id === 'number' || typeof id === 'string') {
      return id;
    }
  }
  return null;
}

/** Идентификаторы связи «многие ко многим» в порядке, заданном редактором. */
export function relationIds(value: unknown): readonly RecordId[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: RecordId[] = [];
  for (const item of value) {
    const id = relationId(item);
    if (id !== null) {
      ids.push(id);
    }
  }
  return ids;
}

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
 * Родительский узел подборки — для хлебных крошек и ссылки «вверх».
 *
 * `null` означает и «узел верхнего уровня», и «родитель не опубликован». Разница
 * для публичной страницы отсутствует: ссылки нет в обоих случаях. Для человека
 * это разные ситуации, и вторая — сигнал о состоянии контента (опубликованный
 * узел под неопубликованным родителем), но решать её публикацией родителя может
 * только он.
 */
export async function findParentCollection(
  parentId: RecordId | null,
): Promise<Collection | null> {
  const { docs } = await findMany(parentCollectionQuery(parentId));
  const node = docs.at(0) as Collection | undefined;
  return node === undefined ? null : assertPublicallyReadable(node, 'родительскую подборку');
}

/** Смежные подборки для обязательного блока перелинковки (решение Ч-04-8). */
export async function listRelatedCollections(
  ids: readonly RecordId[],
): Promise<readonly Collection[]> {
  const { docs } = await findMany(relatedCollectionsQuery(ids));
  return (docs as Collection[]).map((node) => assertPublicallyReadable(node, 'смежную подборку'));
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
