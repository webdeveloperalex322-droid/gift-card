/**
 * Требование («Правила URL»): «Один материал доступен только по одному пути».
 * Второй адрес, отдающий 200 с тем же содержанием, — дубль, даже если canonical
 * указывает на первый.
 *
 * Здесь проверяется конкретный класс дублей — `.html`-двойник маршрута страницы:
 * `/index.html` для корня и `<путь>.html` / `<путь>/index.html` для остальных
 * страниц.
 *
 * ## Почему это не гипотетическая проверка
 *
 * `apps/web/astro.config.mjs` задаёт `build.format: 'file'` (парный к
 * `trailingSlash: 'never'`). В astro 7.2.4 при этом значении маршрутизатор перед
 * сопоставлением СРЕЗАЕТ `.html` и `/index.html` с пути запроса
 * (`normalizeFileFormatPathname`, вызывается под условием
 * `if (this.#buildFormat === "file")` — см. собранный
 * `apps/web/dist/server/entry.mjs`). То есть двойник получает КАЖДЫЙ маршрут
 * страницы, а не только корень, и отвечает 200 тем же HTML.
 *
 * Наше правило пути такой адрес не перехватывает: `isPageRoute()` видит
 * расширение и относит `/index.html` к URL файлов, а файловые URL из
 * нормализации исключены решением Ч-21. Дыра ровно на стыке двух верных по
 * отдельности решений.
 *
 * Ожидаемое поведение — любое из двух, оба закрывают дубль:
 *   - одиночный 301 на канонический адрес (предпочтительно: Яндекс склеивает
 *     301 надёжнее, чем canonical, и прямо рекомендует его для дублей);
 *   - 404 — двойник адресом страницы не является.
 *
 * Исправляет владелец слоя (`astro-web`, файлы `apps/web/src/routing/` и
 * `apps/web/astro.config.mjs`); аудитор код приложений не правит.
 */

import { expect, test } from '@playwright/test';

import { describeChain, followRedirects, hopCount } from './support/http.js';
import { ACCEPTANCE_PAGES, expectedCanonicalPath } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Адреса-двойники, которые фреймворк отдаёт вместо страницы при build.format: 'file'. */
function twinsFor(path: string): string[] {
  return path === '/' ? ['/index.html'] : [`${path}.html`, `${path}/index.html`];
}

for (const page of ACCEPTANCE_PAGES) {
  for (const twin of twinsFor(page.path)) {
    test(`нет .html-двойника страницы ${page.path}: ${twin} (${page.task})`, async ({
      request,
    }) => {
      const chain = await followRedirects(request, urlFor(target, twin));
      const first = chain[0];
      const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

      expect(
        first?.status,
        `«${twin}» отдаёт 200 с тем же содержанием, что «${page.path}» — это второй адрес ` +
          'одного материала, то есть дубль. Требование «Один материал доступен только по одному ' +
          `пути» нарушено.${context}`,
      ).not.toBe(200);

      if (first !== undefined && first.status >= 300 && first.status < 400) {
        expect(first.status, 'Склейка дубля — это 301, а не временный редирект.').toBe(301);
        expect(
          first.resolvedLocation,
          'Двойник обязан вести на канонический адрес страницы.',
        ).toBe(urlFor(target, expectedCanonicalPath(page)));
        expect(hopCount(chain), `Переход обязан быть один.${context}`).toBe(1);
      }
    });
  }
}
