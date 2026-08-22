/**
 * Middleware Astro: тонкая обёртка над решением по пути.
 *
 * Здесь нет ни одного правила — все они в `./routing/path-policy.ts` и покрыты
 * юнит-тестами (`tests/unit/web-path-policy.test.ts`). Задача этого файла —
 * превратить решение в HTTP-ответ и ничего больше: правило, живущее в
 * обработчике запроса, проверяется только поднятым сервером, а правило
 * завершающего слеша — приоритетное требование проекта (решение Ч-21).
 */

import type { MiddlewareHandler } from 'astro';

import { adminRoutePrefix, decideRequestPath } from './routing/path-policy';
import { serverEnv } from './server-env';

export const onRequest: MiddlewareHandler = (context, next) => {
  const decision = decideRequestPath({
    adminPath: adminRoutePrefix(serverEnv()),
    pathname: context.url.pathname,
    search: context.url.search,
  });

  if (decision.action === 'redirect') {
    // Ответ собирается вручную, а не через `context.redirect`: статус обязан
    // быть ровно 301 и тело обязано быть пустым. Одиночный 301 — требование
    // CLAUDE.md, раздел «HTTP-статусы».
    return new Response(null, {
      status: decision.status,
      headers: { Location: decision.location },
    });
  }

  if (decision.action === 'not-found') {
    // Пустое тело здесь обязательно, и это не мелочь: Astro перерисовывает
    // ответ своей страницей ошибки только когда статус реroutable и тело равно
    // null (`astro/dist/core/routing/handler.js`, проверка
    // `REROUTABLE_STATUS_CODES.includes(response.status) && response.body === null`).
    // Так 404 остаётся настоящим 404 и при этом получает страницу с навигацией,
    // а не пустой ответ.
    return new Response(null, { status: 404 });
  }

  // `not-served` (маршруты админки Payload) обрабатывается так же, как
  // `render`, и это не упрощение: Astro обязан НЕ вмешиваться — ни редиректом,
  // ни нормализацией. Не найдя такого маршрута, он ответит честным 404, а
  // настоящую админку по этому пути отдаёт apps/cms на своём порту.
  return next();
};
