#!/usr/bin/env node
/**
 * Разовый замер CLS, LCP и доли первого экрана под рекламой (задача Э3-12).
 *
 * ## Зачем отдельный скрипт, а не spec в приёмке
 *
 * `tests/seo/` принадлежит агенту `seo-auditor`, и порог CLS там пришлось бы
 * держать на данных, которых у страницы может не быть (пустой каталог, ненастроенные
 * рекламные места). Этот скрипт — измерительный прибор: он ничего не утверждает и
 * ничем не блокирует, а печатает числа, которые попадают в отчёт задачи. Критерий
 * «CLS ниже 0,1» проверяется человеком по этим числам, а не зелёным тестом на
 * пустой странице.
 *
 * ## Что и как измеряется
 *
 *   - **CLS** — сумма `layout-shift` без взаимодействия пользователя
 *     (`hadRecentInput: false`), то есть ровно то, что считает Chrome для
 *     Core Web Vitals;
 *   - **LCP** — последнее событие `largest-contentful-paint` до полной загрузки;
 *   - **доля первого экрана под рекламой** — суммарная площадь коробок
 *     `.ad-row__slot`, попавших в первый экран, к площади первого экрана. Это
 *     проверка требования ТЗ §5.7 «первый экран не занят рекламой полностью»
 *     числом, а не на глаз.
 *
 * Экран — мобильный (390×844, DPR 2): целевые метрики ТЗ §10 заданы для
 * 75-го перцентиля МОБИЛЬНЫХ, и мерить их на широком окне бессмысленно.
 *
 * ## Запуск
 *
 *   MEASURE_BASE_URL=http://127.0.0.1:4401 node apps/web/scripts/measure-web-vitals.mjs / /otkrytki
 *
 * Адреса — аргументами. Значения по умолчанию у базового адреса нет: замер,
 * молча ушедший на другой хост, измеряет не тот сайт (то же правило, что у
 * `BASE_URL` приёмки).
 *
 * ## Почему в коде для страницы всё через `globalThis`
 *
 * Функции, которые уходят в `addInitScript` и `page.evaluate`, исполняются В
 * БРАУЗЕРЕ, а лежат в файле для Node. Обращение к `window`, `document` и
 * `PerformanceObserver` по короткому имени eslint справедливо считает
 * неопределённым (`no-undef`): в этом файле их действительно нет. Префикс
 * `globalThis` — способ сказать «это глобаль ТОЙ среды», не расширяя список
 * глобальных имён для всего репозитория в корневом конфиге линтера.
 */

const baseUrl = (process.env.MEASURE_BASE_URL ?? '').trim();
if (baseUrl === '') {
  console.error(
    'MEASURE_BASE_URL не задан. Замер идёт против СОБРАННОГО сервера:\n' +
      '  pnpm --filter @otkritka/web run build\n' +
      '  pnpm --filter @otkritka/web run start\n' +
      '  MEASURE_BASE_URL=http://127.0.0.1:4321 node apps/web/scripts/measure-web-vitals.mjs /',
  );
  process.exit(1);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Укажите хотя бы один путь: node apps/web/scripts/measure-web-vitals.mjs / /otkrytki');
  process.exit(1);
}

const playwright = await import('@playwright/test').catch(() => null);
if (playwright === null) {
  console.error(
    'Playwright недоступен, замер НЕ ВЫПОЛНЕН. Это честный результат: подставлять числа ' +
      'вместо измерения нельзя.',
  );
  process.exit(1);
}

const VIEWPORT = { height: 844, width: 390 };

const browser = await playwright.chromium.launch();
try {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();

  // Наблюдатели ставятся ДО навигации: сдвиги первого экрана происходят в первые
  // миллисекунды, и подписка после `goto` пропустила бы именно их.
  await page.addInitScript(() => {
    const state = { cls: 0, lcp: 0, shifts: [] };
    globalThis.__vitals = state;
    new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          state.cls += entry.value;
          state.shifts.push(entry.value);
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.lcp = entry.startTime;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });

  for (const path of paths) {
    const url = `${baseUrl}${path}`;
    const response = await page.goto(url, { waitUntil: 'load' });
    // Пауза после загрузки: сдвиги от поздних шрифтов и изображений приходят уже
    // после события `load`, и без ожидания CLS вышел бы оптимистично низким.
    await page.waitForTimeout(1500);

    const measured = await page.evaluate((viewportHeight) => {
      const state = globalThis.__vitals;
      const firstScreenArea = globalThis.innerWidth * viewportHeight;
      let adArea = 0;
      for (const element of globalThis.document.querySelectorAll('.ad-row__slot')) {
        const box = element.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(box.bottom, viewportHeight) - Math.max(box.top, 0));
        adArea += visibleHeight * box.width;
      }
      return {
        cls: state.cls,
        lcp: state.lcp,
        shifts: state.shifts.length,
        adShare: firstScreenArea === 0 ? 0 : adArea / firstScreenArea,
        images: globalThis.document.querySelectorAll('img').length,
        adBoxes: globalThis.document.querySelectorAll('.ad-row__slot').length,
      };
    }, VIEWPORT.height);

    console.log(
      `${path}\n` +
        `  статус: ${String(response?.status() ?? 0)}\n` +
        `  CLS: ${measured.cls.toFixed(4)} (сдвигов: ${String(measured.shifts)})\n` +
        `  LCP: ${(measured.lcp / 1000).toFixed(3)} с\n` +
        `  изображений: ${String(measured.images)}, рекламных коробок: ${String(measured.adBoxes)}\n` +
        `  доля первого экрана под рекламой: ${(measured.adShare * 100).toFixed(1)} %`,
    );
  }

  await context.close();
} finally {
  await browser.close();
}
