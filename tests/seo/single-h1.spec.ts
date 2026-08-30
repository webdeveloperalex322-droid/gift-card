/**
 * Требование (п. 22): на странице РОВНО один H1, и он не пустой.
 *
 * Отдельным spec'ом — намеренно: «ровно один H1» и «H1 присутствует в серверном
 * HTML» ломаются по разным причинам (второй H1 обычно приносит шаблон блока,
 * отсутствие H1 — ошибка данных), и падение должно называть, что именно
 * нарушено.
 */

import { expect, test } from '@playwright/test';

import { headingTexts } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`ровно один непустой H1: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const headings = headingTexts(response.body, 1);

    expect(
      headings,
      `H1 обязан быть ровно один. Найдено ${String(headings.length)}: ` +
        `${JSON.stringify(headings)}.`,
    ).toHaveLength(1);
    expect((headings[0] ?? '').length, 'H1 не может быть пустым.').toBeGreaterThan(0);
  });
}
