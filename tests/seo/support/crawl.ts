/**
 * Обход сайта от главной по серверным `<a href>` — измерение глубины, на
 * котором держится требование «нет страниц-сирот» (п. 22, п. 5.1.5, задача
 * Э4-08).
 *
 * Модуль отвечает на один вопрос — «за сколько переходов от главной достижим
 * каждый адрес», — и не содержит ни одного утверждения: находки классифицирует
 * `../no-orphans.spec.ts`. Иначе падение говорило бы «обход сломался» вместо
 * «страница X недостижима».
 *
 * ═══ ПРАВИЛА ПОДСЧЁТА ═══
 *
 * Взяты из нормы и сверены с обходом дашборда (`apps/cms/src/audit/link-audit.ts`,
 * задача Э5-03), чтобы два отчёта об одном и том же не расходились в цифрах.
 * Совпадают:
 *
 *   - **ширина, а не глубина.** Нужна МИНИМАЛЬНАЯ длина пути от главной; обход в
 *     глубину дал бы первую найденную и завышал бы число переходов, порождая
 *     ложные находки «глубже нормы»;
 *   - **редирект переходом не считается.** Цель 3xx ставится в очередь на ТОЙ ЖЕ
 *     глубине: одиночный 301 внутри сайта иначе съедал бы клик из нормы «≤ 4»,
 *     хотя посетитель и краулер тратят на него один переход, а не два;
 *   - **предел числа запросов.** Обход без предела — полный проход по сайту на
 *     каждом `pnpm verify`. Упёрлись в предел — обход помечается усечённым, и
 *     «ссылок не найдено» при недообойдённом сайте не означает ничего;
 *   - **URL файлов не обходятся.** Искать `<a href>` внутри `.webp` бессмысленно.
 *
 * Расходятся сознательно, и оба расхождения — в безопасную сторону (могут
 * добавить находку, но не спрятать):
 *
 *   1. **адреса с параметрами не берутся вовсе.** Обход дашборда держит их
 *      отдельными целями, потому что ищет ещё и битые ссылки: ссылка на
 *      несуществующий адрес с параметрами тоже битая. Здесь измеряется
 *      достижимость ИНДЕКСИРУЕМЫХ страниц, а адрес с параметрами индексируемой
 *      страницей не бывает — у него нет собственного canonical (ТЗ §6.5) и он
 *      закрыт от индексации (§5.5, Ч-05). Считать переходы через ряд фильтра
 *      значило бы измерять путь, которым краулер до канонической страницы не
 *      идёт. Направление безопасное: выброшенные ссылки могут только увеличить
 *      измеренную глубину или сделать страницу ненайденной, то есть добавить
 *      находку, а не убрать;
 *   2. **со страницы `nofollow` ссылки не берутся.** Робот по ним не идёт,
 *      значит достижимости они не создают. Сегодня это ничего не меняет (ни одна
 *      страница выборки не отдаёт `nofollow`), но правило записано до того, как
 *      такая страница появится, — иначе достижимость однажды посчиталась бы по
 *      ссылкам, которых для робота нет.
 *
 * ═══ ПОНИЖЕНИЕ ГЛУБИНЫ ПОСЛЕ ОПРОСА ═══
 *
 * Обход в ширину даёт минимальную глубину только пока адреса встречаются в
 * порядке возрастания глубины. Здесь этот порядок нарушается штатно: цель
 * редиректа ставится в очередь на глубине СТРАНИЦЫ-ИСТОЧНИКА, а опрашивается
 * раундом позже. Поэтому страница с малой глубиной может быть опрошена поздно —
 * позже, чем тот же адрес был найден обычной ссылкой с глубины большей.
 *
 * Пример, на котором это ломается: `/` → 301 → `/a` (глубина 0, опрошен во
 * втором раунде) → 301 → `/b` (глубина 0, третий раунд), и `/b` ссылается на
 * `/x`; а `/x` к тому времени уже опрошен по ссылке из другой ветви с глубиной
 * 3. Просто взять `Math.min` мало: сам `/x` глубину исправит, а его потомки
 * останутся с 4 и 5 — то есть на ВЕРНОЙ перелинковке появится ложная находка
 * `too-deep` и красный обязательный шлюз. Ложное падение здесь не безопаснее
 * ложного зелёного: оно учит не верить приёмке.
 *
 * Поэтому понижение глубины у уже опрошенного узла возвращает его в очередь
 * (`probed = false` в {@link crawlFromHome}), и потомки получают глубину заново.
 * Цена — повторный запрос на каждое понижение; он платится только там, где
 * внутри сайта есть редиректы, а внутренние ссылки обязаны быть каноническими
 * (это отдельное требование, его проверяет `category-menu-links-are-live`).
 * Завершение обхода гарантируют два независимых ограничителя: глубина узла
 * только убывает (значит повторов конечное число) и предел числа запросов.
 *
 * Замер 2026-09-03 на наполненном каталоге: 69 адресов, 69 запросов — ни одного
 * повторного опроса, то есть на текущей перелинковке случай не встречается. Это
 * довод НЕ убирать проверку: случай редкий, а находка от него — красный шлюз без
 * причины.
 *
 * ═══ ПОЧЕМУ КОД ОБХОДА СВОЙ, А НЕ ИМПОРТ ИЗ `apps/cms` ═══
 *
 * `crawlSite` из `link-audit.ts` делает почти то же самое, и импорт выглядел бы
 * экономией. Он отклонён по тому же доводу, по которому приёмка держит свою
 * копию набора robots-директив: приёмка не берёт эталон из кода, который
 * проверяет. Правило подсчёта глубины — это и есть эталон требования «≤ 4
 * перехода»; импортируй приёмка его из продукта, изменение правила в продукте
 * (скажем, «редирект считать переходом» или «предел обхода 50 запросов») приёмка
 * приняла бы АВТОМАТИЧЕСКИ и без строки в своём дифе. Здесь же расхождение
 * правил даёт падение, которое человек увидит и разберёт.
 *
 * По той же причине не импортируется `isPageRoute` из `@otkritka/shared`:
 * различение «страница/файл» — тоже правило продукта. Оно продублировано
 * в {@link isFileUrl} узко и явно; расхождение с продуктом безопасно (лишний
 * адрес в обходе даёт лишнюю находку, а не спрятанную).
 */

import type { APIRequestContext } from '@playwright/test';

import { anchorTags, metaContents } from './html.js';
import { fetchRaw } from './http.js';
import { type AcceptanceTarget, urlFor } from './target.js';

/**
 * Норма достижимости: сколько переходов от главной допустимо.
 *
 * Значение из ТЗ (п. 5.1.5, чек-лист п. 22), а не выбор агента. Требование
 * держится на прямых ссылках из меню и с главной на праздничные узлы — следствие
 * Ч-04-5, из-за которого путь до карточки в паре «праздник × адресат» имеет пять
 * сегментов, а достижимость карточек за первой страницей списка обеспечивают
 * обязательные серверные блоки перелинковки (Ч-04-8).
 */
export const MAX_CLICKS_FROM_HOME = 4;

/**
 * До какой глубины идёт обход.
 *
 * На одну ступень сверх нормы — чтобы отличить «глубже нормы» от «не найдено
 * вовсе»: без запаса страница на пятом переходе выглядела бы ненайденной, и
 * отчёт вместо «слишком глубоко» показывал бы «нет ссылок», то есть называл бы
 * находку чужим именем. У обхода дашборда запас две ступени; здесь одна, потому
 * что приёмка платит за каждый запрос временем `pnpm verify`, а одной ступени
 * достаточно, чтобы находка называлась верно.
 */
export const CRAWL_DEPTH_LIMIT = MAX_CLICKS_FROM_HOME + 1;

/**
 * Предел числа запросов к стенду за один обход.
 *
 * ПРОВЕНАНС: выбор агента-аудитора. Замер 2026-09-03: на каталоге из 50
 * опубликованных открыток (46 реальных плюс 4 фикстуры харнесса Э6-02) и 11
 * опубликованных подборок (10 реальных плюс 1 фикстура) обход посещает 69
 * адресов, то есть запас почти шестикратный. Смысл предела не в экономии, а в том, чтобы обход, попавший
 * на разросшийся каталог, не превращал обязательный шлюз в многоминутный краулер
 * молча: превышение помечается и разбирается spec’ом.
 */
export const CRAWL_MAX_REQUESTS = 400;

/** Сколько запросов идёт одновременно. Тот же порядок, что у обхода дашборда. */
export const CRAWL_CONCURRENCY = 6;

/** Один адрес, встреченный обходом. */
export interface CrawledTarget {
  readonly url: string;
  /** Минимальное число ПЕРЕХОДОВ от главной; редирект переходом не считается. */
  readonly depth: number;
  /** Код ответа; `null` — адрес не спрошен (обход упёрся в предел). */
  readonly status: number | null;
  /** Значение `<meta name="robots">` у ответа 200; `null` — тега нет либо не 200. */
  readonly robots: string | null;
  /** Страницы, на которых стоит ссылка на этот адрес. */
  readonly referrers: readonly string[];
}

export interface CrawlResult {
  /** Адрес, с которого начат обход. */
  readonly start: string;
  readonly targets: ReadonlyMap<string, CrawledTarget>;
  /** Сколько запросов сделано. */
  readonly requested: number;
  /** Обход оборван пределом: находки о достижимости ненадёжны. */
  readonly truncated: boolean;
}

interface MutableTarget {
  url: string;
  depth: number;
  status: number | null;
  robots: string | null;
  referrers: string[];
  probed: boolean;
}

/** Сколько источников ссылки запоминается — для сообщения об ошибке. */
const MAX_REFERRERS = 5;

/**
 * URL файла, а не маршрут страницы: в последнем сегменте пути есть точка.
 *
 * Узкая копия правила `isPageRoute()` из `@otkritka/shared` — почему копия, а не
 * импорт, сказано в шапке модуля. Проверяется именно ПОСЛЕДНИЙ сегмент: точка в
 * середине пути (`/otkrytki/8-marta-mimoza`) файлом адрес не делает.
 */
export function isFileUrl(url: string): boolean {
  try {
    const segments = new URL(url).pathname.split('/');
    return (segments[segments.length - 1] ?? '').includes('.');
  } catch {
    return true;
  }
}

/**
 * Приводит `href` к абсолютному внутреннему адресу страницы либо отвергает его.
 *
 * `null` возвращается для: пустого значения, якоря, чужой схемы (`mailto:`,
 * `tel:`, `javascript:`), чужого origin и — отдельным решением, разобранным в
 * шапке модуля — любого адреса С ПАРАМЕТРАМИ. Фрагмент отбрасывается: `#dalee`
 * второго адреса не создаёт.
 */
export function normalizeInternalHref(
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
  if (url.search !== '') {
    return null;
  }
  return `${url.origin}${url.pathname}`;
}

/** Директива запрещает идти по ссылкам страницы. */
function forbidsFollowing(robots: string | null): boolean {
  return (robots ?? '')
    .toLowerCase()
    .split(/[\s,]+/u)
    .includes('nofollow');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const slice = items.slice(start, start + limit);
    results.push(...(await Promise.all(slice.map(worker))));
  }
  return results;
}

/**
 * Обходит сайт от главной и возвращает измеренные глубины.
 *
 * Ни одного утверждения здесь нет — в том числе о статусах: адрес, ответивший
 * 404, остаётся в результате со своим кодом. Решение «это нарушение» принимает
 * spec; пропусти обход такой адрес, он спрятал бы ровно то, что проверяется.
 */
export async function crawlFromHome(
  request: APIRequestContext,
  target: AcceptanceTarget,
  options: {
    readonly maxDepth?: number;
    readonly maxRequests?: number;
    readonly concurrency?: number;
  } = {},
): Promise<CrawlResult> {
  const maxDepth = options.maxDepth ?? CRAWL_DEPTH_LIMIT;
  const maxRequests = options.maxRequests ?? CRAWL_MAX_REQUESTS;
  const concurrency = options.concurrency ?? CRAWL_CONCURRENCY;
  const start = urlFor(target, '/');

  const targets = new Map<string, MutableTarget>();
  let requested = 0;
  let truncated = false;

  const see = (url: string, depth: number, referrer: string | null): MutableTarget => {
    const known = targets.get(url);
    if (known !== undefined) {
      if (depth < known.depth) {
        known.depth = depth;
        // Узел уже опрошен, а путь к нему нашёлся КОРОЧЕ — его потомки унесли
        // завышенную глубину, и исправить её можно только пройдя по ним заново.
        // Поэтому узел возвращается в очередь: `probed = false` заставит
        // вызывающего положить его во фронтир (`if (!next.probed)`), а повторный
        // обход раздаст потомкам `depth + 1` от нового, меньшего значения.
        // Разбор, почему без этого возможен ЛОЖНЫЙ `too-deep`, — в шапке модуля,
        // раздел «Понижение глубины после опроса».
        known.probed = false;
      }
      if (
        referrer !== null &&
        known.referrers.length < MAX_REFERRERS &&
        !known.referrers.includes(referrer)
      ) {
        known.referrers.push(referrer);
      }
      return known;
    }
    const created: MutableTarget = {
      depth,
      probed: false,
      referrers: referrer === null ? [] : [referrer],
      robots: null,
      status: null,
      url,
    };
    targets.set(url, created);
    return created;
  };

  let frontier: MutableTarget[] = [see(start, 0, null)];

  // Раунд обхода — это не глубина: цель редиректа встаёт в очередь на той же
  // глубине и тратит раунд, а узел, чья глубина понизилась после опроса,
  // возвращается в очередь и тратит ещё один. Запас сверх `maxDepth` покрывает
  // и то и другое, а верхняя граница числа раундов не даёт кольцу редиректов
  // крутиться вечно. Завершение обхода при этом гарантирует не она, а два
  // независимых ограничителя: глубина узла только УБЫВАЕТ (значит повторных
  // опросов конечное число) и `maxRequests`.
  const maxRounds = (maxDepth + 4) * 2;
  for (let round = 0; round < maxRounds && frontier.length > 0; round += 1) {
    const seen = new Set<string>();
    const batch = frontier.filter((candidate) => {
      if (candidate.probed || seen.has(candidate.url)) {
        return false;
      }
      seen.add(candidate.url);
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

    const answers = await mapWithConcurrency(allowed, concurrency, async (candidate) => ({
      candidate,
      response: await fetchRaw(request, candidate.url),
    }));

    for (const { candidate, response } of answers) {
      candidate.probed = true;
      candidate.status = response.status;

      if (response.status >= 300 && response.status < 400) {
        const moved =
          response.resolvedLocation === null
            ? null
            : normalizeInternalHref(response.resolvedLocation, candidate.url, target.origin);
        if (moved !== null && !isFileUrl(moved)) {
          const next = see(moved, candidate.depth, null);
          if (!next.probed) {
            frontier.push(next);
          }
        }
        continue;
      }

      if (response.status !== 200) {
        continue;
      }
      candidate.robots = metaContents(response.body, 'robots')[0] ?? null;

      if (candidate.depth >= maxDepth || forbidsFollowing(candidate.robots)) {
        // Страница отвечена и учтена; её ссылки за пределом обхода либо закрыты
        // от обхода директивой.
        continue;
      }
      for (const anchor of anchorTags(response.body)) {
        const internal = normalizeInternalHref(anchor.href ?? '', candidate.url, target.origin);
        if (internal === null || isFileUrl(internal)) {
          continue;
        }
        const next = see(internal, candidate.depth + 1, candidate.url);
        if (!next.probed) {
          frontier.push(next);
        }
      }
    }

    if (truncated) {
      break;
    }
  }

  // Фронтир не пуст, а раунды кончились: часть адресов не спрошена, и это НЕ
  // «ссылок не найдено». Пометка та же, что у исчерпанного бюджета запросов, —
  // spec обязан назвать такие адреса «не измерено», а не «сирота».
  if (frontier.some((candidate) => !candidate.probed)) {
    truncated = true;
  }

  const frozen = new Map<string, CrawledTarget>();
  for (const [url, mutable] of targets) {
    frozen.set(url, {
      depth: mutable.depth,
      referrers: [...mutable.referrers],
      robots: mutable.robots,
      status: mutable.status,
      url,
    });
  }
  return { requested, start, targets: frozen, truncated };
}

/** Адрес в том виде, в каком его различает обход: origin + путь, без параметров. */
export function crawlKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Директива открывает страницу для индексации. */
export function isIndexableDirective(robots: string | null): boolean {
  return (robots ?? '').trim().toLowerCase().startsWith('index');
}
