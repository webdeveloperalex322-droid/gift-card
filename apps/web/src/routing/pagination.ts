/**
 * Пагинация сегментом пути: адреса, границы, директива робота и модель блока
 * ссылок (задача Э3-07).
 *
 * Норма: решение Ч-05 (`CLAUDE.md`, «Правила URL» — «Пагинация — сегментом пути
 * `/page/N`, не query-параметром. Первая страница любого списка живёт по базовому
 * URL; `/page/1` не существует ни на одном уровне»), решение Ч-01b/Ч-05
 * («Правила индексации» — страницы 2+ отдают `noindex,follow` и в sitemap не
 * входят), раздел «Рендеринг» («Бесконечная лента запрещена; только обычная
 * пагинация с постоянными URL»).
 *
 * Модуль ЧИСТЫЙ: ни запросов, ни чтения `process.env`, ни импортов Astro и
 * Payload. Поэтому он входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом `tests/unit/web-pagination.test.ts`. Маршруты
 * (`pages/otkrytki/page/[page].astro`, `pages/podborki/[...path].astro`) только
 * превращают его решения в HTTP-ответ.
 *
 * ## Почему `/page/1` не может появиться в выходном значении
 *
 * Это не дисциплина шаблона, а свойство функции: {@link paginationPathFor} на
 * номере 1 возвращает БАЗОВЫЙ путь. Из неё собираются все ссылки — и номера, и
 * «предыдущая» со второй страницы, — поэтому чтобы в HTML появился `/page/1`,
 * пришлось бы написать этот адрес руками, минуя модуль. Обратный порядок (строить
 * `/page/N` в шаблоне, а первую страницу обрабатывать условием) один раз уже
 * даёт дубль: условие забывают в одном месте из пяти.
 *
 * ## Два случая, которых ТЗ не задаёт
 *
 * Решения приняты на задаче Э3-07 и ПОДЛЕЖАТ ПОДТВЕРЖДЕНИЮ ЧЕЛОВЕКОМ (вынесены в
 * отчёт задачи):
 *
 *   - **`/page/1`** — одиночный 301 на базовый URL списка
 *     ({@link PageParamDecision} `redirect-to-base`). Адреса не существует, но он
 *     предсказуемо появится во внешних ссылках и в ручном наборе; 301 убирает
 *     дубль и не создаёт «существующего» адреса. Цепочки не возникает: переход
 *     ведёт прямо на базовый URL, а не на другую форму `/page/…`. Маршрут при
 *     этом обязан сначала убедиться, что базовый URL отвечает 200, иначе получился
 *     бы 301 на 404;
 *   - **номер вне диапазона** (`0`, отрицательный, нечисловой, с ведущим нулём,
 *     больше числа страниц) — **404**. Не 200 с пустой сеткой: пустая страница не
 *     отдаёт 200 (ТЗ §5.3). И не редирект на базовый URL: тогда бесконечное
 *     множество адресов вело бы 301 в один, то есть краулер получал бы повод
 *     обходить их все.
 *
 * ## Чего здесь нет намеренно
 *
 *   - **`rel="next"`/`rel="prev"`.** Google их не использует, а ошибка в них
 *     дороже отсутствия (решение задачи Э3-07);
 *   - **исключения страниц пагинации из sitemap.** Это состав sitemap, задача
 *     Э4-04; здесь только директива робота, из которой это исключение и обязано
 *     выводиться данными;
 *   - **какой бы то ни было подгрузки.** Модель — список постоянных адресов;
 *     бесконечная лента запрещена.
 */

import {
  canonicalizePath,
  looksLikeAbsoluteUrl,
  PAGINATION_SEGMENT,
  pathSegments,
} from '@otkritka/shared';

export { PAGINATION_SEGMENT };

/**
 * Директивы, допустимые в `<meta name="robots">` на этом сайте. Совпадает с
 * пропом `robots` у `../layouts/BaseLayout.astro` и с полем `robots` контентных
 * коллекций: значение без догадок ходит от записи до тега.
 */
export type RobotsDirective = 'index,follow' | 'noindex,follow' | 'noindex,nofollow';

/**
 * Сколько соседних номеров показывается слева и справа от текущей страницы.
 *
 * Значение — выбор агента (кандидат в реестр решений человека). Смысл окна:
 * список номеров обязан быть ограниченным, иначе у каталога из сотни страниц блок
 * пагинации сам становится страницей ссылок. Первая и последняя страницы в блоке
 * есть всегда — без них список из середины не даёт вернуться к началу.
 */
export const PAGINATION_WINDOW = 1;

/**
 * Каноническая запись номера страницы в адресе: без ведущего нуля, без знака,
 * без пробелов, только цифры ASCII.
 *
 * Ведущий нуль отклоняется, а не нормализуется, и это тот же довод, по которому
 * процентно-кодированный псевдоним пути отклоняется в `./path-policy.ts`:
 * `/page/02` — это ВТОРОЙ адрес второй страницы. Нормализация редиректом создала
 * бы их бесконечно много (`/page/002`, `/page/0002`).
 *
 * Предел длины держит номер в безопасных целых: `Number` на 17 цифрах уже теряет
 * точность, и сравнение с числом страниц перестало бы быть сравнением.
 */
const CANONICAL_PAGE_NUMBER = /^[1-9][0-9]{0,8}$/;

/** Первая страница списка. Живёт по базовому URL — своего адреса у неё нет. */
const FIRST_PAGE = 1;

/**
 * Разбор пути на базовый URL списка и номер страницы из адреса.
 *
 * Хвостом пагинации считаются РОВНО последние два сегмента вида `page/<что-то>`.
 * Номер здесь не проверяется — он возвращается строкой, как пришёл: проверка
 * формы это отдельное решение ({@link decidePageParam}), и смешивать их нельзя,
 * иначе `/page/0` выглядел бы как путь записи со slug `0`.
 *
 * Неоднозначности не возникает: сегмент `page` запрещён в slug на любой позиции
 * (реестр зарезервированных маршрутов, `packages/shared`), поэтому запись,
 * чей путь оканчивается на `page/<что-то>`, существовать не может.
 *
 * @throws Error если на вход дали не путь (параметры, фрагмент, абсолютный или
 *   протокольно-относительный адрес) — проверка живёт в `pathSegments`.
 */
export function splitPaginatedPath(path: string): {
  readonly basePath: string;
  readonly pageParam: string | null;
} {
  const segments = [...pathSegments(path)];
  const last = segments.at(-1);
  if (last === undefined || segments.at(-2) !== PAGINATION_SEGMENT) {
    return { basePath: canonicalizePath(path), pageParam: null };
  }
  segments.splice(-2, 2);
  return {
    basePath: segments.length === 0 ? '/' : `/${segments.join('/')}`,
    pageParam: last,
  };
}

/** Что маршрут обязан сделать с номером страницы, взятым из адреса. */
export type PageParamDecision =
  /** Номер канонический и не первый: показываем эту страницу списка. */
  | { readonly action: 'page'; readonly page: number }
  /** `/page/1` — одиночный 301 на базовый URL списка. */
  | { readonly action: 'redirect-to-base'; readonly reason: string }
  /** Адресом страницы такой номер не является — 404. */
  | { readonly action: 'not-found'; readonly reason: string };

/**
 * Решение по номеру страницы, взятому из адреса.
 *
 * Диапазон здесь НЕ проверяется: число страниц известно только после запроса, и
 * функция обязана оставаться чистой. Маршрут после этого решения сверяет номер с
 * `pageCount` и на превышении отвечает 404 — тем же, что и на неканонической
 * записи номера.
 */
export function decidePageParam(raw: string): PageParamDecision {
  if (!CANONICAL_PAGE_NUMBER.test(raw)) {
    return {
      action: 'not-found',
      reason:
        `«${raw}» не является номером страницы. Канонический номер — целое от 2 без ведущего ` +
        'нуля и без знака: /page/0, /page/01 и /page/dva адресами не являются, поэтому они ' +
        'отвечают 404. Редирект на базовый URL здесь запрещён — тогда бесконечное множество ' +
        'адресов вело бы 301 в один, и краулер получил бы повод обойти их все.',
    };
  }

  const page = Number(raw);
  if (page === FIRST_PAGE) {
    return {
      action: 'redirect-to-base',
      reason:
        'Первая страница списка живёт по базовому URL, /page/1 не существует ни на одном ' +
        'уровне (решение Ч-05). Ответ — одиночный 301 на базовый URL: адрес предсказуемо ' +
        'появляется во внешних ссылках и в ручном наборе, и 301 убирает дубль, не создавая ' +
        'существующего адреса.',
    };
  }

  return { action: 'page', page };
}

/**
 * Число страниц списка.
 *
 * У пустого списка страниц НОЛЬ, а не одна: страницы 1 у него тоже нет — базовый
 * URL пустого списка не отдаёт 200 (ТЗ §5.3), и маршрут отвечает 404.
 *
 * @throws Error если размер страницы не целое ≥ 1 или число элементов
 *   отрицательное. Оба случая — ошибка вызывающего: молчаливое `0` или `Infinity`
 *   дали бы список, границы которого зависят от опечатки.
 */
export function pageCountFor(totalItems: number, perPage: number): number {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new Error(
      `Размер страницы «${String(perPage)}» недопустим: ожидается целое от 1. Значение задаёт ` +
        'слой данных (DEFAULT_CARDS_PER_PAGE), и подстановка вместо него нуля означала бы ' +
        'деление на ноль в расчёте числа страниц.',
    );
  }
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new Error(
      `Число элементов списка «${String(totalItems)}» недопустимо: ожидается целое от 0.`,
    );
  }
  return Math.ceil(totalItems / perPage);
}

/**
 * Путь страницы списка. Номер 1 даёт БАЗОВЫЙ путь — это и есть решение Ч-05.
 *
 * @throws Error если базовый путь — корень сайта (главная списком не является и
 *   пагинации не имеет), если он сам оканчивается на хвост `page/N` (второй
 *   уровень пагинации — это выдуманный адрес), если номер не целое ≥ 1 либо если
 *   вместо пути передали абсолютный адрес.
 */
export function paginationPathFor(basePath: string, page: number): string {
  // Абсолютный адрес отклоняется ЗДЕСЬ, до нормализации, и это не дублирование
  // проверки: `canonicalizePath` его не отвергает — он схлопнул бы
  // `https://chuzhoy.test/otkrytki` в правдоподобный относительный путь
  // `/https:/chuzhoy.test/otkrytki`, то есть в рабочую ссылку пагинации на
  // несуществующую страницу СВОЕГО хоста. Та же проверка и по той же причине
  // стоит у звена крошек и в `./canonical.ts`.
  if (looksLikeAbsoluteUrl(basePath)) {
    throw new Error(
      `Базовый путь списка «${basePath}» задан абсолютным адресом. Ожидается путь от корня ` +
        'сайта: хост попадает в абсолютный URL только из SITE_URL через единственный хелпер ' +
        '(CLAUDE.md, «Правила URL»), а ссылки пагинации остаются относительными.',
    );
  }
  const split = splitPaginatedPath(basePath);
  if (split.pageParam !== null) {
    throw new Error(
      `Базовый путь списка «${basePath}» сам оканчивается на «/${PAGINATION_SEGMENT}/` +
        `${split.pageParam}». Второго уровня пагинации не существует: /page/N строится от ` +
        'базового URL списка, а не от другой его страницы.',
    );
  }
  if (split.basePath === '/') {
    throw new Error(
      'Корень сайта не пагинируется: главная — не список, и адреса /page/N у неё нет. ' +
        'Пагинацию имеют список карточек подборки и каталог /otkrytki.',
    );
  }
  if (!Number.isInteger(page) || page < FIRST_PAGE) {
    throw new Error(
      `Номер страницы «${String(page)}» недопустим: ожидается целое от ${String(FIRST_PAGE)}.`,
    );
  }
  return page === FIRST_PAGE
    ? split.basePath
    : `${split.basePath}/${PAGINATION_SEGMENT}/${String(page)}`;
}

/**
 * Директива робота для страницы списка.
 *
 * Первая страница отдаёт директиву ЗАПИСИ (у каталога — директиву маршрута):
 * решение об `index,follow` принимает человек, и переписывать его здесь нельзя.
 * Страницы 2+ — `noindex,follow` (решение Ч-01b): ссылки обходятся, страницы в
 * индекс не идут и в sitemap не попадают.
 *
 * Исключение ровно одно: `noindex,nofollow` на первой странице сохраняется и на
 * страницах 2+. Страница пагинации не бывает ОТКРЫТЕЕ базовой — иначе директива,
 * которой человек закрыл обход списка, снималась бы со второй страницы.
 */
export function robotsForPage(base: RobotsDirective, page: number): RobotsDirective {
  if (page === FIRST_PAGE) {
    return base;
  }
  return base === 'noindex,nofollow' ? base : 'noindex,follow';
}

/**
 * Заголовок страницы пагинации: тот же текст плюс номер.
 *
 * Зачем номер в title и H1: два одинаковых title на двух адресах — это дубль
 * (п. 22.1), даже когда оба адреса закрыты от индексации. Шаблонным SEO-текстом
 * это не является — номер страницы факт навигации, а не подставленное в
 * заготовку ключевое слово.
 */
export function paginationTitle(text: string, page: number): string {
  return page === FIRST_PAGE ? text : `${text} — страница ${String(page)}`;
}

/**
 * Текст крошки страницы пагинации.
 *
 * @throws Error на первой странице: её крошка — сам список, а не номер.
 */
export function paginationCrumbLabel(page: number): string {
  if (!Number.isInteger(page) || page <= FIRST_PAGE) {
    throw new Error(
      `Крошки «Страница ${String(page)}» не бывает: первая страница списка живёт по базовому ` +
        'URL, и её крошка — сам список.',
    );
  }
  return `Страница ${String(page)}`;
}

/** Звено блока пагинации: либо номер со своим адресом, либо помеченный разрыв. */
export type PaginationEntry =
  | {
      readonly kind: 'page';
      readonly page: number;
      /** Постоянный адрес страницы. У первой страницы — базовый URL списка. */
      readonly path: string;
      readonly current: boolean;
    }
  | { readonly kind: 'gap' };

export interface PaginationModel {
  readonly page: number;
  readonly pageCount: number;
  /** Путь предыдущей страницы; со второй страницы — БАЗОВЫЙ URL. */
  readonly previousPath: string | null;
  /** Путь следующей страницы. На последней — `null`: ленты дальше нет. */
  readonly nextPath: string | null;
  readonly entries: readonly PaginationEntry[];
}

export interface PaginationModelInput {
  readonly basePath: string;
  readonly page: number;
  readonly pageCount: number;
}

/**
 * Модель блока пагинации либо `null`, если блока нет вовсе.
 *
 * `null` при одной странице — не оптимизация разметки: блок из единственного
 * номера был бы ссылкой страницы на саму себя.
 *
 * @throws Error если номер страницы вне диапазона. До модели такой номер
 *   доходить не должен: маршрут отвечает на него 404 раньше, поэтому здесь это
 *   ошибка вызывающего, а не состояние данных.
 */
export function paginationModel(input: PaginationModelInput): PaginationModel | null {
  const { page, pageCount } = input;
  if (!Number.isInteger(pageCount) || pageCount < 0) {
    throw new Error(`Число страниц «${String(pageCount)}» недопустимо: ожидается целое от 0.`);
  }
  if (pageCount <= 1) {
    return null;
  }
  if (!Number.isInteger(page) || page < FIRST_PAGE || page > pageCount) {
    throw new Error(
      `Страницы ${String(page)} у списка «${input.basePath}» нет: страниц всего ` +
        `${String(pageCount)}. Номер вне диапазона обязан получить 404 в маршруте, а не ` +
        'блок пагинации с несуществующей текущей страницей.',
    );
  }

  const numbers = new Set<number>([FIRST_PAGE, pageCount]);
  for (let near = page - PAGINATION_WINDOW; near <= page + PAGINATION_WINDOW; near += 1) {
    if (near >= FIRST_PAGE && near <= pageCount) {
      numbers.add(near);
    }
  }

  const entries: PaginationEntry[] = [];
  let previousNumber: number | null = null;
  for (const number of [...numbers].sort((left, right) => left - right)) {
    if (previousNumber !== null && number - previousNumber > 1) {
      entries.push({ kind: 'gap' });
    }
    entries.push({
      current: number === page,
      kind: 'page',
      page: number,
      path: paginationPathFor(input.basePath, number),
    });
    previousNumber = number;
  }

  return {
    entries,
    nextPath: page === pageCount ? null : paginationPathFor(input.basePath, page + 1),
    page,
    pageCount,
    previousPath: page === FIRST_PAGE ? null : paginationPathFor(input.basePath, page - 1),
  };
}
