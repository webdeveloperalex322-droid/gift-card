/**
 * Требование (ТЗ §5.5, «Правила индексации», вето V6): страница результатов
 * внутреннего поиска не индексируется НИКОГДА, у неё один адрес — чистый
 * `/search`, и от запроса не зависят ни директива, ни canonical, ни заголовок.
 *
 * Почему проверяется на наборе запросов, а не на одном: поломка здесь возникает
 * именно от значения параметра. Три её вида, и все три встречаются в живых
 * проектах:
 *
 *   - **директива выводится из результата.** «Нашлось — открываем, не нашлось —
 *     закрываем» кажется разумным и означает, что часть страниц поиска уходит в
 *     индекс. Требование ТЗ безусловно: `noindex` при любом `?q=`;
 *   - **запрос попадает в canonical.** Тогда адресов у страницы столько, сколько
 *     люди введут слов, и каждый объявляет себя каноническим;
 *   - **запрос попадает в `title` или `H1`.** Это тот же дубль, только по
 *     заголовку: одинаковое содержание страницы с разными заголовками. Поэтому
 *     сравниваются и `title`, и `H1` — они обязаны быть одинаковыми на всех
 *     запросах. Сам запрос виден в поле формы и в тексте над результатами:
 *     посетителю нужен именно он, а не заголовок вкладки.
 *
 * Набор запросов включает кириллицу, латиницу, слишком короткую строку, пробелы,
 * подстановочные символы `like` и попытку разметки. Последняя — не проверка
 * экранирования (это дело юнит-тестов), а проверка того, что страница остаётся
 * ОДНОЙ И ТОЙ ЖЕ: 200, `noindex`, чистый canonical.
 *
 * Пагинации у поиска нет намеренно (`apps/web/src/seo/search-page.ts`), поэтому
 * `/search/page/2` здесь не проверяется — этот адрес обязан отвечать 404 как
 * любой несуществующий, и его проверяет `not-found-status.spec.ts` через реестр
 * зарезервированных маршрутов (`/search` занят ЦЕЛИКОМ).
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs, headingTexts, metaContents, titles } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Канонический адрес страницы поиска — единственный, который у неё есть. */
const SEARCH_PATH = '/search';

const QUERIES: readonly { readonly query: string; readonly note: string }[] = [
  { query: '', note: 'без параметров вовсе' },
  { query: '?q=', note: 'пустое значение' },
  { query: '?q=%20%20', note: 'только пробелы' },
  { query: '?q=8', note: 'слишком короткий запрос' },
  { query: '?q=8%20marta', note: 'латиница с пробелом' },
  { query: '?q=%D1%82%D1%8E%D0%BB%D1%8C%D0%BF%D0%B0%D0%BD%D1%8B', note: 'кириллица' },
  { query: '?q=%25', note: 'подстановочный символ like' },
  { query: '?q=%3Cscript%3E', note: 'попытка разметки' },
  { query: '?q=marta&format=square&utm_source=vk', note: 'запрос плюс чужие параметры' },
  { query: '?page=2&q=marta', note: 'попытка пагинации параметром' },
];

test('страница поиска: один адрес, noindex и один заголовок при любом запросе', async ({
  request,
}) => {
  const expectedCanonical = `${target.origin}${SEARCH_PATH}`;
  const seenTitles = new Set<string>();
  const seenHeadings = new Set<string>();

  for (const probe of QUERIES) {
    const url = urlFor(target, `${SEARCH_PATH}${probe.query}`);
    const response = await fetchRaw(request, url);

    expect(
      response.status,
      `${SEARCH_PATH}${probe.query} (${probe.note}) обязан отдавать 200: страница поиска ` +
        'отвечает и без запроса, и с пустой выдачей — она показывает форму, а не ошибку.',
    ).toBe(200);

    const directives = metaContents(response.body, 'robots');
    expect(
      directives,
      `На ${SEARCH_PATH}${probe.query} (${probe.note}) обязана быть ровно одна директива робота.`,
    ).toHaveLength(1);
    expect(
      (directives[0] ?? '').startsWith('noindex'),
      `На ${SEARCH_PATH}${probe.query} (${probe.note}) директива «${directives[0] ?? '—'}». ` +
        'Страница результатов внутреннего поиска не индексируется НИКОГДА (ТЗ §5.5): это ' +
        'безусловное требование, а не решение, которое зависит от того, что нашлось.',
    ).toBe(true);

    expect(
      canonicalHrefs(response.body),
      `На ${SEARCH_PATH}${probe.query} (${probe.note}) canonical обязан быть ровно один и ` +
        'указывать на чистый /search: запрос в canonical означает столько канонических ' +
        'адресов, сколько люди введут слов.',
    ).toEqual([expectedCanonical]);

    seenTitles.add(titles(response.body)[0] ?? '');
    const headings = headingTexts(response.body, 1);
    expect(headings, `На ${SEARCH_PATH}${probe.query} обязан быть ровно один H1.`).toHaveLength(1);
    seenHeadings.add(headings[0] ?? '');
  }

  expect(
    [...seenTitles],
    'title страницы поиска обязан быть ОДИН для всех запросов. Подставленный в заголовок ' +
      'запрос даёт столько разных заголовков, сколько запросов, — то есть страницу-двойник ' +
      'ровно там, где поиск и закрыт от индексации.',
  ).toHaveLength(1);

  expect(
    [...seenHeadings],
    'H1 страницы поиска обязан быть ОДИН для всех запросов: запрос виден в поле формы и в ' +
      'тексте над результатами, а H1 описывает саму страницу.',
  ).toHaveLength(1);
});
