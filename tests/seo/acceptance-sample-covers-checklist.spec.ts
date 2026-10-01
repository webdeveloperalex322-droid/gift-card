/**
 * Требование (`CLAUDE.md`, раздел «SEO-тесты»; DoD задачи Э4-07): приёмка
 * гоняется на выборке из ДЕСЯТИ видов страниц — главная, раздел, праздничная
 * посадочная, дочерняя подборка, карточка, пагинация, внутренний поиск, URL с
 * параметрами, удалённая карточка, 404.
 *
 * Spec проверяет не сайт, а САМУ ПРИЁМКУ: у каждого вида страницы из этого
 * состава есть владелец — либо запись в инвентаре
 * (`support/declared-pages.ts`, поле `sampleRole`), либо названный spec-файл,
 * который проверяет этот вид отдельно, потому что своего адреса у него нет
 * (`URL с параметрами` — это набор параметров к каждой странице выборки; `404` —
 * ответ на любой несуществующий адрес).
 *
 * ## Зачем это отдельным тестом, если состав виден глазами
 *
 * Потому что сужение приёмки — самая тихая из возможных поломок. Удалить строку
 * из инвентаря или файл spec’а можно, не сломав ни одного теста: число тестов
 * уменьшится, все останутся зелёными, и отчёт `pnpm test:seo` скажет `PASSED`.
 * Ровно этот класс в проекте объявлен дороже упавшего теста, поэтому у состава
 * выборки есть свой сторож. Он же не даёт «закрыть» вид страницы ссылкой на
 * spec, которого нет: файлы-владельцы проверяются на существование.
 *
 * ## Про вид «удалённая карточка»
 *
 * У него владельца в приёмке НЕТ, и это не забывчивость. Случаю нужна запись в
 * базе — снятая с публикации карточка плюс строка в `redirects`, — а фикстуры в
 * приёмку не тащим (разбор в `support/discovery.ts` и `README.md`). Поэтому вид
 * объявлен непокрытым, названы места, где он проверяется вне приёмки, и КАЖДЫЙ
 * прогон печатает об этом аннотацию «проверено нечем». Существование названных
 * файлов тоже проверяется: иначе ссылка на чужое покрытие однажды станет
 * неправдой, и никто об этом не узнает.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { noteNotChecked } from './support/not-checked.js';
import { ABSENT_ACCEPTANCE_PAGES, DECLARED_ACCEPTANCE_PAGES } from './support/pages.js';

/** Владелец вида страницы: запись инвентаря, spec-файл или «не покрыто». */
type Owner =
  | { readonly kind: 'inventory'; readonly role: string }
  | { readonly kind: 'specs'; readonly files: readonly string[]; readonly why: string }
  | { readonly kind: 'uncovered'; readonly why: string; readonly elsewhere: readonly string[] };

interface ChecklistItem {
  /** Вид страницы, как он назван в `CLAUDE.md`. */
  readonly kind: string;
  readonly owner: Owner;
}

const SAMPLE: readonly ChecklistItem[] = [
  { kind: 'главная', owner: { kind: 'inventory', role: 'главная' } },
  { kind: 'раздел', owner: { kind: 'inventory', role: 'раздел (единый каталог открыток)' } },
  {
    kind: 'праздничная посадочная',
    owner: { kind: 'inventory', role: 'праздничная посадочная (эталонная тема Ч-06)' },
  },
  { kind: 'дочерняя подборка', owner: { kind: 'inventory', role: 'дочерняя подборка' } },
  { kind: 'карточка', owner: { kind: 'inventory', role: 'карточка открытки' } },
  { kind: 'пагинация', owner: { kind: 'inventory', role: 'пагинация' } },
  { kind: 'внутренний поиск', owner: { kind: 'inventory', role: 'внутренний поиск' } },
  {
    kind: 'URL с параметрами',
    owner: {
      kind: 'specs',
      files: [
        'canonical-ignores-query.spec.ts',
        'status-ignores-query.spec.ts',
        'filtered-view-not-indexable.spec.ts',
        'search-not-indexable.spec.ts',
      ],
      why:
        'своего адреса у вида нет: это НАБОРЫ ПАРАМЕТРОВ (support/declared-pages.ts, ' +
        'QUERY_VARIANTS), приписываемые к каждой странице выборки. Записью инвентаря такой вид ' +
        'быть не может — у адреса с параметрами нет собственного canonical (ТЗ §6.5)',
    },
  },
  {
    kind: '404',
    owner: {
      kind: 'specs',
      files: [
        'not-found-status.spec.ts',
        'not-found-page-content.spec.ts',
        'not-found-body-is-single.spec.ts',
      ],
      why:
        'своего адреса у вида нет: 404 — ответ на ЛЮБОЙ несуществующий адрес, поэтому страница ' +
        'проверяется на нескольких классах промаха, а не одной записью инвентаря',
    },
  },
  {
    kind: 'удалённая карточка',
    owner: {
      kind: 'uncovered',
      why:
        'случаю нужна запись в базе: снятая с публикации карточка плюс строка в `redirects` ' +
        '(301 на замену либо 410 без замены). Приёмка записей не создаёт — публикация и снятие ' +
        'с публикации есть решение человека (п. 7.1 и п. 23 ТЗ), а сеялка внутри `pnpm verify` ' +
        'делала бы это решение побочным эффектом стандартной команды проверки',
      elsewhere: [
        'tests/unit/web-redirects.test.ts',
        'apps/web/scripts/smoke-redirects.ts',
        'apps/web/scripts/status-matrix-check.ts',
      ],
    },
  },
];

const seoDir = new URL('./', import.meta.url);
const repoRoot = new URL('../../', import.meta.url);

// Тест синхронный и без фикстур: он сверяет объявления приёмки между собой и с
// файловой системой, ни одного запроса к сайту здесь нет и быть не должно —
// состав выборки от состояния стенда не зависит. `testInfo` берётся из
// `test.info()`, а не из второго параметра: Playwright требует, чтобы ПЕРВЫЙ
// параметр был объектным деструктурированием, а пустой шаблон `{}` запрещает
// eslint (`no-empty-pattern`). Ни то, ни другое обходить не нужно — нужен просто
// колбэк без параметров.
test('у каждого вида страницы из выборки п. 22 есть владелец в приёмке', () => {
  const testInfo = test.info();
  const declaredRoles = new Set(DECLARED_ACCEPTANCE_PAGES.map((page) => page.sampleRole));
  const missing: string[] = [];

  for (const item of SAMPLE) {
    const { owner } = item;

    if (owner.kind === 'inventory') {
      if (!declaredRoles.has(owner.role)) {
        missing.push(
          `«${item.kind}»: в инвентаре нет записи с sampleRole «${owner.role}». Объявлены: ` +
            `${[...declaredRoles].join(', ')}`,
        );
      }
      continue;
    }

    if (owner.kind === 'specs') {
      for (const file of owner.files) {
        if (!existsSync(fileURLToPath(new URL(file, seoDir)))) {
          missing.push(
            `«${item.kind}»: файл-владелец tests/seo/${file} не существует. Вид страницы ` +
              `объявлен покрытым им, потому что ${owner.why}`,
          );
        }
      }
      continue;
    }

    for (const file of owner.elsewhere) {
      if (!existsSync(fileURLToPath(new URL(file, repoRoot)))) {
        missing.push(
          `«${item.kind}»: вид объявлен непокрытым в приёмке со ссылкой на ${file}, а этого ` +
            'файла нет. Ссылка на чужое покрытие обязана быть проверяемой, иначе она однажды ' +
            'становится неправдой молча',
        );
      }
    }
  }

  expect(
    missing,
    'Состав выборки приёмки (`CLAUDE.md`, «SEO-тесты») обязан быть покрыт целиком. Пропавший ' +
      'владелец означает, что приёмка сузилась, а отчёт остался зелёным — это ровно тот ложный ' +
      'зелёный, который в этом проекте дороже упавшего теста.',
  ).toEqual([]);

  // Вид без владельца в приёмке — не находка теста, а объявленное состояние. Но
  // объявленное СЛОВАМИ в каждом прогоне, а не подразумеваемое.
  for (const item of SAMPLE) {
    if (item.owner.kind !== 'uncovered') {
      continue;
    }
    noteNotChecked(
      testInfo,
      `Вид страницы «${item.kind}» из выборки п. 22 приёмкой НЕ проверяется: ${item.owner.why}. ` +
        `Вне приёмки он покрыт: ${item.owner.elsewhere.join(', ')} — но эти проверки в ` +
        '`pnpm test:seo` не входят, поэтому зелёный статус приёмки покрытием этого вида не ' +
        'является.',
    );
  }

  // Виды, чей владелец объявлен, но страницы на стенде нет, перечисляются здесь
  // сводкой: подробный разбор каждой — в `declared-page-not-served.spec.ts`,
  // однако сводка нужна, чтобы «сколько видов проверено» читалось одной строкой.
  if (ABSENT_ACCEPTANCE_PAGES.length > 0) {
    noteNotChecked(
      testInfo,
      `Из объявленной выборки на стенде отсутствует ${String(ABSENT_ACCEPTANCE_PAGES.length)} ` +
        `страниц${ABSENT_ACCEPTANCE_PAGES.length === 1 ? 'а' : ''}: ` +
        `${ABSENT_ACCEPTANCE_PAGES.map((absent) => `${absent.page.path} (${absent.page.sampleRole})`).join(', ')}. ` +
        'Эти виды страниц в текущем прогоне не проверены; разбор по каждой — в тестах ' +
        '«объявленная страница не отдаётся».',
    );
  }
});
