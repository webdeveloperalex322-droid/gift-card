/**
 * Карта сайта: условия включения, разбиение на файлы и сборка XML (задача
 * Э4-04).
 *
 * Норма: ТЗ §7.3, `CLAUDE.md` — раздел «Sitemap и robots»:
 *
 *   - индекс `/sitemap.xml` → sections, cards (по 50 000 URL max), images;
 *   - «включаются только абсолютные канонические URL со статусом 200 и
 *     разрешением на индексацию. Редиректы, 404, noindex, параметры —
 *     исключаются. Это проверяется тестом, а не соглашением»;
 *   - «`lastmod` меняется только при содержательном обновлении».
 *
 * Модуль ЧИСТЫЙ: без Astro, без Payload, без чтения `process.env` (окружение —
 * аргумент). Входит в composite-проект `../../tsconfig.node.json`, проверяется
 * `tests/unit/web-sitemap.test.ts`. Чтение записей и решение «отвечает ли адрес
 * 200» живут в `../data/sitemap-content.ts`.
 *
 * ## ТРИ УСЛОВИЯ ВКЛЮЧЕНИЯ И ОТКУДА БЕРЁТСЯ КАЖДОЕ
 *
 *   1. **разрешение на индексацию** — из директивы, посчитанной единственным
 *      разрешателем (`./robots-directive.ts`, задача Э4-01). Не из поля записи и
 *      не из статуса: у страницы, закрытой пагинацией или пустым описанием, поле
 *      записи по-прежнему может говорить `index,follow`;
 *   2. **каноничность адреса** — сравнением `canonical` записи с адресом
 *      страницы (`sitemapEligibility`, тоже Э4-01). Страница с переопределённым
 *      canonical остаётся законно открытой, но в карту не входит, и по директиве
 *      это не видно;
 *   3. **ответ 200** — ФАКТОМ СНАРУЖИ ({@link SitemapPageFacts.respondsOk}).
 *      Знает его только маршрут: у карточки это наличие производных изображения,
 *      у подборки — предикат «опубликован И непуст», у каталога — непустой
 *      список. Догадываться здесь запрещено: догадка разошлась бы с шаблоном, и
 *      в карте оказался бы адрес, отвечающий 404.
 *
 * ## Чего здесь НЕТ намеренно
 *
 * **Списка исключений.** Ни пагинации, ни поиска, ни фильтров, ни черновиков:
 * у всех этих страниц директива уже закрыта тем же разрешателем, а второй
 * список однажды разошёлся бы с первым — и разошёлся бы молча. Единственное
 * исключение из этого правила — условие 3, и оно не список, а факт на каждую
 * страницу.
 *
 * **Даты «сейчас».** Отсутствующий `lastmod` не заменяется текущим временем:
 * это сообщило бы поисковику об обновлении, которого не было, и обесценило бы
 * значение поля для всех остальных страниц.
 */

import {
  buildAbsoluteUrl,
  canonicalizePath,
  currentEnv,
  looksLikeAbsoluteUrl,
  type SharedEnv,
} from '@otkritka/shared';

import { type PageRobots, sitemapEligibility } from './robots-directive.js';

/** Предел числа URL в одном файле карты сайта (ТЗ §7.3). */
export const MAX_URLS_PER_SITEMAP = 50_000;

/** Адрес sitemap-индекса. На него же ссылается `robots.txt` (решение Ч-22). */
export const SITEMAP_INDEX_PATH = '/sitemap.xml';

/** Карта разделов: главная, каталоги, служебные страницы, узлы таксономии. */
export const SITEMAP_SECTIONS_PATH = '/sitemap-sections.xml';

/**
 * Основа имени файлов карточек. Файл получает номер: `sitemap-cards-1.xml`.
 *
 * Номер ставится ВСЕГДА, даже когда файл один. Иначе адрес первого файла зависел
 * бы от объёма каталога: пока карточек меньше предела — `/sitemap-cards.xml`, а
 * после превышения тот же набор переехал бы на `/sitemap-cards-1.xml`. Адреса
 * файлов карты сайта запоминает поисковая система, и такой переезд означал бы
 * 404 на месте известного ей файла.
 */
export const SITEMAP_CARDS_PREFIX = 'sitemap-cards';

/** Основа имени файлов image sitemap. Нумерация та же и по той же причине. */
export const SITEMAP_IMAGES_PREFIX = 'sitemap-images';

/** Тип содержимого всех файлов карты сайта. */
export const SITEMAP_CONTENT_TYPE = 'application/xml; charset=utf-8';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const IMAGE_NAMESPACE = 'http://www.google.com/schemas/sitemap-image/1.1';

/** Изображение страницы для image sitemap. */
export interface SitemapImage {
  /** Абсолютный адрес ФАЙЛА, который страница действительно показывает. */
  readonly loc: string;
}

/** Готовая запись карты сайта. */
export interface SitemapUrl {
  /** Абсолютный канонический адрес страницы. */
  readonly loc: string;
  /** Дата содержательного обновления либо `null` — элемента `lastmod` не будет. */
  readonly lastmod: string | null;
  /** Изображения страницы. Пустой массив — страница попадёт только в обычный urlset. */
  readonly images: readonly SitemapImage[];
}

/** Почему адрес не попал в карту сайта. */
export type SitemapExclusion =
  /** Директива закрывает страницу от индексации (условие 1). */
  | 'noindex'
  /** canonical указывает на другой адрес (условие 2). */
  | 'not-self-canonical'
  /** Маршрут не отвечает 200 (условие 3). */
  | 'not-200'
  /**
   * Значение не является путём страницы: параметры, фрагмент или абсолютный
   * адрес чужого хоста. Отдельная причина, а не отказ сборки: одна повреждённая
   * запись не должна уносить с собой всю карту сайта, но и попасть в неё она не
   * может — в карте только канонические адреса без параметров.
   */
  | 'not-a-path';

/** Факты о странице — ровно то, из чего складывается решение о включении. */
export interface SitemapPageFacts {
  /** Собственный адрес страницы от корня сайта. */
  readonly pagePath: string;
  /** Канонический путь: поле `canonical` записи либо собственный адрес. */
  readonly canonicalPath: string;
  /** Директива, посчитанная `resolvePageRobots` (задача Э4-01). */
  readonly robots: PageRobots;
  /** Отвечает ли маршрут 200. Условие 3: факт снаружи, см. шапку модуля. */
  readonly respondsOk: boolean;
  /**
   * Дата содержательного обновления (`updatedContentAt`).
   *
   * Тип с явным `| undefined`: при `exactOptionalPropertyTypes` поле записи,
   * которого может не быть вовсе, обязано быть выразимо здесь — иначе слой
   * данных нормализовал бы его сам, то есть завёл бы вторую трактовку «пусто».
   */
  readonly lastmod?: string | null | undefined;
  /** Изображения страницы для image sitemap. */
  readonly images?: readonly SitemapImage[];
}

export type SitemapDecision =
  | { readonly included: true; readonly url: SitemapUrl }
  | { readonly included: false; readonly excludedBy: readonly SitemapExclusion[] };

/** Сколько страниц рассмотрено, сколько вошло и почему остальные не вошли. */
export interface SitemapDiagnostics {
  readonly considered: number;
  readonly included: number;
  readonly excludedBy: Readonly<Record<SitemapExclusion, number>>;
}

export interface SitemapSelection {
  readonly urls: readonly SitemapUrl[];
  readonly diagnostics: SitemapDiagnostics;
}

/** Запись sitemap-индекса. */
export interface SitemapIndexEntry {
  readonly loc: string;
  readonly lastmod: string | null;
}

/**
 * Является ли значение путём страницы ЭТОГО сайта.
 *
 * Проверка абсолютного адреса стоит ОТДЕЛЬНО от `canonicalizePath`, и это не
 * перестраховка: сама по себе нормализация схлопнула бы
 * `https://chuzhoy.test/x` в правдоподобный путь `/https:/chuzhoy.test/x`, то
 * есть в карту сайта попал бы несуществующий адрес своего хоста — молча. Та же
 * проверка и по той же причине стоит у canonical (`../routing/canonical.ts`).
 */
function isPathValue(value: string): boolean {
  if (looksLikeAbsoluteUrl(value)) {
    return false;
  }
  try {
    canonicalizePath(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Приводит дату содержательного обновления к форме W3C.
 *
 * @throws Error если значение непусто и не разбирается как дата. Тихо выбросить
 *   непонятное значение нельзя: `lastmod` — единственное, чем карта сайта
 *   сообщает об обновлении, и его молчаливая пропажа выглядела бы как «страница
 *   не менялась».
 */
export function formatLastmod(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (raw === '') {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Значение lastmod «${raw}» не разбирается как дата. Оно приходит из поля ` +
        'updatedContentAt записи (дата содержательного обновления, ТЗ §7.3), поэтому ' +
        'непонятное здесь означает повреждённые данные. Подставить текущее время вместо ' +
        'отказа нельзя: карта сайта сообщила бы поисковику об обновлении, которого не было.',
    );
  }
  return parsed.toISOString();
}

/**
 * Решение о включении одного адреса в карту сайта.
 *
 * Причины перечисляются ВСЕ, а не первая: диагностика отвечает на вопрос
 * «почему страницы нет в карте», и половина ответа отправила бы редактора
 * исправлять не то.
 *
 * @throws Error если `SITE_URL` не задан или если `lastmod` не разбирается.
 */
export function decideSitemapUrl(
  facts: SitemapPageFacts,
  env: SharedEnv = currentEnv(),
): SitemapDecision {
  const excludedBy: SitemapExclusion[] = [];
  const pathsAreValid = isPathValue(facts.pagePath) && isPathValue(facts.canonicalPath);

  if (pathsAreValid) {
    // Условия 1 и 2 считает Э4-01 — тот же код, что отвечает на вопрос «можно ли
    // индексировать» в шаблоне. Второй трактовки здесь нет и быть не должно.
    excludedBy.push(
      ...sitemapEligibility({
        canonicalPath: facts.canonicalPath,
        pagePath: facts.pagePath,
        robots: facts.robots,
      }).excludedBy,
    );
  }
  if (!facts.respondsOk) {
    excludedBy.push('not-200');
  }
  if (!pathsAreValid) {
    excludedBy.push('not-a-path');
  }

  if (excludedBy.length > 0) {
    return { excludedBy, included: false };
  }

  return {
    included: true,
    url: {
      images: facts.images ?? [],
      lastmod: formatLastmod(facts.lastmod),
      // Адрес собирается из СОБСТВЕННОГО пути страницы: он и canonical к этому
      // моменту уже признаны одним адресом (условие 2), а собственный путь —
      // тот, по которому маршрут отвечает 200.
      loc: buildAbsoluteUrl(canonicalizePath(facts.pagePath), env),
    },
  };
}

const NO_EXCLUSIONS: Readonly<Record<SitemapExclusion, number>> = {
  noindex: 0,
  'not-200': 0,
  'not-a-path': 0,
  'not-self-canonical': 0,
};

/**
 * Отбор набора страниц с диагностикой.
 *
 * Диагностика — не украшение: на ненаполненной базе карта сайта законно пуста, и
 * без неё «пусто, потому что нечего публиковать» неотличимо от «пусто, потому
 * что фильтр съел всё». Первое — нормальное состояние проекта, второе — дефект.
 */
export function selectSitemapUrls(
  facts: readonly SitemapPageFacts[],
  env: SharedEnv = currentEnv(),
): SitemapSelection {
  const urls: SitemapUrl[] = [];
  const excludedBy: Record<SitemapExclusion, number> = { ...NO_EXCLUSIONS };

  for (const candidate of facts) {
    const decision = decideSitemapUrl(candidate, env);
    if (decision.included) {
      urls.push(decision.url);
      continue;
    }
    for (const reason of decision.excludedBy) {
      excludedBy[reason] += 1;
    }
  }

  return {
    diagnostics: { considered: facts.length, excludedBy, included: urls.length },
    urls,
  };
}

/** Складывает диагностики нескольких наборов в одну. */
export function mergeDiagnostics(
  parts: readonly SitemapDiagnostics[],
): SitemapDiagnostics {
  const excludedBy: Record<SitemapExclusion, number> = { ...NO_EXCLUSIONS };
  let considered = 0;
  let included = 0;

  for (const part of parts) {
    considered += part.considered;
    included += part.included;
    for (const reason of Object.keys(excludedBy) as SitemapExclusion[]) {
      excludedBy[reason] += part.excludedBy[reason];
    }
  }

  return { considered, excludedBy, included };
}

/**
 * Режет набор на файлы по {@link MAX_URLS_PER_SITEMAP}.
 *
 * Пустой набор даёт НОЛЬ файлов, а не один пустой: файл без единого `<url>` не
 * является валидной картой сайта, и выкладывать его — значит показывать
 * поисковой системе ошибку вместо отсутствия данных.
 */
export function shardUrls(urls: readonly SitemapUrl[]): readonly (readonly SitemapUrl[])[] {
  const shards: SitemapUrl[][] = [];
  for (let index = 0; index < urls.length; index += MAX_URLS_PER_SITEMAP) {
    shards.push([...urls.slice(index, index + MAX_URLS_PER_SITEMAP)]);
  }
  return shards;
}

/** Адрес файла-части: `/sitemap-cards-1.xml`. Нумерация с единицы. */
export function shardFilePath(prefix: string, shard: number): string {
  if (!Number.isInteger(shard) || shard < 1) {
    throw new Error(
      `Номер файла карты сайта «${String(shard)}» недопустим: нумерация целая и с единицы. ` +
        'Ноль и отрицательные номера адресами файлов не бывают, а «часть 0» означала бы, что ' +
        'индекс и маршрут считают части по-разному.',
    );
  }
  return `/${prefix}-${String(shard)}.xml`;
}

/**
 * Разбор номера файла из адреса. `null` — такого файла не существует, и маршрут
 * обязан ответить 404.
 *
 * Форма строгая, как у номера страницы пагинации: `01` — не номер, иначе один и
 * тот же файл имел бы два адреса.
 */
export function parseShardParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9][0-9]*$/u.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function lastmodElement(lastmod: string | null): readonly string[] {
  return lastmod === null ? [] : [`    <lastmod>${escapeXml(lastmod)}</lastmod>`];
}

function document(root: string, attributes: string, body: readonly string[]): string {
  return [XML_DECLARATION, `<${root} ${attributes}>`, ...body, `</${root}>`, ''].join('\n');
}

/** Обычный `urlset`: адреса страниц с датами обновления. */
export function renderUrlset(urls: readonly SitemapUrl[]): string {
  const body = urls.flatMap((url) => [
    '  <url>',
    `    <loc>${escapeXml(url.loc)}</loc>`,
    ...lastmodElement(url.lastmod),
    '  </url>',
  ]);
  return document('urlset', `xmlns="${SITEMAP_NAMESPACE}"`, body);
}

/**
 * Image sitemap: те же адреса страниц плюс изображения, которые на них видны.
 *
 * @throws Error если у адреса нет ни одного изображения. Пустой `<url>` в image
 *   sitemap — это запись, которая ничего не описывает; попасть сюда страница без
 *   изображений может только по ошибке отбора, и молчать об этом нельзя.
 */
export function renderImageUrlset(urls: readonly SitemapUrl[]): string {
  const body = urls.flatMap((url) => {
    if (url.images.length === 0) {
      throw new Error(
        `Адрес «${url.loc}» попал в image sitemap без единого изображения. В этот файл ` +
          'отбираются только страницы, показывающие изображение; запись без <image:image> ' +
          'ничего не описывает и означает ошибку отбора, а не пустую страницу.',
      );
    }
    return [
      '  <url>',
      `    <loc>${escapeXml(url.loc)}</loc>`,
      ...lastmodElement(url.lastmod),
      ...url.images.flatMap((image) => [
        '    <image:image>',
        `      <image:loc>${escapeXml(image.loc)}</image:loc>`,
        '    </image:image>',
      ]),
      '  </url>',
    ];
  });

  return document(
    'urlset',
    `xmlns="${SITEMAP_NAMESPACE}" xmlns:image="${IMAGE_NAMESPACE}"`,
    body,
  );
}

/** Sitemap-индекс: перечень файлов карты сайта. */
export function renderSitemapIndex(entries: readonly SitemapIndexEntry[]): string {
  const body = entries.flatMap((entry) => [
    '  <sitemap>',
    `    <loc>${escapeXml(entry.loc)}</loc>`,
    ...lastmodElement(entry.lastmod),
    '  </sitemap>',
  ]);
  return document('sitemapindex', `xmlns="${SITEMAP_NAMESPACE}"`, body);
}

/**
 * Ответ на запрос ОДНОГО файла карты сайта.
 *
 * Собирается здесь, а не в трёх маршрутах, по одной причине: решение «файла нет»
 * обязано быть одинаковым у всех частей. Разойдясь, они дали бы индекс, который
 * ссылается на 404 у одной части и на пустой валидный файл у другой.
 */
export interface SitemapFilePayload {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: 200 | 404;
}

/**
 * Текст ответа на запрос несуществующей части карты сайта.
 *
 * Обычный текст, а не HTML: адрес файловый, и страницу 404 сюда подставлять
 * незачем — ответ читает робот.
 */
const ABSENT_SITEMAP_FILE_TEXT =
  '404 Not Found\n\nТакой части карты сайта нет. Существуют только те файлы, что перечислены ' +
  'в индексе /sitemap.xml: пустая часть не выкладывается вовсе.\n';

/**
 * Готовый ответ для маршрута файла карты сайта.
 *
 * Пустой набор и отсутствующий номер части дают ОДИН И ТОТ ЖЕ 404: файла с таким
 * адресом не существует ни в том, ни в другом случае. Отдавать пустой `<urlset>`
 * нельзя — он невалиден по схеме, и поисковая система показала бы его ошибкой, а
 * не пустотой.
 */
export function sitemapFilePayload(
  urls: readonly SitemapUrl[] | null,
  render: (urls: readonly SitemapUrl[]) => string,
): SitemapFilePayload {
  if (urls === null || urls.length === 0) {
    return {
      body: ABSENT_SITEMAP_FILE_TEXT,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      status: 404,
    };
  }

  return {
    body: render(urls),
    headers: {
      // Тот же короткий кеш, что у индекса: карта собирается на запросе, окна
      // устаревания у неё нет, а пять минут защищают базу от частого обхода.
      'Cache-Control': 'public, max-age=300',
      'Content-Type': SITEMAP_CONTENT_TYPE,
    },
    status: 200,
  };
}

/** Самая свежая дата набора либо `null` — датировать файл нечем. */
export function latestLastmod(urls: readonly SitemapUrl[]): string | null {
  let latest: string | null = null;
  for (const url of urls) {
    if (url.lastmod === null) {
      continue;
    }
    if (latest === null || url.lastmod > latest) {
      latest = url.lastmod;
    }
  }
  return latest;
}
