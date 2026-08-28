/**
 * Набор значений robots-директивы — ЕДИНСТВЕННЫЙ источник на монорепозиторий
 * (задача Э4-05, ТЗ §8.1: `robots | select`).
 *
 * ## Почему набор живёт здесь, а не в слое
 *
 * Он нужен обоим слоям, и по разным поводам. `apps/cms` строит из него опции
 * поля `robots` и проверяет вход REST/GraphQL (`collections/seo-fields.ts`,
 * `collections/status-model.ts`, `access/policies.ts`). `apps/web` проверяет им
 * объявленную директиву страницы и отбирает страницы в sitemap
 * (`seo/robots-directive.ts`). До Э4-05 набор лежал двумя копиями — не по
 * небрежности: импортировать `.ts` чужого приложения в composite-проект
 * `apps/web` нельзя, а собранного пакета у `apps/cms` нет.
 *
 * Цена копии видна не сразу и платится в самом дорогом месте: два закрытых
 * набора расходятся молча. Значение, добавленное в CMS и неизвестное вебу, даёт
 * либо исключение на рендере, либо — что хуже — страницу, закрытую в разметке и
 * открытую в карте сайта, то есть ровно запрет п. 23 «НЕ добавлять в sitemap
 * неканонические/закрытые страницы».
 *
 * ## Что сюда НЕ переехало
 *
 * Правило «какая директива у ЭТОЙ страницы» — то есть понижение до
 * `noindex,follow` из-за пагинации, фильтра, пустого описания или статуса
 * записи — осталось в `apps/web/src/seo/robots-directive.ts`. Это правило
 * рендера, у него один потребитель, и второй его источник в проекте уже
 * приходилось убирать. Здесь только набор значений и предикаты САМОГО значения.
 *
 * Расширять набор нельзя без решения человека: `robots` управляет попаданием
 * страницы в индекс, а не оформлением.
 */

/** Допустимые значения поля `robots`. Порядок — от самого «открытого» к закрытому. */
export const ROBOTS_DIRECTIVES = ['index,follow', 'noindex,follow', 'noindex,nofollow'] as const;

export type RobotsDirective = (typeof ROBOTS_DIRECTIVES)[number];

/**
 * Значение по умолчанию для НОВОЙ записи.
 *
 * `noindex,follow`, а не `index,follow`: требование CLAUDE.md и ТЗ §8.2 — новая
 * запись создаётся только в `draft` и только с `noindex`. Дефолт здесь является
 * частью защиты: значение по умолчанию `index,follow` открыло бы в индекс любую
 * запись, созданную через API без явного `robots`.
 */
export const DEFAULT_ROBOTS: RobotsDirective = 'noindex,follow';

export function isRobotsDirective(value: unknown): value is RobotsDirective {
  return typeof value === 'string' && (ROBOTS_DIRECTIVES as readonly string[]).includes(value);
}

/**
 * Разрешает ли директива индексацию.
 *
 * Проверяется именно равенство `index,follow`, а не отсутствие слова `noindex`:
 * набор значений закрытый, и «всё, что не noindex» при добавлении нового
 * значения молча пустило бы страницу в индекс.
 */
export function isIndexableRobots(value: unknown): boolean {
  return value === 'index,follow';
}
