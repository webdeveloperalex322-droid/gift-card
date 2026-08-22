/**
 * Требование (п. 22 + «Правила URL»): на странице ровно один
 * `<link rel="canonical">`, он АБСОЛЮТНЫЙ, указывает на саму страницу и на
 * канонический адрес — без завершающего слеша (решение Ч-21), без параметров.
 *
 * Сравнивается абсолютный адрес ЦЕЛИКОМ (схема, хост, порт, путь), а не
 * «оканчивается на путь». Ослабление до сравнения хвоста пропустило бы главную
 * ошибку этого класса — canonical, собранный на другом хосте, — а её цена
 * измеряется в потерянном трафике после индексации.
 *
 * Отдельный случай в конце файла: страница, запрошенная с параметрами, обязана
 * отдавать canonical на ЧИСТЫЙ адрес. Иначе каждый рекламный `utm_source`
 * становится самостоятельной посадочной, то есть дублем.
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, expectedCanonicalPath } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Абсолютный канонический адрес страницы: у корня — `<origin>/`. */
function expectedCanonicalUrl(path: string): string {
  return urlFor(target, path);
}

for (const page of ACCEPTANCE_PAGES) {
  test(`абсолютный self-canonical: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const hrefs = canonicalHrefs(response.body);
    expect(
      hrefs,
      `<link rel="canonical"> обязан быть ровно один. Найдено ${String(hrefs.length)}: ` +
        `${JSON.stringify(hrefs)}.`,
    ).toHaveLength(1);

    const href = hrefs[0] ?? '';
    expect(
      /^https?:\/\//i.test(href),
      `canonical «${href}» обязан быть абсолютным (схема + хост). Относительный canonical ` +
        'разрешается браузером, но лишает нас единственного источника хоста — SITE_URL.',
    ).toBe(true);

    expect(
      href,
      `canonical обязан указывать на канонический адрес самой страницы. Ожидался ` +
        `«${expectedCanonicalUrl(expectedCanonicalPath(page))}», получен «${href}».`,
    ).toBe(expectedCanonicalUrl(expectedCanonicalPath(page)));

    const canonical = new URL(href);
    expect(canonical.search, 'В canonical не должно быть параметров.').toBe('');
    expect(canonical.hash, 'В canonical не должно быть фрагмента.').toBe('');
    if (canonical.pathname !== '/') {
      expect(
        canonical.pathname.endsWith('/'),
        `canonical «${href}» заканчивается слешем. Канонический вид маршрута — без ` +
          'завершающего слеша (решение Ч-21), иначе canonical указывает на адрес, который ' +
          'сам отдаёт 301.',
      ).toBe(false);
    }
  });
}

for (const page of ACCEPTANCE_PAGES) {
  test(`параметры не попадают в canonical: ${page.path}?utm_source=... (${page.task})`, async ({
    request,
  }) => {
    const withQuery = `${page.path === '/' ? '/' : page.path}?utm_source=test&sort=new`;
    const response = await fetchRaw(request, urlFor(target, withQuery));

    expect(response.status, 'Адрес с параметрами обязан отдавать ту же страницу, 200.').toBe(200);

    const hrefs = canonicalHrefs(response.body);
    expect(hrefs, 'canonical обязан быть ровно один и на адресе с параметрами.').toHaveLength(1);
    expect(
      hrefs[0],
      'canonical обязан указывать на чистый адрес: иначе каждый рекламный параметр создаёт ' +
        'дубль страницы.',
    ).toBe(expectedCanonicalUrl(expectedCanonicalPath(page)));
  });
}
