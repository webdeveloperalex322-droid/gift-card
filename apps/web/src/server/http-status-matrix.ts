/**
 * Матрица HTTP-статусов — ОДИН проверяемый объект вместо таблицы в документе
 * (задача Э4-06).
 *
 * Норма: `CLAUDE.md`, раздел «HTTP-статусы» (таблица «Ситуация → Ответ» и два
 * запрета рядом с ней) плюс «Правила индексации» в части «пустая или слабая
 * страница не отдаёт 200 как полноценная посадочная».
 *
 * ## Зачем модуль, если каждая строка и так проверена
 *
 * Строки таблицы закрывались по одной и в разное время: 404 и 503 — на Э3-11,
 * 301 и 410 — на Э4-02, «пустая страница не 200» — на Э3-13. Проверки живы, но
 * ТАБЛИЦЫ как объекта не существовало: перечень ситуаций жил в документе, а
 * доказательства — в семи местах кода и смоуков. Такой набор ломается не тем,
 * что проверка провалится, а тем, что СТРОКУ ЗАБУДУТ: новая ситуация
 * добавляется в `CLAUDE.md` одной строкой таблицы, и ничто не падает.
 *
 * Поэтому здесь перечень ситуаций, у каждой — ожидаемые статусы, правила
 * заголовков и ССЫЛКИ НА ПРОВЕРКИ ({@link StatusCoverage}). Ссылка машинная: она
 * называет файл и строку, которая обязана в нём быть дословно. Отсюда три
 * замка, и все три срабатывают в обычном `pnpm test`
 * (`tests/unit/web-http-status-matrix.test.ts`):
 *
 *   1. состав {@link HTTP_STATUS_MATRIX} сверяется с таблицей САМОГО
 *      `CLAUDE.md` — строка, добавленная в документ и не добавленная сюда,
 *      роняет тест, и наоборот;
 *   2. у каждой строки обязана быть хотя бы одна ссылка на проверку, а файл по
 *      ссылке — содержать названный якорь. Строка без проверки и проверка,
 *      которую переименовали или удалили, видны одинаково;
 *   3. сами правила исполняются: {@link statusViolations} применяется и в
 *      юнит-тесте к чистым решениям (`resolveRedirect`, `maintenanceMode`, тела
 *      410 и 503), и в живом смоуке к настоящим ответам сервера.
 *
 * ## Почему ссылки на проверки лежат в этом файле, а не в тесте
 *
 * Их читают ДВА потребителя. Юнит-тест — чтобы убедиться, что проверка
 * существует; живой смоук (`../../scripts/smoke-redirects.ts`) — чтобы взять из
 * матрицы список строк, которые обязан отработать ИМЕННО ОН, и упасть, если
 * какая-то осталась неотработанной. Разложи их по тестам — и вторая половина
 * замка исчезнет: смоук перестанет знать, чего от него ждут.
 *
 * ## Чего в матрице нет
 *
 * Нет ответа 400 и нет 500. Оба не являются строкой нормы: 400 — это отказ
 * разобрать цель запроса (правила и проверки — в `../routing/path-policy.ts`),
 * 500 — авария. Матрица описывает СУДЬБУ АДРЕСА, а не поведение при поломке.
 *
 * Модуль ЧИСТЫЙ: без Astro, без Payload, без чтения файлов и окружения. Входит в
 * composite-проект `../../tsconfig.node.json`.
 */

/** Требование к заголовку ответа. Промежуточного «как получится» здесь нет. */
export type HeaderRule = 'required' | 'forbidden';

/**
 * Откуда строка взялась.
 *
 *   - `table-row` — строка таблицы «Ситуация → Ответ». Её текст сверяется с
 *     `CLAUDE.md` дословно;
 *   - `prohibition` — запрет, записанный рядом с таблицей или в «Правилах
 *     индексации». У него нет колонок, но есть предложение нормы, которое тоже
 *     сверяется дословно ({@link HttpStatusRow.quote}).
 */
export type HttpStatusRowKind = 'table-row' | 'prohibition';

export type HttpStatusRowId =
  | 'published-200'
  | 'moved-301'
  | 'deleted-gone'
  | 'replaced-301'
  | 'service-unavailable-503'
  | 'no-blanket-home-redirect'
  | 'real-404-with-navigation'
  | 'no-soft-404';

/**
 * Ссылка на существующую проверку строки.
 *
 * `anchor` — не описание, а ДОСЛОВНАЯ строка из файла: имя проверки смоука или
 * имя `it(...)` юнит-теста. Так ссылка перестаёт быть обещанием: переименовали
 * проверку — тест матрицы падает и требует поправить ссылку либо признать, что
 * строка осталась без доказательства.
 */
export interface StatusCoverage {
  /** `unit` — обычный `pnpm test`; `live` — смоук против собранного сервера. */
  readonly kind: 'unit' | 'live';
  /** Путь файла от корня монорепозитория, через прямые слеши. */
  readonly file: string;
  /** Строка, обязанная присутствовать в файле дословно. */
  readonly anchor: string;
}

export interface HttpStatusRow {
  readonly id: HttpStatusRowId;
  readonly kind: HttpStatusRowKind;
  /** Левая колонка таблицы `CLAUDE.md` дословно; у запрета — краткое имя. */
  readonly situation: string;
  /** Правая колонка таблицы дословно; у запрета — требуемый ответ словами. */
  readonly answer: string;
  /** Предложение нормы дословно. Есть только у запретов. */
  readonly quote?: string;
  /** Допустимые статусы. Несколько — когда норма даёт выбор («404/410»). */
  readonly statuses: readonly number[];
  readonly location: HeaderRule;
  readonly retryAfter: HeaderRule;
  /**
   * Сколько переходов допускается от запрошенного адреса до конечного ответа.
   * У ответов, которые сами являются конечными, — ноль.
   */
  readonly maxHops: number;
  /** `Location`, который для этой строки является нарушением, а не адресом. */
  readonly locationMustNotBe: readonly string[];
  /** Куски, обязанные быть в теле ответа. Пустой список — тело не проверяется. */
  readonly bodyMustContain: readonly string[];
  /** Зачем строка такая. Попадает в текст нарушения не целиком, а как справка. */
  readonly why: string;
  readonly coverage: readonly StatusCoverage[];
}

const SMOKE_REDIRECTS = 'apps/web/scripts/smoke-redirects.ts';
const SMOKE_PAGES = 'apps/web/scripts/smoke-pages.ts';
const UNIT_MATRIX = 'tests/unit/web-http-status-matrix.test.ts';

/**
 * Матрица. Порядок первых пяти строк совпадает с порядком таблицы `CLAUDE.md`, и
 * это требование теста, а не оформление: так расхождение видно построчно.
 */
export const HTTP_STATUS_MATRIX: readonly HttpStatusRow[] = [
  {
    id: 'published-200',
    kind: 'table-row',
    situation: 'Опубликованная страница',
    answer: '200',
    statuses: [200],
    location: 'forbidden',
    retryAfter: 'forbidden',
    maxHops: 0,
    locationMustNotBe: [],
    bodyMustContain: [],
    why:
      'Опубликованная страница отвечает сама, а не переходом: 301 с адреса живой страницы ' +
      'делает её недостижимой, и причина не видна ни в шаблоне, ни в записи.',
    coverage: [
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'цель переноса отвечает 200' },
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'у живой страницы нет Location' },
    ],
  },
  {
    id: 'moved-301',
    kind: 'table-row',
    situation: 'Перенос',
    answer: 'одиночный 301',
    statuses: [301],
    location: 'required',
    retryAfter: 'forbidden',
    // «Одиночный» — это и есть ограничение на число переходов: цепочки
    // запрещены, а схлопывание цепочки в данных проверяется тем же числом.
    maxHops: 1,
    locationMustNotBe: [],
    bodyMustContain: [],
    why:
      'Перенос отвечает ОДНИМ переходом на конечный адрес. Второй переход — потеря веса ' +
      'ссылки, и заметен он не в админке, а в логах поисковой системы.',
    coverage: [
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'перенос: ровно ОДИН переход' },
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'перенос ведёт на 200, а не на 404' },
      {
        kind: 'live',
        file: SMOKE_REDIRECTS,
        anchor: 'цепочка A→B при B→C: ровно ОДИН переход',
      },
      { kind: 'unit', file: UNIT_MATRIX, anchor: 'перенос: один переход на конечный адрес' },
    ],
  },
  {
    id: 'deleted-gone',
    kind: 'table-row',
    situation: 'Удалено без замены',
    answer: '404/410',
    statuses: [404, 410],
    location: 'forbidden',
    retryAfter: 'forbidden',
    maxHops: 0,
    locationMustNotBe: [],
    // Тело 410 обязано содержать навигацию (п. 23) и директиву робота: ответ
    // приходит по адресу, который был проиндексирован, и посетителю нужно
    // продолжение, а не тупик.
    bodyMustContain: ['<h1', 'href="/otkrytki"', 'noindex'],
    why:
      'Удалённый без замены адрес не отвечает ни 200, ни переходом. Выбор между 404 и 410 — ' +
      'решение администратора в группе `withdrawal`, и оба варианта норма.',
    coverage: [
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'удалено без замены — 410' },
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: '410 содержит заголовок и навигацию' },
      {
        kind: 'live',
        file: SMOKE_REDIRECTS,
        anchor: 'удалённая открытка не отдаёт 200 ни при каких параметрах',
      },
      { kind: 'unit', file: UNIT_MATRIX, anchor: 'удалено без замены: 410 с навигацией' },
    ],
  },
  {
    id: 'replaced-301',
    kind: 'table-row',
    situation: 'Удалено с заменой',
    answer: '301 на релевантный URL',
    statuses: [301],
    location: 'required',
    retryAfter: 'forbidden',
    maxHops: 1,
    // Главная — не «релевантный URL» ни для одной удалённой страницы. Тот же
    // адрес отдельно закрыт запретом `no-blanket-home-redirect`.
    locationMustNotBe: ['/'],
    bodyMustContain: [],
    why:
      'Замена — это конкретный релевантный адрес, названный администратором. Подстановка ' +
      'главной превращает перенос в потерю страницы.',
    coverage: [
      {
        kind: 'live',
        file: SMOKE_REDIRECTS,
        anchor: 'удалено с заменой — ровно один 301 на релевантный адрес',
      },
      { kind: 'unit', file: UNIT_MATRIX, anchor: 'удалено с заменой: 301 на названный адрес' },
    ],
  },
  {
    id: 'service-unavailable-503',
    kind: 'table-row',
    situation: 'Сервис недоступен',
    answer: '503 + Retry-After',
    statuses: [503],
    location: 'forbidden',
    retryAfter: 'required',
    maxHops: 0,
    locationMustNotBe: [],
    bodyMustContain: ['<h1', 'noindex'],
    why:
      '503 с Retry-After — единственный ответ, при котором поисковая система понимает ' +
      '«страница жива, приходите позже». 200 с текстом «ведём работы», 302 на заглушку и 404 ' +
      'означают для краулера, что материала больше нет.',
    coverage: [
      {
        kind: 'live',
        file: SMOKE_REDIRECTS,
        anchor: 'в режиме обслуживания перенесённый адрес отдаёт 503, а не 301',
      },
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'у 503 есть Retry-After' },
      { kind: 'unit', file: UNIT_MATRIX, anchor: 'сервис недоступен: 503 с Retry-After' },
    ],
  },
  {
    id: 'no-blanket-home-redirect',
    kind: 'prohibition',
    situation: 'Массовый редирект удалённых страниц на главную',
    answer: 'запрещён: 301 ведёт на названный релевантный адрес либо правила нет вовсе',
    quote: 'Массовый редирект удалённых страниц на главную запрещён.',
    statuses: [301],
    location: 'required',
    retryAfter: 'forbidden',
    maxHops: 1,
    locationMustNotBe: ['/'],
    bodyMustContain: [],
    why:
      'Правило 301 без цели не превращается в переход на главную: оно объявляется негодным, и ' +
      'адрес отвечает так, как будто правила нет. Отдать 301 «куда-нибудь» дороже, чем не ' +
      'отдать его вовсе.',
    coverage: [
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'замена не является главной страницей' },
      {
        kind: 'unit',
        file: UNIT_MATRIX,
        anchor: 'правило 301 без цели не подставляет главную',
      },
    ],
  },
  {
    id: 'real-404-with-navigation',
    kind: 'prohibition',
    situation: 'Несуществующий адрес',
    answer: 'настоящий 404 с навигацией, без Location',
    quote: 'Страница 404 отдаёт настоящий 404 и содержит навигацию.',
    statuses: [404],
    location: 'forbidden',
    retryAfter: 'forbidden',
    maxHops: 0,
    locationMustNotBe: [],
    bodyMustContain: ['<h1', 'href="/"'],
    why:
      'Настоящий — значит статус 404, а не 200 с текстом «не найдено» и не переход на главную. ' +
      'Навигация обязательна: без неё ответ является тупиком.',
    coverage: [
      {
        kind: 'live',
        file: SMOKE_REDIRECTS,
        anchor: '404 остался настоящей страницей 404 с навигацией',
      },
      { kind: 'live', file: SMOKE_REDIRECTS, anchor: 'у 404 нет Location' },
      { kind: 'live', file: SMOKE_PAGES, anchor: 'черновик/review не отдаётся' },
    ],
  },
  {
    id: 'no-soft-404',
    kind: 'prohibition',
    situation: 'Пустая или слабая страница',
    answer: '404 вместо 200: полноценной посадочной она не является',
    quote: 'Пустая или слабая страница не отдаёт 200 как полноценная посадочная.',
    statuses: [404],
    location: 'forbidden',
    retryAfter: 'forbidden',
    maxHops: 0,
    locationMustNotBe: [],
    bodyMustContain: [],
    why:
      'Пустая сетка под заголовком — это soft 404. Решение принимается по ЗАПИСИ и до ' +
      'применения фильтра: адрес, отдающий 200 без параметров и 404 с ними, — два разных ' +
      'ответа одной страницы.',
    coverage: [
      {
        kind: 'live',
        file: SMOKE_PAGES,
        anchor: 'опустевший узел: базовый URL отдаёт 404, а не 200 с пустой сеткой',
      },
      { kind: 'live', file: SMOKE_PAGES, anchor: 'номер вне диапазона — 404 без редиректа' },
    ],
  },
];

/**
 * Строка матрицы по идентификатору.
 *
 * @throws Error на неизвестном идентификаторе: молчаливый `undefined` означал бы
 *   проверку, которая ничего не проверила, — а именно от этого матрица и
 *   существует.
 */
export function httpStatusRow(id: HttpStatusRowId): HttpStatusRow {
  const row = HTTP_STATUS_MATRIX.find((entry) => entry.id === id);
  if (row === undefined) {
    throw new Error(
      `В матрице HTTP-статусов нет строки «${id}». Идентификаторы перечислены типом ` +
        'HttpStatusRowId; расхождение означает правку матрицы без правки потребителя.',
    );
  }
  return row;
}

/** Наблюдение: что ответил сервер (или чистое решение) на конкретный адрес. */
export interface ObservedResponse {
  readonly status: number;
  /** Значение заголовка `Location`. Нет заголовка — `undefined` или `null`. */
  readonly location?: string | null | undefined;
  /** Значение заголовка `Retry-After` как строка либо число секунд. */
  readonly retryAfter?: string | number | null | undefined;
  /** Тело ответа. Обязательно для строк, у которых непустой `bodyMustContain`. */
  readonly body?: string | undefined;
  /** Сколько переходов было пройдено до этого ответа. */
  readonly hops?: number | undefined;
}

function headerPresent(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value === 'number' ? true : value.trim() !== '';
}

/**
 * Проверяет наблюдение по строке матрицы и возвращает СПИСОК нарушений.
 *
 * Список, а не первое нарушение и не булево значение: ответ бывает неправ сразу
 * в двух местах (например 503 без `Retry-After` и с `Location`), и отчёт «что-то
 * не так» отправил бы разбираться не туда. Пустой список — строка выполнена.
 *
 * Правило заголовка `Location` проверяется у КАЖДОЙ строки, включая те, где
 * его быть не должно. Это отдельное требование задачи Э4-06: 200, 404, 410 и 503
 * с заголовком `Location` — это ответы, которые часть клиентов и краулеров
 * трактует как переход.
 */
export function statusViolations(
  row: HttpStatusRow,
  observed: ObservedResponse,
): readonly string[] {
  const violations: string[] = [];

  if (!row.statuses.includes(observed.status)) {
    violations.push(
      `статус ${String(observed.status)} вместо ${row.statuses.join(' или ')} ` +
        `(«${row.situation}» → «${row.answer}»)`,
    );
  }

  const hasLocation = headerPresent(observed.location);
  if (row.location === 'required' && !hasLocation) {
    violations.push('нет заголовка Location, хотя ответ является переходом');
  }
  if (row.location === 'forbidden' && hasLocation) {
    violations.push(
      `есть заголовок Location: ${String(observed.location)} — этот ответ переходом не является`,
    );
  }
  if (hasLocation && row.locationMustNotBe.includes(String(observed.location))) {
    violations.push(
      `Location = ${String(observed.location)} — этот адрес для строки «${row.situation}» ` +
        'является нарушением, а не заменой',
    );
  }

  const hasRetryAfter = headerPresent(observed.retryAfter);
  if (row.retryAfter === 'required' && !hasRetryAfter) {
    violations.push('нет заголовка Retry-After: без него 503 читается как «материала нет»');
  }
  if (row.retryAfter === 'forbidden' && hasRetryAfter) {
    violations.push(
      `есть заголовок Retry-After: ${String(observed.retryAfter)} — ответ временным не является`,
    );
  }

  if (observed.hops !== undefined && observed.hops > row.maxHops) {
    violations.push(
      `переходов ${String(observed.hops)} при допустимых ${String(row.maxHops)}: ` +
        'цепочки редиректов запрещены',
    );
  }

  if (row.bodyMustContain.length > 0) {
    if (observed.body === undefined) {
      violations.push(
        'тело ответа не предъявлено, а строка требует его проверки: ' +
          `${row.bodyMustContain.join(', ')}`,
      );
    } else {
      for (const fragment of row.bodyMustContain) {
        if (!observed.body.includes(fragment)) {
          violations.push(`в теле ответа нет «${fragment}»`);
        }
      }
    }
  }

  return violations;
}

/**
 * Строки, живая проверка которых поручена конкретному файлу смоука.
 *
 * Смоук берёт этот список у матрицы и в конце прогона сверяет с тем, что
 * фактически отработал. Поэтому новая строка с живой проверкой в этом файле
 * заставляет смоук упасть, пока проверку не напишут, — а не остаётся обещанием
 * в комментарии.
 */
export function liveRowsFor(file: string): readonly HttpStatusRow[] {
  return HTTP_STATUS_MATRIX.filter((row) =>
    row.coverage.some((entry) => entry.kind === 'live' && entry.file === file),
  );
}
