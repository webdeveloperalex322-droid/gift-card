/**
 * Инвентарь приёмки в том виде, в каком его читают specs: ОБЪЯВЛЕННАЯ выборка
 * (`./declared-pages.ts`) плюс результат замера присутствия (`./discovery.ts`).
 *
 * Модуль отвечает на один вопрос — «какие из объявленных страниц стенд отдаёт в
 * этом прогоне», — и делит выборку на два списка:
 *
 *   - {@link ACCEPTANCE_PAGES} — страницы, отвечающие 200. Их проверяет весь
 *     набор инвариантных specs (`single-h1`, `self-canonical-absolute`,
 *     `robots-directive-present`, `unique-title-h1-description`,
 *     `internal-links-are-anchors`, `server-rendered-without-js`,
 *     `no-client-javascript`, `page-has-no-html-twin`, `image-attributes`,
 *     `structured-data-matches-visible`, `canonical-ignores-query`,
 *     `status-ignores-query`, `filtered-view-not-indexable`, `site-nav-present`,
 *     `sidebar-present`, `category-menu-*`, `preloaded-fonts-are-served`,
 *     `served-text-has-no-tag-literals`, `content-column-not-collapsed`,
 *     `indexable-has-description`). Ни одно утверждение для контентных страниц
 *     не ослаблено: страница либо проверяется полностью, либо не проверяется
 *     вовсе — и тогда она в списке ниже;
 *   - {@link ABSENT_ACCEPTANCE_PAGES} — объявленные страницы, которых на стенде
 *     нет. Их разбирает `declared-page-not-served.spec.ts`: проверяет, что
 *     отсутствие выглядит ровно как 404, и ставит аннотацию «проверено нечем» с
 *     перечислением непроверенного. Зелёный прогон при непустом этом списке
 *     покрытием не является, и в отчёте это написано словами.
 *
 * Почему замер присутствия вообще существует, почему он не фикстуры и не обход
 * сайта — в шапке `./discovery.ts`. Почему адрес контентной страницы считается
 * гарантированным репозиторием — в шапке `./declared-pages.ts`.
 *
 * Специи импортируют по-прежнему отсюда: добавление страницы в выборку остаётся
 * ОДНОЙ записью в `./declared-pages.ts`, без правок в самих specs.
 */

import {
  ABSENT_STATUS,
  PRESENT_STATUS,
  readDeclaredPageProbe,
  DECLARED_PAGE_PROBE_ENV_KEY,
} from './discovery.js';
import { type AcceptancePage, DECLARED_ACCEPTANCE_PAGES } from './declared-pages.js';
import { resolveAcceptanceTarget } from './target.js';

export {
  ALLOWED_ROBOTS_DIRECTIVES,
  DECLARED_ACCEPTANCE_PAGES,
  QUERY_VARIANTS,
  expectedCanonicalPath,
  isIndexable,
} from './declared-pages.js';
export type {
  AcceptancePage,
  DescriptionExpectation,
  ImageExpectation,
  PageAvailability,
  RobotsDirective,
  StructuredDataExpectation,
} from './declared-pages.js';

const target = resolveAcceptanceTarget();
const probe = readDeclaredPageProbe(target.origin);

if (probe === null) {
  // stderr, а не stdout: в режиме `--list` вывод разбирают инструменты, и лишняя
  // строка в stdout ломала бы разбор. Сообщение при этом обязано быть: молчание
  // здесь означало бы, что приёмка сузилась до маршрутов кода незаметно.
  console.warn(
    `[SEO-приёмка] замера присутствия страниц нет (${DECLARED_PAGE_PROBE_ENV_KEY} не задан). ` +
      'Все объявленные страницы считаются присутствующими: отсутствие замера обязано давать ' +
      'красный отчёт с внятной причиной, а не тихо уменьшать приёмку. Замер делает ' +
      'tests/seo/global-setup.ts — он не выполняется в режиме --list и при конфиге без ' +
      'globalSetup.',
  );
}

/** Объявленная страница, которой на стенде нет, вместе с фактическим ответом. */
export interface AbsentAcceptancePage {
  readonly page: AcceptancePage;
  /** Код, которым адрес ответил при замере. Законным считается только 404. */
  readonly status: number;
}

function measuredStatus(page: AcceptancePage): number {
  if (page.availability === 'route' || probe === null) {
    return PRESENT_STATUS;
  }
  return probe.statuses[page.path] ?? ABSENT_STATUS;
}

export const ACCEPTANCE_PAGES: readonly AcceptancePage[] = DECLARED_ACCEPTANCE_PAGES.filter(
  (page) => measuredStatus(page) === PRESENT_STATUS,
);

export const ABSENT_ACCEPTANCE_PAGES: readonly AbsentAcceptancePage[] = DECLARED_ACCEPTANCE_PAGES
  .filter((page) => measuredStatus(page) !== PRESENT_STATUS)
  .map((page) => ({ page, status: measuredStatus(page) }));
