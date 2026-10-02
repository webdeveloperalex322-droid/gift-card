/**
 * Требование (`CLAUDE.md`, «Sitemap и robots»; п. 22): карта сайта и разметка
 * говорят об индексации ОДНО И ТО ЖЕ. Обратное направление — «в карте только
 * страницы 200 + self-canonical + `index,follow`» — держит
 * `sitemap-entries-are-indexable.spec.ts`. Здесь прямое: страница, фактически
 * отдающая `index,…`, обязана быть в карте сайта.
 *
 * ## Почему это отдельное требование
 *
 * Два направления ломаются по-разному и разными руками. «Лишний адрес в карте»
 * — ошибка отбора в генераторе карты; «страница открыта, но в карту не попала» —
 * расхождение источника данных карты с тем, что отдаёт шаблон. Второе тише:
 * страница выглядит открытой, в браузере всё нормально, а поисковая система
 * узнаёт о ней только случайной ссылкой. Для посадочных, ради которых проект и
 * существует, это означает потерянный канал.
 *
 * До волны 1 (2026-10-02) требование было непроверяемо по состоянию: в
 * `index,follow` не было открыто ни одной страницы, и spec’а под него в приёмке
 * не существовало — это было честно записано в `README.md` как «не покрыто».
 * Волна 1 открыла шесть праздничных узлов, и пропуск стал дорогим: именно эти
 * шесть страниц — весь индексируемый сайт.
 *
 * ## Как собирается список «фактически открытых»
 *
 * Обходом серверного HTML от главной (`support/crawl.ts`), без JS. Обход — не
 * идеальный источник: страницу, на которую нет ни одной ссылки, он не найдёт.
 * Но именно такую страницу ловит `no-orphans.spec.ts` со стороны карты, и
 * вдвоём эти два spec’а закрывают оба промаха: сирота в карте и открытая
 * страница вне карты.
 *
 * Обход оборванный пределом запросов не делает утверждение ложным — он лишь
 * сужает проверенное, и это помечается аннотацией «проверено нечем».
 *
 * ## Чего spec не делает
 *
 * Не требует обратного («всё, что в карте, встречается в обходе») — это
 * достижимость, предмет `no-orphans.spec.ts`. Не проверяет статусы встреченных
 * ссылок — это Э5-03.
 */

import { expect, test } from '@playwright/test';

import {
  CRAWL_MAX_REQUESTS,
  crawlFromHome,
  crawlKey,
  isIndexableDirective,
} from './support/crawl.js';
import { noteNotChecked } from './support/not-checked.js';
import { readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();

test.describe.configure({ timeout: 300_000 });

test('каждая страница, отдающая index,follow, перечислена в карте сайта', async ({
  browser,
  request,
}, testInfo) => {
  const crawl = await crawlFromHome(request, target);

  expect(
    crawl.targets.size,
    'С главной не нашлось ни одной внутренней ссылки <a href>: либо навигация собирается ' +
      'скриптом (прямой запрет п. 23 ТЗ), либо сломан обход — и тогда «расхождений не ' +
      'найдено» ниже было бы ложным.',
  ).toBeGreaterThan(1);

  const tree = await readSitemapTree(request, browser, target);
  const inSitemap = new Set<string>();
  for (const loc of tree.pageUrls) {
    const key = crawlKey(loc);
    if (key !== null) {
      inSitemap.add(key);
    }
  }

  const open = [...crawl.targets.values()].filter(
    (found) => found.status === 200 && isIndexableDirective(found.robots),
  );
  const missing = open
    .filter((found) => !inSitemap.has(found.url))
    .map(
      (found) =>
        `${found.url} — отдаёт «${found.robots ?? ''}», но в карте сайта её нет. Ссылки на ` +
        `неё: ${found.referrers.length === 0 ? 'нет' : found.referrers.join(', ')}`,
    );

  console.log(
    `[карта против разметки] открытых в индекс страниц найдено обходом: ${String(open.length)}, ` +
      `адресов в карте сайта: ${String(inSitemap.size)}.`,
  );

  if (open.length === 0) {
    noteNotChecked(
      testInfo,
      'Соответствие «открытая в индекс страница есть в карте сайта» НЕ проверено: обход не ' +
        'встретил ни одной страницы с директивой «index,…». Обход при этом работает — ' +
        `адресов пройдено ${String(crawl.targets.size)}. Открытие страницы в index,follow — ` +
        'решение человека (п. 7.1 и п. 23 ТЗ); пока его нет, сверять нечего.',
    );
    return;
  }

  expect(
    missing,
    'Страница открыта в индекс разметкой, но в карту сайта не попала. Карта и разметка обязаны ' +
      'говорить одно: поисковая система приходит со списком из карты, и отсутствующая в ней ' +
      'посадочная ждёт случайной ссылки. Правится генератором карты или данными записи ' +
      '(владельцы — `astro-web` и `payload-cms`), а не приёмкой.',
  ).toEqual([]);

  if (crawl.truncated) {
    noteNotChecked(
      testInfo,
      `Обход оборван пределом в ${String(CRAWL_MAX_REQUESTS)} запросов: утверждение верно о ` +
        `${String(open.length)} найденных открытых страницах, но страница, до которой обход ` +
        'не дошёл, проверена не была. Предел поднимается в support/crawl.ts осознанно — он ' +
        'ограничивает время обязательного шлюза `pnpm verify`.',
    );
  }
});
