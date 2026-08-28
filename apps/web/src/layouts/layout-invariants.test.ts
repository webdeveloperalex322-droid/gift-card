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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SITE_NAV } from '../seo/catalog-pages.js';
import { INFO_PAGE_NAV } from '../seo/info-pages.js';

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
 *
 * Перевод строки распознаётся в обеих формах (`\n` и `\r\n`). Это не
 * придирка: при `core.autocrlf=true` (по умолчанию на Windows) рабочая копия
 * получает CRLF, граница frontmatter не находилась, функция возвращала ВЕСЬ файл
 * — и проверка падала на собственном объяснении правила. То есть результат теста
 * зависел от настроек checkout'а, а не от кода. Найдено на задаче Э4-01 в
 * worktree с CRLF.
 */
function markupOf(source: string): string {
  const fenced = /^---[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source);
  return fenced?.[1] ?? source;
}

/**
 * Рендерит ли шаблон `BaseLayout` — сам или через компонент, который импортирует.
 *
 * Обход по ИМПОРТАМ, а не по списку известных имён компонентов: список пришлось
 * бы дописывать при каждом новом общем компоненте страницы, и проверка падала бы
 * на верном коде. Глубина ограничена: цепочка «маршрут → компонент страницы →
 * layout» — это два шага, а бесконечный обход на циклическом импорте зацикливался
 * бы.
 */
function rendersBaseLayout(file: string, depth = 2, seen = new Set<string>()): boolean {
  if (seen.has(file)) {
    return false;
  }
  seen.add(file);

  const source = readFileSync(file, 'utf8');
  if (/<BaseLayout\b/.test(source)) {
    return true;
  }
  if (depth === 0) {
    return false;
  }

  // Импорты компонентов `.astro` — относительными путями из frontmatter.
  const imports = [...source.matchAll(/^import\s+\w+\s+from\s+'([^']+\.astro)';$/gmu)];
  return imports.some((match) => {
    const relative = match[1];
    if (relative === undefined) {
      return false;
    }
    const target = resolve(dirname(file), relative);
    return existsSync(target) && rendersBaseLayout(target, depth - 1, seen);
  });
}

describe('инварианты всех шаблонов страниц', () => {
  it('шаблоны страниц вообще найдены: пустая выборка проверкой не является', () => {
    expect(PAGE_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(PAGE_TEMPLATES)('%s рендерит BaseLayout, то есть получает навигацию', (file) => {
    // Либо шаблон сам рендерит BaseLayout, либо он делает это через компонент
    // страницы: разметка, общая для нескольких маршрутов, живёт в компоненте
    // (каталог открыток отдают два маршрута; три служебные страницы — три).
    //
    // Делегат ищется ПО ИМПОРТАМ, а не по списку известных имён. Список
    // приходилось бы дописывать при каждом новом общем компоненте, и до этой
    // правки он был именно списком из одного имени — то есть проверка падала на
    // верном коде и учила себя чинить подгонкой.
    expect(rendersBaseLayout(file)).toBe(true);
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

  it('BaseLayout печатает подвал, а подвал ведёт на все три служебные страницы', () => {
    // Служебные страницы (Э3-11) попадают в постоянную навигацию через подвал, а
    // не через верхнее меню. Требование то же — «страница входит в навигацию»
    // (условие п. 5.1), — и держится оно так же: подвал печатает layout, значит он
    // есть на каждой странице, включая 404.
    const layout = readFileSync(join(WEB_SRC, 'layouts', 'BaseLayout.astro'), 'utf8');
    const footer = readFileSync(join(WEB_SRC, 'components', 'SiteFooter.astro'), 'utf8');

    expect(layout).toMatch(/<SiteFooter\b/);
    expect(footer).toMatch(/<a\b[^>]*href=\{link\.path\}/);
    expect(markupOf(footer)).not.toContain('href="#"');
    expect(markupOf(footer)).not.toMatch(/<button\b/);
    expect(INFO_PAGE_NAV.map((link) => link.path)).toEqual([
      '/o-proekte',
      '/usloviya',
      '/kontakty',
    ]);
  });

  it('директиву robots не пишет строкой ни один шаблон и ни один модуль', () => {
    // Задача Э4-01: значение `<meta name="robots">` вычисляет РОВНО один модуль
    // (`src/seo/robots-directive.ts`). Основная защита — типовая: проп `robots`
    // у BaseLayout принимает только `PageRobots`, а собрать такое значение вне
    // разрешателя нельзя. Эта проверка закрывает два обхода типа: приведение к
    // нему через `as` и директиву, вписанную в разметку атрибутом.
    const resolver = resolve(WEB_SRC, 'seo', 'robots-directive.ts');
    const sources = [...filesUnder(WEB_SRC, '.astro'), ...filesUnder(WEB_SRC, '.ts')].filter(
      (file) => resolve(file) !== resolver,
    );

    // Искомая строка собирается из кусков намеренно: иначе ЭТОТ файл содержал бы
    // её сам и проверку пришлось бы исключать из собственной выборки — то есть
    // ослаблять её ради того, чтобы она проходила.
    const cast = `as ${'Page'}${'Robots'}`;

    expect(sources.length).toBeGreaterThan(20);
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');

      // Единственное место приведения к номинальному типу — сам разрешатель.
      expect(source, file).not.toContain(cast);
      // Директива, вписанная в шаблон атрибутом строкой, а не выражением.
      expect(markupOf(source), file).not.toMatch(/robots\s*=\s*["'](?:no)?index/u);
    }
  });

  it('страница 404 ПРЕРЕНДЕРЕНА — иначе у сайта две разные страницы 404', () => {
    // Условие «страница 404 у сайта одна» (задача Э3-11): пререндер кладёт
    // `dist/client/404.html`, и этот файл читают ОБА пути — наш статический слой
    // (`src/server/front-door.ts`) и приложение Astro (адаптер `@astrojs/node`
    // подставляет `prerenderedErrorPageFetch`, читающий `404.html` из корня
    // клиента). С `prerender = false` файла в сборке нет, и тело 404 начинает
    // приходить из двух мест.
    //
    // Проверка текстовая и в этом её смысл: `prerender = false` — одна строка,
    // которую легко дописать «чтобы взять данные из БД», а следствие видно только
    // сравнением двух ответов на живом сервере.
    const notFound = readFileSync(join(WEB_SRC, 'pages', '404.astro'), 'utf8');

    expect(notFound).not.toMatch(/export\s+const\s+prerender\s*=\s*false/u);
    // И ни одного обращения к слою данных: пререндер выполняется на сборке, где
    // базы может не быть вовсе.
    expect(notFound).not.toMatch(/from\s+'\.\.\/data'/u);
    // Canonical у страницы 404 не бывает: она отвечает по любому адресу.
    expect(notFound).toMatch(/canonicalPath=\{null\}/u);
  });
});
