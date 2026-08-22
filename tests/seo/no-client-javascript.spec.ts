/**
 * Требование (раздел «Рендеринг»): клиентский JS — только точечные острова;
 * по умолчанию его нет. На страницах волны 0 островов нет ни одного, поэтому
 * исполняемых `<script>` в ответе быть не должно.
 *
 * Что НЕ считается клиентским JS: `<script type="application/ld+json">`. Это
 * структурированные данные, они обязательны по ТЗ (раздел «Структурированные
 * данные») и появятся на карточке, подборке и главной. Spec различает их по
 * `type`, а не «разрешает любой script с json в теле» — иначе он перестал бы
 * ловить настоящий скрипт.
 *
 * Когда появятся острова (кнопка скачивания на Э3-05, фильтры на Э3-10), это
 * требование не отменяется, а уточняется: разрешённый скрипт станет свойством
 * страницы в инвентаре (`support/pages.ts`), а не общим послаблением. Пока
 * послабления нет.
 */

import { expect, test } from '@playwright/test';

import { scriptTags } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();
const STRUCTURED_DATA_TYPE = 'application/ld+json';

for (const page of ACCEPTANCE_PAGES) {
  test(`нет исполняемого клиентского JS: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const executable = scriptTags(response.body).filter(
      (script) => script.type !== STRUCTURED_DATA_TYPE,
    );

    expect(
      executable.map((script) => script.tag),
      'Клиентского JS на этой странице быть не должно (нулевой клиентский JS по умолчанию). ' +
        `Исключение — только <script type="${STRUCTURED_DATA_TYPE}">.`,
    ).toEqual([]);
  });
}
