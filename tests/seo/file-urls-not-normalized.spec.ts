/**
 * Требование (решение Ч-21): правило завершающего слеша — про маршруты СТРАНИЦ.
 * URL файлов слешем не заканчиваются, и middleware их не нормализует: у
 * файлового URL нет второй формы, а редирект на URL файла означал бы, что
 * постоянный адрес файла перестал быть постоянным.
 *
 * Проверяется, что по каноническому URL файла сервер НЕ отвечает переходом.
 * Статус здесь не утверждается намеренно: он зависит от состояния сайта
 * (`/media/...` наполняется реальными производными, части карты существуют ровно
 * те, что названы в индексе), а требование этого spec'а — про ФОРМУ адреса.
 * Статус самих `/robots.txt` и `/sitemap.xml` утверждают specs своего
 * требования: `robots-txt-contract.spec.ts` и `sitemap-index-chain.spec.ts`.
 *
 * Второй блок — СОСЕДНИЕ формы имени файла (дополнение, задача Э4-03/Э4-04). У
 * файлового URL одна форма, и все похожие на неё обязаны отвечать 404 без
 * `Location`: `/robots.txt/` и `/sitemap.xml/` (завершающий слеш), `/sitemap`
 * (имя без расширения — оно зарезервировано реестром ровно потому, что путается
 * с `/sitemap.xml`), `/sitemap-cards-1.xml/`. Редирект с любой из них означал бы
 * вторую форму адреса файла, а ответ 200 — второй адрес одного файла.
 *
 * Одно расхождение зафиксировано и разбирается там же: обращение с завершающим
 * слешем (`/robots.txt/`) Astro всё равно нормализует своим 301 — в ветке
 * `never` он расширение не смотрит. Наш код в этом случае не делает ничего
 * (`isPageRoute` отсекает файловые URL раньше), поэтому второго перехода не
 * появляется, а итог — 404. Разбор — в `apps/web/src/routing/path-policy.ts`,
 * шаг 3.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw, isRedirect } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const FILE_URLS: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/robots.txt', note: 'файл директив обхода, Э4-03' },
  { path: '/sitemap.xml', note: 'sitemap-индекс, Э4-04' },
  { path: '/sitemap-cards-1.xml', note: 'часть карты карточек, Э4-04' },
  {
    path: '/media/cards/a1b2c3/otkrytka-mame-na-8-marta-640.webp',
    note: 'производная изображения: URL файла постоянен (раздел «Изображения»)',
  },
];

for (const file of FILE_URLS) {
  test(`URL файла не нормализуется: ${file.path} (${file.note})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, file.path));

    expect(
      isRedirect(response.status),
      `URL файла обязан отвечать сам, а не переходом. Получено ${String(response.status)}` +
        `${response.location === null ? '' : ` Location: ${response.location}`}.`,
    ).toBe(false);
    expect(
      response.location,
      'У ответа на URL файла не должно быть заголовка Location.',
    ).toBeNull();
  });
}

/**
 * Соседние формы имени файла: похожи на адрес файла, но адресами не являются.
 *
 * Каждая из них однажды приводила к двум адресам одного файла в реальных
 * проектах, поэтому проверяются они, а не «что-нибудь несуществующее»:
 *
 *   - завершающий слеш у файлового URL. Правило Ч-21 к файлам не применяется, и
 *     нормализовать такой адрес нельзя: 301 означал бы, что у файла есть вторая
 *     форма, а 200 — что их две одновременно;
 *   - имя БЕЗ расширения (`/sitemap`). Оно зарезервировано реестром именно
 *     потому, что путается с `/sitemap.xml`: подборка со slug `sitemap` заняла
 *     бы этот адрес, и получилась бы страница, которую и человек, и робот
 *     принимают за карту сайта;
 *   - путь ПОД файлом (`/robots.txt/istoriya`). У файла нет подмаршрутов, и
 *     ответ 200 на таком адресе означает, что маршрут разбирает путь не целиком.
 */
const FILE_URL_NEIGHBOURS: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/robots.txt/', note: 'завершающий слеш у файлового URL' },
  { path: '/sitemap.xml/', note: 'завершающий слеш у sitemap-индекса' },
  { path: '/sitemap-cards-1.xml/', note: 'завершающий слеш у части карты' },
  { path: '/sitemap', note: 'имя без расширения: реестр резервирует и его' },
  { path: '/robots', note: 'имя без расширения для robots.txt' },
  { path: '/robots.txt/istoriya', note: 'путь под файлом — подмаршрутов у файла нет' },
];

for (const neighbour of FILE_URL_NEIGHBOURS) {
  test(`соседняя форма имени файла отвечает 404: ${neighbour.path} (${neighbour.note})`, async ({
    request,
  }) => {
    const response = await fetchRaw(request, urlFor(target, neighbour.path));

    expect(
      response.status,
      `${neighbour.path} обязан отвечать 404. Получено ${String(response.status)}` +
        `${response.location === null ? '' : ` Location: ${response.location}`}. Ответ 200 ` +
        'здесь — второй адрес одного файла, а 301 — вторая форма постоянного URL файла.',
    ).toBe(404);

    expect(
      response.location,
      'У 404 на соседней форме имени файла не должно быть Location: перевод робота с неё на ' +
        'настоящий файл узаконил бы вторую форму адреса.',
    ).toBeNull();
  });
}
