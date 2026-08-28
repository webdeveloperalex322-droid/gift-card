/**
 * Обход карты сайта: индекс → перечисленные в нём файлы → адреса страниц.
 *
 * Модуль отвечает на один вопрос — «что сейчас лежит в карте сайта», — и не
 * содержит ни одного утверждения. Утверждения живут в specs, по одному
 * требованию на файл: иначе падение говорило бы «карта сайта сломана» вместо
 * «в карте адрес, отвечающий 404».
 *
 * ## Почему обход, а не список известных адресов
 *
 * Состав файлов карты меняется от объёма каталога: `sitemap-cards-1.xml`,
 * `-2.xml` и так далее появляются по мере наполнения (`MAX_URLS_PER_SITEMAP` в
 * `apps/web/src/seo/sitemap.ts`). Приёмка, знающая список файлов заранее,
 * проверяла бы известные ей и молчала бы о новых — то есть первый же файл,
 * появившийся сверх ожидаемых, оказался бы вне проверки. Поэтому источник
 * состава здесь ровно один: сам индекс, как его читает поисковая система.
 *
 * ## Пустая карта — законное состояние, а не пропуск
 *
 * Пока ни одна страница не открыта в `index,follow` (Ч-04-1: спрос данными не
 * подтверждён), индекс пуст и обход возвращает ноль файлов. Это не повод
 * молчать: specs обязаны пометить такой прогон аннотацией «проверено нечем» —
 * зелёный на пустом обходе не является покрытием. Готовый текст аннотации
 * ставит {@link annotateEmptyRun}, чтобы формулировка была одной во всех specs.
 */

import type { APIRequestContext, Browser } from '@playwright/test';

import { fetchRaw, type RawResponse } from './http.js';
import { type AnnotatableTestInfo, noteNotChecked } from './not-checked.js';
import { type AcceptanceTarget, urlFor } from './target.js';
import { createXmlParser, type ParsedSitemapXml } from './xml.js';

/** Адрес индекса карты сайта. На него же ссылается `robots.txt` (решение Ч-22). */
export const SITEMAP_INDEX_PATH = '/sitemap.xml';

/** Один запрошенный и разобранный документ карты сайта. */
export interface SitemapDocument {
  /** Абсолютный адрес, по которому документ запрошен. */
  readonly url: string;
  readonly response: RawResponse;
  readonly parsed: ParsedSitemapXml;
}

export interface SitemapTree {
  /** Ответ и разбор `/sitemap.xml`. */
  readonly index: SitemapDocument;
  /**
   * Документы, на которые ссылается индекс, — в порядке перечисления.
   *
   * Сюда попадает КАЖДЫЙ `<loc>` индекса, включая тот, что ответил 404 или
   * невалидным XML: решение «это нарушение» принимает spec, а не обход.
   * Пропустив такой адрес здесь, обход спрятал бы ровно то, что проверяется.
   */
  readonly files: readonly SitemapDocument[];
  /** Все адреса страниц из всех `urlset` дерева. */
  readonly pageUrls: readonly string[];
}

/**
 * Читает индекс и все перечисленные в нём файлы.
 *
 * Адрес из `<loc>` разрешается относительно самого документа (`new URL`): в
 * карте сайта он обязан быть абсолютным, но проверка этого — требование
 * отдельного spec'а, и обход не должен падать раньше, чем spec успеет назвать
 * нарушение.
 */
export async function readSitemapTree(
  request: APIRequestContext,
  browser: Browser,
  target: AcceptanceTarget,
): Promise<SitemapTree> {
  const parser = await createXmlParser(browser);
  try {
    const indexUrl = urlFor(target, SITEMAP_INDEX_PATH);
    const indexResponse = await fetchRaw(request, indexUrl);
    const index: SitemapDocument = {
      parsed: await parser.parse(indexResponse.body),
      response: indexResponse,
      url: indexUrl,
    };

    const files: SitemapDocument[] = [];
    const pageUrls: string[] = [];

    for (const entry of index.parsed.sitemapEntries) {
      if (entry.loc === null || entry.loc === '') {
        continue;
      }
      let fileUrl: string;
      try {
        fileUrl = new URL(entry.loc, indexUrl).toString();
      } catch {
        continue;
      }
      const response = await fetchRaw(request, fileUrl);
      const parsed = await parser.parse(response.body);
      files.push({ parsed, response, url: fileUrl });
      for (const urlEntry of parsed.urlEntries) {
        if (urlEntry.loc !== null && urlEntry.loc !== '') {
          pageUrls.push(urlEntry.loc);
        }
      }
    }

    return { files, index, pageUrls };
  } finally {
    await parser.close();
  }
}

/**
 * Все `<loc>` индекса как они записаны в документе, без разрешения
 * относительно базы. Нужны spec'у, который проверяет ФОРМУ адреса.
 */
export function indexLocs(tree: SitemapTree): readonly string[] {
  return tree.index.parsed.sitemapEntries
    .map((entry) => entry.loc)
    .filter((loc): loc is string => loc !== null);
}

/** Все `<loc>` записей `<url>` во всех файлах — как они записаны в документе. */
export function pageLocs(tree: SitemapTree): readonly string[] {
  return tree.files.flatMap((file) =>
    file.parsed.urlEntries.map((entry) => entry.loc).filter((loc): loc is string => loc !== null),
  );
}

/** Файлы дерева, которые являются image sitemap: их адрес начинается с этой основы. */
export const SITEMAP_IMAGES_PREFIX = 'sitemap-images-';

export function isImageSitemapUrl(url: string): boolean {
  try {
    const segments = new URL(url).pathname.split('/');
    return (segments[segments.length - 1] ?? '').startsWith(SITEMAP_IMAGES_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Помечает прогон по ПУСТОЙ карте сайта.
 *
 * Формулировка одна на все specs намеренно: три разных описания одного и того же
 * состояния читались бы как три разных состояния. Механика пометки (аннотация
 * плюс строка в stdout) и её обоснование — в `./not-checked.ts`.
 */
export function annotateEmptyRun(testInfo: AnnotatableTestInfo, what: string): void {
  noteNotChecked(
    testInfo,
    `${what} В индексе /sitemap.xml сейчас ноль файлов: ни одна страница не выполняет трёх ` +
      'условий включения (ответ 200, разрешение на индексацию, собственный canonical), ' +
      'потому что ни одна страница сайта пока не открыта в index,follow (Ч-04-1 — спрос ' +
      'данными не подтверждён). Прогон прошёл ВХОЛОСТУЮ: зелёный статус здесь означает ' +
      '«нарушений не найдено, потому что проверять было нечего», а не покрытие. Полную силу ' +
      'проверка получает в день, когда человек откроет в индекс первую страницу; правок в ' +
      'spec для этого не нужно.',
  );
}
