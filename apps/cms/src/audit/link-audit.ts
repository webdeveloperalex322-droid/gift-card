/**
 * Проверка внутренних ссылок (задача Э5-03, ТЗ §8.3.4): обход живого сайта и
 * разбор находок. Чистое ядро — ни Payload, ни базы, ни `fetch`.
 *
 * ═══ ПОЧЕМУ ОБХОД САЙТА, А НЕ ЗАПРОС К БАЗЕ ═══
 *
 * Проверять надо ссылки, а ссылок в CMS нет. Перелинковку собирает шаблон
 * `apps/web`: меню, хлебные крошки, блоки «Похожие», «Разделы подборки»,
 * «Смотрите также». Список записей из базы дал бы другое множество и другой
 * ответ на вопрос «достижима ли страница»: запись существует и опубликована —
 * это ещё не ссылка на неё. Поэтому источник фактов здесь тот же, что у выгрузки
 * Э5-05, — фактический ответ сайта, и слой опроса тот же самый
 * ({@link SiteProbe}, `../export/inventory.ts`), а не второй такой же.
 *
 * Куда ходит проверка — только на origin из `SITE_URL`. Ни параметра, ни второй
 * переменной окружения: иначе это был бы инструмент запросов с сервера CMS на
 * произвольный хост. Ссылки на чужие origin в обход не берутся вовсе — их
 * доступность не наше требование, а поход по ним превратил бы ежесуточную
 * задачу в краулер интернета.
 *
 * ═══ ЧТО ИМЕННО СЧИТАЕТСЯ И КАК ЭТО НАЗВАНО ═══
 *
 * Норма (п. 5.1.5 и чек-лист п. 22.15) формулирует достижимость так: «на
 * страницу есть хотя бы одна ссылка `<a href>`… страница достижима за ≤ 4
 * перехода от главной». Обход даёт ровно это, и находки названы по тому, что
 * измерено, а не по тому, что хотелось бы знать:
 *
 *   - `not-linked` — «в обходе от главной не встретилось ни одной ссылки на этот
 *     адрес». Утверждение НЕ равно «ссылок на неё нет нигде»: ссылка со
 *     страницы, до которой обход не дошёл, невидима для обхода — как и для
 *     краулера, идущего от главной. ТЗ перечисляет «сирот» и «страницы вне
 *     навигации» отдельно; при измерении обходом это ОДНО И ТО ЖЕ множество,
 *     поэтому колонка одна и названа по измерению. Разводить их можно было бы
 *     только считая ссылки по данным CMS — то есть отвечая на другой вопрос;
 *   - `too-deep` — путь от главной есть, но длиннее {@link LINK_AUDIT_MAX_CLICKS}
 *     переходов;
 *   - `not-200` — адрес опубликованной записи ответил не 200. Это не про ссылки
 *     вовсе, но молчать об этом в отчёте о достижимости нельзя;
 *   - `not-measured` — адрес не спрошен: обход упёрся в предел. Пустое место в
 *     отчёте обязано называться «не измерено», а не «всё хорошо».
 *
 * Битой считается внутренняя ссылка, чей адрес ответил 4xx/5xx или не ответил
 * вовсе. Ссылка на 3xx битой НЕ считается и попадает в отдельный список: она
 * работает, но тратит переход и нарушает правило «внутренние ссылки —
 * канонические». Смешать их в одну кучу значило бы либо поднять ложную тревогу,
 * либо спрятать настоящий дефект среди неё.
 *
 * ═══ ЧЕГО ПРОВЕРКА НЕ ДЕЛАЕТ ═══
 *
 * Ничего не пишет в записи, не меняет статусы и robots-директивы, ничего не
 * публикует и не снимает с публикации — ни при каких находках. Она читает сайт и
 * складывает отчёт (`./report.ts`). Это не самоограничение реализации: решение о
 * публикации и об индексации принимает человек (п. 7.1 и п. 23), и фоновая
 * задача, «чинящая» найденное, была бы ровно тем автоматическим решением,
 * которого статусная модель не допускает.
 */
import { isPageRoute } from '@otkritka/shared';

import { type SiteProbe, mapWithConcurrency } from '../export/inventory';

/**
 * Норма достижимости: сколько переходов от главной допустимо (п. 5.1.5, п.
 * 22.15). Значение из ТЗ, не выбор агента.
 */
export const LINK_AUDIT_MAX_CLICKS = 4;

/**
 * До какой глубины идёт обход.
 *
 * ПРОВЕНАНС: выбор агента. Две ступени сверх нормы — чтобы отличить «глубже
 * нормы» от «не найдено вовсе»: без запаса страница на пятом переходе выглядела
 * бы ненайденной, и отчёт вместо «слишком глубоко» показывал бы «нет ссылок»,
 * то есть называл бы находку чужим именем.
 */
export const LINK_AUDIT_CRAWL_DEPTH = LINK_AUDIT_MAX_CLICKS + 2;

/**
 * Предел числа запросов к сайту за один прогон.
 *
 * ПРОВЕНАНС: выбор агента (кандидат в реестр решений рядом с
 * `MAX_INVENTORY_ROWS`). Смысл тот же, что у предела выгрузки: обход без предела
 * — это полный проход по сайту с сервера CMS, и запускается он по расписанию,
 * то есть без человека рядом. Упёрлись в предел — обход помечается усечённым, и
 * находки о достижимости объявляются НЕНАДЁЖНЫМИ целиком: «ссылок не найдено»
 * при недообойдённом сайте не значит ничего.
 */
export const LINK_AUDIT_MAX_REQUESTS = 2000;

/** Сколько запросов к сайту идёт одновременно. Тот же порядок, что у выгрузки. */
export const LINK_AUDIT_CONCURRENCY = 4;

/**
 * Сколько находок каждого вида попадает в отчёт списком.
 *
 * ПРОВЕНАНС: выбор агента. Отчёт читают глазами; общее число при этом не
 * теряется — оно хранится отдельным счётчиком, как `metaConflict.total` у дублей
 * метатегов.
 */
export const LINK_AUDIT_MAX_LISTED = 50;

/** Сколько страниц-источников перечисляется у одной битой ссылки. */
export const LINK_AUDIT_MAX_REFERRERS = 5;

/* ------------------------------------------------------------------ */
/* Разбор HTML                                                         */
/* ------------------------------------------------------------------ */

const ANCHOR_HREF = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;

/**
 * Значения `href` всех якорей документа.
 *
 * Разбор регулярным выражением, а не деревом: это НАШ же HTML, отданный нашим же
 * шаблоном, и разбирается ровно один атрибут одного тега. Полноценный парсер
 * здесь означал бы зависимость ради задачи, которая от неё не становится
 * вернее. Три формы записи атрибута (двойные кавычки, одинарные, без кавычек)
 * распознаются все: пропуск формы означал бы «ссылок нет» там, где они есть, —
 * то есть ложную сироту.
 */
export function extractHrefs(html: string): readonly string[] {
  const hrefs: string[] = [];
  for (const match of html.matchAll(ANCHOR_HREF)) {
    hrefs.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return hrefs;
}

/**
 * Приводит `href` к абсолютному адресу СВОЕГО origin либо отвергает его.
 *
 * `null` возвращается для всего, что обходу не принадлежит: пустая ссылка, якорь
 * на той же странице, `mailto:`/`tel:`/`javascript:`, чужой хост, неразбираемый
 * адрес. Фрагмент отбрасывается — `#blok` не создаёт другого адреса; строка
 * запроса СОХРАНЯЕТСЯ: `?page=2` — это другой ответ сервера, и молча склеивать
 * его с базовым адресом значило бы не заметить ссылку на неканоническую форму.
 */
export function resolveInternalTarget(
  href: string,
  pageUrl: string,
  origin: string,
): string | null {
  const raw = href.trim();
  if (raw === '' || raw.startsWith('#')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.origin !== origin) {
    return null;
  }
  return `${url.origin}${url.pathname}${url.search}`;
}

/* ------------------------------------------------------------------ */
/* Обход                                                              */
/* ------------------------------------------------------------------ */

/** Один адрес, встреченный обходом. */
export interface CrawlTarget {
  /** Минимальное число ПЕРЕХОДОВ от главной; редирект переходом не считается. */
  readonly depth: number;
  /** Почему адрес не удалось спросить; `null` — ошибки не было. */
  readonly failure: string | null;
  /** Маршрут страницы (`true`) или URL файла (`false`) — {@link isPageRoute}. */
  readonly isPage: boolean;
  /** `Location` ответа 3xx; `null` — не редирект либо заголовок не пришёл. */
  readonly location: string | null;
  /** Страницы, с которых на этот адрес есть ссылка. Ограничены по числу. */
  readonly referrers: readonly string[];
  /** Код ответа; `null` — адрес не спрошен (предел обхода) или спросить не вышло. */
  readonly status: number | null;
  readonly url: string;
}

export interface CrawlResult {
  /** Сколько запросов к сайту сделано. */
  readonly requested: number;
  /** Адрес, с которого начат обход. */
  readonly start: string;
  readonly targets: ReadonlyMap<string, CrawlTarget>;
  /** Обход оборван пределом: находки о достижимости ненадёжны. */
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

interface MutableTarget {
  depth: number;
  failure: string | null;
  isPage: boolean;
  location: string | null;
  probed: boolean;
  referrers: string[];
  status: number | null;
  url: string;
}

function pageRouteOf(url: string): boolean {
  try {
    return isPageRoute(new URL(url).pathname);
  } catch {
    return false;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Обходит сайт от главной по внутренним `<a href>`.
 *
 * Ширину (BFS) выбирает не стиль, а смысл измерения: нужна МИНИМАЛЬНАЯ длина
 * пути от главной, и обход в глубину дал бы первую найденную, а не кратчайшую —
 * то есть завышал бы число переходов и порождал ложные находки `too-deep`.
 *
 * Редирект переходом НЕ считается: цель 3xx ставится в очередь на ТОЙ ЖЕ
 * глубине. Иначе одиночный 301 внутри сайта съедал бы клик из нормы «≤ 4», хотя
 * пользователь и краулер тратят на него один переход, а не два.
 *
 * URL файлов (с расширением) спрашиваются, но по ним не идут: ссылка на
 * несуществующий файл — та же битая ссылка, а вот искать `<a href>` внутри
 * `.webp` бессмысленно.
 */
export async function crawlSite(args: {
  readonly concurrency?: number;
  readonly maxDepth?: number;
  readonly maxRequests?: number;
  readonly origin: string;
  readonly probe: SiteProbe;
}): Promise<CrawlResult> {
  const maxDepth = args.maxDepth ?? LINK_AUDIT_CRAWL_DEPTH;
  const maxRequests = args.maxRequests ?? LINK_AUDIT_MAX_REQUESTS;
  const concurrency = args.concurrency ?? LINK_AUDIT_CONCURRENCY;
  const origin = args.origin.replace(/\/+$/, '');
  const start = `${origin}/`;

  const targets = new Map<string, MutableTarget>();
  const warnings: string[] = [];
  let requested = 0;
  let truncated = false;

  const see = (url: string, depth: number, referrer: string | null): MutableTarget => {
    const known = targets.get(url);
    if (known === undefined) {
      const created: MutableTarget = {
        depth,
        failure: null,
        isPage: pageRouteOf(url),
        location: null,
        probed: false,
        referrers: referrer === null ? [] : [referrer],
        status: null,
        url,
      };
      targets.set(url, created);
      return created;
    }
    known.depth = Math.min(known.depth, depth);
    if (
      referrer !== null &&
      known.referrers.length < LINK_AUDIT_MAX_REFERRERS &&
      !known.referrers.includes(referrer)
    ) {
      known.referrers.push(referrer);
    }
    return known;
  };

  let frontier: MutableTarget[] = [see(start, 0, null)];

  // Раунд обхода — это не глубина: цель редиректа встаёт в очередь на той же
  // глубине и тратит раунд. Запас сверх `maxDepth` даёт редиректам дойти до
  // цели, а верхняя граница числа раундов не даёт кольцу редиректов крутиться
  // вечно.
  const maxRounds = maxDepth + 4;
  for (let round = 0; round < maxRounds && frontier.length > 0; round += 1) {
    const seen = new Set<string>();
    const batch = frontier.filter((target) => {
      if (target.probed || seen.has(target.url)) {
        return false;
      }
      seen.add(target.url);
      return true;
    });
    frontier = [];
    if (batch.length === 0) {
      continue;
    }
    if (requested + batch.length > maxRequests) {
      truncated = true;
    }
    const allowed = batch.slice(0, Math.max(0, maxRequests - requested));
    requested += allowed.length;

    const answers = await mapWithConcurrency(allowed, concurrency, async (target) => {
      try {
        return { response: await args.probe(target.url), target };
      } catch (error) {
        return { failure: reason(error), target };
      }
    });

    for (const answer of answers) {
      const { target } = answer;
      target.probed = true;
      if ('failure' in answer) {
        target.failure = answer.failure;
        warnings.push(`${target.url} — не удалось спросить: ${answer.failure}`);
        continue;
      }
      const { response } = answer;
      target.status = response.status;
      target.location = response.location ?? null;

      // Цель редиректа — та же глубина: 301 не является переходом.
      if (response.status >= 300 && response.status < 400 && target.location !== null) {
        const moved = resolveInternalTarget(target.location, target.url, origin);
        if (moved !== null) {
          const next = see(moved, target.depth, null);
          if (!next.probed) {
            frontier.push(next);
          }
        }
        continue;
      }

      if (response.status !== 200 || !target.isPage) {
        continue;
      }
      if (target.depth >= maxDepth) {
        // Страница отвечена и учтена, но её ссылки уже за пределом обхода.
        continue;
      }
      for (const href of extractHrefs(response.body)) {
        const internal = resolveInternalTarget(href, target.url, origin);
        if (internal === null) {
          continue;
        }
        const next = see(internal, target.depth + 1, target.url);
        if (!next.probed) {
          frontier.push(next);
        }
      }
    }

    if (truncated) {
      break;
    }
  }

  if (truncated) {
    warnings.push(
      `Обход оборван пределом в ${String(maxRequests)} запросов. Находки о достижимости ` +
        'ненадёжны: «ссылок не найдено» при недообойдённом сайте не означает ничего.',
    );
  }

  const frozen = new Map<string, CrawlTarget>();
  for (const [url, target] of targets) {
    frozen.set(url, {
      depth: target.depth,
      failure: target.failure,
      isPage: target.isPage,
      location: target.location,
      referrers: [...target.referrers],
      status: target.status,
      url,
    });
  }
  return { requested, start, targets: frozen, truncated, warnings };
}

/* ------------------------------------------------------------------ */
/* Разбор находок                                                      */
/* ------------------------------------------------------------------ */

/** Опубликованная запись CMS: то, что ОБЯЗАНО быть достижимо. */
export interface AuditedRecord {
  readonly collection: 'cards' | 'collections';
  readonly id: string;
  readonly title: string;
  /** Абсолютный URL записи, собранный тем же хелпером, что canonical. */
  readonly url: string;
}

export type RecordFindingReason = 'not-200' | 'not-linked' | 'not-measured' | 'too-deep';

export interface RecordFinding {
  readonly collection: 'cards' | 'collections';
  /** Число переходов от главной; `null` — путь не найден. */
  readonly depth: number | null;
  readonly id: string;
  /** Есть ли адрес в карте сайта; `null` — карта не прочитана. */
  readonly inSitemap: boolean | null;
  readonly reason: RecordFindingReason;
  readonly status: number | null;
  readonly title: string;
  readonly url: string;
}

export interface LinkFinding {
  readonly failure: string | null;
  readonly location: string | null;
  /** Страницы, на которых стоит эта ссылка. */
  readonly referrers: readonly string[];
  readonly status: number | null;
  readonly url: string;
}

export interface LinkAuditFindings {
  /** Внутренние ссылки на 4xx/5xx и на адреса, не ответившие вовсе. */
  readonly broken: readonly LinkFinding[];
  readonly brokenTotal: number;
  /** Опубликованные записи, с которыми что-то не так. */
  readonly records: readonly RecordFinding[];
  readonly recordsTotal: number;
  /** Внутренние ссылки на 3xx: работают, но тратят переход. */
  readonly redirected: readonly LinkFinding[];
  readonly redirectedTotal: number;
  /**
   * Можно ли верить находкам о достижимости. `false` — обход усечён или главная
   * не ответила 200; в этом случае «сирот» в отчёте читать нельзя.
   */
  readonly reliable: boolean;
  readonly warnings: readonly string[];
}

/** Сколько записей попало в разряд «сирота» по ТЗ: нет ссылок либо глубже нормы. */
export function orphanCount(findings: LinkAuditFindings): number {
  return findings.records.filter(
    (record) => record.reason === 'not-linked' || record.reason === 'too-deep',
  ).length;
}

function linkFindingOf(target: CrawlTarget): LinkFinding {
  return {
    failure: target.failure,
    location: target.location,
    referrers: target.referrers,
    status: target.status,
    url: target.url,
  };
}

/**
 * Раскладывает обход и список опубликованных записей на находки.
 *
 * Порядок разбора записи значим: сначала «адрес не отвечает 200», потом «на
 * адрес нет ссылок», потом глубина. Иначе опубликованная запись, отдающая 404,
 * попадала бы в отчёт как сирота — и правилась бы перелинковкой вместо
 * настоящей причины.
 */
export function classifyLinkAudit(args: {
  readonly crawl: CrawlResult;
  readonly maxClicks?: number;
  readonly records: readonly AuditedRecord[];
  /** Адреса из карты сайта; `null` — карта не прочитана. */
  readonly sitemapUrls: ReadonlySet<string> | null;
}): LinkAuditFindings {
  const maxClicks = args.maxClicks ?? LINK_AUDIT_MAX_CLICKS;
  const warnings = [...args.crawl.warnings];
  const home = args.crawl.targets.get(args.crawl.start);
  const homeAnswered = home?.status === 200;
  if (!homeAnswered) {
    warnings.push(
      `Главная ${args.crawl.start} ответила ${home?.status === null || home === undefined ? 'ничем' : String(home.status)}: ` +
        'обход не состоялся, и находки о достижимости смысла не имеют.',
    );
  }

  const broken: LinkFinding[] = [];
  const redirected: LinkFinding[] = [];
  for (const target of args.crawl.targets.values()) {
    if (target.referrers.length === 0) {
      // Ни одной ссылки на этот адрес нет: это старт обхода либо цель редиректа.
      continue;
    }
    if (target.failure !== null || (target.status !== null && target.status >= 400)) {
      broken.push(linkFindingOf(target));
      continue;
    }
    if (target.status !== null && target.status >= 300 && target.status < 400) {
      redirected.push(linkFindingOf(target));
    }
  }

  const records: RecordFinding[] = [];
  for (const record of args.records) {
    const target = args.crawl.targets.get(record.url);
    const inSitemap = args.sitemapUrls === null ? null : args.sitemapUrls.has(record.url);
    const shared = {
      collection: record.collection,
      id: record.id,
      inSitemap,
      title: record.title,
      url: record.url,
    };
    if (target === undefined) {
      records.push({ ...shared, depth: null, reason: 'not-linked', status: null });
      continue;
    }
    if (target.status === null) {
      records.push({
        ...shared,
        depth: target.depth,
        reason: target.failure === null ? 'not-measured' : 'not-200',
        status: null,
      });
      continue;
    }
    if (target.status !== 200) {
      records.push({ ...shared, depth: target.depth, reason: 'not-200', status: target.status });
      continue;
    }
    if (target.referrers.length === 0 && record.url !== args.crawl.start) {
      records.push({ ...shared, depth: target.depth, reason: 'not-linked', status: 200 });
      continue;
    }
    if (target.depth > maxClicks) {
      records.push({ ...shared, depth: target.depth, reason: 'too-deep', status: 200 });
    }
  }

  return {
    broken: broken.slice(0, LINK_AUDIT_MAX_LISTED),
    brokenTotal: broken.length,
    records: records.slice(0, LINK_AUDIT_MAX_LISTED),
    recordsTotal: records.length,
    redirected: redirected.slice(0, LINK_AUDIT_MAX_LISTED),
    redirectedTotal: redirected.length,
    reliable: homeAnswered && !args.crawl.truncated,
    warnings,
  };
}

/** Подписи находок — те же в отчёте, в дашборде и в журнале. */
export const RECORD_FINDING_LABELS: Readonly<Record<RecordFindingReason, string>> = {
  'not-200': 'адрес опубликованной записи ответил не 200',
  'not-linked': 'в обходе от главной не встретилось ни одной ссылки на этот адрес',
  'not-measured': 'адрес не спрошен: обход оборвался по пределу',
  'too-deep': `путь от главной длиннее ${String(LINK_AUDIT_MAX_CLICKS)} переходов`,
};
