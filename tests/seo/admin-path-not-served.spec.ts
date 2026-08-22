/**
 * Требование («Правила URL», решение Ч-22): маршруты админки Payload обслуживает
 * `apps/cms` на своём порту. Astro их не рендерит и не нормализует, а путь
 * админки не публикуется в `robots.txt` — он закрывается авторизацией и
 * заголовком `X-Robots-Tag`.
 *
 * Проверяется, что фронтенд по этому пути ничего не отдаёт: ни страницы (иначе
 * подборка или карточка заняла бы адрес админки — ровно тот случай, ради
 * которого путь админки вычисляется из `PAYLOAD_ADMIN_PATH` и попадает в реестр
 * зарезервированных маршрутов), ни редиректа в чужой роутер.
 *
 * Путь берётся из окружения, а не из строки `/admin`: при нестандартном
 * `PAYLOAD_ADMIN_PATH` зашитая строка проверяла бы не то, что развёрнуто. Пустое
 * значение — ошибка конфигурации окружения, а не повод пропустить проверку.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const adminPath = (process.env['PAYLOAD_ADMIN_PATH'] ?? '').trim();

if (adminPath === '') {
  throw new Error(
    'SEO-приёмка: PAYLOAD_ADMIN_PATH не задан. Значения по умолчанию здесь нет намеренно: ' +
      'проверка «Astro не обслуживает админку» обязана идти по тому же пути, который задан ' +
      'окружению, иначе она проверяет чужой адрес. Задайте PAYLOAD_ADMIN_PATH в .env.',
  );
}

const PROBES: readonly { readonly path: string; readonly note: string }[] = [
  { path: adminPath, note: 'корень админки' },
  { path: `${adminPath}/collections/cards`, note: 'вложенный маршрут админки' },
];

for (const probe of PROBES) {
  test(`Astro не обслуживает путь админки: ${probe.path} (${probe.note})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, probe.path));

    expect(
      response.status,
      `Фронтенд обязан не отдавать по этому пути страницу. Получено ${String(response.status)}. ` +
        'Ответ 200 означает, что маршрут Astro или запись CMS заняли адрес админки.',
    ).not.toBe(200);

    expect(
      response.location,
      'Astro не должен нормализовать и уводить редиректом маршруты чужого роутера: ' +
        `получено Location: ${response.location ?? '—'}.`,
    ).toBeNull();
  });
}
