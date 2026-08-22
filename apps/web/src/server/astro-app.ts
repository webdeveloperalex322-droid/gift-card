/**
 * Загрузка собранного приложения Astro для входного сервера.
 *
 * ## Зачем это отдельный модуль
 *
 * Адаптер `@astrojs/node` переведён в `mode: 'middleware'`: он больше не
 * поднимает сервер сам и не обслуживает статику. Вместо этого он собирает
 * обработчик запроса (`createMiddleware` → `createAppHandler`), а поднимает
 * сервер и решает порядок обработки наш `./front-door.ts`. Причина — находки
 * 1–3 контролёра `url-guard`: пути `%2F`, `//`, `////` и `/index.html`
 * обрабатывались в `standalone` ДО пользовательского middleware, поэтому
 * исправить их в middleware было нельзя (разбор — в шапке
 * `../routing/path-policy.ts`).
 *
 * ## Почему загрузка динамическая
 *
 * Модуль Astro (`build.serverEntry: 'astro-app.mjs'`) появляется только в
 * `dist/server/` после `astro build`; в исходниках его нет по построению.
 * Статический импорт по такому пути не прошёл бы проверку типов, а объявить его
 * ambient-модулем означало бы описать чужой контракт вручную и однажды с ним
 * разойтись. Поэтому модуль грузится по вычисленному URL, а его форма
 * проверяется в рантайме: отсутствующий или неожидаемый экспорт — это внятная
 * ошибка запуска, а не `undefined is not a function` на первом же запросе.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Обработчик запроса, который отдаёт адаптер в режиме middleware.
 *
 * Третий аргумент (`next`) намеренно НЕ передаётся: без него обработчик на
 * несовпавшем маршруте рендерит собственный ответ 404 (`app.render`), в том
 * числе заранее отрендеренную страницу `404.html`, если она есть. Передача
 * `next` вернула бы управление нам, и 404 пришлось бы собирать второй раз.
 */
export type AstroNodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Собранное приложение и значения из `astro.config.mjs`, нужные для запуска. */
export interface BuiltAstroApp {
  readonly handler: AstroNodeHandler;
  /** `server.host` из конфига Astro, уже приведённый к адресу привязки. */
  readonly configuredHost: string;
  /**
   * `server.port` из конфига Astro, если он там задан. `undefined` означает
   * «конфиг порта не назвал» — значение по умолчанию подставляет не этот модуль,
   * а вызывающий, и делает это явно.
   */
  readonly configuredPort: number | undefined;
}

/** Имя файла собранного приложения — парное к `build.serverEntry` в `astro.config.mjs`. */
export const ASTRO_APP_FILE_NAME = 'astro-app.mjs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Адрес привязки из значения `server.host` конфига Astro. Логика повторяет
 * `hostOptions` адаптера (`@astrojs/node/dist/standalone.js`), потому что это
 * контракт конфига, а не наше решение: `true` означает «все интерфейсы»,
 * `false` — «только петля».
 */
function hostFromConfig(value: unknown): string {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (value === true) {
    return '0.0.0.0';
  }
  return 'localhost';
}

/**
 * Грузит `dist/server/astro-app.mjs` рядом с собой и проверяет его форму.
 *
 * @param serverDir каталог собранного сервера (`dist/server/`), со завершающим
 *   слешем — по нему разрешается имя файла приложения.
 * @throws Error если файла нет или он не экспортирует обработчик: сервер,
 *   поднявшийся без приложения, отвечал бы 404 на всё и выглядел бы рабочим.
 */
export async function loadBuiltAstroApp(serverDir: URL): Promise<BuiltAstroApp> {
  const moduleUrl = new URL(ASTRO_APP_FILE_NAME, serverDir);

  let loaded: unknown;
  try {
    loaded = (await import(moduleUrl.href)) as unknown;
  } catch (cause) {
    throw new Error(
      `Не удалось загрузить собранное приложение Astro (${moduleUrl.href}). Соберите ` +
        'приложение: pnpm --filter @otkritka/web run build. Имя файла задаёт build.serverEntry ' +
        'в astro.config.mjs и обязано совпадать с ASTRO_APP_FILE_NAME.',
      { cause },
    );
  }

  if (!isRecord(loaded) || typeof loaded['handler'] !== 'function') {
    throw new Error(
      `${moduleUrl.href} не экспортирует функцию «handler». Так бывает, когда адаптер собран в ` +
        'режиме standalone: тогда он поднимает сервер сам и обслуживает статику своим ' +
        'обработчиком, а именно от этого apps/web и отказался (находки 1–3 url-guard). ' +
        "Проверьте adapter: node({ mode: 'middleware' }) в astro.config.mjs.",
    );
  }

  const handler = loaded['handler'] as AstroNodeHandler;
  const options: unknown = loaded['options'];
  const port: unknown = isRecord(options) ? options['port'] : undefined;

  return {
    handler,
    configuredHost: hostFromConfig(isRecord(options) ? options['host'] : undefined),
    configuredPort: typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined,
  };
}
