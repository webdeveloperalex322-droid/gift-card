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
 *   - `./content.ts` — выполнение запросов и типы результата.
 *
 * Где этот слой работает: только внутри сборки Astro (Vite). Входной сервер
 * (`../server/*`) компилируется в настоящий Node ESM и импортировать конфиг
 * Payload — файл `.ts` из другого пакета — не может; там его и не нужно.
 */

export {
  cardPath,
  type CardsPage,
  findCardBySlug,
  findCollectionByPath,
  findParentCollection,
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
