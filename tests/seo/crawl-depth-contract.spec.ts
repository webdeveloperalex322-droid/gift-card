/**
 * Проверяется не сайт, а ИНСТРУМЕНТ приёмки: `support/crawl.ts` обязан измерять
 * МИНИМАЛЬНУЮ глубину адреса от главной. Тот же приём и та же причина, что у
 * `html-parser-contract.spec.ts`: ошибка в инструменте не делает тесты красными,
 * она делает их неправдивыми — здесь она порождала бы находку `too-deep` на
 * верной перелинковке, то есть красный обязательный шлюз без причины.
 *
 * ## Топология, на которой ломался прежний обход
 *
 * Обход в ширину даёт минимальную глубину, пока адреса встречаются в порядке
 * возрастания глубины. В этом обходе порядок нарушается штатно: цель редиректа
 * встаёт в очередь на глубине СТРАНИЦЫ-ИСТОЧНИКА (301 переходом не считается —
 * норма Ч-04-8), но опрашивается раундом позже. Значит адрес с МАЛОЙ глубиной
 * может быть опрошен ПОЗЖЕ, чем тот же адрес найден длинной ссылкой:
 *
 *     /            (0) → /deep1 и /r1
 *     /deep1 (1) → /deep2 (2) → /deep3 (3) → /x   ← /x найден на глубине 4
 *     /r1    (1) → 301 → /r2 → 301 → /r3 → 301 → /r4 → 301 → /r5
 *                  (вся цепочка остаётся глубиной 1, но тратит по раунду)
 *     /r5    (1) → /x                              ← /x на самом деле глубина 2
 *     /x           → /y
 *
 * Прежняя редакция брала `Math.min` и на этом останавливалась: сам `/x` глубину
 * исправлял, а `/y`, розданный потомкам ДО исправления, оставался с глубиной 5 —
 * при норме 4 это ложная сирота-«слишком глубоко». Правка возвращает узел с
 * понизившейся глубиной в очередь, поэтому потомки получают глубину заново.
 *
 * Числа в топологии подобраны так, чтобы `/r5` опрашивался ПОЗЖЕ `/x`: иначе
 * понижение приходило бы до опроса, `Math.min` хватало бы, и тест проверял бы не
 * тот случай. Проверено экспериментом 2026-09-03 (не рассуждением): при снятой
 * правке — `known.probed = false` убран из `see()` — spec падает с
 * `Expected: 3 / Received: 5`, то есть ровно ложной находкой «глубже нормы 4»;
 * с правкой проходит.
 *
 * Сервер поднимается свой, крошечный: топология обязана быть ЗАДАННОЙ, а не
 * подобранной из реального сайта. Приёмка так уже делает для режима обслуживания
 * (`support/maintenance-server.ts`), причина там та же — проверяемое состояние
 * нельзя получить на общем стенде.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { MAX_CLICKS_FROM_HOME, crawlFromHome } from './support/crawl.js';
import type { AcceptanceTarget } from './support/target.js';

/** Страницы стенда: путь → ссылки, которые печатает страница. */
const PAGES: Readonly<Record<string, readonly string[]>> = {
  '/': ['/deep1', '/r1'],
  '/deep1': ['/deep2'],
  '/deep2': ['/deep3'],
  '/deep3': ['/x'],
  '/r5': ['/x'],
  '/x': ['/y'],
  '/y': [],
};

/** Цепочка редиректов: путь → куда ведёт одиночный 301. */
const REDIRECTS: Readonly<Record<string, string>> = {
  '/r1': '/r2',
  '/r2': '/r3',
  '/r3': '/r4',
  '/r4': '/r5',
};

function startTopologyServer(): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    const movedTo = REDIRECTS[pathname];
    if (movedTo !== undefined) {
      res.writeHead(301, { 'Content-Length': '0', Location: movedTo });
      res.end();
      return;
    }

    const links = PAGES[pathname];
    if (links === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="ru"><body><h1>Нет</h1></body></html>');
      return;
    }

    const body =
      '<!doctype html><html lang="ru"><head><meta name="robots" content="noindex,follow">' +
      `</head><body><h1>${pathname}</h1>` +
      links.map((href) => `<a href="${href}">${href}</a>`).join('') +
      '</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
        origin: `http://127.0.0.1:${String(port)}`,
      });
    });
  });
}

test.describe('обход измеряет минимальную глубину', () => {
  // Бюджет времени: запросов десяток, но сервер поднимается в самом тесте.
  test.describe.configure({ timeout: 60_000 });

  test('глубина потомков пересчитывается, когда путь к родителю нашёлся короче', async ({
    request,
  }) => {
    const stand = await startTopologyServer();
    try {
      const target: AcceptanceTarget = {
        origin: stand.origin,
        reuseExistingServer: true,
        serverHost: '127.0.0.1',
        serverPort: 0,
      };

      const crawl = await crawlFromHome(request, target);
      const depthOf = (path: string): number | undefined =>
        crawl.targets.get(`${stand.origin}${path}`)?.depth;

      expect(crawl.truncated, 'Обход не должен упираться в пределы на семи страницах.').toBe(false);

      expect(
        depthOf('/x'),
        'Короткий путь до /x — через цепочку редиректов с глубины 1, то есть 2 перехода. ' +
          'Редирект переходом не считается (Ч-04-8).',
      ).toBe(2);

      expect(
        depthOf('/y'),
        'ЭТО И ЕСТЬ ПРОВЕРЯЕМЫЙ СЛУЧАЙ: /y найден потомком /x, когда /x считался глубиной 4, ' +
          'и должен получить глубину заново после того, как /x понизился до 2. Значение 5 ' +
          'означает возврат прежнего дефекта: обход раздал бы потомкам завышенную глубину и ' +
          `выдал бы ложную находку «глубже нормы ${String(MAX_CLICKS_FROM_HOME)}» на верной ` +
          'перелинковке.',
      ).toBe(3);

      expect(depthOf('/deep3'), 'Прямая ветвь ссылок меряется как обычно.').toBe(3);
      expect(
        depthOf('/r5'),
        'Цель одиночного 301 остаётся на глубине источника: четыре редиректа с /r1 (глубина 1) ' +
          'не тратят ни одного перехода.',
      ).toBe(1);
    } finally {
      await stand.close();
    }
  });
});
