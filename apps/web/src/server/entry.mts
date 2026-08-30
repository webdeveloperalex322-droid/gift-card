/**
 * Точка входа собранного сервера apps/web: `dist/server/entry.mjs`.
 *
 * ## Почему точка входа наша, а не адаптерная
 *
 * Адаптер `@astrojs/node` собран в `mode: 'middleware'` (`astro.config.mjs`):
 * он отдаёт обработчик приложения и НЕ поднимает сервер сам, потому что в режиме
 * `standalone` его статический обработчик отвечал раньше нашего кода и давал три
 * класса ошибок URL — цикл 301 на `/%2F`, цепочку из трёх переходов на `////` и
 * второй адрес главной `/index.html` с 200. Разбор и замеры — в шапке
 * `../routing/path-policy.ts`.
 *
 * ## Почему именно это имя файла
 *
 * `dist/server/entry.mjs` — контракт сборки, на который смотрят и смоук
 * (`scripts/smoke-trailing-slash.mjs`), и стенд SEO-приёмки
 * (`tests/seo/support/serve-built-web.mjs`), и `astro preview`. Он сохранён:
 * приложение Astro переехало в `dist/server/astro-app.mjs`
 * (`build.serverEntry`), а этим именем называется наш сервер. Исходник —
 * `.mts`, потому что только из `.mts` tsc даёт на выходе `.mjs`; компилирует его
 * `apps/web/tsconfig.node.json` (см. скрипт `build` в `package.json`).
 *
 * Сервер поднимается на импорте — как это делал standalone-вход адаптера, и по
 * той же причине: стенд приёмки поднимает сервер `import()` в своём процессе,
 * чтобы дочерний процесс не остался держать порт. Отключается так же, как у
 * адаптера: `ASTRO_NODE_AUTOSTART=disabled`; тогда модуль только экспортирует
 * `handler`, и им пользуется `astro preview`.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adminRoutePrefix } from '../routing/path-policy.js';
import { serverEnv, workspaceRoot } from '../server-env.js';
import { loadBuiltAstroApp } from './astro-app.js';
import { createFrontDoor } from './front-door.js';
import { maintenanceMode } from './maintenance.js';
import { resolveMediaRoot } from './media-files.js';

/**
 * Порт по умолчанию нужен только когда его не назвали ни окружение (`PORT`), ни
 * конфиг Astro (`server.port`). Это порт процесса, а не хост в канонических
 * URL: правило «никаких значений по умолчанию» относится к `SITE_URL`, потому
 * что молча подставленный ХОСТ уезжает в canonical и sitemap, а молча выбранный
 * порт просто не даёт подключиться.
 */
const FALLBACK_PORT = 4321;

const serverDir = new URL('./', import.meta.url);
/** `path.resolve` заодно снимает завершающий разделитель — сравнение корня требует его отсутствия. */
const clientRoot = path.resolve(fileURLToPath(new URL('../client/', import.meta.url)));

const app = await loadBuiltAstroApp(serverDir);

export const handler = createFrontDoor({
  adminPath: adminRoutePrefix(serverEnv()),
  astroHandler: app.handler,
  clientRoot,
  logError: (message: string) => {
    console.error(`[apps/web] ${message}`);
  },
  /**
   * Режим обслуживания. Как и корень производных, читается ЛЕНИВО — на запросе, а
   * не при сборке обработчика: `serverEnv()` подмешивает корневой `.env`, и
   * порядок «сначала окружение, потом решение» обязан сохраниться (обоснование —
   * шапка `FrontDoorOptions.maintenance`). Непонятное значение выключателя даёт
   * отказ, который превращается в 500 с внятной причиной в логе, — это лучше
   * сайта, который считается закрытым и отвечает 200.
   */
  maintenance: () => maintenanceMode(serverEnv()),
  /**
   * Корень производных вычисляется ЛЕНИВО — при первом запросе к `/media/...`, а
   * не при старте. Причина в шапке `FrontDoorOptions.mediaRoot`: без корня сайт
   * работоспособен во всём, кроме изображений, и валить старт означало бы
   * блокировать работу, которая от параметра не зависит. Пустое значение всё
   * равно не подменяется дефолтом — оно даёт внятную ошибку и 500 на запрос
   * файла.
   */
  mediaRoot: () => resolveMediaRoot(serverEnv(), workspaceRoot()),
});

function resolvePort(): number {
  const fromEnv = (process.env['PORT'] ?? '').trim();
  if (fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`PORT=«${fromEnv}» не является номером порта (0..65535).`);
    }
    return parsed;
  }
  return app.configuredPort ?? FALLBACK_PORT;
}

/**
 * Адрес привязки. `HOST` сильнее конфига — так же, как у адаптера.
 *
 * Про `localhost` на Windows: Node привязывает его к IPv6-петле (`[::1]`),
 * поэтому инструмент, резолвящий `localhost` в `127.0.0.1`, до сервера не
 * доходит. Смоук и стенд приёмки задают `HOST=127.0.0.1` явно именно из-за
 * этого.
 */
function resolveHost(): string {
  const fromEnv = (process.env['HOST'] ?? '').trim();
  return fromEnv !== '' ? fromEnv : app.configuredHost;
}

export function startServer(): http.Server {
  const host = resolveHost();
  const port = resolvePort();
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const shown = address === null || typeof address === 'string' ? `${host}:${String(port)}` : `${address.address}:${String(address.port)}`;
    console.log(`[apps/web] сервер слушает http://${shown}`);
  });
  return server;
}

if (process.env['ASTRO_NODE_AUTOSTART'] !== 'disabled') {
  startServer();
}
