/**
 * Входной обработчик HTTP: первое, что видит запрос, и единственное место, где
 * решается порядок обработки.
 *
 * Порядок ровно такой и в таком порядке значим:
 *
 *   0. режим обслуживания (`maintenanceMode`) — раньше ВСЕГО, включая политику
 *      пути. Обоснование порядка — в шапке `./maintenance.ts`: сервис, объявивший
 *      себя недоступным, не выдаёт заодно утверждений о канонической форме
 *      адресов, а полуоткрытый сайт (страницы 503, картинки 200) хуже честной
 *      недоступности;
 *   1. решение по СЫРОЙ цели (`decideRequestTarget`) — до статики и до
 *      маршрутизации Astro;
 *   2. производные изображений из корня `/media` — только файлы, только
 *      `GET`/`HEAD`, без редиректов и без листинга. Раньше статики сборки
 *      намеренно: пространство `/media` принадлежит хранилищу (решение Ч-03), и
 *      файл, случайно оказавшийся в `dist/client/media/...`, не должен уметь его
 *      подменить;
 *   3. статика из `dist/client` — только файлы, только `GET`/`HEAD`, без
 *      редиректов;
 *   4. приложение Astro — всё остальное, включая SSR-маршруты и собственный 404.
 *
 * Почему порядок принадлежит нам, а не адаптеру: в `mode: 'standalone'` шаги 2 и
 * 3 выполнялись до пользовательского middleware, и три класса путей (`%2F`,
 * повторные слеши, `/index.html`) отвечали мимо нашего кода — цикл редиректов,
 * цепочка из трёх переходов и второй адрес главной с 200. Разбор — в шапке
 * `../routing/path-policy.ts`.
 *
 * Правил в этом файле нет. Все они — в чистой функции решения, покрытой
 * юнит-тестами; здесь только превращение решения в HTTP-ответ. Правило, живущее
 * в обработчике запроса, проверяется лишь поднятым сервером, а правила URL —
 * приоритетное требование проекта.
 */

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { decideRequestTarget } from '../routing/path-policy.js';
import type { AstroNodeHandler } from './astro-app.js';
import type { MaintenanceDecision } from './maintenance.js';
import { decideMediaRequest, type MediaDecision } from './media-files.js';
import { tryServeStaticFile } from './static-files.js';

/** Имя файла заранее отрендеренной страницы 404 в корне статики. */
const PRERENDERED_NOT_FOUND_FILE = '404.html';

/**
 * Ответ 404 на случай, когда заранее отрендеренной страницы 404 в сборке нет.
 *
 * Требование п. 23 ТЗ — «страница 404 отдаёт настоящий 404 и содержит
 * навигацию». С задачи Э3-11 полноценная страница есть: `src/pages/404.astro`,
 * ПРЕРЕНДЕРЕННАЯ (без `prerender = false`), поэтому в сборке появляется
 * `dist/client/404.html`. Этот файл читают ОБА пути — наш (`loadNotFoundBody`
 * ниже) и приложение Astro (адаптер `@astrojs/node` подставляет
 * `prerenderedErrorPageFetch`, читающий `404.html` из корня клиента), — то есть
 * страница 404 у сайта одна, а не две разные.
 *
 * Резерв поэтому достижим ровно в одном состоянии: артефакт собран без страницы
 * 404 (например, каталог `dist/client` подменён). Он отдаёт настоящий 404 и одну
 * ссылку, но полноценной страницей не является — и не должен: его задача не
 * подменять страницу, а не дать серверу ответить пустотой.
 */
const FALLBACK_NOT_FOUND_HTML = [
  '<!doctype html>',
  '<html lang="ru">',
  '<head><meta charset="utf-8"><title>Страница не найдена</title>',
  '<meta name="robots" content="noindex,follow"></head>',
  '<body><h1>Страница не найдена</h1>',
  '<p>Такого адреса на сайте нет. <a href="/">Перейти на главную</a>.</p>',
  '</body></html>',
  '',
].join('\n');

const BAD_REQUEST_TEXT = [
  '400 Bad Request',
  '',
  'Цель запроса не является адресом на этом сайте: недопустимое процентное',
  'кодирование, dot-сегмент или форма цели, которая сайту не адресована.',
  '',
].join('\n');

const SERVER_ERROR_TEXT = '500 Internal Server Error\n';

export interface FrontDoorOptions {
  /** Обработчик собранного приложения Astro. */
  readonly astroHandler: AstroNodeHandler;
  /** Абсолютный путь каталога `dist/client` без завершающего разделителя. */
  readonly clientRoot: string;
  /** Путь админки Payload из `PAYLOAD_ADMIN_PATH`. */
  readonly adminPath: string;
  /**
   * Корень ПУБЛИЧНЫХ производных изображений (`IMAGE_STORAGE_DERIVATIVES_ROOT`).
   *
   * Функция, а не строка, и вызывается только на запросе к `/media/...`:
   * значение обязательное и без дефолта, но без изображений сайт поднимается и
   * страницы отдаёт. Валить старт сервера из-за незаполненного параметра
   * означало бы блокировать работу, которая от него не зависит, — то же решение
   * и по той же причине принято в `apps/cms` (`src/images/storage-env.ts`).
   */
  readonly mediaRoot: () => string;
  /** Куда писать диагностику. Отдельным параметром, чтобы тест не читал stderr. */
  readonly logError: (message: string) => void;
  /**
   * Решение по режиму обслуживания. Спрашивается на каждый запрос.
   *
   * Функция, а не готовое значение, по двум причинам, и ни одна из них не в том,
   * что переменную окружения можно поменять на живом процессе (нельзя — она
   * читается из `process.env` того же процесса):
   *
   *   1. значение не должно застыть на ИМПОРТЕ модуля. Порядок «сначала
   *      подмешать корневой `.env`, потом собрать обработчик» держится тем, что
   *      окружение читается позже — ровно как у `mediaRoot` рядом;
   *   2. правило одно на два входа (наш сервер и middleware Astro), и проверяется
   *      оно юнит-тестом на подставленном решении, а не поднятым сервером с
   *      подкрученным `process.env`.
   *
   * Параметр обязательный и без значения по умолчанию: сервер, собранный без этой
   * проверки, молча отвечал бы 200 в режиме обслуживания — то есть выключатель
   * существовал бы и не работал.
   */
  readonly maintenance: () => MaintenanceDecision;
}

/** Тело страницы 404 читается с диска один раз за время жизни процесса. */
let notFoundBody: Buffer | string | undefined;

async function loadNotFoundBody(clientRoot: string): Promise<Buffer | string> {
  if (notFoundBody !== undefined) {
    return notFoundBody;
  }
  try {
    notFoundBody = await readFile(path.join(clientRoot, PRERENDERED_NOT_FOUND_FILE));
  } catch {
    notFoundBody = FALLBACK_NOT_FOUND_HTML;
  }
  return notFoundBody;
}

/**
 * Тело редиректа ПУСТОЕ, и это не мелочь. Шаблон 3xx самого Astro
 * (`astro/dist/core/routing/3xx.js`) кладёт в `<meta http-equiv="refresh">` и в
 * `<a href>` адрес-ИСТОЧНИК, а не цель (`relativeLocation: url.pathname` в
 * `trailing-slash-handler.js`). Для клиента, который предпочитает meta-refresh
 * заголовку `Location`, это бесконечный цикл. Мы отдаём свой ответ и своё тело —
 * дефект апстрима становится недостижим, и смоук это проверяет.
 */
function respondRedirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, {
    'Content-Length': '0',
    Location: location,
  });
  res.end();
}

function respondText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(body);
}

async function respondNotFound(res: ServerResponse, clientRoot: string): Promise<void> {
  const body = await loadNotFoundBody(clientRoot);
  res.writeHead(404, {
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(body);
}

/**
 * Собирает входной обработчик.
 *
 * Ошибка любого шага превращается в 500 и в запись в лог: незавершённый ответ
 * оставил бы соединение висеть, а молчаливое падение выглядело бы таймаутом
 * сети.
 */
export function createFrontDoor(
  options: FrontDoorOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res, options);
    } catch (error) {
      options.logError(
        `Ошибка обработки «${req.url ?? '—'}»: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        respondText(res, 500, SERVER_ERROR_TEXT);
        return;
      }
      res.end();
    }
  };
}

/**
 * Отдаёт производную изображения из корня хранилища.
 *
 * Приложению Astro запрос под `/media/` не передаётся НИКОГДА: пространство
 * файлов и пространство страниц разные, и промах по файлу здесь — это 404, а не
 * повод искать страницу с таким адресом. Промах по методу (`POST` и прочие) —
 * тоже 404: у адреса файла других методов нет.
 */
async function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  options: FrontDoorOptions,
  decision: Exclude<MediaDecision, { readonly action: 'not-media' }>,
): Promise<void> {
  if (decision.action === 'not-found') {
    options.logError(`404 на «${req.url ?? '—'}»: ${decision.reason}`);
    await respondNotFound(res, options.clientRoot);
    return;
  }

  const served = await tryServeStaticFile({
    headers: decision.headers,
    relativePath: decision.key,
    req,
    res,
    root: options.mediaRoot(),
  });

  if (!served) {
    await respondNotFound(res, options.clientRoot);
  }
}

/**
 * Ответ 503 режима обслуживания.
 *
 * `Retry-After` обязателен: без него 503 для краулера означает неопределённость,
 * а с ним — «приходите через N секунд». Тело приходит из
 * `./maintenance.ts` и от базы не зависит вовсе.
 */
function respondUnavailable(
  res: ServerResponse,
  decision: Extract<MaintenanceDecision, { readonly action: 'unavailable' }>,
): void {
  res.writeHead(decision.status, {
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(decision.body)),
    'Content-Type': 'text/html; charset=utf-8',
    'Retry-After': String(decision.retryAfterSeconds),
  });
  res.end(decision.body);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: FrontDoorOptions,
): Promise<void> {
  // Шаг 0: режим обслуживания. Раньше политики пути, раньше `/media`, раньше
  // статики — обоснование в шапке `./maintenance.ts`.
  const maintenance = options.maintenance();
  if (maintenance.action === 'unavailable') {
    respondUnavailable(res, maintenance);
    return;
  }

  const target = req.url;
  if (target === undefined || target === '') {
    respondText(res, 400, BAD_REQUEST_TEXT);
    return;
  }

  const decision = decideRequestTarget({ adminPath: options.adminPath, target });

  switch (decision.action) {
    case 'redirect':
      respondRedirect(res, decision.status, decision.location);
      return;

    case 'bad-request':
      // Причина уходит в лог, а не в тело ответа: тело обязано быть одинаковым
      // для всех отказов этого класса, иначе оно превращается в справочник по
      // внутренностям сервера для того, кто его перебирает.
      options.logError(`400 на «${target}»: ${decision.reason}`);
      respondText(res, 400, BAD_REQUEST_TEXT);
      return;

    case 'not-found':
      await respondNotFound(res, options.clientRoot);
      return;

    case 'not-served':
      // Маршруты админки Payload. Причина в лог НЕ пишется намеренно: она
      // содержит значение PAYLOAD_ADMIN_PATH, а путь админки не публикуется
      // (решение Ч-22). Ответ — обычный 404, неотличимый от любого другого:
      // отдельный статус или отдельное тело подсказывали бы, что по этому
      // адресу что-то есть.
      await respondNotFound(res, options.clientRoot);
      return;

    case 'serve': {
      const media = decideMediaRequest(decision.pathname);
      if (media.action !== 'not-media') {
        await serveMedia(req, res, options, media);
        return;
      }

      const served = await tryServeStaticFile({
        pathname: decision.pathname,
        req,
        res,
        root: options.clientRoot,
      });
      if (served) {
        return;
      }
      await options.astroHandler(req, res);
      return;
    }
  }
}
