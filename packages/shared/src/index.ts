/**
 * Общие типы и утилиты монорепозитория.
 *
 * Владелец пакета: агент `shared` не выделен — правки вносит тот реализатор,
 * которому утилита нужна, но контракт (экспорты и типы) правит только после
 * согласования, потому что от него зависят и web, и cms.
 *
 * Состав (задача Э1-01 закрыта полностью):
 *   - `./slug.ts` — транслитерация заголовка в slug и валидатор slug.
 *     Единственный источник правил slug: `apps/cms`, `apps/web` и
 *     `packages/images` зовут его, а не повторяют таблицу транслитерации;
 *   - `./routes.ts` — единое правило завершающего слеша (решение Ч-21: БЕЗ
 *     слеша), предикат `isPageRoute()` и приведение пути к канонической форме;
 *     там же распознавание абсолютного адреса, отданного вместо пути:
 *     `looksLikeAbsoluteUrl()` (схема ИЛИ протокольно-относительная форма) и
 *     `isProtocolRelativeUrl()`. Локальных копий этой проверки в `apps/*` быть
 *     не должно: правило одно, и второй потребитель про локальную копию не
 *     узнаёт;
 *   - `./site-url.ts` — ЕДИНСТВЕННЫЙ хелпер сборки абсолютного URL из
 *     env-параметра `SITE_URL`. Хост не хардкодится: пустое значение валит
 *     сборку, значений по умолчанию в коде нет;
 *   - `./reserved-routes.ts` — реестр зарезервированных маршрутов (контейнеры и
 *     занятые целиком), запрет сегмента `page` на любой позиции; путь админки
 *     вычисляется из `PAYLOAD_ADMIN_PATH`, а не записан строкой;
 *   - `./env.ts` — тип среза окружения; окружение всегда аргумент с дефолтом,
 *     чтобы тесты не мутировали `process.env`.
 *
 * Реализовано через TDD: тесты в `tests/unit/` (`slug`, `routes`, `site-url`,
 * `reserved-routes`), затем код.
 */

export { currentEnv, type SharedEnv } from './env.js';

export {
  assertPathNotReserved,
  checkReservedPath,
  isReservedPath,
  PAGINATION_SEGMENT,
  parseAdminPath,
  PAYLOAD_ADMIN_PATH_ENV_KEY,
  type PathAvailability,
  type ReservedRoute,
  type ReservedRouteKind,
  type ReservedRouteSource,
  reservedRoutes,
  type ReservedRule,
} from './reserved-routes.js';

export {
  canonicalizePath,
  isPageRoute,
  isProtocolRelativeUrl,
  looksLikeAbsoluteUrl,
  pathSegments,
  TRAILING_SLASH,
} from './routes.js';

export { buildAbsoluteUrl, resolveSiteOrigin, SITE_URL_ENV_KEY } from './site-url.js';

export {
  DEFAULT_SLUG_MAX_LENGTH,
  findYearInSlug,
  hasYearInSlug,
  isValidSlug,
  SLUG_PATTERN,
  slugify,
  type SlugOptions,
  YEAR_IN_SLUG_MAX,
  YEAR_IN_SLUG_MIN,
} from './slug.js';

/** Статусная модель контента. Переход в `published` делает только человек. */
export const CONTENT_STATUSES = ['draft', 'review', 'published'] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Статусы, в которых страница обязана отдавать `noindex` и быть вне sitemap. */
export const NON_INDEXABLE_STATUSES: readonly ContentStatus[] = ['draft', 'review'];

export function isIndexableStatus(status: ContentStatus): boolean {
  return !NON_INDEXABLE_STATUSES.includes(status);
}
