/**
 * Требование (ТЗ §6.5, вето V6): добавление параметров не меняет СТАТУС ответа.
 *
 * Отдельно от canonical, потому что это другая поломка. Статус, зависящий от
 * строки запроса, означает, что параметр стал частью адреса: страница «есть» с
 * одним набором параметров и «нет» с другим. Для краулера это худший из миров —
 * он видит семейство адресов, каждый из которых иногда отвечает, и обходит их
 * все. Два конкретных механизма, которые здесь ловятся:
 *
 *   - параметр уходит в выборку записей, выборка пустеет, и страница отвечает
 *     404 (или 500) вместо 200 — то есть фильтр начинает «удалять» страницы;
 *   - параметр разбирается строго, непонятное значение даёт 400. Разбор
 *     представления обязан быть терпимым: чужой параметр из внешней ссылки
 *     оставляет страницу той же самой (`apps/web/src/routing/view-params.ts`).
 *
 * Проверяется в обе стороны: существующий адрес остаётся 200 с любым набором
 * параметров, а несуществующий остаётся 404. Второе не менее важно: 404,
 * превращающийся с параметром в 200, — это soft 404 на бесконечном множестве
 * адресов.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES, QUERY_VARIANTS } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`статус не зависит от параметров: ${page.path} (${page.task})`, async ({ request }) => {
    for (const variant of QUERY_VARIANTS) {
      const response = await fetchRaw(request, urlFor(target, `${page.path}${variant.query}`));

      expect(
        response.status,
        `${page.path}${variant.query} (${variant.note}) обязан отдавать 200, как и чистый ` +
          'адрес. Статус, зависящий от строки запроса, означает, что параметр стал частью ' +
          'адреса: страница «есть» с одним набором параметров и «нет» с другим.',
      ).toBe(200);

      expect(
        response.location,
        `${page.path}${variant.query} обязан отдать страницу, а не редирект: перенаправление с ` +
          'параметрами либо теряет их, либо создаёт второй адрес, ведущий 301 в первый.',
      ).toBeNull();
    }
  });
}

/**
 * Несуществующий адрес: параметр не делает его существующим.
 *
 * Путь взят таким же, как в `not-found-status.spec.ts` (тот же класс адреса —
 * карточка внутри контейнера `/otkrytki`), чтобы падение обоих specs указывало на
 * одну причину, а не выглядело как две разные.
 */
const MISSING_PATH = '/otkrytki/takoy-otkrytki-net-e3-14';

test('параметры не превращают 404 в 200', async ({ request }) => {
  for (const variant of QUERY_VARIANTS) {
    const response = await fetchRaw(request, urlFor(target, `${MISSING_PATH}${variant.query}`));

    expect(
      response.status,
      `${MISSING_PATH}${variant.query} (${variant.note}) обязан отдавать 404. Ответ 200 здесь — ` +
        'soft 404 на бесконечном множестве адресов: к несуществующему пути можно приписать ' +
        'любой параметр.',
    ).toBe(404);
  }
});
