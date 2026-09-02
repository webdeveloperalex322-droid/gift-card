/**
 * Категории открыток для БОКОВОГО МЕНЮ, печатаемого `../layouts/BaseLayout.astro`
 * на каждой странице, кроме 404 (обоснование исключения — шапка `BaseLayout.astro`
 * и `../components/SiteSidebar.astro`).
 *
 * Функция существует ровно потому, что дерево «корневые узлы + их прямые дети»
 * нужно ПЯТИ разным сборщикам страниц (`./catalog.ts`, `./search.ts`,
 * `./info-pages.ts`, маршрут `../pages/otkrytki/[...path].astro` — все зовут
 * `siteCategoryNav` напрямую, и `./home.ts`, которому корни уже даёт собственный
 * `Promise.all`, поэтому он зовёт `catalogSectionsFrom` с готовым списком, не
 * читая корни второй раз). Разложить один и тот же обход по пяти местам значило
 * бы, что при следующей правке условия отбора (например, второго условия
 * «непусто», Э3-13-A) кто-то из пяти забудет обновить свою копию.
 *
 * Отбор совпадает с отбором каталога `/otkrytki`: только опубликованные и только
 * непустые узлы (предикат `nodesWithContent` внутри `listRootCollections` и
 * `listChildCollections`, `./content.ts`) — то же самое условие «страница
 * отвечает 200», по которому меню уже не ссылается на несуществующие узлы
 * (`../components/SiteNav.astro`, задача Э3-08).
 *
 * Список ДЕТЕЙ здесь НЕ обрезан числом показа: обрезка (`HOME_SECTION_CHILDREN`
 * у главной) — свойство ОДНОГО блока НА ОДНОЙ странице, а не свойство меню,
 * которое обязано быть одинаковым везде (тот же довод, что у `SiteNav.astro`).
 */

import type { Collection } from '@otkritka/cms/types';

import {
  listChildCollections,
  listRootCollections,
  newNodeContentMemo,
  type NodeContentMemo,
} from './content.js';
import { type CatalogSection, catalogSections } from './page-data.js';

/**
 * Прямые дети заданных корней, собранные в форму бокового меню.
 *
 * Вынесена отдельно от {@link siteCategoryNav}, потому что `./home.ts` корни уже
 * читает — тем же `Promise.all`, что и сезонный блок и свежие открытки, — и
 * второй самостоятельный запрос корней был бы избыточен. Раньше `./home.ts` и
 * `./catalog.ts` держали каждый свою копию этого обхода; обе копии сведены сюда.
 *
 * @param roots узлы, для которых нужны дети. `siteCategoryNav` передаёт сюда
 *   результат `listRootCollections`; `./home.ts` — тот же результат, который уже
 *   прочитал сам.
 * @param memo мемоизатор предиката «непуст» на один рендер страницы — ОБЯЗАН
 *   быть тем же, которым читались `roots`, иначе узел, чьё «непусто» уже посчитано
 *   там, посчитается здесь заново.
 */
export async function catalogSectionsFrom(
  roots: readonly Collection[],
  memo: NodeContentMemo,
): Promise<readonly CatalogSection[]> {
  return catalogSections(
    await Promise.all(
      roots.map(async (node) => ({
        children: await listChildCollections(node.id, memo),
        node,
      })),
    ),
  );
}

/**
 * Корневые узлы таксономии и их прямые дети, в форме бокового меню.
 *
 * @param memo мемоизатор предиката «непуст» на один рендер страницы. Не передан —
 *   создаётся свой; передавать стоит там, где сборщик страницы уже проверяет
 *   пересекающийся набор узлов, — иначе один и тот же узел однажды посчитается
 *   дважды в одном ответе.
 */
export async function siteCategoryNav(
  memo: NodeContentMemo = newNodeContentMemo(),
): Promise<readonly CatalogSection[]> {
  return catalogSectionsFrom(await listRootCollections(memo), memo);
}
