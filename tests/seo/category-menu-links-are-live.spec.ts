/**
 * Требование (п. 22: «внутренние ссылки — `<a href>`», «404 отдаёт 404»; раздел
 * «Правила URL»: канонический вид адреса — без завершающего слеша, без
 * параметров).
 *
 * Боковое меню категорий стоит на КАЖДОЙ странице сайта, поэтому цена ошибки в
 * нём умножается на число страниц: один пункт, ведущий на 404 или на редирект, —
 * это битая ссылка со всего сайта сразу и лишний переход на каждом пути обхода.
 *
 * Слой данных обещает ровно это и обещает сильно: `siteCategoryNav()`
 * (`apps/web/src/data/site-nav.ts`) отбирает узлы предикатом `nodesWithContent`,
 * то есть «ссылка печатается тогда и только тогда, когда её адрес отвечает 200».
 * Обещание проверяется здесь, потому что состоит оно из двух независимых частей
 * (что отобрал запрос и что ответил маршрут), и разойтись они могут молча — узел
 * опустеет, а отбор посчитает его непустым по кешированному счёту.
 *
 * Проверяется по КАЖДОЙ странице выборки, а не по одной: меню собирают пять
 * разных сборщиков, и адрес, испорченный в одном из них, на остальных не виден.
 *
 * Чего этот spec НЕ делает: не требует, чтобы меню существовало. Пустая
 * таксономия — законное состояние, и тогда прогон помечается «проверено нечем».
 * Тождество состава меню на всех страницах проверяет `category-menu-is-uniform`.
 */

import { expect, test } from '@playwright/test';

import { CATEGORY_MENU_LABEL, categoryMenuHrefs } from './support/category-menu.js';
import { fetchRaw, isRedirect } from './support/http.js';
import { noteNotChecked } from './support/not-checked.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const EMPTY_TAXONOMY_NOTE =
  `Адреса бокового меню категорий НЕ проверены: ориентира <nav aria-label="${CATEGORY_MENU_LABEL}"> ` +
  'в ответах нет. Меню печатается только при непустой таксономии, а опубликованных узлов на ' +
  'сайте сейчас нет: все записи `collections` стоят в статусе `review`, и перевод в `published` — ' +
  'решение человека (п. 7.1 и п. 23 ТЗ). Прогон прошёл ВХОЛОСТУЮ: зелёный статус здесь означает ' +
  '«нарушений не найдено, потому что проверять было нечего», а не покрытие. Полную силу проверка ' +
  'получает в день, когда человек опубликует первый узел таксономии.';

for (const page of ACCEPTANCE_PAGES) {
  test(`адреса бокового меню категорий отвечают 200: ${page.path} (${page.task})`, async ({
    request,
  }, testInfo) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, `Страница инвентаря обязана отдавать 200. ${page.note}`).toBe(200);

    const hrefs = categoryMenuHrefs(response.body);
    if (hrefs === null || hrefs.length === 0) {
      noteNotChecked(testInfo, `${EMPTY_TAXONOMY_NOTE} Страница: ${page.path}.`);
      return;
    }

    for (const href of hrefs) {
      expect(href, `Пункт меню на ${page.path} без атрибута href.`).not.toBeNull();
      const value = href ?? '';

      expect(
        value.startsWith('/'),
        `Пункт меню «${value}» на ${page.path} — не путь от корня сайта. Постоянная навигация ` +
          'ведёт по своему хосту (ровно один хост на весь сайт, «Правила URL»); абсолютный ' +
          'адрес в меню либо уводит на чужой origin, либо жёстко зашивает хост мимо SITE_URL.',
      ).toBe(true);
      expect(
        value,
        `Пункт меню «${value}» на ${page.path} содержит параметры или фрагмент. Адрес с ` +
          'параметрами не имеет собственного canonical (ТЗ §6.5), и постоянная навигация на ' +
          'него ссылаться не должна.',
      ).not.toMatch(/[?#]/u);
      expect(
        value === '/' || !value.endsWith('/'),
        `Пункт меню «${value}» на ${page.path} оканчивается слешем. Канонический вид маршрута — ` +
          'БЕЗ завершающего слеша (решение Ч-21), и такая ссылка стоила бы лишнего 301 на ' +
          'каждом переходе с каждой страницы сайта.',
      ).toBe(true);
    }

    // Дубли внутри одного меню — не косметика: один и тот же адрес двумя пунктами
    // означает, что дерево собрано с повторами, а посетитель видит два входа в
    // одно место.
    const unique = new Set(hrefs.map((href) => href ?? ''));
    expect(
      unique.size,
      `В боковом меню на ${page.path} один и тот же адрес встречается дважды: ` +
        `${hrefs.map((href) => String(href)).join(', ')}.`,
    ).toBe(hrefs.length);

    for (const href of unique) {
      const target_ = await fetchRaw(request, urlFor(target, href));
      expect(
        isRedirect(target_.status),
        `Пункт меню «${href}» (страница ${page.path}) отвечает переходом ` +
          `${String(target_.status)} → ${String(target_.location)}. Постоянная навигация обязана ` +
          'вести на конечный адрес: редирект в меню — лишний переход на каждом обходе, а ' +
          'цепочки редиректов запрещены прямо («Правила URL»).',
      ).toBe(false);
      expect(
        target_.status,
        `Пункт меню «${href}» (страница ${page.path}) отвечает ${String(target_.status)}. ` +
          'Слой данных обещает обратное: узлы отбираются предикатом `nodesWithContent`, то есть ' +
          'ссылка печатается тогда и только тогда, когда её адрес отвечает 200 ' +
          '(`apps/web/src/data/content.ts`). Битый пункт постоянного меню — битая ссылка со ' +
          'всех страниц сайта сразу.',
      ).toBe(200);
    }
  });
}
