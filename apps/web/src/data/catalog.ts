/**
 * Сборка страниц каталогов `/otkrytki` и `/podborki` (задачи Э3-07, Э3-08).
 *
 * Здесь живёт РЕШЕНИЕ, а маршруты его только исполняют: три исхода — «показать
 * страницу», «одиночный 301 на базовый URL» и «404». Модуль существует ровно
 * потому, что каталог открыток отдают ДВА маршрута — `/otkrytki` и
 * `/otkrytki/page/N`, — а решение у них одно. Разложить это решение по двум
 * шаблонам значило бы, что первая страница и страницы 2+ однажды разойдутся в
 * canonical, в директиве робота или в составе разметки; расхождение обнаружилось
 * бы уже после индексации.
 *
 * Правил в этом файле нет: тексты каталогов и их крошки — `../seo/catalog-pages.ts`,
 * адреса и границы страниц — `../routing/pagination.ts`, чтение записей —
 * `./content.ts`, разметка — `../seo/collection-page.ts`. Все четыре покрыты
 * юнит-тестами; здесь только порядок вызовов, и его проверяет смоук на собранном
 * сервере (`apps/web/scripts/smoke-pages.ts`).
 *
 * ## Почему пустой каталог отвечает 404, а не 200 с пустой сеткой
 *
 * Пустая страница не отдаёт 200 как полноценная посадочная (ТЗ §5.3) — тот же
 * довод, по которому 404 отвечает подборка без открыток и без детей. У каталога
 * это состояние означает, что публично на сайте нет ни одной открытки (или ни
 * одной подборки), то есть сайт ещё не наполнен. Отдавать по такому адресу 200 с
 * заголовком и пустым списком — это ровно тот soft 404, которым списки и попадают
 * в индекс мусором.
 *
 * Следствие, которое надо знать: пока каталог пуст, пункт меню ведёт на 404. Это
 * видимый признак ненаполненного сайта, а не дефект меню; альтернатива —
 * страница-обманка с 200 — запрещена правилом выше.
 *
 * ## Порядок шагов при разборе `/page/N` значим
 *
 *   1. форма номера (`../routing/pagination.ts`): `0`, `01`, `-1`, `dva` — 404
 *      сразу, без запроса к базе. Такие адреса не существуют, и знать про них
 *      данные не нужно;
 *   2. запрос страницы. Он же даёт общее число страниц;
 *   3. `/page/1` — 301 на базовый URL, но ТОЛЬКО если базовый URL отвечает 200.
 *      Иначе получился бы 301 на 404: формально не цепочка, но переход в никуда;
 *   4. номер больше числа страниц — 404.
 */

import type { SharedEnv } from '@otkritka/shared';

import {
  type PaginationModel,
  paginationModel,
  type PageParamDecision,
  decidePageParam,
} from '../routing/pagination.js';
import type { BreadcrumbTrail } from '../seo/breadcrumbs.js';
import {
  CATALOGS,
  catalogBreadcrumbTrail,
  type CatalogPageView,
  catalogPageView,
} from '../seo/catalog-pages.js';
import { type CollectionPageJsonLd, collectionPageJsonLd } from '../seo/collection-page.js';
import { listCatalogCards, listChildCollections, listRootCollections } from './content.js';
import {
  type CardTile,
  cardTiles,
  type CatalogSection,
  catalogSectionItems,
  catalogSections,
} from './page-data.js';

/** Что маршрут каталога обязан ответить. */
export type CatalogPageResult<TBody> =
  | { readonly kind: 'not-found' }
  /** Одиночный 301. `location` — БАЗОВЫЙ URL списка, а не другая форма `/page/…`. */
  | { readonly kind: 'redirect'; readonly location: string }
  | ({ readonly kind: 'page' } & TBody);

/** Общая часть головы документа и крошек у обоих каталогов. */
interface CatalogPageHead {
  readonly view: CatalogPageView;
  readonly trail: BreadcrumbTrail;
  readonly jsonLd: CollectionPageJsonLd;
}

export interface CardCatalogBody extends CatalogPageHead {
  /** Номер показанной страницы, начиная с 1. Первая живёт по базовому URL. */
  readonly page: number;
  /** Плитки ЭТОЙ страницы. Из этого же массива собран `ItemList`. */
  readonly tiles: readonly CardTile[];
  readonly pagination: PaginationModel | null;
}

export interface CollectionCatalogBody extends CatalogPageHead {
  /** Разделы верхнего уровня со своими детьми. Из них же собран `ItemList`. */
  readonly sections: readonly CatalogSection[];
}

/**
 * Страница каталога открыток `/otkrytki` — первая или страница пагинации.
 *
 * @param pageParam значение сегмента `/page/<...>` из адреса; `null` — обращение
 *   по базовому URL каталога.
 */
export async function cardCatalogPage(
  pageParam: string | null,
  env?: SharedEnv,
): Promise<CatalogPageResult<CardCatalogBody>> {
  const decision: PageParamDecision =
    pageParam === null ? { action: 'page', page: 1 } : decidePageParam(pageParam);
  if (decision.action === 'not-found') {
    return { kind: 'not-found' };
  }

  // `/page/1` обслуживается запросом ПЕРВОЙ страницы: нужно узнать, отвечает ли
  // базовый URL 200, — иначе 301 повёл бы на 404.
  const requested = decision.action === 'redirect-to-base' ? 1 : decision.page;
  const cardsPage = await listCatalogCards({ page: requested });
  // Пустая страница — 404 по ЧИСЛУ ВЫДАННЫХ СТРОК, а не только по числу страниц.
  // Замерено на живом сервере: у пустой коллекции Payload отдаёт `totalPages: 1`
  // при `totalDocs: 0`, поэтому проверка одного `pageCount` пропускала пустой
  // каталог дальше, и страница падала 500 на сборке `ItemList` (он справедливо
  // отказывается описывать список без элементов). 500 вместо 404 — это ещё и
  // неверный сигнал поисковику: «зайдите позже» вместо «здесь ничего нет».
  if (
    cardsPage.pageCount === 0 ||
    requested > cardsPage.pageCount ||
    cardsPage.cards.length === 0
  ) {
    return { kind: 'not-found' };
  }

  if (decision.action === 'redirect-to-base') {
    return { kind: 'redirect', location: CATALOGS.cards.path };
  }

  const tiles = cardTiles(cardsPage.cards);
  const view = catalogPageView('cards', requested);
  return {
    jsonLd: collectionPageJsonLd(
      {
        canonicalPath: view.canonicalPath,
        description: view.metaDescription,
        heading: view.heading,
        items: tiles,
      },
      env,
    ),
    kind: 'page',
    page: requested,
    pagination: paginationModel({
      basePath: CATALOGS.cards.path,
      page: requested,
      pageCount: cardsPage.pageCount,
    }),
    tiles,
    trail: catalogBreadcrumbTrail('cards', requested),
    view,
  };
}

/**
 * Страница каталога подборок `/podborki`.
 *
 * Пагинации у неё нет намеренно: содержание — узлы ВЕРХНЕГО уровня и их прямые
 * дети, а их единицы. Поэтому `/podborki/page/N` не существует ни в каком виде и
 * отвечает 404 маршрутом ветви (`pages/podborki/[...path].astro`): записи с таким
 * путём нет, а редирект на базовый URL означал бы, что пагинация у каталога когда-
 * то была.
 */
export async function collectionCatalogPage(
  env?: SharedEnv,
): Promise<CatalogPageResult<CollectionCatalogBody>> {
  const roots = await listRootCollections();
  const sections = catalogSections(
    await Promise.all(
      roots.map(async (node) => ({ children: await listChildCollections(node.id), node })),
    ),
  );
  const items = catalogSectionItems(sections);
  if (items.length === 0) {
    return { kind: 'not-found' };
  }

  const view = catalogPageView('collections', 1);
  return {
    jsonLd: collectionPageJsonLd(
      {
        canonicalPath: view.canonicalPath,
        description: view.metaDescription,
        heading: view.heading,
        items,
      },
      env,
    ),
    kind: 'page',
    sections,
    trail: catalogBreadcrumbTrail('collections', 1),
    view,
  };
}
