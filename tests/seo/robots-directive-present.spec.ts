/**
 * Требование («Правила индексации», п. 5.1, п. 7.1 и п. 23 ТЗ): у каждой
 * страницы есть явная директива для робота, её значение — из закрытого списка, и
 * оно совпадает с тем, что зафиксировано в инвентаре приёмки.
 *
 * Зачем сверять со ЗАФИКСИРОВАННЫМ значением, а не просто «директива есть»:
 * открытие страницы в `index,follow` — решение человека, а не побочный эффект
 * правки шаблона. Молчаливое `index,follow`, приехавшее с рефакторингом layout,
 * не поймать иначе — в браузере оно выглядит ровно как раньше.
 *
 * Второе утверждение — условия п. 5.1, проверяемые машиной, для страниц,
 * открытых в индекс: 200, абсолютный self-canonical, ровно один H1, непустые
 * title и description. Остальные условия п. 5.1 (подтверждённый спрос, отдельный
 * интент, достаточно открыток, включение в навигацию) машина не проверяет — их
 * подтверждает человек, и по решению Ч-04-1 «подтверждённый спрос» данными пока
 * не подтверждён вовсе. Поэтому spec не разрешает индексацию, а лишь ловит
 * страницу, открытую в индекс без выполнения проверяемой части условий.
 */

import { expect, test } from '@playwright/test';

import { canonicalHrefs, headingTexts, metaContents, titles } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, ALLOWED_ROBOTS_DIRECTIVES, isIndexable } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`директива робота задана явно: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const directives = metaContents(response.body, 'robots');
    expect(
      directives,
      'На странице обязан быть ровно один <meta name="robots">: два взаимно противоречащих ' +
        'значения робот трактует по худшему, и это происходит молча.',
    ).toHaveLength(1);

    const directive = directives[0] ?? '';
    expect(
      ALLOWED_ROBOTS_DIRECTIVES as readonly string[],
      `Значение «${directive}» не входит в список допустимых директив проекта.`,
    ).toContain(directive);
    expect(
      directive,
      `Директива разошлась с инвентарём приёмки (tests/seo/support/pages.ts). Если страницу ` +
        'открыл в индекс человек — правка инвентаря входит в это решение и должна быть видна ' +
        'в дифе. Если значение изменилось само, это молчаливое изменение индексации.',
    ).toBe(page.expectedRobots);
  });
}

for (const page of ACCEPTANCE_PAGES.filter(isIndexable)) {
  test(`проверяемая машиной часть условий п. 5.1 выполнена: ${page.path} (${page.task})`, async ({
    request,
  }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));

    expect(response.status, 'Индексируемая страница обязана отвечать 200.').toBe(200);
    expect(
      canonicalHrefs(response.body),
      'У индексируемой страницы обязан быть ровно один self-canonical.',
    ).toHaveLength(1);
    expect(headingTexts(response.body, 1), 'Ровно один H1.').toHaveLength(1);
    expect((titles(response.body)[0] ?? '').length, 'Непустой title.').toBeGreaterThan(0);
    expect(
      (metaContents(response.body, 'description')[0] ?? '').length,
      'Непустой description.',
    ).toBeGreaterThan(0);
  });
}
