/**
 * Слой доступа к данным apps/web (задача Э3-02) — единственная дверь шаблонов к
 * содержимому CMS.
 *
 * Читать Payload напрямую из `.astro` запрещено не стилистически: право
 * публичного рендера — права АНОНИМА, и они задаются параметрами каждого
 * запроса (`PUBLIC_READ_SCOPE`). Шаблон, собравший запрос сам, однажды соберёт
 * его без этих параметров, и разница будет видна не в сборке, а в индексе.
 *
 * Состав:
 *   - `./payload-client.ts` — подключение (Local API, один экземпляр на процесс)
 *     и обоснование выбора против HTTP-доступа под API-ключом;
 *   - `./read-scope.ts` — область чтения, постусловие по статусу, номер страницы;
 *   - `./queries.ts` — чистые запросы (что именно спрашивается у Payload);
 *   - `./relations.ts` — разбор значений связей (чистый, конфиг CMS не тянет);
 *   - `./content.ts` — выполнение запросов и типы результата;
 *   - `./breadcrumbs.ts` — цепочка крошек из записей (задача Э3-03);
 *   - `./card-image.ts` — модель разметки изображения из зеркала производных
 *     (задача Э3-04). Шаблоны её обычно не зовут: за них это делает компонент
 *     `../components/CardImage.astro`. Прямой вызов нужен разметке JSON-LD
 *     `ImageObject` (задача Э3-05), где тот же файл называется абсолютным
 *     адресом.
 *
 * Где этот слой работает: только внутри сборки Astro (Vite). Входной сервер
 * (`../server/*`) компилируется в настоящий Node ESM и импортировать конфиг
 * Payload — файл `.ts` из другого пакета — не может; там его и не нужно.
 */

import type { Card } from '@otkritka/cms/types';

import type { BreadcrumbTrail } from '../seo/breadcrumbs.js';
import {
  cardBreadcrumbs,
  type CardCrumbSource,
  type CollectionCrumbNode,
  type CollectionReader,
  collectionBreadcrumbs,
} from './breadcrumbs.js';
import { findCollectionById } from './content.js';

/**
 * Живое чтение подборок для крошек — права анонима, как и весь публичный рендер.
 *
 * Привязка живёт здесь, а не значением по умолчанию внутри `./breadcrumbs.ts`:
 * тот модуль должен грузиться без конфига Payload, иначе его юнит-тест поднимал
 * бы CMS ради проверки чистых адаптеров. Барьер слоя — правильное место для
 * подстановки настоящей зависимости.
 */
const READ_COLLECTION: CollectionReader = findCollectionById;

/**
 * Крошки страницы подборки. Шаблон Э3-06 зовёт эту функцию.
 *
 * `page` — номер страницы списка (Э3-07). На страницах 2+ цепочка получает
 * последнее звено «Страница N», а сама подборка становится ссылкой на БАЗОВЫЙ
 * URL списка.
 */
export function collectionBreadcrumbTrail(
  node: CollectionCrumbNode,
  page = 1,
): Promise<BreadcrumbTrail> {
  return collectionBreadcrumbs(node, READ_COLLECTION, page);
}

/** Крошки страницы карточки: цепочка её основной подборки (ТЗ §5.4). Шаблон Э3-05. */
export function cardBreadcrumbTrail(
  card: CardCrumbSource & Pick<Card, 'collections'>,
): Promise<BreadcrumbTrail> {
  return cardBreadcrumbs(card, READ_COLLECTION);
}

export {
  type CardImageSource,
  cardImageAlt,
  cardImageVariants,
  type CardPictureInput,
  cardPictureModel,
} from './card-image.js';

export {
  cardPath,
  type CardsPage,
  findCardBySlug,
  findCollectionById,
  findCollectionByPath,
  listCatalogCards,
  listCollectionCards,
  listCollectionsByIds,
  listChildCollections,
  listRecentCards,
  listRelatedCollections,
  listRootCollections,
  listSeasonalCollections,
  listSimilarCards,
  newNodeContentMemo,
  type NodeContentMemo,
  nodesWithContent,
  readSiteSettings,
  searchCards,
  searchCollections,
  relationId,
  relationIds,
} from './content.js';

/**
 * Содержимое страниц карточки и подборки (Э3-05, Э3-06). Шаблон зовёт ОДНУ
 * функцию на страницу и рендерит то, что она вернула: так у видимого блока и у
 * разметки JSON-LD один источник значения — обоснование в шапке `./page-data.ts`.
 */
/**
 * Сборка страниц каталогов `/otkrytki` и `/podborki` (Э3-07, Э3-08). Маршрут
 * зовёт одну функцию и превращает её решение в ответ: 200, одиночный 301 или 404.
 */
export {
  type CardCatalogBody,
  cardCatalogPage,
  type CatalogPageResult,
  type CollectionCatalogBody,
  collectionCatalogPage,
} from './catalog.js';

/**
 * Служебные информационные страницы (Э3-11). Маршрут зовёт одну функцию: исхода
 * «страницы нет» у неё нет — незаполненная страница отвечает 200 с заглушкой и
 * `noindex` (обоснование в шапке `../seo/info-pages.ts`).
 */
export { infoPage, infoPageFacts } from './info-pages.js';

/**
 * Внутренний поиск (Э3-10). Страница отвечает 200 всегда и всегда `noindex`:
 * обоснование в шапке `./search.ts`.
 */
export { searchPage, type SearchPageContent } from './search.js';

/**
 * Главная (Э3-09). Исхода «страницы нет» у неё тоже нет: она существует всегда,
 * а блоки, для которых нет данных, не печатаются вовсе — обоснование в шапке
 * `./home.ts`.
 */
export {
  HOME_RECENT_CARDS,
  HOME_SECTION_CHILDREN,
  homePage,
  type HomePageContent,
  type HomePageView,
} from './home.js';

export {
  type CardAttributeLink,
  cardAttributeLinks,
  type CardPageContent,
  cardPageContent,
  type CardTile,
  cardTiles,
  type CatalogSection,
  catalogSectionItems,
  catalogSections,
  collectionLinks,
  type CollectionPageContent,
  collectionPageContent,
  seasonalLinks,
} from './page-data.js';

export {
  assertPageNumber,
  assertPublicallyReadable,
  DEFAULT_CARDS_PER_PAGE,
  PUBLIC_READ_SCOPE,
} from './read-scope.js';

export {
  MAX_LIST_ROWS,
  type RecordId,
  RELATED_COLLECTIONS_MAX,
  SIMILAR_CARDS_MAX,
  SIMILAR_CARDS_TARGET_MIN,
} from './queries.js';

export { payloadClient } from './payload-client.js';
