/**
 * Требование (`CLAUDE.md`, «HTTP-статусы» + шапка `apps/web/src/pages/404.astro`):
 * страница 404 у сайта ОДНА.
 *
 * Почему это отдельное требование, а не придирка. Ответ 404 на этом сайте
 * рождается в пяти разных местах кода:
 *
 *   1. входной обработчик читает `dist/client/404.html` — решения `not-found` и
 *      `not-served` политики пути (`apps/web/src/server/front-door.ts`);
 *   2. он же отвечает на промах по файлу производной изображения (`/media/...`);
 *   3. маршрут карточки и маршрут ветви подборок отвечают
 *      `new Response(null, { status: 404 })`, и страницу ошибки подставляет
 *      приложение Astro через `prerenderedErrorPageFetch` адаптера;
 *   4. маршрут пагинации отвечает так же на неканонический номер страницы;
 *   5. резерв в `front-door.ts` (`FALLBACK_NOT_FOUND_HTML`) — на случай сборки
 *      без файла 404.
 *
 * Пути 1–4 обязаны читать ОДИН файл. Именно это условие и держит требование
 * «страница 404 пререндеренная»: снимите `prerender`, и файла в сборке не будет —
 * 404 начнёт приходить из двух мест с разным телом, причём статус останется
 * верным, и заметить расхождение снаружи будет нечем. Резерв (5) достижим только
 * при подменённом артефакте и здесь не проверяется — он и не должен совпадать.
 *
 * Проверка сравнивает тела БАЙТ В БАЙТ на адресах из разных ветвей. Отдельно важен
 * путь админки: там разное тело было бы не косметикой, а подсказкой — «по этому
 * адресу что-то есть», тогда как путь админки не публикуется (решение Ч-22) и
 * обязан отвечать 404, неотличимым от любого другого.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();
const adminPath = (process.env['PAYLOAD_ADMIN_PATH'] ?? '').trim();

if (adminPath === '') {
  throw new Error(
    'SEO-приёмка: PAYLOAD_ADMIN_PATH не задан. Ветвь `not-served` (маршруты админки) обязана ' +
      'отдавать то же тело 404, что и остальные, а путь берётся из окружения: зашитая строка ' +
      'проверяла бы чужой адрес.',
  );
}

const BRANCHES: readonly { readonly path: string; readonly note: string }[] = [
  {
    path: '/takogo-razdela-net-e3-14',
    note: 'промах маршрутизации Astro на первом уровне',
  },
  {
    path: '/otkrytki/takoy-otkrytki-net-e3-14',
    note: 'маршрут карточки: запись не найдена (ответ маршрута с пустым телом)',
  },
  {
    path: '/podborki/prazdniki/takogo-prazdnika-net-e3-14',
    note: 'маршрут ветви подборок: узел не найден',
  },
  {
    path: '/otkrytki/page/0',
    note: 'маршрут пагинации: номер страницы не является адресом',
  },
  {
    path: '/search/istoriya',
    note: 'путь под маршрутом, занятым ЦЕЛИКОМ (реестр зарезервированных маршрутов)',
  },
  {
    path: '/media/takogo-fayla-net-e3-14.jpg',
    note: 'промах по файлу производной изображения',
  },
  {
    path: adminPath,
    note: 'путь админки: решение not-served политики пути',
  },
];

test('тело страницы 404 одинаково у всех ветвей кода', async ({ request }) => {
  const collected: { readonly path: string; readonly note: string; readonly body: string }[] = [];

  for (const branch of BRANCHES) {
    const response = await fetchRaw(request, urlFor(target, branch.path));

    expect(
      response.status,
      `${branch.path} (${branch.note}) обязан отдавать 404, получено ` +
        `${String(response.status)}.`,
    ).toBe(404);

    collected.push({ body: response.body, note: branch.note, path: branch.path });
  }

  const reference = collected[0];
  expect(reference, 'Список ветвей пуст — сравнивать нечего.').toBeDefined();

  const different = collected
    .filter((entry) => entry.body !== (reference?.body ?? ''))
    .map((entry) => `${entry.path} (${entry.note}): ${String(entry.body.length)} байт`);

  expect(
    different,
    `Тело 404 разошлось с ветвью «${reference?.path ?? ''}» (${String(
      reference?.body.length ?? 0,
    )} байт). Страница 404 у сайта одна: и входной обработчик, и приложение Astro читают ` +
      '`dist/client/404.html`. Расхождение означает, что часть адресов отвечает другой ' +
      'страницей — чаще всего потому, что маршрут 404 перестал быть пререндеренным и файла в ' +
      'сборке больше нет, либо потому, что какая-то ветвь начала печатать своё тело. Статус ' +
      'при этом остаётся верным, и заметить это иначе нечем.',
  ).toEqual([]);

  // Тело не должно оказаться пустым: пустой 404 формально «одинаков» у всех
  // ветвей, но страницей с навигацией не является (ТЗ §5.6).
  expect(
    (reference?.body.length ?? 0) > 500,
    'Тело 404 подозрительно короткое: скорее всего отвечает резерв входного обработчика ' +
      '(FALLBACK_NOT_FOUND_HTML) или пустой ответ, а не страница `src/pages/404.astro`. ' +
      'Проверьте, что в сборке есть dist/client/404.html.',
  ).toBe(true);
});
