/**
 * Требование (п. 5.1 ТЗ, решение Ч-06, `CLAUDE.md` — «Правила индексации»): у
 * страницы, открытой в `index,follow`, должно быть ДОСТАТОЧНО ОТКРЫТОК —
 * ориентир 20–40 на широкую тему, утверждённый минимум 20. И отдельно:
 * «пустая или слабая страница не отдаёт 200 как полноценная посадочная».
 *
 * ## Почему это не покрыто хуком Payload и нужен spec
 *
 * `assertEnoughCardsForIndex` в `apps/cms/src/collections/collections.ts`
 * срабатывает РОВНО В МОМЕНТ открытия узла в `index,follow` — на переходе
 * директивы. После него объём темы не держит никто: карточку можно отвязать от
 * подборки (`collections` у карточки не защищено полевым доступом, а роль
 * `ai-editor` правит опубликованные записи и получила на это именованный
 * инструмент MCP `detach_card_from_collections`). Узел при этом остаётся
 * `index,follow`, отвечает 200 и остаётся в карте сайта — то есть условие п. 5.1
 * перестаёт выполняться МОЛЧА, и ни один тест об этом не говорил.
 *
 * Поэтому проверяется не переход, а состояние: сколько открыток показывает
 * страница, которая прямо сейчас объявляет себя индексируемой. Такую проверку
 * может выполнить только приёмка — факт «страница показывает N открыток» живёт в
 * ответе сервера, а не в правиле отбора.
 *
 * ## Откуда берётся число
 *
 * Из `ItemList` разметки страницы: её состав обязан совпадать с видимым списком
 * (`structured-data-matches-visible.spec.ts` проверяет это отдельно), а считать
 * открытки по `<a href>` нельзя — в сетке и в меню живут ссылки на узлы той же
 * формы `/otkrytki/<сегмент>`, что и адрес карточки (единое пространство имён,
 * решение Ч-04-9), и подсчёт по форме адреса смешал бы открытки с разделами.
 *
 * Список постраничный, поэтому обход идёт по `/page/N`, пока не наберётся норма.
 * У здоровой темы хватает первой страницы (в сетке 24 места), и второй запрос
 * делается только для темы, которая нормы НЕ набрала, — цена проверки на
 * зелёном прогоне равна одному запросу на тему.
 *
 * ## Порог записан здесь числом, а не импортирован
 *
 * По той же причине, что `MAX_CLICKS_FROM_HOME` в `support/crawl.ts`: приёмка не
 * берёт эталон из кода, который проверяет. Значение 20 — решение человека Ч-06;
 * продуктовый параметр `COLLECTION_MIN_PUBLISHED_CARDS` может быть понижен на
 * стенде, и приёмка обязана это ПОЙМАТЬ, а не унаследовать.
 *
 * ## Чего этот spec не проверяет (и говорит об этом вслух)
 *
 *   - **группирующие узлы** (`/otkrytki/prazdniki`): их объём считается по
 *     ПОДДЕРЕВУ (`VOLUME_SCOPE`), а в сетке они показывают дочерние узлы, а не
 *     открытки. Сумма по поддереву из одного ответа не выводится, поэтому такие
 *     адреса перечисляются пометкой «проверено нечем», а не считаются прошедшими;
 *   - **карточки**: у открытки объёма нет, порог к ней не относится. Адрес
 *     карточки и адрес группирующего узла имеют одинаковую форму, поэтому оба
 *     вида отделяются одинаково — по числу сегментов, и оба попадают в пометку;
 *   - **остальные условия п. 5.1** (подтверждённый спрос, отдельный интент,
 *     уникальность вводного текста): машиной не проверяются и остаются решением
 *     человека. Выполненный порог объёма разрешением индексировать не является.
 */

import { expect, test } from '@playwright/test';

import { jsonLdBlocks, jsonLdNodes } from './support/html.js';
import { fetchRaw } from './support/http.js';
import { noteNotChecked } from './support/not-checked.js';
import { annotateEmptyRun, readSitemapTree } from './support/sitemap-tree.js';
import { resolveAcceptanceTarget } from './support/target.js';

const target = resolveAcceptanceTarget();

/**
 * Минимум открыток на индексируемой теме (решение Ч-06, 2026-08-21).
 *
 * Эталон приёмки. Расхождение с продуктовым параметром — находка, а не повод
 * подстроить число.
 */
const MIN_CARDS_FOR_INDEX = 20;

/**
 * Сколько страниц списка обходить максимум.
 *
 * Обход останавливается, как только норма набрана, поэтому предел касается
 * только тем, которые нормы не набирают: при 24 местах в сетке пяти страниц
 * хватает с избытком, а «страница 6 не ответила» ни о чём бы не сказало.
 */
const MAX_PAGES = 5;

/** Контейнер каталога: все посадочные живут под ним (решение Ч-04-9). */
const CATALOG_PREFIX = '/otkrytki';

/** Сегменты пути без пустых — форма адреса решает, посадочная это или нет. */
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

/**
 * Сколько элементов перечисляет разметка страницы.
 *
 * Суммируются все `ItemList` ответа: у подборки он один (`mainEntity`), и
 * суммирование нужно не ради множественности, а чтобы молча не взять первый,
 * если их вдруг окажется два.
 */
function listedItems(html: string): number | null {
  let total = 0;
  let found = false;
  for (const block of jsonLdBlocks(html)) {
    for (const node of jsonLdNodes(block.value, 'ItemList')) {
      found = true;
      const elements: unknown = node.itemListElement;
      total += Array.isArray(elements) ? (elements as readonly unknown[]).length : 0;
    }
  }
  return found ? total : null;
}

test.describe.configure({ timeout: 180_000 });

test('у каждой индексируемой посадочной набран порог в 20 открыток', async ({
  browser,
  request,
}, testInfo) => {
  const tree = await readSitemapTree(request, browser, target);

  if (tree.pageUrls.length === 0) {
    annotateEmptyRun(
      testInfo,
      'Объём индексируемых посадочных НЕ проверен: в карте сайта нет ни одного адреса.',
    );
    return;
  }

  const violations: string[] = [];
  /** Адреса, про которые этот spec утверждать не вправе: карточки и группы. */
  const outOfScope: string[] = [];
  /** Посадочные, у которых разметка не перечислила список вовсе. */
  const withoutList: string[] = [];
  let checked = 0;

  for (const pageUrl of tree.pageUrls) {
    const { pathname, origin } = new URL(pageUrl);
    const segments = segmentsOf(pathname);

    if (segments[0] !== segmentsOf(CATALOG_PREFIX)[0] || segments.length < 3) {
      // Один сегмент под контейнером — это либо карточка, либо группирующий
      // узел: формы адреса у них совпадают (Ч-04-9), а порог к ним либо не
      // относится, либо считается по поддереву. Молча пропустить нельзя.
      outOfScope.push(pathname);
      continue;
    }

    let counted = 0;
    let pagesRead = 0;
    let listMissing = false;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      // Первая страница списка живёт по базовому адресу, `/page/1` не
      // существует ни на одном уровне (решение Ч-05).
      const url = page === 1 ? `${origin}${pathname}` : `${origin}${pathname}/page/${String(page)}`;
      const response = await fetchRaw(request, url);

      if (page === 1) {
        expect(
          response.status,
          `Адрес ${pathname} взят из карты сайта и обязан отдавать 200, получено ` +
            `${String(response.status)}.`,
        ).toBe(200);
      } else if (response.status !== 200) {
        // Страницы дальше нет — список закончился, и накопленное число полное.
        break;
      }

      const items = listedItems(response.body);
      if (items === null) {
        listMissing = true;
        break;
      }
      pagesRead += 1;
      counted += items;
      if (counted >= MIN_CARDS_FOR_INDEX) {
        break;
      }
    }

    if (listMissing) {
      withoutList.push(pathname);
      continue;
    }

    checked += 1;
    if (counted < MIN_CARDS_FOR_INDEX) {
      violations.push(
        `${pathname} открыта в index,follow и перечисляет ${String(counted)} открыток на ` +
          `${String(pagesRead)} странице(ах) списка — меньше порога ${String(MIN_CARDS_FOR_INDEX)} ` +
          '(решение Ч-06, условие п. 5.1 «достаточно открыток»). Такая страница отвечает 200 ' +
          'как полноценная посадочная, не будучи ею. Починка — не правка этого числа: либо ' +
          'на теме снова становится достаточно открыток, либо узел возвращается в ' +
          'noindex,follow (директива — поле записи, меняет её человек с ролью admin).',
      );
    }
  }

  if (outOfScope.length > 0 || withoutList.length > 0) {
    noteNotChecked(
      testInfo,
      `Порог объёма проверен у ${String(checked)} посадочных. НЕ проверен у ` +
        `${String(outOfScope.length + withoutList.length)} адресов карты: ` +
        `${[...outOfScope, ...withoutList].join(', ')}. Адрес из одного сегмента под ` +
        `${CATALOG_PREFIX} — это карточка или группирующий узел: у первой объёма нет, у ` +
        'второго он считается по поддереву и из одного ответа не выводится. Адрес без ' +
        '`ItemList` в разметке не является списком — это предмет ' +
        'structured-data-matches-visible.spec.ts, а не этого утверждения.',
    );
  }

  expect(violations, violations.join('\n')).toEqual([]);
});
