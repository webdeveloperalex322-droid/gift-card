/**
 * Требование (решение Ч-21): правило завершающего слеша — про маршруты СТРАНИЦ.
 * URL файлов слешем не заканчиваются, и middleware их не нормализует: у
 * файлового URL нет второй формы, а редирект на URL файла означал бы, что
 * постоянный адрес файла перестал быть постоянным.
 *
 * Проверяется единственное, что можно проверить сейчас: по каноническому URL
 * файла сервер НЕ отвечает переходом. Статус 200 не проверяется — `/robots.txt`
 * и `/sitemap.xml` появляются на этапе 4 (Э4-03, Э4-04), `/media/...` наполняется
 * реальными производными на Э2-05/Э3-04. До тех пор честный ответ — 404, и
 * spec'у важно ровно одно: что это не 301.
 *
 * Одно расхождение зафиксировано и проверяется НЕ здесь: обращение с
 * завершающим слешем (`/robots.txt/`) Astro всё равно нормализует своим 301 —
 * в ветке `never` он расширение не смотрит. Наш код в этом случае не делает
 * ничего (`isPageRoute` отсекает файловые URL раньше), поэтому второго перехода
 * не появляется. Разбор — в `apps/web/src/routing/path-policy.ts`, шаг 3.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw, isRedirect } from './support/http.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

const FILE_URLS: readonly { readonly path: string; readonly note: string }[] = [
  { path: '/robots.txt', note: 'появится на Э4-04' },
  { path: '/sitemap.xml', note: 'sitemap-индекс, появится на Э4-03' },
  { path: '/sitemap-cards-1.xml', note: 'производный sitemap, Э4-03' },
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
