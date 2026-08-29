/**
 * Выгрузка SEO-инвентаря в CSV (задача Э5-05, ТЗ §8.5).
 *
 * Колонки ТЗ: URL, тип страницы, статус записи, HTTP-статус, robots, canonical,
 * title, наличие в sitemap, дата обновления.
 *
 * ═══ ОТКУДА БЕРЁТСЯ КАЖДАЯ КОЛОНКА И ПОЧЕМУ ИМЕННО ОТТУДА ═══
 *
 * DoD задачи требует, чтобы HTTP-статус и наличие в sitemap СООТВЕТСТВОВАЛИ
 * фактическому ответу сайта. У CMS этого знания нет и быть не может: решение о
 * составе карты (`sitemapEligibility`, `decideSitemapUrl`) и об индексируемости
 * (`resolvePageRobots`) живёт в `apps/web`, зависит от данных, которых в записи
 * нет (например, собрались ли производные файлы изображения), и импортировать
 * `.ts` чужого приложения в CMS нельзя.
 *
 * Из трёх возможных путей выбран ПЕРВЫЙ — спросить сайт по HTTP:
 *
 *   1. ВЫБРАНО. Выгрузка запрашивает каждый адрес и карту сайта у живого сайта.
 *      Колонка «фактический ответ» тогда и есть фактический ответ — честность
 *      не выводится рассуждением, а получается измерением. Цена: выгрузка идёт
 *      столько, сколько идут запросы, и зависит от поднятого сайта. Когда сайт
 *      не отвечает, ячейки остаются ПУСТЫМИ и выдаётся предупреждение: пустая
 *      ячейка — это «не измерено», а любое подставленное значение выглядело бы
 *      измеренным;
 *   2. отвергнуто: вынести предикаты в `packages/shared`. Часть из них опирается
 *      на данные, которых у CMS нет, поэтому перенос дал бы не одну трактовку на
 *      двоих, а вторую трактовку рядом с первой;
 *   3. запрещено: считать заново в CMS. Это ровно второй источник истины о
 *      составе индекса — в проекте на нём уже дважды обжигались.
 *
 * Поэтому колонки разделены по источнику, и разделение это не стилистическое:
 *
 *   ИЗ ЗАПИСИ (факты о записи, существуют в любом статусе):
 *     URL             — путь записи + единственный хелпер `buildAbsoluteUrl`;
 *     тип страницы    — коллекция и вид узла;
 *     статус записи   — draft / review / published;
 *     robots          — директива, выбранная редактором в поле записи;
 *     title           — заголовок записи;
 *     дата обновления — `updatedContentAt` (источник lastmod), иначе `updatedAt`.
 *
 *   ИЗ ОТВЕТА САЙТА (факты о странице; у черновика их нет вовсе):
 *     HTTP-статус     — код ответа, без следования за редиректом;
 *     canonical       — `<link rel="canonical">` из HTML. Из записи его взять
 *                       нельзя: поле `canonical` в CMS — это ПЕРЕОПРЕДЕЛЕНИЕ, и
 *                       оно почти всегда пусто, а вывести self-canonical в CMS
 *                       заново — это путь 3, запрещённый;
 *     в sitemap       — присутствие URL в файлах карты, прочитанных с сайта.
 *
 * ═══ КУДА ХОДИТ ВЫГРУЗКА ═══
 *
 * Только на origin из `SITE_URL` — тот же единственный источник хоста, из
 * которого собираются canonical и карта сайта. Адрес НЕ принимается ни
 * параметром запроса, ни отдельной переменной окружения: параметр превратил бы
 * выгрузку в инструмент запросов с сервера CMS на произвольный хост, а вторая
 * переменная означала бы второй хост у одного сайта. Практическое следствие:
 * если из процесса CMS `SITE_URL` не резолвится, колонки ответа будут пусты — и
 * это верное поведение, а не поломка.
 */
import { buildAbsoluteUrl, resolveSiteOrigin, type SharedEnv } from '@otkritka/shared';

import { COLLECTION_NODE_KIND_LABELS, isCollectionNodeKind } from '../collections/collection-path';
import type { ContentCollectionSlug } from '../seo/paths';
import { type CsvValue, csvDocument } from './csv';

/** Заголовки колонок — в порядке ТЗ §8.5, дословно по составу. */
export const INVENTORY_COLUMNS = [
  'URL',
  'Тип страницы',
  'Статус записи',
  'HTTP-статус',
  'robots',
  'canonical',
  'title',
  'В sitemap',
  'Дата обновления',
] as const;

/** Значение ячейки «В sitemap». `null` в наблюдении даёт пустую ячейку. */
const SITEMAP_YES = 'да';
const SITEMAP_NO = 'нет';

/**
 * Предел числа строк выгрузки.
 *
 * ПРОВЕНАНС: выбор агента, не решение человека (кандидат в реестр решений рядом
 * с `MAX_BATCH_SELECTION` и `MAX_UPLOAD_BYTES`). Смысл — не в размере файла: при
 * включённом опросе сайта каждая строка стоит одного HTTP-запроса, и выгрузка
 * без предела превращается в обход всего сайта по нажатию кнопки. Превышение не
 * молчит: строки обрезаются, а в предупреждениях появляется сколько именно.
 */
export const MAX_INVENTORY_ROWS = 5000;

/** Сколько запросов к сайту идёт одновременно. Умеренно: это свой же сайт. */
export const PROBE_CONCURRENCY = 6;

/** Факты записи — всё, что выгрузка знает без обращения к сайту. */
export interface InventoryRecord {
  readonly collection: ContentCollectionSlug;
  readonly nodeKind?: unknown;
  /** Относительный путь записи; `null` — путь ещё не собран, строки не будет. */
  readonly path: string | null;
  readonly robots?: unknown;
  readonly status?: unknown;
  readonly title?: unknown;
  readonly updatedAt?: unknown;
  readonly updatedContentAt?: unknown;
}

/** Факты ответа сайта по одному адресу. `null` — «не измерено». */
export interface SiteObservation {
  readonly canonical: string | null;
  readonly httpStatus: number | null;
  readonly inSitemap: boolean | null;
}

/** Наблюдение, которого не было: сайт не спрашивали или он не ответил. */
export const UNOBSERVED: SiteObservation = { canonical: null, httpStatus: null, inSitemap: null };

/**
 * Подпись типа страницы.
 *
 * У подборок берётся из `COLLECTION_NODE_KIND_LABELS` — тех же подписей, что
 * видит редактор в админке и что стоят в текстах отказов. Своих названий здесь
 * нет намеренно: две системы подписей для одного вида узла разъезжаются молча.
 */
export function inventoryPageType(record: InventoryRecord): string {
  if (record.collection === 'cards') {
    return 'Открытка';
  }
  return isCollectionNodeKind(record.nodeKind)
    ? COLLECTION_NODE_KIND_LABELS[record.nodeKind]
    : 'Подборка (вид узла не задан)';
}

/**
 * Дата обновления: `updatedContentAt`, иначе `updatedAt`.
 *
 * Порядок именно такой, потому что в карту сайта `lastmod` идёт из
 * `updatedContentAt` — «дата СОДЕРЖАТЕЛЬНОГО обновления». Техническая правка
 * записи `lastmod` не двигает, и колонка отчёта не должна утверждать обратное.
 */
export function inventoryUpdatedAt(record: InventoryRecord): string {
  const content = typeof record.updatedContentAt === 'string' ? record.updatedContentAt.trim() : '';
  if (content !== '') {
    return content;
  }
  return typeof record.updatedAt === 'string' ? record.updatedAt.trim() : '';
}

/** Абсолютный URL записи. Хост — только из `SITE_URL`, через единственный хелпер. */
export function inventoryUrl(record: InventoryRecord, env?: SharedEnv): string | null {
  return record.path === null ? null : buildAbsoluteUrl(record.path, env);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Одна строка выгрузки в порядке {@link INVENTORY_COLUMNS}. */
export function inventoryRow(args: {
  readonly observation: SiteObservation;
  readonly record: InventoryRecord;
  readonly url: string;
}): readonly CsvValue[] {
  const { observation, record, url } = args;
  return [
    url,
    inventoryPageType(record),
    text(record.status),
    observation.httpStatus === null ? '' : String(observation.httpStatus),
    text(record.robots),
    observation.canonical ?? '',
    text(record.title),
    observation.inSitemap === null ? '' : observation.inSitemap ? SITEMAP_YES : SITEMAP_NO,
    inventoryUpdatedAt(record),
  ];
}

/* ------------------------------------------------------------------ */
/* Опрос живого сайта                                                  */
/* ------------------------------------------------------------------ */

/** Ответ сайта в объёме, который нужен выгрузке. */
export interface ProbeResponse {
  readonly body: string;
  readonly status: number;
}

/**
 * Как выгрузка спрашивает сайт. Отдельный тип, чтобы опрос подменялся в тестах:
 * иначе проверить «сайт не ответил» можно было бы только выключив сайт.
 */
export type SiteProbe = (url: string) => Promise<ProbeResponse>;

/** Все `<loc>` документа карты сайта. Разбор нарочно минимальный: это наш же XML. */
export function parseSitemapLocations(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1] ?? '');
}

/**
 * `href` из `<link rel="canonical">`.
 *
 * Это НАБЛЮДЕНИЕ за нашим же ответом, а не разбор произвольного HTML: порядок
 * атрибутов задаёт шаблон проекта, поэтому принимаются обе формы — `rel` до
 * `href` и после. Ничего не найдено — `null`, то есть пустая ячейка.
 */
export function parseCanonical(html: string): string | null {
  const withRelFirst = /<link[^>]*\srel=["']canonical["'][^>]*\shref=["']([^"']*)["']/i.exec(html);
  if (withRelFirst?.[1] !== undefined) {
    return withRelFirst[1];
  }
  const withHrefFirst = /<link[^>]*\shref=["']([^"']*)["'][^>]*\srel=["']canonical["']/i.exec(html);
  return withHrefFirst?.[1] ?? null;
}

/** Результат опроса карты сайта. `urls === null` — карта не прочитана. */
export interface SitemapReading {
  readonly urls: ReadonlySet<string> | null;
  readonly warnings: readonly string[];
}

/**
 * Читает карту сайта: индекс `/sitemap.xml`, затем каждый файл из него.
 *
 * Состав карты НЕ вычисляется — он читается. Если индекс не ответил 200, набор
 * остаётся `null`, и колонка «В sitemap» будет пустой у всех строк: сказать
 * «нет» означало бы утверждать, что страницы в карте нет, тогда как известно
 * лишь то, что карту не удалось прочитать.
 */
export async function readSitemapUrls(args: {
  readonly origin: string;
  readonly probe: SiteProbe;
}): Promise<SitemapReading> {
  const warnings: string[] = [];
  const indexUrl = `${args.origin}/sitemap.xml`;
  let indexBody: string;
  try {
    const response = await args.probe(indexUrl);
    if (response.status !== 200) {
      return {
        urls: null,
        warnings: [`Индекс карты сайта ${indexUrl} ответил ${String(response.status)}.`],
      };
    }
    indexBody = response.body;
  } catch (error) {
    return { urls: null, warnings: [`Индекс карты сайта ${indexUrl} недоступен: ${reason(error)}`] };
  }

  const urls = new Set<string>();
  for (const file of parseSitemapLocations(indexBody)) {
    try {
      const response = await args.probe(file);
      if (response.status !== 200) {
        warnings.push(`Файл карты ${file} ответил ${String(response.status)}.`);
        continue;
      }
      for (const location of parseSitemapLocations(response.body)) {
        urls.add(location);
      }
    } catch (error) {
      warnings.push(`Файл карты ${file} недоступен: ${reason(error)}`);
    }
  }
  return { urls, warnings };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Выполняет задачи с ограничением одновременности, сохраняя порядок результата. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Спрашивает сайт по каждому адресу: код ответа и canonical из HTML.
 *
 * За редиректом опрос НЕ идёт: колонка называется «HTTP-статус», и 301 в ней
 * обязан остаться 301 — иначе переехавший адрес выглядел бы живой страницей.
 */
export async function observePages(args: {
  readonly probe: SiteProbe;
  readonly urls: readonly string[];
}): Promise<{
  readonly observations: ReadonlyMap<string, { canonical: string | null; httpStatus: number }>;
  readonly warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const observations = new Map<string, { canonical: string | null; httpStatus: number }>();
  const results = await mapWithConcurrency(args.urls, PROBE_CONCURRENCY, async (url) => {
    try {
      const response = await args.probe(url);
      return { canonical: parseCanonical(response.body), httpStatus: response.status, url };
    } catch (error) {
      return { failure: reason(error), url };
    }
  });
  for (const result of results) {
    if ('failure' in result) {
      warnings.push(`${result.url} — не удалось спросить: ${result.failure}`);
      continue;
    }
    observations.set(result.url, {
      canonical: result.canonical,
      httpStatus: result.httpStatus,
    });
  }
  return { observations, warnings };
}

/* ------------------------------------------------------------------ */
/* Сборка файла                                                        */
/* ------------------------------------------------------------------ */

export interface InventoryCsv {
  readonly csv: string;
  readonly rows: number;
  /**
   * Что осталось неизмеренным. Пустые ячейки без объяснения выглядели бы
   * как «страницы нет», поэтому предупреждения обязаны дойти до вызывающего.
   */
  readonly warnings: readonly string[];
}

/**
 * Собирает CSV из записей и (необязательного) опроса сайта.
 *
 * `probe === null` — режим без опроса: колонки ответа пусты у всех строк, и
 * предупреждение об этом стоит первым. Такой режим нужен, когда сайт заведомо не
 * поднят: файл со списком записей полезен, а выдумывать в нём коды ответа —
 * нет.
 */
export async function buildInventoryCsv(args: {
  readonly env?: SharedEnv;
  readonly probe: SiteProbe | null;
  readonly records: readonly InventoryRecord[];
}): Promise<InventoryCsv> {
  const warnings: string[] = [];
  const limited = args.records.slice(0, MAX_INVENTORY_ROWS);
  if (args.records.length > limited.length) {
    warnings.push(
      `Записей ${String(args.records.length)}, в выгрузку вошли первые ` +
        `${String(MAX_INVENTORY_ROWS)}: предел выгрузки.`,
    );
  }

  const addressed: { record: InventoryRecord; url: string }[] = [];
  for (const record of limited) {
    const url = inventoryUrl(record, args.env);
    if (url === null) {
      warnings.push(
        `Запись «${text(record.title)}» (${record.collection}) пропущена: путь ещё не собран.`,
      );
      continue;
    }
    addressed.push({ record, url });
  }

  let sitemapUrls: ReadonlySet<string> | null = null;
  const observations = new Map<string, { canonical: string | null; httpStatus: number }>();

  if (args.probe === null) {
    warnings.push(
      'Сайт не опрашивался: колонки «HTTP-статус», «canonical» и «В sitemap» пусты. ' +
        'Пустая ячейка означает «не измерено», а не «страницы нет».',
    );
  } else {
    const origin = resolveSiteOrigin(args.env);
    const sitemap = await readSitemapUrls({ origin, probe: args.probe });
    sitemapUrls = sitemap.urls;
    warnings.push(...sitemap.warnings);
    if (sitemap.urls === null) {
      warnings.push('Колонка «В sitemap» пуста у всех строк: карта сайта не прочитана.');
    }
    const pages = await observePages({
      probe: args.probe,
      urls: addressed.map((item) => item.url),
    });
    warnings.push(...pages.warnings);
    for (const [url, observation] of pages.observations) {
      observations.set(url, observation);
    }
  }

  const rows = addressed.map(({ record, url }) => {
    const observed = observations.get(url);
    return inventoryRow({
      observation:
        observed === undefined
          ? { ...UNOBSERVED, inSitemap: sitemapUrls === null ? null : sitemapUrls.has(url) }
          : {
              canonical: observed.canonical,
              httpStatus: observed.httpStatus,
              inSitemap: sitemapUrls === null ? null : sitemapUrls.has(url),
            },
      record,
      url,
    });
  });

  return { csv: csvDocument(INVENTORY_COLUMNS, rows), rows: rows.length, warnings };
}

/**
 * Опрос через `fetch`: без следования за редиректом и без кеша.
 *
 * Тело читается всегда — из него берётся canonical; у 3xx и 404 оно просто не
 * содержит canonical, и ячейка остаётся пустой.
 */
export function fetchProbe(): SiteProbe {
  return async (url: string): Promise<ProbeResponse> => {
    const response = await fetch(url, { cache: 'no-store', redirect: 'manual' });
    return { body: await response.text(), status: response.status };
  };
}
