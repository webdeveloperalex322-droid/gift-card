/**
 * Замер присутствия объявленных страниц перед загрузкой spec-файлов.
 *
 * Единственная задача: спросить стенд про адреса, объявленные в
 * `support/declared-pages.ts` как `content`, и положить результат в окружение —
 * оттуда его прочитает инвентарь (`support/pages.ts`) в момент, когда Playwright
 * строит список тестов. Почему замер вообще нужен, почему он передаётся
 * переменной окружения и что происходит, если его нет, — в шапке
 * `support/discovery.ts`.
 *
 * Здесь нет ни одного утверждения: несостоявшийся замер валит прогон
 * исключением из `probeDeclaredPages`, а всё остальное — предмет specs. Шаг
 * печатает состав выборки в stdout, потому что статус приёмки переносят из
 * вывода `pnpm test:seo`: сокращение выборки обязано быть видно там же, где
 * «240 passed», а не только в отчёте Playwright.
 */

import { DECLARED_ACCEPTANCE_PAGES } from './support/declared-pages.js';
import {
  PRESENT_STATUS,
  probeDeclaredPages,
  publishDeclaredPageProbe,
} from './support/discovery.js';
import { resolveAcceptanceTarget } from './support/target.js';

export default async function globalSetup(): Promise<void> {
  const target = resolveAcceptanceTarget();
  const contentPages = DECLARED_ACCEPTANCE_PAGES.filter((page) => page.availability === 'content');

  const probe = await probeDeclaredPages(target.origin, contentPages);
  publishDeclaredPageProbe(probe);

  const present = contentPages.filter((page) => probe.statuses[page.path] === PRESENT_STATUS);
  const absent = contentPages.filter((page) => probe.statuses[page.path] !== PRESENT_STATUS);

  const routes = DECLARED_ACCEPTANCE_PAGES.length - contentPages.length;
  console.log(
    `[SEO-приёмка] выборка: ${String(routes + present.length)} из ` +
      `${String(DECLARED_ACCEPTANCE_PAGES.length)} объявленных страниц отдаются стендом ` +
      `(${String(routes)} маршрутов кода + ${String(present.length)} контентных).`,
  );
  for (const page of absent) {
    console.log(
      `[SEO-приёмка] ${page.path} — ${String(probe.statuses[page.path] ?? 0)}, вид страницы ` +
        `«${page.sampleRole}» в этом прогоне НЕ проверен (подробности — в тесте ` +
        '«объявленная страница не отдаётся»).',
    );
  }
}
