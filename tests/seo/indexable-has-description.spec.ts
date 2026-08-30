/**
 * Требование (задача Э4-01, решение «нет описания → страница закрыта от
 * индекса»; п. 22.1): страница без непустого `<meta name="description">` не
 * бывает индексируемой.
 *
 * ## Почему это не повтор `unique-title-h1-description.spec.ts`
 *
 * Тот spec сверяет ОБЪЯВЛЕНИЕ инвентаря: страница, у которой в
 * `support/pages.ts` записано `description: 'absent'`, не может быть объявлена
 * там же индексируемой. Это проверка согласованности двух строк файла приёмки, и
 * она нужна — но правило Э4-01 живёт в коде сайта, а не в инвентаре. Здесь
 * сверяются два ФАКТА ОДНОГО ОТВЕТА: что напечатано в `<meta name="robots">` и
 * что напечатано в `<meta name="description">`. Расхождение между ними означает,
 * что директива посчитана мимо единственного разрешателя
 * (`apps/web/src/seo/robots-directive.ts`) — например подставлена в шаблоне
 * константой, — и инвентарь об этом ничего не знает.
 *
 * ## Почему проверка формулируется «нет описания → закрыта», а не наоборот
 *
 * Логически это одно утверждение, но проверяются в них разные страницы, и
 * сегодня разница решающая. Формулировка «у индексируемой страницы есть
 * описание» на сайте, где ни одна страница не открыта в индекс (Ч-04-1),
 * проверяет пустое множество — то есть не проверяет ничего. Формулировка «без
 * описания — закрыта» работает уже сейчас: у `/o-proekte`, `/usloviya` и
 * `/kontakty` тега description нет вовсе (текст берётся из глобала настроек,
 * глобал — заглушка по Ч-19, а пустое поле убирает тег целиком), и spec
 * утверждает про каждую из них, что она закрыта. Если человек по Ч-23 включит им
 * `index,follow`, не заполнив описание, приёмка упадёт — а не промолчит.
 *
 * Ответ на такое падение — заполнить описание в админке ИЛИ оставить страницу
 * закрытой. Подставлять описание шаблоном нельзя: шаблонный SEO-текст запрещён
 * п. 23.4, описание пишет человек.
 *
 * ## Второй тест: адреса из карты сайта
 *
 * Они индексируемы по определению (в карту входят только страницы с
 * `index,follow`), поэтому у каждого обязан быть непустой description. Пока карта
 * пуста, тест проходит вхолостую и помечает прогон аннотацией «проверено нечем».
 */

import { expect, test } from '@playwright/test';

import { metaContents } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { annotateEmptyRun, readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Директива, при которой описание обязательно. */
const INDEXABLE = 'index,follow';

/** Непустое описание страницы либо `null`: тега нет или он пуст. */
function describedBy(html: string): string | null {
  return metaContents(html, 'description').find((value) => value.trim() !== '') ?? null;
}

test('страница без description не бывает открытой в индекс', async ({ request }) => {
  const violations: string[] = [];
  const withoutDescription: string[] = [];

  for (const page of ACCEPTANCE_PAGES) {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, `Страница ${page.path} обязана отдавать 200.`).toBe(200);

    const directives = metaContents(response.body, 'robots');
    expect(
      directives,
      `На ${page.path} обязана быть ровно одна директива робота.`,
    ).toHaveLength(1);

    if (describedBy(response.body) !== null) {
      continue;
    }
    withoutDescription.push(page.path);

    if (directives[0] === INDEXABLE) {
      violations.push(
        `${page.path} (${page.task}) отдаёт «${INDEXABLE}» и при этом не имеет непустого ` +
          '<meta name="description">',
      );
    }
  }

  expect(
    violations,
    'Правило Э4-01: отсутствие описания ЗАКРЫВАЕТ страницу от индексации. Открытая страница ' +
      'без описания означает, что директива посчитана не единственным разрешателем ' +
      '(apps/web/src/seo/robots-directive.ts). Проверено страниц без описания: ' +
      `${String(withoutDescription.length)} из ${String(ACCEPTANCE_PAGES.length)} ` +
      `(${withoutDescription.join(', ')}) — на них утверждение и работает.`,
  ).toEqual([]);
});

test.describe('адреса из карты сайта', () => {
  test.describe.configure({ timeout: 180_000 });

  test('у каждого адреса из карты сайта есть непустой description', async ({
    browser,
    request,
  }, testInfo) => {
    const tree = await readSitemapTree(request, browser, target);

    if (tree.pageUrls.length === 0) {
      annotateEmptyRun(testInfo, 'Наличие description у страниц карты сайта НЕ проверено.');
      return;
    }

    const without: string[] = [];

    for (const loc of tree.pageUrls) {
      const response = await fetchRaw(request, loc);
      if (response.status !== 200) {
        // Статус адресов карты — предмет `sitemap-entries-are-indexable.spec.ts`.
        // Здесь он не переспрашивается: два падения на одну причину читались бы
        // как две разные проблемы.
        continue;
      }
      if (describedBy(response.body) === null) {
        without.push(loc);
      }
    }

    expect(
      without,
      'Адрес попал в карту сайта, то есть признан индексируемым, но непустого description у ' +
        'страницы нет. По Э4-01 такая страница обязана быть закрыта от индекса — значит, отбор ' +
        'в карту и разрешатель директивы разошлись.',
    ).toEqual([]);
  });
});
