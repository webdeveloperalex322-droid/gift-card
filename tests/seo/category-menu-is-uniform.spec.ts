/**
 * Требование (п. 5.1 «включена в навигацию»; п. 22 «нет страниц-сирот: каждая
 * индексируемая страница достижима за ≤ 4 перехода от главной»).
 *
 * Боковое меню категорий печатает LAYOUT, и вся его польза для достижимости
 * держится ровно на этом: узел таксономии находится за один переход С ЛЮБОЙ
 * страницы. Утверждение теряет силу, как только состав меню начинает зависеть от
 * страницы: тогда «за один переход» становится «за один переход с тех страниц,
 * где нужный пункт оказался», а глубина обхода перестаёт быть свойством сайта.
 *
 * Расхождение состава — поломка тихая. Меню собирает `siteCategoryNav()`
 * (`apps/web/src/data/site-nav.ts`), но зовут его ПЯТЬ разных сборщиков страниц,
 * и каждый передаёт свой результат в layout сам. Достаточно одному из них
 * подрезать список «под свой блок» (у главной такая обрезка уже есть —
 * `HOME_SECTION_CHILDREN`, и она намеренно НЕ применяется к меню), чтобы
 * навигация стала разной, а все остальные проверки остались зелёными: ссылки на
 * месте, `<a href>` настоящие, статусы верные.
 *
 * Проверяется поэтому не наличие меню, а ТОЖДЕСТВО его состава на всех страницах
 * выборки — включая порядок: порядок пунктов задаёт запрос, и перестановка на
 * отдельной странице означала бы, что состав собран другим путём.
 *
 * Страница 404 в выборку не входит: рельса у неё нет намеренно (она пререндерена
 * на сборке, где базы может не быть) — см. проп `categorySections` у
 * `apps/web/src/layouts/BaseLayout.astro`. Требование «на 404 есть навигация»
 * покрыто отдельно, `not-found-page-content.spec.ts` и `site-nav-present.spec.ts`.
 */

import { expect, test } from '@playwright/test';

import { CATEGORY_MENU_LABEL, categoryMenuLinks } from './support/category-menu.js';
import { fetchRaw } from './support/http.js';
import { noteNotChecked } from './support/not-checked.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const EMPTY_TAXONOMY_NOTE =
  `Состав бокового меню категорий НЕ проверен: ориентира <nav aria-label="${CATEGORY_MENU_LABEL}"> ` +
  'нет ни на одной странице выборки. Меню печатается только при непустой таксономии, а ' +
  'опубликованных узлов на сайте сейчас нет: все записи `collections` стоят в статусе `review`, ' +
  'и перевод в `published` — решение человека (п. 7.1 и п. 23 ТЗ), которое приёмка принять не ' +
  'вправе. Прогон прошёл ВХОЛОСТУЮ: зелёный статус здесь означает «нарушений не найдено, потому ' +
  'что проверять было нечего», а не покрытие. Полную силу проверка получает в день, когда ' +
  'человек опубликует первый узел таксономии; правок в spec для этого не нужно.';

test('боковое меню категорий одинаково на всех страницах выборки', async ({ request }, testInfo) => {
  const seen = await Promise.all(
    ACCEPTANCE_PAGES.map(async (page) => {
      const response = await fetchRaw(request, urlFor(target, page.path));
      expect(response.status, `Страница инвентаря обязана отдавать 200. ${page.note}`).toBe(200);
      return { links: categoryMenuLinks(response.body), path: page.path };
    }),
  );

  const withMenu = seen.filter((entry) => entry.links !== null);

  if (withMenu.length === 0) {
    noteNotChecked(testInfo, EMPTY_TAXONOMY_NOTE);
    return;
  }

  // Меню либо есть везде, либо нет нигде. Промежуточное состояние — это и есть
  // «страница вне навигации», ради которого проверка существует.
  expect(
    withMenu.map((entry) => entry.path),
    'Боковое меню категорий печатает layout, поэтому оно обязано быть на КАЖДОЙ странице ' +
      'выборки либо ни на одной (пустая таксономия). Найдено на части страниц — значит какой-то ' +
      'сборщик страницы не передал `categorySections` в BaseLayout, и эта страница выпала из ' +
      'постоянной навигации.',
  ).toEqual(ACCEPTANCE_PAGES.map((page) => page.path));

  for (const entry of withMenu) {
    const links = entry.links ?? [];
    expect(links.length, `Ориентир меню на ${entry.path} есть, а ссылок в нём нет.`).toBeGreaterThan(
      0,
    );
    for (const link of links) {
      expect(
        link.href,
        `Пункт меню на ${entry.path} без href: навигация обязана быть <a href> (раздел ` +
          '«Рендеринг»), а не элементом, который куда-то ведёт скриптом.',
      ).not.toBeNull();
      expect(
        link.text.trim(),
        `Пункт меню на ${entry.path} (${String(link.href)}) без видимого текста: ссылка без ` +
          'анкора не сообщает ни посетителю, ни поиску, куда она ведёт.',
      ).not.toBe('');
    }
  }

  const reference = withMenu[0];
  const referenceItems = (reference?.links ?? []).map(
    (link) => `${String(link.href)} — ${link.text.trim()}`,
  );

  for (const entry of withMenu.slice(1)) {
    expect(
      (entry.links ?? []).map((link) => `${String(link.href)} — ${link.text.trim()}`),
      `Состав бокового меню на ${entry.path} отличается от состава на ${String(reference?.path)}. ` +
        'Меню обязано быть одинаковым на каждой странице: на нём держится утверждение «узел ' +
        'таксономии достижим за один переход с любой страницы», то есть требование «нет ' +
        'страниц-сирот» (п. 22). Обрезка списка под блок конкретной страницы (как ' +
        'HOME_SECTION_CHILDREN у главной) к меню применяться не должна.',
    ).toEqual(referenceItems);
  }
});
