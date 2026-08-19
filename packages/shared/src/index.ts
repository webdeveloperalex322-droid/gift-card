/**
 * Общие типы и утилиты монорепозитория.
 *
 * Владелец пакета: агент `shared` не выделен — правки вносит тот реализатор,
 * которому утилита нужна, но контракт (экспорты и типы) правит только после
 * согласования, потому что от него зависят и web, и cms.
 *
 * Запланировано ТЗ и CLAUDE.md, пока не реализовано:
 *   - транслитерация заголовка в slug (правила URL: нижний регистр, дефисы,
 *     без кириллицы/пробелов/подчёркиваний/параметров);
 *   - валидация canonical URL (абсолютный, завершающий слеш, один путь на материал);
 *   - общие типы статусной модели draft -> review -> published.
 *
 * Реализовывать через TDD: тест в `tests/unit/`, затем код.
 */

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
