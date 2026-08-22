/**
 * Robots-директивы записи (ТЗ §8.1: `robots | select`).
 *
 * Отдельный модуль, а не константа внутри коллекции, по двум причинам:
 *   - тот же набор нужен коллекции `collections` (Э1-05) и генерации sitemap
 *     (этап 4): второй список значений неизбежно разошёлся бы с первым;
 *   - от него зависят и правила доступа (`access/policies.ts`), и определения
 *     полей (`collections/seo-fields.ts`). Если бы константы жили в любом из
 *     этих двух файлов, между ними появился бы цикл импортов.
 *
 * Значения — дословно из ТЗ §8.1. Расширять набор нельзя без решения человека:
 * `robots` управляет попаданием страницы в индекс, а не оформлением.
 */

/** Допустимые значения поля `robots`. Порядок — от самого «открытого» к закрытому. */
export const ROBOTS_DIRECTIVES = ['index,follow', 'noindex,follow', 'noindex,nofollow'] as const;

export type RobotsDirective = (typeof ROBOTS_DIRECTIVES)[number];

/**
 * Значение по умолчанию для НОВОЙ записи.
 *
 * `noindex,follow`, а не `index,follow`: требование CLAUDE.md и ТЗ §8.2 —
 * новая запись создаётся только в `draft` и только с `noindex`. Дефолт здесь
 * является частью защиты: значение по умолчанию `index,follow` открыло бы в
 * индекс любую запись, созданную через API без явного `robots`.
 */
export const DEFAULT_ROBOTS: RobotsDirective = 'noindex,follow';

export function isRobotsDirective(value: unknown): value is RobotsDirective {
  return typeof value === 'string' && (ROBOTS_DIRECTIVES as readonly string[]).includes(value);
}

/**
 * Разрешает ли директива индексацию.
 *
 * Проверяется именно `index,follow`, а не отсутствие слова `noindex`: набор
 * значений закрытый, и «всё, что не noindex» при добавлении нового значения
 * молча пустило бы страницу в индекс.
 */
export function isIndexableRobots(value: unknown): boolean {
  return value === 'index,follow';
}
