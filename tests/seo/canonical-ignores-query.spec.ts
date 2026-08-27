/**
 * Требование (ТЗ §6.5 и §5.5, вето V6): любой URL с параметрами отдаёт canonical
 * на ЧИСТЫЙ путь страницы. Набор параметров нового адреса не создаёт.
 *
 * Это главная проверка вокруг фильтров и меток кампаний. Механизм дубля, который
 * она ловит: страница печатает self-canonical из запрошенного адреса
 * (`Astro.url`), и тогда `?utm_source=vk`, `?format=vertical` и `?style=akvarel`
 * становятся тремя каноническими адресами одного содержимого — три страницы с
 * одинаковым текстом, конкурирующие между собой в выдаче. Реализация закрывает
 * это по построению (canonical собирается из ПУТИ, строка запроса приходит
 * отдельно — `apps/web/src/routing/canonical.ts`, `view-params.ts`), но
 * «по построению» проверяется на живом ответе: достаточно однажды передать в
 * layout `Astro.url.pathname + Astro.url.search`, и свойство исчезнет.
 *
 * Что проверяется на каждом адресе выборки для каждого набора параметров
 * (`QUERY_VARIANTS` в `support/pages.ts`):
 *
 *   - в ответе РОВНО ОДИН `<link rel="canonical">`. Два canonical — это не «оба
 *     сработают», а неопределённость, которую поисковая система разрешает сама;
 *   - его значение совпадает символ в символ с canonical ЧИСТОГО адреса. Не
 *     «оканчивается на путь» и не «содержит путь»: сравнение абсолютных адресов
 *     целиком — единственная форма, при которой проверка ловит и подменённый
 *     хост, и приклеенную строку запроса;
 *   - в canonical нет ни `?`, ни `&`. Утверждение избыточно к предыдущему и
 *     оставлено намеренно: оно называет нарушение своими словами в сообщении об
 *     ошибке.
 *
 * Чего здесь НЕТ и почему: карточки, подборки и каталогов. Их страницы
 * существуют только у опубликованной записи, а инвентарь приёмки не имеет права
 * зависеть от содержимого базы (разбор — в шапке `support/pages.ts`). На этих
 * шаблонах то же свойство проверено смоуком против собранного сервера
 * (`apps/web/scripts/smoke-pages.ts`); в приёмку они входят на Э3-13 одной
 * записью в инвентаре, и этот spec начнёт их проверять без правок.
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, expectedCanonicalPath, QUERY_VARIANTS } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`canonical не зависит от параметров: ${page.path} (${page.task})`, async ({ request }) => {
    const expected = `${target.origin}${expectedCanonicalPath(page)}`;

    const clean = await fetchRaw(request, urlFor(target, page.path));
    expect(clean.status, 'Чистый адрес страницы обязан отдавать 200.').toBe(200);
    expect(
      canonicalHrefs(clean.body),
      'У страницы обязан быть ровно один абсолютный self-canonical.',
    ).toEqual([expected]);

    for (const variant of QUERY_VARIANTS) {
      const response = await fetchRaw(request, urlFor(target, `${page.path}${variant.query}`));

      expect(
        response.status,
        `Адрес ${page.path}${variant.query} (${variant.note}) обязан отдавать ту же страницу ` +
          '200: параметр меняет представление, а не адрес.',
      ).toBe(200);

      const hrefs = canonicalHrefs(response.body);
      expect(
        hrefs,
        `На ${page.path}${variant.query} (${variant.note}) canonical обязан указывать на ЧИСТЫЙ ` +
          'адрес страницы и быть единственным. Значение с параметром означает, что каждый ' +
          'набор параметров объявил себя отдельной страницей — то есть дубль с одинаковым ' +
          'содержимым.',
      ).toEqual([expected]);

      const href = hrefs[0] ?? '';
      expect(
        href.includes('?') || href.includes('&'),
        `В canonical «${href}» попала строка запроса.`,
      ).toBe(false);
    }
  });
}
