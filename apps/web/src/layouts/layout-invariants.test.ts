/**
 * Инварианты, которые обязаны держаться на КАЖДОЙ странице (задача Э3-08).
 *
 * Проверка текстовая — по исходникам `src/pages/**` и `src/layouts/**`, — и это
 * не подмена настоящей проверки, а другая проверка. Живой ответ сервера
 * проверяет смоук (`apps/web/scripts/smoke-pages.ts`) и приёмка Playwright, но и
 * то и другое видит только те страницы, которые кто-то догадался внести в
 * выборку. Текстовый тест видит ВСЕ шаблоны, включая только что добавленный, и
 * падает в тот же прогон `pnpm test` — то есть до того, как страница без
 * навигации попадёт на стенд.
 *
 * Тот же приём и по той же причине уже применён к области чтения публичного
 * рендера (`../data/data-access.test.ts`: `overrideAccess` не включён ни в одном
 * вызове по всему `apps/web`).
 *
 * Что здесь закреплено:
 *
 *   - **навигация есть на каждой странице.** Требование «страница входит в
 *     навигацию» — условие п. 5.1 ТЗ, а меню печатает `BaseLayout`. Значит,
 *     каждый шаблон страницы обязан рендерить именно этот layout: шаблон со
 *     своей разметкой `<html>` выпал бы из навигации молча;
 *   - **меню ведёт на оба каталога** — `/otkrytki` и `/podborki` (задача Э3-08);
 *   - **клиентского JS в шаблонах нет.** Ни одной директивы `client:*`: острова
 *     добавляются точечно и осознанно, а не появляются в шаблоне списка.
 *
 * Файл лежит рядом с исходниками, а не в `tests/unit/`: он читает дерево
 * `apps/web/src`, то есть проверяет само приложение, и переезд каталога должен
 * ломать его вместе с приложением, а не тихо оставлять пустую выборку.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SITE_NAV } from '../seo/catalog-pages.js';

const WEB_SRC = fileURLToPath(new URL('../', import.meta.url));

function filesUnder(directory: string, extension: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(extension)) {
        found.push(full);
      }
    }
  };
  walk(directory);
  return found;
}

const PAGE_TEMPLATES = filesUnder(join(WEB_SRC, 'pages'), '.astro');

/**
 * Разметка компонента `.astro` без frontmatter: всё после закрывающего `---`.
 *
 * Нужна там, где проверяется ОТСУТСТВИЕ конструкции. Комментарий во frontmatter
 * законно перечисляет запрещённое (`href="#"`, `client:*`), и поиск по всему
 * файлу падал бы на объяснении правила, а не на его нарушении.
 */
function markupOf(source: string): string {
  const fenced = /^---[\s\S]*?\n---\n([\s\S]*)$/.exec(source);
  return fenced?.[1] ?? source;
}

describe('инварианты всех шаблонов страниц', () => {
  it('шаблоны страниц вообще найдены: пустая выборка проверкой не является', () => {
    expect(PAGE_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(PAGE_TEMPLATES)('%s рендерит BaseLayout, то есть получает навигацию', (file) => {
    const source = readFileSync(file, 'utf8');

    // Либо шаблон сам рендерит BaseLayout, либо он делает это через компонент
    // страницы (каталог открыток отдают два маршрута, и разметка у них общая).
    const rendersLayout = /<BaseLayout\b/.test(source);
    const delegates = /<CardCatalogPage\b/.test(source);

    expect(rendersLayout || delegates).toBe(true);
  });

  it.each(PAGE_TEMPLATES)('%s не подключает клиентский JS директивой client:*', (file) => {
    expect(markupOf(readFileSync(file, 'utf8'))).not.toMatch(/\bclient:[a-z]+/);
  });

  it('BaseLayout печатает меню, а меню ведёт на оба каталога', () => {
    const layout = readFileSync(join(WEB_SRC, 'layouts', 'BaseLayout.astro'), 'utf8');
    const nav = readFileSync(join(WEB_SRC, 'components', 'SiteNav.astro'), 'utf8');
    const paths = SITE_NAV.map((link) => link.path);

    expect(layout).toMatch(/<SiteNav\b/);
    // Меню печатает только `<a href>`: ни кнопок в роли ссылок, ни hash-маршрутов.
    // Проверяется РАЗМЕТКА, а не весь файл: во frontmatter лежит комментарий,
    // который эти запреты как раз перечисляет — искать их по всему тексту
    // означало бы падать на объяснении правила.
    expect(nav).toMatch(/<a\b[^>]*href=\{link\.path\}/);
    expect(markupOf(nav)).not.toContain('href="#"');
    expect(markupOf(nav)).not.toMatch(/<button\b/);
    expect(paths).toContain('/otkrytki');
    expect(paths).toContain('/podborki');
  });
});
