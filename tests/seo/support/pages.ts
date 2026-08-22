/**
 * Инвентарь страниц, которые сайт отдаёт СЕЙЧАС, и ожидаемая директива робота
 * для каждой.
 *
 * Список ведётся только добавлением: страницы Э3-05…Э3-12 (карточка, подборка,
 * каталоги, главная, `/search`, служебные) дописываются сюда, и все инвариантные
 * specs (`single-h1`, `self-canonical-absolute`, `robots-directive-present`,
 * `unique-title-h1-description`, `internal-links-are-anchors`,
 * `server-rendered-without-js`, `no-client-javascript`) начинают проверять их без
 * единой правки в самих specs. Заглушек-скипов на ещё не существующие страницы
 * здесь нет намеренно: пропуск, притворяющийся проверкой, — та же ошибка
 * отчётности, что и `SKIPPED`, выданный за `PASSED`.
 *
 * ## Про поле `expectedRobots`
 *
 * Оно фиксирует, что страница отдаёт СЕЙЧАС, и охраняет границу: перевод
 * страницы в `index,follow` — решение человека (п. 7.1 и п. 23 ТЗ), а не
 * побочный эффект правки шаблона. Если рефакторинг layout молча откроет
 * страницу в индекс, `robots-directive-present.spec.ts` упадёт. Обратная
 * сторона: когда человек ОСОЗНАННО открывает страницу, он правит и эту строку —
 * то есть решение видно в дифе. Аудитор значения здесь не «повышает»: смена
 * `noindex` на `index` в этом файле без решения человека — нарушение границ
 * агента `seo-auditor`.
 */

/** Директивы, допустимые в `<meta name="robots">` на этом сайте. */
export const ALLOWED_ROBOTS_DIRECTIVES = [
  'index,follow',
  'noindex,follow',
  'noindex,nofollow',
] as const;

export type RobotsDirective = (typeof ALLOWED_ROBOTS_DIRECTIVES)[number];

export interface AcceptancePage {
  /**
   * Канонический путь страницы: без завершающего слеша (решение Ч-21),
   * единственное исключение — корень `/`.
   */
  readonly path: string;
  /** Ожидаемое значение `<meta name="robots">`. */
  readonly expectedRobots: RobotsDirective;
  /** Задача, которой страница принадлежит, — чтобы падение указывало на владельца. */
  readonly task: string;
  /** Зачем страница существует и что на ней проверяется. */
  readonly note: string;
}

export const ACCEPTANCE_PAGES: readonly AcceptancePage[] = [
  {
    path: '/',
    expectedRobots: 'noindex,follow',
    task: 'Э3-01',
    note:
      'Техническая страница-заглушка на корне. Настоящая главная — Э3-09. Условиям п. 5.1 ' +
      'не удовлетворяет ни по одному пункту (нет содержания, нет открыток, нет навигации), ' +
      'поэтому обязана оставаться закрытой от индексации.',
  },
];

/** Индексируемая страница — та, чья директива начинается с `index`. */
export function isIndexable(page: AcceptancePage): boolean {
  return page.expectedRobots.startsWith('index');
}

/**
 * Ожидаемый путь в self-canonical. Совпадает с {@link AcceptancePage.path}: у
 * корня канонический абсолютный адрес — `<origin>/`, у остальных страниц —
 * `<origin><path>` без завершающего слеша.
 */
export function expectedCanonicalPath(page: AcceptancePage): string {
  return page.path;
}
