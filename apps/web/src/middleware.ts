/**
 * Middleware Astro: тот же контроль пути, но для входов, где нашего сервера нет.
 *
 * Правил здесь нет — все они в `./routing/path-policy.ts` и покрыты
 * юнит-тестами (`tests/unit/web-path-policy.test.ts`). Задача этого файла —
 * превратить решение в HTTP-ответ и ничего больше.
 *
 * ## Кто и когда доходит до этого middleware
 *
 * На СОБРАННОМ сервере — почти никто: порядок обработки принадлежит
 * `src/server/front-door.ts`, и приложению Astro передаются только цели,
 * получившие решение `serve`, то есть уже канонические. Поэтому здесь
 * штатный результат — `next()`, и это не бесполезная работа: middleware
 * остаётся единственным контролем пути там, где входного сервера нет, а именно
 *
 *   - `astro dev` (`pnpm dev`) — dev-сервер Vite поднимает Astro напрямую;
 *   - любое встраивание обработчика в чужой Node-сервер.
 *
 * Дублирования правила при этом нет: и middleware, и входной сервер зовут одну и
 * ту же чистую функцию.
 *
 * ## Что в dev-режиме всё равно не проверить
 *
 * Замерено на astro 7.2.4: встроенный обработчик Astro вызывает
 * `handleTrailingSlash` ДО пользовательского middleware
 * (`dist/core/routing/handler.js`), а в `astro dev` при `trailingSlash: 'never'`
 * вместо 301 показывает страницу-предупреждение со статусом 404. Поэтому
 * правило слеша проверяется против собранного сервера, а не против dev — и
 * смоуком, и приёмкой SEO.
 */

import type { MiddlewareHandler } from 'astro';

import { adminRoutePrefix, decideRequestTarget } from './routing/path-policy.js';
import { serverEnv } from './server-env.js';

export const onRequest: MiddlewareHandler = (context, next) => {
  // Заранее отрендеренные маршруты проходят без проверки, и это НЕ послабление.
  // Во время сборки Astro запрашивает такую страницу по имени её ФАЙЛА:
  // при `build.format: 'file'` это `/zzprobe.html`, при `directory` — путь с
  // завершающим слешем. Наша политика оба вида справедливо считает не-адресом,
  // и отказ на них означал бы, что пререндер не создаёт файл вовсе. Замерено:
  // «/zzprobe.html (file not created, response body was empty)» — то есть все
  // статические страницы молча исчезли бы из сборки.
  //
  // Второго адреса это не создаёт: в рантайме заранее отрендеренный маршрут
  // отдаёт наш статический слой (`src/server/static-files.ts`), к обработчику
  // Astro он не попадает, а обращение по `.html` отклоняет входной сервер.
  if (context.isPrerendered) {
    return next();
  }

  const decision = decideRequestTarget({
    adminPath: adminRoutePrefix(serverEnv()),
    target: `${context.url.pathname}${context.url.search}`,
  });

  if (decision.action === 'redirect') {
    // Ответ собирается вручную, а не через `context.redirect`: статус обязан
    // быть ровно 301, а тело — пустым. Тело здесь важно отдельно: шаблон 3xx
    // самого Astro кладёт в `<meta http-equiv="refresh">` адрес-ИСТОЧНИК, то
    // есть отправляет клиента назад (разбор — в шапке path-policy.ts).
    return new Response(null, {
      status: decision.status,
      headers: { 'Content-Length': '0', Location: decision.location },
    });
  }

  if (decision.action === 'bad-request') {
    return new Response('400 Bad Request\n', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (decision.action === 'not-found' || decision.action === 'not-served') {
    // Пустое тело здесь обязательно, и это не мелочь: Astro перерисовывает
    // ответ своей страницей ошибки только когда статус реroutable и тело равно
    // null (`astro/dist/core/routing/handler.js`, проверка
    // `REROUTABLE_STATUS_CODES.includes(response.status) && response.body === null`).
    // Так 404 остаётся настоящим 404 и получает страницу 404 приложения — пока
    // это страница Astro по умолчанию (`<html lang="en">`, без навигации), своя
    // с навигацией появится на Э3-11.
    //
    // `not-served` (маршруты админки Payload) отвечает тем же 404 намеренно:
    // отдельный статус или отдельное тело подсказывали бы, что по этому адресу
    // что-то есть, а путь админки не публикуется (решение Ч-22).
    return new Response(null, { status: 404 });
  }

  return next();
};
