/**
 * Требование (решение Ч-05): `/page/1` вложенной подборки
 * отдаёт одиночный 301 на базовый URL ТОЛЬКО когда база публично
 * существует и отвечает 200. Иначе оба адреса отвечают 404: 301 на
 * несуществующую или слабую страницу запрещён.
 *
 * Путь намеренно вложенный: именно catch-all маршрут раньше терял
 * решение `redirect-to-base` между разбором пагинации и шаблоном.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw, followRedirects, hopCount } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();
const BASE_PATH = '/otkrytki/prazdniki/8-marta';
const PAGE_ONE_PATH = `${BASE_PATH}/page/1`;

test('/page/1 вложенной подборки не редиректит на 404', async ({ request }) => {
  const base = await fetchRaw(request, urlFor(target, BASE_PATH));
  const pageOne = await fetchRaw(request, urlFor(target, PAGE_ONE_PATH));

  expect(
    [200, 404],
    `База проверочной подборки должна либо публично существовать (200), либо ` +
      `не существовать для анонима (404), получено ${String(base.status)}.`,
  ).toContain(base.status);

  if (base.status === 404) {
    expect(pageOne.status, '301 на базу с 404 запрещён.').toBe(404);
    expect(pageOne.location, '404 не должен нести Location.').toBeNull();
    return;
  }

  expect(pageOne.status, 'Публичная база даёт один 301 с `/page/1`.').toBe(301);
  expect(pageOne.resolvedLocation).toBe(urlFor(target, BASE_PATH));
  expect(pageOne.body, 'Ответ 301 завершает route и не рендерит HTML страницы.').toBe('');

  const chain = await followRedirects(request, urlFor(target, PAGE_ONE_PATH));
  expect(hopCount(chain), 'Редирект должен быть одиночным.').toBe(1);
  expect(chain.at(-1)?.status, 'Конечная цель одиночного 301 должна отвечать 200.').toBe(200);
});
