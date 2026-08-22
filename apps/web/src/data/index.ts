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

/** Крошки страницы подборки. Шаблоны Э3-06 и Э3-08 зовут эту функцию. */
export function collectionBreadcrumbTrail(node: CollectionCrumbNode): Promise<BreadcrumbTrail> {
  return collectionBreadcrumbs(node, READ_COLLECTION);
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
  listCollectionCards,
  listChildCollections,
  listRecentCards,
  listRelatedCollections,
  listSeasonalCollections,
  readSiteSettings,
  relationId,
  relationIds,
} from './content.js';

export {
  assertPageNumber,
  assertPublicallyReadable,
  DEFAULT_CARDS_PER_PAGE,
  PUBLIC_READ_SCOPE,
} from './read-scope.js';

export { MAX_LIST_ROWS, type RecordId } from './queries.js';

export { payloadClient } from './payload-client.js';
