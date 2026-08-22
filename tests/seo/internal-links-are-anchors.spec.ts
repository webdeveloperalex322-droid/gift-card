/**
 * Требование (п. 22 + раздел «Рендеринг»): внутренние ссылки — только
 * `<a href>`; hash-маршрутизация запрещена; переходов «по onclick» нет.
 *
 * Честная оговорка о текущей силе проверки: на странице волны 0 (`/` — заглушка
 * Э3-01) ссылок нет ни одной, поэтому утверждения о форме ссылок сейчас ничего
 * не доказывают. Проверка начнёт работать, когда появятся навигация и блоки
 * перелинковки (Э3-05…Э3-09). Утверждение, которое работает уже сейчас, —
 * отсутствие обработчиков `onclick`, которыми навигацию иногда подменяют.
 *
 * Заглушки-скипа на «страницы, которых ещё нет», здесь нет намеренно: как только
 * страница появляется в инвентаре, она попадает в эту проверку без правки
 * spec'а.
 */

import { expect, test } from '@playwright/test';

import { anchorTags, openingTags } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

for (const page of ACCEPTANCE_PAGES) {
  test(`ссылки — только <a href>: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const anchors = anchorTags(response.body);

    expect(
      anchors.filter((anchor) => anchor.href === null || anchor.href.trim() === '').map((a) => a.tag),
      '<a> без href ссылкой не является: робот по ней не пойдёт.',
    ).toEqual([]);

    expect(
      anchors
        .filter((anchor) => (anchor.href ?? '').trim().toLowerCase().startsWith('javascript:'))
        .map((anchor) => anchor.tag),
      'Ссылка через javascript: — это скрытая от робота навигация.',
    ).toEqual([]);

    expect(
      anchors.filter((anchor) => (anchor.href ?? '').trim().startsWith('#')).map((a) => a.tag),
      'Hash-маршрутизация запрещена: адрес без серверного ответа страницей не является. ' +
        '(Якорь внутри страницы допустим только как дополнение к обычной ссылке — если он ' +
        'здесь появился осознанно, это правка spec\'а вместе с решением, а не молча.)',
    ).toEqual([]);

    const withInlineHandler = [
      ...openingTags(response.body, 'a'),
      ...openingTags(response.body, 'div'),
      ...openingTags(response.body, 'span'),
      ...openingTags(response.body, 'button'),
    ].filter((tag) => /\bon(click|mousedown|keydown)\s*=/i.test(tag));

    expect(
      withInlineHandler,
      'Переход по обработчику события вместо <a href> — контент, скрытый за JavaScript.',
    ).toEqual([]);
  });
}
