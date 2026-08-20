/**
 * Общие типы и утилиты монорепозитория.
 *
 * Владелец пакета: агент `shared` не выделен — правки вносит тот реализатор,
 * которому утилита нужна, но контракт (экспорты и типы) правит только после
 * согласования, потому что от него зависят и web, и cms.
 *
 * Реализовано (задача Э1-01a):
 *   - транслитерация заголовка в slug и валидатор slug — `./slug.ts`. Это
 *     единственный источник правил slug: `apps/cms`, `apps/web` и
 *     `packages/images` зовут его, а не повторяют таблицу транслитерации.
 *
 * Запланировано ТЗ и CLAUDE.md, пока не реализовано (остаток задачи Э1-01):
 *   - сборка абсолютного canonical из env `SITE_URL` (пустое значение обязано
 *     валить сборку; значений по умолчанию в коде нет);
 *   - реестр зарезервированных маршрутов (контейнеры и занятые целиком) и
 *     запрет сегмента `page` на любой позиции;
 *   - предикат `isPageRoute()` для правила завершающего слеша.
 *
 * Реализовывать через TDD: тест в `tests/unit/`, затем код.
 */

export {
  DEFAULT_SLUG_MAX_LENGTH,
  isValidSlug,
  SLUG_PATTERN,
  slugify,
  type SlugOptions,
} from './slug.js';

/** Единое правило завершающего слеша по всему сайту (выбрано: со слешем). */
export const TRAILING_SLASH = true;

/** Статусная модель контента. Переход в `published` делает только человек. */
export const CONTENT_STATUSES = ['draft', 'review', 'published'] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Статусы, в которых страница обязана отдавать `noindex` и быть вне sitemap. */
export const NON_INDEXABLE_STATUSES: readonly ContentStatus[] = ['draft', 'review'];

export function isIndexableStatus(status: ContentStatus): boolean {
  return !NON_INDEXABLE_STATUSES.includes(status);
}
