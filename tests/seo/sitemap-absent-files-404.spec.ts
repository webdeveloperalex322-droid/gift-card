/**
 * Требование (`CLAUDE.md`, «HTTP-статусы» и «Правила URL»; задача Э4-04): у
 * одного файла карты сайта один адрес, и адреса, которого не существует, не
 * бывает «почти существующим». Номер части — целое с единицы; `0`, `01` и номер
 * за пределами набора отвечают 404 без `Location`.
 *
 * ## Почему это важно именно для карты сайта
 *
 * Форма номера здесь та же по смыслу, что у пагинации `/page/N`, но цена ошибки
 * другая. Пустой `<urlset>`, отданный с кодом 200 вместо 404, поисковая система
 * читает не как «файла нет», а как «файл есть и в нём ноль страниц» — то есть
 * как сообщение об удалении всего, что в этом файле лежало раньше. А `01`,
 * отвечающий тем же содержимым, что `1`, даёт второй адрес одного файла: карта
 * сайта индексируется, и два её адреса — это дубль.
 *
 * ## Что здесь НЕ проверяется
 *
 * Что файл, названный в индексе, отвечает 200: это соседнее требование, и его
 * держит `sitemap-index-chain.spec.ts`. Здесь только обратная сторона —
 * несуществующее не отвечает.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import { readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

test.describe.configure({ timeout: 180_000 });

const ABSENT_FILES: readonly { readonly path: string; readonly note: string }[] = [
  {
    path: '/sitemap-cards-0.xml',
    note: 'нумерация частей идёт с единицы, части «0» не бывает',
  },
  {
    path: '/sitemap-cards-01.xml',
    note: 'ведущий ноль — не номер: иначе у одного файла было бы два адреса',
  },
  {
    path: '/sitemap-cards-999.xml',
    note: 'номер за пределами набора: такой части нет ни при каком объёме каталога',
  },
  { path: '/sitemap-images-0.xml', note: 'то же правило для image sitemap' },
  { path: '/sitemap-images-01.xml', note: 'то же правило для image sitemap' },
  { path: '/sitemap-images-999.xml', note: 'то же правило для image sitemap' },
];

for (const file of ABSENT_FILES) {
  test(`несуществующая часть карты сайта отвечает 404: ${file.path} (${file.note})`, async ({
    request,
  }) => {
    const response = await fetchRaw(request, urlFor(target, file.path));

    expect(
      response.status,
      `${file.path} обязан отвечать 404. Получено ${String(response.status)}. Ответ 200 с ` +
        'пустым <urlset> поисковая система читает как «файл есть и в нём ноль страниц», то есть ' +
        'как сообщение об удалении всего, что в нём лежало.',
    ).toBe(404);

    expect(
      response.location,
      'У несуществующей части карты не должно быть Location: перевести робота с одного адреса ' +
        'файла карты на другой значило бы завести второй адрес того же файла.',
    ).toBeNull();
  });
}

/**
 * Номер, следующий за последним существующим, — 404.
 *
 * Утверждение работает и на пустой карте (тогда проверяется часть №1, которой
 * действительно нет), и на наполненной: когда частей станет три, тест сам
 * начнёт спрашивать четвёртую. Фиксированный номер `999` из списка выше этого не
 * даёт — он останется несуществующим при любом правдоподобном объёме каталога и
 * потому ничего не скажет о ГРАНИЦЕ набора.
 */
const PART_PREFIXES = ['sitemap-cards', 'sitemap-images'] as const;

test('часть, следующая за последней существующей, отвечает 404', async ({ browser, request }) => {
  const tree = await readSitemapTree(request, browser, target);

  const namedParts = new Set(
    tree.files.map((file) => {
      const segments = new URL(file.url).pathname.split('/');
      return segments[segments.length - 1] ?? '';
    }),
  );

  const problems: string[] = [];

  for (const prefix of PART_PREFIXES) {
    let next = 1;
    while (namedParts.has(`${prefix}-${String(next)}.xml`)) {
      next += 1;
    }
    const path = `/${prefix}-${String(next)}.xml`;
    const response = await fetchRaw(request, urlFor(target, path));
    if (response.status !== 404) {
      problems.push(
        `${path} → ${String(response.status)}, а индекс такой части не называет. Существуют ` +
          'ровно те части, что перечислены в индексе: файл, отвечающий мимо индекса, поисковая ' +
          'система не найдёт, а найдя по старой ссылке — прочитает как отдельную карту.',
      );
    }
    if (response.location !== null) {
      problems.push(`${path} → Location: ${response.location}, а обязан быть чистый 404.`);
    }
  }

  expect(problems, `Частей, названных индексом: ${String(namedParts.size)}.`).toEqual([]);
});
