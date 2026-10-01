/**
 * Требование (п. 5.1: «включена в навигацию») применительно к боковому меню
 * категорий (`apps/web/src/components/SiteSidebar.astro`) — тот же приём, что и у
 * `site-nav-present.spec.ts` для верхнего меню.
 *
 * Здесь проверяется ПРИСУТСТВИЕ меню на каждой странице выборки и его ОТСУТСТВИЕ
 * на 404. Состав пунктов и живость ссылок — предмет соседних spec'ов
 * (`category-menu-is-uniform`, `category-menu-links-are-live`), и дублировать их
 * тут незачем.
 *
 * Меню опознаётся по доступному имени ориентира (`support/category-menu.ts`), а не
 * по классам: класс — деталь оформления и перекраску не переживает. Обоснование
 * целиком — в шапке того модуля.
 *
 * ## Про пустой прогон
 *
 * Рельс берёт узлы тем же отбором, что и каталог: только опубликованные и только
 * непустые (`siteCategoryNav`, `apps/web/src/data/site-nav.ts`). Пока человек не
 * опубликовал ни одного корневого узла — а на момент написания spec'а все записи
 * `collections` лежат в `review`, — меню законно не печатается нигде.
 *
 * Отличить «законно пусто» от «меню сломано» spec умеет БЕЗ доступа к базе: у
 * каталога `/otkrytki` есть собственный блок разделов, который читает ТЕ ЖЕ
 * корневые узлы тем же отбором. Есть разделы в каталоге, но нет меню — дефект, и
 * тест падает. Нет ни там, ни там — прогон вхолостую, и он помечается «проверено
 * нечем»: зелёный на пустых данных покрытием не является.
 */

import { expect, test } from '@playwright/test';

import { categoryMenuLinks } from './support/category-menu.js';
import { fetchRaw } from './support/http.js';
import { noteNotChecked } from './support/not-checked.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/**
 * Блок разделов самого каталога: те же корневые узлы, прочитанные тем же отбором.
 *
 * Опознаётся по заголовку блока — он печатается только при непустом наборе
 * разделов (`CardCatalogPage.astro`), поэтому его наличие и означает «корневые
 * узлы опубликованы».
 */
const CATALOG_SECTION = /class="catalog__section-title"/u;

for (const page of ACCEPTANCE_PAGES) {
  test(`боковое меню категорий есть в HTML: ${page.path} (${page.task})`, async ({
    request,
  }, testInfo) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    const links = categoryMenuLinks(response.body);

    if (links === null) {
      // Меню нет. Законно это ровно тогда, когда опубликованных корневых узлов нет
      // вовсе, — и тогда их нет и в собственном блоке разделов каталога.
      const catalog = await fetchRaw(request, urlFor(target, '/otkrytki'));

      expect(
        CATALOG_SECTION.test(catalog.body),
        `На ${page.path} нет ориентира бокового меню, ХОТЯ каталог /otkrytki печатает свои ` +
          'разделы из тех же корневых узлов. Значит, дело не в пустых данных: меню не ' +
          'напечаталось при живом дереве категорий — проп BaseLayout.categorySections до ' +
          'этого шаблона не доехал.',
      ).toBe(false);

      noteNotChecked(
        testInfo,
        `Боковое меню на ${page.path} не проверено: опубликованных корневых узлов таксономии ` +
          'сейчас нет ни одного (их нет и в блоке разделов каталога /otkrytki), поэтому ' +
          'siteCategoryNav() отдаёт пустой список и SiteSidebar законно не печатает ничего. ' +
          'Прогон прошёл ВХОЛОСТУЮ: зелёный статус здесь означает «нарушений не найдено, ' +
          'потому что проверять было нечего», а не покрытие. Полную силу проверка получает в ' +
          'день, когда человек опубликует первый узел.',
      );
      return;
    }

    expect(
      links.length,
      `Ориентир бокового меню на ${page.path} есть, но ссылок в нём нет: меню напечаталось ` +
        'пустым, хотя SiteSidebar рендерит его только при непустом дереве.',
    ).toBeGreaterThan(0);
  });
}

test('боковое меню категорий отсутствует на 404 (страница пререндерена без БД)', async ({
  request,
}) => {
  const response = await fetchRaw(request, urlFor(target, '/takogo-adresa-net-e3-14'));

  expect(
    categoryMenuLinks(response.body),
    'На странице 404 не должно быть ориентира бокового меню: она пререндерена на сборке, где ' +
      'категорий из БД взять негде, и BaseLayout получает categorySections={null} явно — см. ' +
      'apps/web/src/pages/404.astro.',
  ).toBeNull();
});
