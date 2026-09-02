/**
 * Требование — **не п. 22, а раздел «Рендеринг»** (`CLAUDE.md`): «title, H1,
 * canonical, хлебные крошки, основной текст, ссылки и первые изображения
 * присутствуют в HTML-ответе сервера. Проверка: страница полноценна при
 * отключённом JS». Полноценна — значит и ПОКАЗАНА как страница, а не как колонка
 * шириной с боковой рельс.
 *
 * Прецедент такого объявления в этой приёмке уже есть: `preloaded-fonts-are-served`
 * помечен «не п. 22, а раздел «Производительность»». Строка про раздел стоит
 * здесь по той же причине — чтобы никто не искал это требование в чек-листе.
 *
 * ## Почему это отдельный spec, а не придирка к оформлению
 *
 * Разметка и содержание при такой поломке ЦЕЛЫ: статус 200, один H1, canonical на
 * месте, ссылки на месте, изображения с `width`/`height`/`alt`. Ни один
 * существующий spec приёмки не шевелится — падает только то, что видит человек.
 * Именно поэтому проверка нужна машинная: поломка тихая, а появляется она ровно
 * там, где к layout'у добавляют колонку (боковое меню, рекламный рельс, панель
 * фильтров) — то есть при каждой правке `BaseLayout.astro`.
 *
 * Замер 2026-09-02, на котором spec и написан: после добавления левого рельса
 * категорий `.layout__body` получил `grid-template-columns: 14rem minmax(0,60rem)`
 * НА ЛЮБОЙ широкой странице, а сам рельс печатается не всегда — его нет на 404
 * (`categorySections={null}`, страница пререндерена) и нет при пустой таксономии.
 * Оставшись единственным элементом сетки, `<main>` встаёт в ПЕРВУЮ колонку: при
 * окне 1440 px содержание всех страниц сайта рисовалось в 224 px, а 928 px
 * оставались пустыми.
 *
 * ## Как проверка устроена и почему не привязана к классам
 *
 * Ни одного селектора вида `.layout__body` или `.sidebar` здесь нет: класс —
 * деталь оформления, он меняется при перекраске, и приёмка, привязанная к нему,
 * начала бы падать на верном коде. Утверждение формулируется от `<main>` —
 * элемента, который обязан быть на любой странице:
 *
 *   `<main>` вместе с элементами, стоящими с ним В ОДНОЙ СТРОКЕ, заполняет
 *   ширину содержимого своего родителя (с точностью до одного зазора сетки).
 *
 * Соседи в строке (рельс категорий) в расчёт входят и место занимать вправе;
 * пустая колонка — не входит, и это ровно то, что ловится. Соседи ВНЕ строки
 * (шапка, подвал, если layout однажды положит их рядом) отбираются по
 * вертикальному пересечению, иначе проверка стала бы тавтологией.
 */

import { expect, test, type Browser } from '@playwright/test';

import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/**
 * Поверхность DOM, которой пользуется код внутри `page.evaluate`.
 *
 * Объявлена локально по той же причине, что и в `support/xml.ts`: проект
 * `tests/` собирается без `lib: ["DOM"]` намеренно — это код для Node, и
 * глобальные `document`/`getComputedStyle` не должны подсказываться всему
 * проекту ради одного модуля.
 */
interface DomRectLike {
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
}

interface DomElementLike {
  readonly tagName: string;
  readonly clientWidth: number;
  readonly children: ArrayLike<DomElementLike>;
  readonly parentElement: DomElementLike | null;
  getBoundingClientRect(): DomRectLike;
}

interface DomStyleLike {
  readonly paddingLeft: string;
  readonly paddingRight: string;
  readonly columnGap: string;
}

interface BrowserGlobals {
  readonly document: { querySelector(selector: string): DomElementLike | null };
  getComputedStyle(element: DomElementLike): DomStyleLike;
}

interface ColumnMeasurement {
  /** `<main>` в документе не найден — это уже нарушение, и оно называется отдельно. */
  readonly mainFound: boolean;
  readonly mainWidth: number;
  /** Ширина содержимого родителя `<main>` (без его собственных отступов). */
  readonly parentContentWidth: number;
  /** Суммарная ширина элементов, стоящих с `<main>` в одной строке. */
  readonly rowSiblingsWidth: number;
  /** Число таких соседей — по нему считается допуск на зазоры сетки. */
  readonly rowSiblingsCount: number;
  /** `column-gap` родителя в пикселях; `normal` считается нулём. */
  readonly columnGap: number;
  readonly parentTag: string;
}

/** Допуск на округление размеров браузером. */
const ROUNDING_SLACK_PX = 4;

/** Ширины окна, на которых проверяется раскладка. */
const VIEWPORTS: readonly { readonly width: number; readonly height: number; readonly note: string }[] =
  [
    { height: 900, note: 'широкий настольный экран', width: 1440 },
    // Порог двух колонок — 66rem = 1056 px (выведен из контракта `sizes`, см.
    // шапку `apps/web/src/layouts/BaseLayout.astro`). Меряется ОБЕ его стороны:
    // граничное значение — то место, где раскладку ломают чаще всего, и ошибка
    // ровно на нём (порог сместили, а проверку оставили на старом числе) иначе
    // не видна.
    { height: 800, note: 'на пиксель ниже порога: ещё одна колонка', width: 1055 },
    { height: 800, note: 'ровно порог: уже две колонки', width: 1056 },
    { height: 800, note: 'младший настольный экран, ниже порога', width: 1024 },
    { height: 844, note: 'мобильный экран (одна колонка)', width: 390 },
  ];

/**
 * Страница 404 проверяется наравне с остальными: рельса у неё нет намеренно, и
 * именно поэтому её раскладка ломается первой. Своего адреса у 404 нет — берётся
 * заведомо несуществующий путь, как в `site-nav-present.spec.ts`.
 */
const PAGES: readonly { readonly path: string; readonly label: string }[] = [
  ...ACCEPTANCE_PAGES.map((page) => ({ label: page.task, path: page.path })),
  { label: 'страница 404', path: '/takogo-adresa-net-e3-15' },
];

async function measure(browser: Browser, width: number, height: number): Promise<
  readonly { readonly path: string; readonly label: string; readonly measurement: ColumnMeasurement }[]
> {
  const context = await browser.newContext({ viewport: { height, width } });
  try {
    const page = await context.newPage();
    const results = [];
    for (const entry of PAGES) {
      await page.goto(urlFor(target, entry.path), { waitUntil: 'load' });
      const measurement = await page.evaluate((): ColumnMeasurement => {
        const globals = globalThis as unknown as BrowserGlobals;
        const main = globals.document.querySelector('main');
        const parent = main?.parentElement ?? null;
        if (main === null || parent === null) {
          return {
            columnGap: 0,
            mainFound: main !== null,
            mainWidth: 0,
            parentContentWidth: 0,
            parentTag: parent?.tagName ?? '',
            rowSiblingsCount: 0,
            rowSiblingsWidth: 0,
          };
        }

        const px = (value: string): number => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : 0;
        };

        const style = globals.getComputedStyle(parent);
        const mainRect = main.getBoundingClientRect();
        // Сосед считается стоящим В ОДНОЙ СТРОКЕ с `<main>`, если их полосы по
        // вертикали пересекаются. Иначе (шапка сверху, подвал снизу) он места в
        // строке не отнимает, и вычитать его ширину значило бы обнулить проверку.
        const rowSiblings = Array.from(parent.children).filter((element) => {
          if (element === main) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.bottom > mainRect.top + 1 && rect.top < mainRect.bottom - 1;
        });

        return {
          columnGap: px(style.columnGap),
          mainFound: true,
          mainWidth: mainRect.width,
          parentContentWidth: parent.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
          parentTag: parent.tagName.toLowerCase(),
          rowSiblingsCount: rowSiblings.length,
          rowSiblingsWidth: rowSiblings.reduce(
            (sum, element) => sum + element.getBoundingClientRect().width,
            0,
          ),
        };
      });
      results.push({ label: entry.label, measurement, path: entry.path });
    }
    return results;
  } finally {
    await context.close();
  }
}

test.describe('основная колонка занимает отведённую ей ширину', () => {
  // Отдельный бюджет времени — плата за запуск браузера, как в
  // `server-rendered-without-js.spec.ts`. Утверждения при этом ждут не дольше
  // `expect.timeout` из конфига.
  test.describe.configure({ timeout: 180_000 });

  for (const viewport of VIEWPORTS) {
    test(`${String(viewport.width)}×${String(viewport.height)} — ${viewport.note}`, async ({
      browser,
    }) => {
      const measured = await measure(browser, viewport.width, viewport.height);

      for (const { label, measurement, path } of measured) {
        expect(
          measurement.mainFound,
          `На ${path} (${label}) нет элемента <main>: основное содержание страницы обязано ` +
            'лежать в нём — на этом держатся и доступность, и все проверки «содержание пришло ' +
            'с сервера».',
        ).toBe(true);

        const gaps = measurement.columnGap * Math.max(1, measurement.rowSiblingsCount);
        const available = measurement.parentContentWidth - measurement.rowSiblingsWidth - gaps;

        expect(
          measurement.mainWidth,
          `На ${path} (${label}), окно ${String(viewport.width)} px: <main> шириной ` +
            `${measurement.mainWidth.toFixed(0)} px, тогда как в строке свободно ` +
            `${available.toFixed(0)} px (родитель <${measurement.parentTag}> шириной ` +
            `${measurement.parentContentWidth.toFixed(0)} px, соседей в строке ` +
            `${String(measurement.rowSiblingsCount)} общей шириной ` +
            `${measurement.rowSiblingsWidth.toFixed(0)} px, зазор ` +
            `${measurement.columnGap.toFixed(0)} px). Основная колонка обязана занимать всё ` +
            'место, которое не заняли соседи в той же строке. Расхождение означает пустую ' +
            'колонку в сетке: содержание страницы рисуется в полосе, отведённой под другой ' +
            'элемент. Разметка при этом цела, статус 200, один H1 — поломку не видит ни один ' +
            'другой spec приёмки, поэтому она проверяется здесь.',
        ).toBeGreaterThanOrEqual(available - ROUNDING_SLACK_PX);
      }
    });
  }
});
