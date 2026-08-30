/**
 * Требование («HTTP-статусы» + «Правила URL»): переход — это ЗАГОЛОВОК, а не
 * страница. Наш ответ 3xx состоит из кода и `Location`; тела у него нет.
 *
 * ## Почему это отдельное требование, а не придирка к байтам
 *
 * Тело у 3xx опасно ровно тем, что его читают. Замер контролёра `url-guard` от
 * 2026-08-28 на живом сервере: `/staraya.html/?utm_source=mail` отдавал 301, а в
 * теле ехала страница Astro, где
 *
 *   - `<meta http-equiv="refresh">` указывал НАЗАД на источник перехода. Для
 *     клиента, который предпочитает meta заголовку, это бесконечный цикл: 301
 *     ведёт вперёд, meta — обратно;
 *   - `<meta name="robots">` был чужой — директива страницы, которой этот адрес
 *     не является;
 *   - `<link rel="canonical">` был относительный, то есть указывал на адрес,
 *     который сам же отдаёт переход.
 *
 * Статус при этом был верным (301), `Location` — верным, и ни одна проверка,
 * смотрящая на код и заголовок, дефекта не видела. Видно его только в теле.
 *
 * ## Что здесь проверяется
 *
 * Две группы, потому что у них разная сила утверждения:
 *
 *   1. адреса, которые ОБЯЗАНЫ отвечать 301 (нормализация по Ч-21 и схлопывание
 *      повторных слешей). Здесь инвариант проверяется на живом переходе, то есть
 *      не может пройти вхолостую;
 *   2. класс `<…>.html` со слешем — тот, на котором дефект и был замерен.
 *      Сегодня он отвечает 404, и требование «404 без Location» держит
 *      `page-has-no-html-twin.spec.ts`; повторять его тут нечего. Утверждение
 *      этой группы — про ФОРМУ ответа, если он всё-таки окажется переходом:
 *      вернувшийся дефект даёт здесь 3xx с телом и падает.
 *
 * Проверяется каждый ответ ЦЕПОЧКИ, а не только первый: тело может появиться на
 * втором шаге ровно так же, как на первом.
 *
 * Исправляет владелец слоя (`astro-web`: `apps/web/src/routing/`,
 * `apps/web/src/server/`); аудитор код приложений не правит.
 */

import { expect, test } from '@playwright/test';

import type { RawResponse } from './support/http.js';
import { describeChain, followRedirects, isRedirect } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Мета-обновление в теле: именно оно и создавало цикл на ответе 3xx. */
const META_REFRESH = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i;

/**
 * Утверждения о ФОРМЕ перехода. Вынесены в функцию, потому что применяются к
 * каждому ответу цепочки в обеих группах, а не к одному ответу одной проверки.
 */
function expectBareRedirect(response: RawResponse, context: string): void {
  expect(
    response.body,
    `У перехода (${String(response.status)} на «${response.requestedUrl}») есть тело — ` +
      `${String(response.body.length)} байт. Ответ 3xx состоит из кода и Location: тело у него ` +
      'читают, и именно через тело 2026-08-28 приезжали meta-refresh назад на источник, чужая ' +
      `директива робота и относительный canonical.${context}`,
  ).toBe('');

  expect(
    META_REFRESH.test(response.body),
    `В теле перехода есть <meta http-equiv="refresh">. Клиент, предпочитающий meta заголовку, ` +
      `получает цикл: заголовок ведёт вперёд, meta — назад на источник.${context}`,
  ).toBe(false);

  expect(
    response.location,
    `Переход без Location никуда не ведёт: клиент получает 3xx и остаётся ни с чем.${context}`,
  ).not.toBeNull();

  expect(
    (response.location ?? '').startsWith('//'),
    `Location начинается с «//»: браузер и краулер читают такой адрес как ЧУЖОЙ хост — это ` +
      `открытый редирект.${context}`,
  ).toBe(false);

  if (response.resolvedLocation !== null) {
    expect(
      new URL(response.resolvedLocation).origin,
      `Переход обязан оставаться на нашем хосте.${context}`,
    ).toBe(target.origin);
  }
}

/**
 * Группа 1: адреса, у которых переход — штатное поведение (решение Ч-21).
 *
 * Взяты маршруты, существующие при ЛЮБОМ состоянии базы, — иначе проверка
 * зависела бы от содержимого чужой базы, а не от кода.
 */
const MUST_REDIRECT: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/o-proekte/', note: 'маршрут страницы со слешем — штатный 301 по Ч-21' },
  { path: '/search/', note: 'то же на маршруте внутреннего поиска' },
  { path: '/o-proekte/?utm_source=mail', note: 'query переносится в Location, тело остаётся пустым' },
  { path: '//', note: 'схлопывание повторных слешей: Location не должен начинаться с «//»' },
];

for (const entry of MUST_REDIRECT) {
  test(`переход отвечает голым заголовком: ${entry.path} (${entry.note})`, async ({ request }) => {
    const chain = await followRedirects(request, urlFor(target, entry.path));
    const first = chain[0];
    const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

    expect(
      first === undefined ? 0 : first.status,
      `«${entry.path}» обязан отвечать переходом: без него проверять форму перехода не на ` +
        `чем.${context}`,
    ).toBe(301);

    for (const response of chain) {
      if (isRedirect(response.status)) {
        expectBareRedirect(response, context);
      }
    }
  });
}

/**
 * Группа 2: класс, на котором инвариант ломался.
 *
 * Сегодня все эти адреса отвечают 404 (это требование держит
 * `page-has-no-html-twin.spec.ts`), поэтому проверка формы перехода здесь —
 * страховка на случай, когда ответ снова станет переходом: вернувшийся дефект
 * апстрима даёт 301 с телом Astro и падает на первом же утверждении
 * {@link expectBareRedirect}.
 */
const BROKEN_ONCE: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/o-proekte.html/', note: 'форма со слешем у существующей страницы' },
  { path: '/staraya.html/?utm_source=mail', note: 'ровно тот адрес, на котором замерен дефект' },
  { path: '/index.html/', note: 'двойник главной со слешем' },
  { path: '/404.html/', note: 'страница ошибки как файл со слешем' },
  { path: '/o-proekte.html//', note: 'пустой сегмент в хвосте того же класса' },
  { path: '/a.HTML/', note: 'верхний регистр расширения' },
  { path: '/media/foo.html/', note: 'пространство производных изображений' },
  { path: '/staraya.php/', note: 'соседнее расширение: ответ обязан быть той же формы' },
  { path: '/katalog/otkrytka.htm/', note: 'соседнее расширение внутри пути' },
];

for (const entry of BROKEN_ONCE) {
  test(`переход по этому адресу, если он есть, голый: ${entry.path} (${entry.note})`, async ({
    request,
  }) => {
    const chain = await followRedirects(request, urlFor(target, entry.path));
    const context = `\n  Цепочка:\n    ${describeChain(chain)}`;

    expect(chain[0], `Ответа на «${entry.path}» нет вовсе.${context}`).toBeDefined();

    for (const response of chain) {
      if (isRedirect(response.status)) {
        expectBareRedirect(response, context);
      }
    }
  });
}
