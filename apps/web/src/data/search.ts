/**
 * Сборка страницы внутреннего поиска `/search` (задача Э3-10).
 *
 * Здесь только ПОРЯДОК ВЫЗОВОВ: правила живут в `../seo/search-page.ts`
 * (адрес, директива робота, нормализация запроса, предел выдачи), запросы — в
 * `./queries.ts`, чтение — в `./content.ts`.
 *
 * ## Что здесь закодировано и почему именно так
 *
 *   - **страница отвечает 200 всегда**, в том числе с пустой выдачей и без
 *     запроса. Это не спор с правилом «пустая страница не отдаёт 200» (ТЗ §5.3):
 *     правило охраняет ПОСАДОЧНЫЕ страницы, претендующие на поисковый запрос, а
 *     эта закрыта директивой `noindex`, вне sitemap и (этап 4) закрыта в
 *     robots.txt. 404 на пустую выдачу означал бы, что адрес страницы поиска то
 *     существует, то нет — в зависимости от параметра;
 *   - **«не искали» и «не нашли» различаются.** Пустое поле даёт
 *     `query: null` и показ формы; запрос без результатов — видимый текст «по
 *     этому запросу ничего не нашлось». Слить их значило бы встречать первого
 *     посетителя сообщением о неудачном поиске, которого не было;
 *   - **выдача ограничена, страниц у неё нет.** Обоснование — в
 *     `SEARCH_RESULTS_LIMIT`: семейство адресов `/search/page/N` у
 *     неиндексируемой страницы не нужно никому, а признак «результатов больше»
 *     честно показывается текстом.
 */

import type { ListItemFacts } from '../seo/collection-page.js';
import {
  normalizeSearchQuery,
  SEARCH_RESULTS_LIMIT,
  type SearchPageView,
  searchPageView,
} from '../seo/search-page.js';
import { searchCards, searchCollections } from './content.js';
import { type CardTile, cardTiles, collectionLinks } from './page-data.js';

export interface SearchPageContent {
  readonly view: SearchPageView;
  /** Найденные открытки плитками. Пустой массив — блока нет. */
  readonly cards: readonly CardTile[];
  /** Найденные подборки ссылками. Пустой массив — блока нет. */
  readonly collections: readonly ListItemFacts[];
  /** Хотя бы один список упёрся в предел — показывается подсказка «уточните запрос». */
  readonly truncated: boolean;
  /** Поиск выполнялся и не дал ничего. Отличается от «запроса не было». */
  readonly nothingFound: boolean;
}

/**
 * Содержимое страницы поиска.
 *
 * Среза окружения функция не принимает намеренно, в отличие от сборщиков
 * карточки, подборки и главной: абсолютных адресов страница поиска не строит —
 * ни canonical (его собирает layout по пути), ни разметки JSON-LD (её у поиска
 * нет вовсе). Необязательный параметр «для единообразия» означал бы, что
 * `SITE_URL` здесь зачем-то нужен.
 *
 * @param rawQuery значение параметра `q` как пришло из адреса; нормализацией
 *   занимается `../seo/search-page.ts`, а не вызывающий.
 */
export async function searchPage(rawQuery: string | null): Promise<SearchPageContent> {
  const query = normalizeSearchQuery(rawQuery);
  const view = searchPageView(query);

  if (query === null) {
    return { cards: [], collections: [], nothingFound: false, truncated: false, view };
  }

  const [cards, collections] = await Promise.all([
    searchCards(query, SEARCH_RESULTS_LIMIT),
    searchCollections(query, SEARCH_RESULTS_LIMIT),
  ]);

  const tiles = cardTiles(cards);
  const links = collectionLinks(collections);

  return {
    cards: tiles,
    collections: links,
    nothingFound: tiles.length === 0 && links.length === 0,
    truncated: cards.length >= SEARCH_RESULTS_LIMIT || collections.length >= SEARCH_RESULTS_LIMIT,
    view,
  };
}
