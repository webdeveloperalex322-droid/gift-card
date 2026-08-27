/**
 * Сборка главной страницы (задача Э3-09).
 *
 * Здесь только ПОРЯДОК ВЫЗОВОВ: маршрут зовёт одну функцию и печатает то, что
 * она вернула. Правил в файле нет — тексты и разметка живут в
 * `../seo/home-page.ts`, окно показа сезонного блока там же, отбор данных
 * организации и имя сайта — предикаты `organizationJsonLd` и `resolveSiteName`
 * из `@otkritka/shared` (решения Ч-17 и Э3-13-B), которые зовёт сборка разметки;
 * чтение записей — `./content.ts`.
 *
 * ## Почему у главной нет исхода «страницы нет»
 *
 * У списков он есть: пустая подборка отдаёт 404, потому что пустая сетка под
 * заголовком — это soft 404 (ТЗ §5.3). Главная — другой случай: она существует
 * всегда, и её содержание не сводится к списку записей. Пока каталог пуст, она
 * честно показывает вводный блок и навигацию; блоки, для которых нет данных, не
 * печатаются вовсе — заголовок над пустотой был бы ровно той обманкой, от
 * которой правило и защищает. В индекс страница при этом не идёт: директива
 * `noindex,follow` (см. `HOME_ROBOTS`), и меняет её только человек.
 *
 * ## Почему день передаётся аргументом
 *
 * Сезонный блок переключается ДАТАМИ ИЗ АДМИНКИ и без пересборки — маршрут
 * главной поэтому SSR (`prerender = false`), а день берётся на запросе. Аргумент,
 * а не `new Date()` внутри: иначе ни тест, ни смоук не смогли бы проверить
 * границы окна, не переводя часы машины.
 */

import type { SharedEnv } from '@otkritka/shared';

import {
  HOME_PAGE,
  HOME_PATH,
  HOME_ROBOTS,
  type HomePageJsonLd,
  homePageJsonLd,
} from '../seo/home-page.js';
import type { ListItemFacts } from '../seo/collection-page.js';
import type { RobotsDirective } from '../routing/pagination.js';
import {
  listChildCollections,
  listRecentCards,
  listRootCollections,
  listSeasonalCollections,
  newNodeContentMemo,
  readSiteSettings,
} from './content.js';
import {
  type CardTile,
  cardTiles,
  type CatalogSection,
  catalogSections,
  seasonalLinks,
} from './page-data.js';

/**
 * Сколько свежих открыток показывает главная.
 *
 * Это предел ЗАПРОСА: строки, которые страница не покажет, не читаются вовсе.
 * Значение — выбор агента (кандидат в реестр решений): двенадцать плиток дают на
 * мобильном три-четыре ряда, то есть блок виден целиком без бесконечного
 * пролистывания, которое ТЗ запрещает и как приём (§5.5).
 */
export const HOME_RECENT_CARDS = 12;

/**
 * Сколько дочерних узлов показывает раздел на главной.
 *
 * Ограничение ПОКАЗА, а не выборки: полный список детей узла живёт на его
 * собственной странице и в каталоге `/podborki`, а главная перечисляет самые
 * заметные входы. Без предела раздел с полусотней праздников вытеснил бы с
 * первого экрана всё остальное. Ссылка на сам узел стоит заголовком раздела,
 * поэтому обрезанный хвост остаётся достижимым в один переход.
 */
export const HOME_SECTION_CHILDREN = 8;

/** Голова документа главной. */
export interface HomePageView {
  readonly canonicalPath: string;
  readonly heading: string;
  readonly title: string;
  readonly metaDescription: string;
  readonly robots: RobotsDirective;
}

export interface HomePageContent {
  readonly view: HomePageView;
  /** Абзацы вводного блока (ТЗ §5.2). */
  readonly lead: readonly string[];
  /**
   * Подборки к ближайшим праздникам: те, чьё окно показа накрывает день. Пустой
   * массив — блока на странице нет вовсе.
   */
  readonly seasonal: readonly ListItemFacts[];
  /** Разделы верхнего уровня и их дети — прямые ссылки на праздничные узлы. */
  readonly sections: readonly CatalogSection[];
  /** Свежие открытки плитками. Пустой массив — блока нет. */
  readonly recent: readonly CardTile[];
  readonly jsonLd: HomePageJsonLd;
}

/**
 * Содержимое главной.
 *
 * @param today день, на который строится сезонный блок.
 * @throws Error если `SITE_URL` не задан или некорректен: абсолютный адрес в
 *   разметке собирается только из него.
 */
export async function homePage(today: Date, env?: SharedEnv): Promise<HomePageContent> {
  // Один мемоизатор предиката «непуст» на весь рендер главной: сезонный блок,
  // корни и их дети пересекаются наборами, и без общей памяти один и тот же узел
  // считался бы трижды (обоснование предиката — в `./content.ts`).
  const memo = newNodeContentMemo();
  const [seasonalNodes, roots, recentCards, settings] = await Promise.all([
    listSeasonalCollections(today, memo),
    listRootCollections(memo),
    listRecentCards(HOME_RECENT_CARDS),
    readSiteSettings(),
  ]);

  const sections = catalogSections(
    await Promise.all(
      roots.map(async (node) => ({
        // Обрезка ПОКАЗА, а не выборки: см. HOME_SECTION_CHILDREN.
        children: (await listChildCollections(node.id, memo)).slice(0, HOME_SECTION_CHILDREN),
        node,
      })),
    ),
  );

  return {
    jsonLd: homePageJsonLd(
      {
        // Передаются СЫРЫЕ данные глобала: из одного поля выводятся два разных
        // решения с разными условиями — выводить ли узел `Organization` (Ч-17,
        // нужны имя и логотип) и какое имя у сайта в `WebSite.name` (нужно только
        // имя). Отбор одним из предикатов здесь терял бы второе решение —
        // обоснование в шапке `HomePageJsonLdInput`.
        organization: settings.organization,
      },
      env,
    ),
    lead: HOME_PAGE.lead,
    recent: cardTiles(recentCards),
    seasonal: seasonalLinks(seasonalNodes, today),
    sections,
    view: {
      canonicalPath: HOME_PATH,
      heading: HOME_PAGE.heading,
      metaDescription: HOME_PAGE.description,
      robots: HOME_ROBOTS,
      title: HOME_PAGE.title,
    },
  };
}
