/**
 * Директива робота страницы — ЕДИНСТВЕННОЕ место, где она вычисляется
 * (задача Э4-01).
 *
 * Норма: ТЗ §7.1 и §7.2, `CLAUDE.md` — «Правила индексации» (в `index,follow`
 * страница попадает только при выполнении условий п. 5.1; всегда `noindex` и вне
 * sitemap: внутренний поиск, фильтры и сортировка, черновики, служебные
 * страницы, пагинация), решения Ч-01b/Ч-05 (страницы 2+ — `noindex,follow`),
 * Ч-04-3 (фильтр отдельных URL не создаёт), п. 22.1 (уникальные
 * title/H1/description на выборке), п. 23.4 (шаблонный SEO-текст запрещён).
 *
 * ## Зачем модуль появился, если правила уже были
 *
 * Правила были, а ответа не было. До Э4-01 итоговое значение складывалось в
 * каждом шаблоне отдельно: подборка звала `robotsForFilteredView(robotsForPage(…))`,
 * каталог — только `robotsForPage`, карточка отдавала поле записи как есть,
 * служебная страница считала конъюнкцию Ч-23, главная и поиск подставляли
 * константу. Совпадение этих формул держалось на дисциплине автора шаблона.
 *
 * Ошибка такого устройства стоит дорого именно на этапе 4: sitemap (Э4-04)
 * отбирает страницы ПО ДИРЕКТИВЕ, и вторая трактовка означала бы страницу,
 * закрытую в разметке и открытую в карте сайта — то есть ровно запрет «НЕ
 * добавлять в sitemap неканонические/закрытые страницы» (п. 23). Поэтому здесь
 * одна функция {@link resolvePageRobots}, и она:
 *
 *   - принимает ОБЪЯВЛЕННУЮ директиву (поле записи или константу маршрута) как
 *     потолок и никогда его не поднимает;
 *   - применяет все закрывающие условия сразу, а не по одному на слой;
 *   - возвращает и значение, и ПРИЧИНЫ — их читает диагностика и будущий
 *     sitemap, которому нужно объяснимое «почему страницы нет в карте».
 *
 * ## Почему тип результата номинальный
 *
 * `PageRobots` — это `RobotsDirective` с недостижимым извне свойством, поэтому
 * литерал `'index,follow'` в шаблон не подставить: проп `robots` у
 * `../layouts/BaseLayout.astro` требует именно `PageRobots`, а получить такое
 * значение можно только из этой функции. Это не украшение типов, а замена
 * дисциплины на проверку: до Э4-01 любой шаблон мог написать директиву строкой,
 * и `astro check` не возразил бы. Единственное место, где значение создаётся, —
 * {@link seal} ниже.
 *
 * ## Где живёт САМ набор значений
 *
 * В `@otkritka/shared` (`packages/shared/src/robots.ts`, задача Э4-05). Здесь его
 * копии больше нет: до Э4-06 модуль держал свой список `ROBOTS_DIRECTIVES`,
 * дословно повторявший список CMS, и совпадение поддерживалось вручную. Два
 * закрытых набора, управляющих индексацией, расходятся молча — значение,
 * известное CMS и неизвестное вебу, даёт либо исключение на рендере, либо
 * страницу, закрытую в разметке и открытую в карте сайта. Разделение
 * ответственности при этом сохранено: общий пакет знает НАБОР значений и
 * предикаты самого значения, а правило «какая директива у ЭТОЙ страницы» —
 * здесь.
 *
 * Модуль ЧИСТЫЙ: без Astro, без Payload, без чтения `process.env`. Входит в
 * composite-проект `../../tsconfig.node.json`, проверяется юнит-тестом
 * `tests/unit/web-robots-directive.test.ts`.
 */

import {
  canonicalizePath,
  isIndexableRobots,
  isRobotsDirective,
  ROBOTS_DIRECTIVES,
  type RobotsDirective,
} from '@otkritka/shared';

import { hasActiveFilter, type ViewParams } from '../routing/view-params.js';

declare const RESOLVED_BY_THIS_MODULE: unique symbol;

/**
 * Директива, ПОЛУЧЕННАЯ из {@link resolvePageRobots}. В разметку попадает только
 * такое значение.
 *
 * Свойство-фантом объявлено `unique symbol`, поэтому вне этого модуля объект с
 * ним не собрать: строковый литерал типу не соответствует, и шаблон, решивший
 * написать директиву руками, не скомпилируется.
 */
export type PageRobots = RobotsDirective & { readonly [RESOLVED_BY_THIS_MODULE]: true };

/** Единственное место, где значение типа {@link PageRobots} появляется. */
function seal(directive: RobotsDirective): PageRobots {
  return directive as PageRobots;
}

/** Почему страница закрыта от индексации, хотя объявленная директива её открывала. */
export type RobotsClosingReason =
  /** Страница пагинации 2+ (решение Ч-01b). */
  | 'pagination'
  /** Активен фильтр представления (ТЗ §5.2, §5.5). */
  | 'filter'
  /** Нет непустого описания, а индексируемая страница без него не бывает (п. 22.1). */
  | 'no-description'
  /** Запись не опубликована: `draft` и `review` — всегда `noindex` (ТЗ §7.1). */
  | 'unpublished';

/** Факты о странице, из которых складывается директива. */
export interface PageIndexationFacts {
  /**
   * ОБЪЯВЛЕННАЯ директива: поле `robots` записи (решение человека) либо
   * константа маршрута (`CATALOG_ROBOTS`, `SEARCH_ROBOTS`, `HOME_ROBOTS`,
   * результат конъюнкции Ч-23 у служебных страниц).
   *
   * Это потолок: функция умеет только закрывать. Открыть страницу в индекс может
   * лишь человек, и делает он это, меняя именно объявленное значение.
   */
  readonly declared: RobotsDirective;
  /**
   * Описание страницы — ровно то значение, которое пойдёт в
   * `<meta name="description">`. Пусто (`null`, `undefined`, пробелы) — тега не
   * будет, и страница закрывается от индексации.
   *
   * Передаётся ТЕКСТ, а не признак «есть описание»: иначе появилась бы вторая
   * трактовка слова «пусто» — у шаблона своя, у этой функции своя, и разошлись бы
   * они на строке из одного пробела.
   */
  readonly description?: string | null | undefined;
  /**
   * Номер страницы списка, начиная с 1. У страницы, которая списком не является,
   * номера нет — значение по умолчанию 1.
   */
  readonly listPage?: number | undefined;
  /** Активные параметры представления (Э3-10). Не переданы — фильтра нет. */
  readonly view?: ViewParams | undefined;
  /**
   * Статус записи CMS, если страница собрана из записи.
   *
   * `undefined` означает «страница не запись» (главная, каталоги, поиск,
   * служебные страницы) и причиной закрытия НЕ является. Проверка существует не
   * вместо публичного фильтра по статусу, а рядом с ним: черновик до шаблона не
   * доходит вовсе (`../data/read-scope.ts` отвечает отказом), и если бы дошёл,
   * страница обязана быть закрыта, а не открыта по полю `robots`, оставшемуся с
   * прошлой публикации.
   */
  readonly status?: string | undefined;
}

/** Ответ на вопрос «какая директива у этой страницы». */
export interface PageIndexation {
  /** Значение для `<meta name="robots">`. */
  readonly robots: PageRobots;
  /** Пойдёт ли страница в индекс — и, следовательно, может ли попасть в sitemap. */
  readonly indexable: boolean;
  /**
   * Все сработавшие закрывающие условия. Пустой массив — страница получила
   * объявленную директиву без изменений.
   *
   * Перечисляются ВСЕ, а не первое: список читает диагностика («почему страница
   * не в sitemap»), и ответ «из-за пагинации» вместо «из-за пагинации и
   * отсутствия описания» отправил бы редактора исправлять не то.
   */
  readonly closedBy: readonly RobotsClosingReason[];
}

/** Первая страница любого списка: живёт по базовому URL (решение Ч-05). */
const FIRST_LIST_PAGE = 1;

/** Публично существует только этот статус (`../data/read-scope.ts`). */
const PUBLIC_STATUS = 'published';

/**
 * Директива робота страницы.
 *
 * @throws Error если объявленная директива не входит в закрытый набор значений.
 *   Подстановка «безопасного» `noindex` вместо отказа скрыла бы, что значение
 *   поля записи не применилось: страница выглядела бы законно закрытой, а поле в
 *   админке — заполненным.
 */
export function resolvePageRobots(facts: PageIndexationFacts): PageIndexation {
  if (!isRobotsDirective(facts.declared)) {
    throw new Error(
      `Директива робота «${String(facts.declared)}» не входит в набор ` +
        `${ROBOTS_DIRECTIVES.join(' / ')}. Значение приходит из поля записи или из константы ` +
        'маршрута, поэтому непонятное здесь означает рассогласование схемы CMS и apps/web. ' +
        'Молча подставить noindex нельзя: тогда решение человека об индексации перестало бы ' +
        'действовать незаметно.',
    );
  }

  const closedBy: RobotsClosingReason[] = [];

  const listPage = facts.listPage ?? FIRST_LIST_PAGE;
  if (listPage > FIRST_LIST_PAGE) {
    closedBy.push('pagination');
  }
  if (facts.view !== undefined && hasActiveFilter(facts.view)) {
    closedBy.push('filter');
  }
  if ((facts.description ?? '').trim() === '') {
    closedBy.push('no-description');
  }
  if (facts.status !== undefined && facts.status !== PUBLIC_STATUS) {
    closedBy.push('unpublished');
  }

  // Единственное правило сборки: закрывающая причина опускает директиву до
  // `noindex,follow`, а уже объявленный `nofollow` остаётся `nofollow`. Обратной
  // операции («поднять до index») в функции нет вовсе — не как условие, а как
  // отсутствующая ветка: страница не бывает открытее того, что объявил человек.
  const robots: RobotsDirective =
    facts.declared === 'noindex,nofollow' || closedBy.length === 0
      ? facts.declared
      : 'noindex,follow';

  return {
    closedBy,
    indexable: isIndexableRobots(robots),
    robots: seal(robots),
  };
}

/**
 * Директива страницы, у которой нет и не может быть описания, — страница 404.
 *
 * Отдельная функция, а не литерал в шаблоне: тип {@link PageRobots} собирается
 * только здесь, и 404 не должна быть исключением из этого правила. Причин
 * закрытия у неё нет в терминах {@link RobotsClosingReason} — своего адреса у
 * страницы не существует вовсе (`../pages/404.astro`), поэтому ни описание, ни
 * canonical к ней не применимы, а `noindex,follow` объявлен маршрутом.
 */
export function errorPageRobots(): PageIndexation {
  return {
    closedBy: [],
    indexable: false,
    robots: seal('noindex,follow'),
  };
}

/** Почему страница исключена из sitemap. */
export type SitemapExclusionReason =
  /** Директива закрывает страницу от индексации. */
  | 'noindex'
  /** canonical указывает не на эту страницу: в карту идут только канонические URL. */
  | 'not-self-canonical';

export interface SitemapCandidate {
  /** Директива, посчитанная {@link resolvePageRobots}. */
  readonly robots: PageRobots;
  /** Канонический путь страницы — то, что стоит в `<link rel="canonical">`. */
  readonly canonicalPath: string;
  /** Собственный адрес страницы. */
  readonly pagePath: string;
}

export interface SitemapEligibility {
  readonly eligible: boolean;
  readonly excludedBy: readonly SitemapExclusionReason[];
}

/**
 * Может ли страница попасть в sitemap.
 *
 * Здесь два условия из трёх, названных `CLAUDE.md` («включаются только
 * абсолютные канонические URL со статусом 200 и разрешением на индексацию»):
 * разрешение на индексацию и каноничность адреса. Третье — ответ 200 — знает
 * только маршрут, и подменять его догадкой эта функция не будет.
 *
 * Почему каноничность проверяется ОТДЕЛЬНО от директивы: страница с
 * переопределённым в CMS полем `canonical` остаётся `index,follow` совершенно
 * законно — переопределение как раз и говорит поисковой системе склеить её с
 * другим адресом. В карту сайта такой URL входить не должен, и по директиве это
 * не видно.
 */
export function sitemapEligibility(candidate: SitemapCandidate): SitemapEligibility {
  const excludedBy: SitemapExclusionReason[] = [];

  if (!isIndexableRobots(candidate.robots)) {
    excludedBy.push('noindex');
  }
  // Сравниваются КАНОНИЧЕСКИЕ формы: хвостовой слеш второго адреса не создаёт
  // (решение Ч-21), и посимвольное сравнение объявило бы такую страницу
  // неканонической на пустом месте.
  if (canonicalizePath(candidate.canonicalPath) !== canonicalizePath(candidate.pagePath)) {
    excludedBy.push('not-self-canonical');
  }

  return { eligible: excludedBy.length === 0, excludedBy };
}
