/**
 * Требование (п. 22 «image sitemap валиден», ТЗ §7.3; задача Э4-04): image
 * sitemap объявляет пространство имён `sitemap-image/1.1`, у каждой записи
 * `<url>` есть хотя бы один `<image:loc>`, и файл по этому адресу действительно
 * отдаётся изображением.
 *
 * ## Почему проверяется КАЖДЫЙ из трёх пунктов
 *
 * Они ломаются независимо, и каждая поломка выглядит как работающий файл:
 *
 *   - без объявления `xmlns:image` элементы `<image:image>` для валидатора
 *     Google не существуют. Документ при этом валидный XML, обычный `urlset`
 *     читается, и в отчёте вебмастера видно «карта обработана» — просто ни одно
 *     изображение из неё не учтено;
 *   - `<url>` без `<image:loc>` ничего не описывает. Сам код это запрещает
 *     (`renderImageUrlset` бросает исключение), но запрет живёт на стороне
 *     сборки документа: страница без изображения не должна дойти до отбора, и
 *     проверить, что не доходит, можно только на готовом файле;
 *   - адрес изображения, отвечающий 404 или отдающий HTML, — самая частая из
 *     трёх. Он появляется, когда карта строится по ПОЛЮ записи, а страница
 *     показывает производную с другим ключом (ревизия, суффикс `-N`), то есть
 *     ровно тогда, когда карта и страница расходятся в том, какой файл считать
 *     изображением открытки.
 *
 * ## Про пустой прогон
 *
 * Пока ни одна карточка не открыта в `index,follow` (Ч-04-1), image sitemap не
 * существует вовсе: пустой файл не выкладывается, и индекс на него не
 * ссылается. Тест проходит ВХОЛОСТУЮ и помечает прогон аннотацией «проверено
 * нечем».
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import {
  annotateEmptyRun,
  isImageSitemapUrl,
  readSitemapTree,
} from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';
import { SITEMAP_IMAGE_NAMESPACE } from './support/xml.js';

const target = resolveAcceptanceTarget();

test.describe.configure({ timeout: 180_000 });

test('image sitemap объявляет пространство имён и у каждой записи есть <image:loc>', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);
  const imageFiles = tree.files.filter((file) => isImageSitemapUrl(file.url));

  if (imageFiles.length === 0) {
    annotateEmptyRun(
      testInfo,
      'Image sitemap НЕ проверен: индекс не называет ни одного такого файла.',
    );
    return;
  }

  const problems: string[] = [];

  for (const file of imageFiles) {
    const declared = Object.entries(file.parsed.rootNamespaceDeclarations).filter(
      ([, uri]) => uri === SITEMAP_IMAGE_NAMESPACE,
    );
    if (declared.length === 0) {
      problems.push(
        `${file.url} — на корне не объявлено пространство имён «${SITEMAP_IMAGE_NAMESPACE}». ` +
          'Без объявления элементы <image:image> для валидатора не существуют, а документ ' +
          'выглядит валидной картой.',
      );
    }

    file.parsed.urlEntries.forEach((entry, position) => {
      if (entry.imageLocs.length === 0) {
        problems.push(
          `${file.url} — запись №${String(position + 1)} («${entry.loc ?? 'без <loc>'}») не ` +
            'содержит ни одного <image:loc>. Такая запись ничего не описывает: в image sitemap ' +
            'отбираются только страницы, показывающие изображение.',
        );
      }
      if (entry.imageLocs.some((loc) => loc === '')) {
        problems.push(
          `${file.url} — у записи «${entry.loc ?? '—'}» пустой <image:loc>.`,
        );
      }
    });
  }

  expect(
    problems,
    `Проверено файлов image sitemap: ${String(imageFiles.length)}.`,
  ).toEqual([]);
});

test('каждый <image:loc> отдаётся изображением с кодом 200', async ({ browser, request }, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);
  const imageLocs = [
    ...new Set(
      tree.files
        .filter((file) => isImageSitemapUrl(file.url))
        .flatMap((file) => file.parsed.urlEntries.flatMap((entry) => entry.imageLocs))
        .filter((loc) => loc !== ''),
    ),
  ];

  if (imageLocs.length === 0) {
    annotateEmptyRun(testInfo, 'Отдача файлов из image sitemap НЕ проверена: адресов в ней нет.');
    return;
  }

  const problems: string[] = [];

  for (const loc of imageLocs) {
    let absolute: string;
    try {
      absolute = new URL(loc).toString();
    } catch {
      problems.push(`«${loc}» — не абсолютный адрес файла.`);
      continue;
    }

    const response = await fetchRaw(request, absolute);

    if (response.status !== 200) {
      problems.push(
        `${loc} → ${String(response.status)}. Адрес изображения в карте обязан отвечать 200: ` +
          'иначе карта описывает изображение, которого нет, а страница показывает другое.',
      );
      continue;
    }
    if (response.location !== null) {
      problems.push(
        `${loc} → переход на ${response.location}. URL файла постоянен (раздел «Изображения»): ` +
          'редирект здесь означает, что постоянный адрес перестал быть постоянным.',
      );
      continue;
    }

    const contentType = (response.contentType ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      problems.push(
        `${loc} → тип «${response.contentType ?? '—'}», а не image/*. Чаще всего так отвечает ` +
          'страница 404 или HTML-заглушка, отданная с кодом 200.',
      );
    }
  }

  expect(problems, `Проверено адресов изображений: ${String(imageLocs.length)}.`).toEqual([]);
});
