/**
 * Требование (п. 22, `CLAUDE.md` — «Sitemap и robots»; задача Э4-04): цепочка
 * карты сайта проходима целиком. `/sitemap.xml` — валидный XML с корнем
 * `sitemapindex`, и КАЖДЫЙ файл, на который он ссылается, существует и тоже
 * является валидной картой.
 *
 * ## Почему это отдельное требование, а не часть проверки состава
 *
 * Состав карты («в ней только 200, canonical и indexable») и проходимость
 * цепочки ломаются по-разному. Индекс, ссылающийся на 404, — это карта, которую
 * поисковая система не может прочитать вовсе; в отчёте вебмастера это выглядит
 * как «карта не обработана», и ни один адрес из неё в индекс не попадёт, даже
 * если состав безупречен. Причина такой поломки тоже своя: части нумеруются с
 * единицы и существуют ровно те, что перечислены в индексе, — разойдясь, индекс
 * и маршрут части дают ровно этот случай.
 *
 * ## Валидность проверяется настоящим XML-парсером
 *
 * Разбор идёт через `DOMParser` браузера (`support/xml.ts`, там же разбор
 * причин). Регулярное выражение достало бы `<loc>` и из документа с оборванным
 * `</urlset>`, то есть spec остался бы зелёным на файле, который поисковая
 * система отвергнет.
 *
 * ## Про пустой прогон
 *
 * Индекс сейчас пуст: ни одна страница не открыта в `index,follow` (Ч-04-1).
 * Второй тест при этом проходит ВХОЛОСТУЮ, и прогон помечается аннотацией
 * «проверено нечем» — зелёный на пустом обходе покрытием не является. Правок в
 * spec в день первой публикации не потребуется: состав он берёт из самого
 * индекса.
 */

import { expect, test } from '@playwright/test';

import { fetchRaw } from './support/http.js';
import {
  annotateEmptyRun,
  readSitemapTree,
  SITEMAP_INDEX_PATH,
} from './support/sitemap-tree.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';
import { createXmlParser, SITEMAP_NAMESPACE } from './support/xml.js';

const target = resolveAcceptanceTarget();

/**
 * Свой бюджет времени: сюда попадает первый запуск chromium, нужного для
 * разбора XML. Утверждения при этом ждут не дольше `expect.timeout` из конфига,
 * поэтому зависший ответ длинным таймаутом не спрячется.
 */
test.describe.configure({ timeout: 180_000 });

test('sitemap-индекс отвечает 200 и является валидным XML с корнем sitemapindex', async ({
  browser,
  request,
}) => {
  const response = await fetchRaw(request, urlFor(target, SITEMAP_INDEX_PATH));

  expect(
    response.status,
    `${SITEMAP_INDEX_PATH} обязан отвечать 200 всегда, в том числе на ненаполненном сайте: на ` +
      'этот адрес ссылается robots.txt, и 404 на нём выглядит поломкой, а не пустотой.',
  ).toBe(200);
  expect(response.location, 'Индекс карты сайта не отвечает переходом.').toBeNull();
  expect(
    (response.contentType ?? '').toLowerCase(),
    'Карта сайта отдаётся как XML.',
  ).toContain('xml');

  const parser = await createXmlParser(browser);
  try {
    const parsed = await parser.parse(response.body);

    expect(
      parsed.parseError,
      `${SITEMAP_INDEX_PATH} не разобрался как XML. Поисковая система дефектный документ не ` +
        'чинит — она отвергает файл целиком, и вместе с ним все адреса, которые он перечисляет.',
    ).toBeNull();
    expect(
      parsed.rootLocalName,
      'Корень индекса — sitemapindex. Корень urlset означает, что по адресу индекса лежит ' +
        'обычная карта: поисковая система прочитает её как перечень СТРАНИЦ, и адреса файлов ' +
        'карты попадут в индекс как страницы.',
    ).toBe('sitemapindex');
    expect(
      parsed.rootNamespace,
      'Пространство имён обязано быть схемой sitemaps.org 0.9: документ без него не карта ' +
        'сайта, а просто XML.',
    ).toBe(SITEMAP_NAMESPACE);
  } finally {
    await parser.close();
  }
});

test('каждый файл из sitemap-индекса отвечает 200 и является валидной картой', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);

  expect(
    tree.index.parsed.parseError,
    'Индекс не разобрался как XML — обойти его файлы нельзя. Причину называет соседний тест ' +
      'этого же spec.',
  ).toBeNull();

  if (tree.files.length === 0) {
    annotateEmptyRun(testInfo, 'Проходимость цепочки «индекс → файлы карты» НЕ проверена.');
    return;
  }

  const broken = tree.files
    .map((file) => {
      if (file.response.status !== 200) {
        return `${file.url} → ${String(file.response.status)}`;
      }
      if (file.response.location !== null) {
        return `${file.url} → переход на ${file.response.location}`;
      }
      if (!(file.response.contentType ?? '').toLowerCase().includes('xml')) {
        return `${file.url} → тип «${file.response.contentType ?? '—'}», а не XML`;
      }
      if (file.parsed.parseError !== null) {
        return `${file.url} → не разобрался как XML: ${file.parsed.parseError}`;
      }
      if (file.parsed.rootLocalName !== 'urlset') {
        return `${file.url} → корень «${file.parsed.rootLocalName ?? '—'}», а не urlset`;
      }
      if (file.parsed.rootNamespace !== SITEMAP_NAMESPACE) {
        return `${file.url} → пространство имён «${file.parsed.rootNamespace ?? '—'}»`;
      }
      if (file.parsed.urlEntries.length === 0) {
        return `${file.url} → ноль записей <url>: пустой urlset невалиден по схеме, и такой ` +
          'файл не выкладывается вовсе — его адрес обязан отвечать 404';
      }
      return null;
    })
    .filter((problem): problem is string => problem !== null);

  expect(
    broken,
    'Индекс перечисляет файлы, которые нельзя прочитать. Для поисковой системы это не частичная ' +
      'потеря, а необработанная карта: адреса из неё в индекс не идут. Частей карты существуют ' +
      'ровно те, что названы в индексе (нумерация с единицы), поэтому расхождение здесь означает, ' +
      'что индекс и маршрут части считают части по-разному.',
  ).toEqual([]);
});
