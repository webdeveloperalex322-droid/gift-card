/**
 * Адрес, против которого гоняется SEO-приёмка, и правила его проверки.
 *
 * Здесь нет ни одного значения по умолчанию для хоста — по той же причине, по
 * которой его нет в продуктовом коде (`CLAUDE.md`, «Правила URL»): молча
 * подставленный адрес означает, что приёмка проверила не то, что развёрнуто.
 *
 * ## Почему хост BASE_URL и хост SITE_URL обязаны совпадать
 *
 * `CLAUDE.md`, раздел «SEO-тесты»: «На окружении, где гоняется приёмка,
 * `SITE_URL` и `BASE_URL` указывают на один и тот же хост — иначе self-canonical
 * укажет на другой хост и проверка canonical либо ложно упадёт, либо будет
 * ослаблена. Ослаблять её запрещено; расхождение хостов — это ошибка
 * конфигурации окружения, а не теста».
 *
 * Отсюда две части решения, разнесённые намеренно:
 *
 *   1. когда собранный сервер поднимает сама приёмка (режим по умолчанию),
 *      конфиг передаёт ему `SITE_URL` = {@link AcceptanceTarget.origin}. Так
 *      окружение приёмки согласовано ПО ПОСТРОЕНИЮ, а не по договорённости;
 *   2. согласованность всё равно проверяется на живом ответе — spec
 *      `environment-hosts-match.spec.ts` сравнивает origin self-canonical с
 *      origin BASE_URL. Эта проверка нужна для режима `SEO_REUSE_SERVER=1`, где
 *      `SITE_URL` сервера приёмке не подконтролен, и она же ловит появление
 *      второго источника хоста в шаблонах (например `Astro.site`).
 *
 * Ослабления здесь нет: spec на canonical сравнивает АБСОЛЮТНЫЙ адрес целиком
 * (схема, хост, порт, путь), а не «оканчивается на путь». Не проверяется ровно
 * одно — что значение `SITE_URL` в `.env` продуктового окружения совпадает с
 * хостом, на котором сайт реально отдаётся. Локально это непроверяемо в
 * принципе: чтобы приёмка шла против `http://otkritka.test` из решения Ч-02,
 * человеку нужно вне репозитория отобразить `otkritka.test` на порт приложения
 * (hosts + обратный прокси). Пока этого нет, приёмка гоняется по адресу петли,
 * и это указано в отчёте, а не спрятано.
 */

/** Ключ окружения с адресом стенда приёмки. */
export const BASE_URL_ENV_KEY = 'BASE_URL';

/** Порт, на котором собранный сервер поднимается, если BASE_URL порта не содержит. */
export const DEFAULT_SERVER_PORT = 4321;

export interface AcceptanceTarget {
  /**
   * Схема + хост + порт без пути и без завершающего слеша. Ровно это значение
   * уходит и в `baseURL` Playwright, и в `SITE_URL` поднимаемого сервера.
   */
  readonly origin: string;
  /** Интерфейс, на котором слушает поднимаемый сервер. */
  readonly serverHost: string;
  /** Порт, на котором слушает поднимаемый сервер. */
  readonly serverPort: number;
  /**
   * `true` — приёмка идёт против уже поднятого сервера, конфиг его не запускает
   * и `SITE_URL` ему не задаёт. Ответственность за то, что это СОБРАННЫЙ сервер
   * (не `astro dev`) и что его `SITE_URL` совпадает с BASE_URL, переходит на
   * того, кто его поднял; вторую часть всё равно проверяет
   * `environment-hosts-match.spec.ts`.
   */
  readonly reuseExistingServer: boolean;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

const HOW_TO_RUN =
  'Запуск: BASE_URL=http://127.0.0.1:4321 pnpm test:seo\n' +
  '  BASE_URL — адрес стенда: схема + хост + порт, без пути и без параметров.';

function fail(message: string): never {
  throw new Error(`SEO-приёмка: ошибка конфигурации окружения.\n  ${message}\n  ${HOW_TO_RUN}`);
}

function readPort(env: EnvLike, url: URL): number {
  const override = (env['SEO_SERVER_PORT'] ?? '').trim();
  const raw = override !== '' ? override : url.port;
  if (raw === '') {
    return DEFAULT_SERVER_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`порт «${raw}» не является номером порта (1..65535).`);
  }
  return port;
}

/**
 * Разбирает и проверяет адрес стенда.
 *
 * @throws Error если `BASE_URL` не задан или задан в форме, при которой
 *   сравнение canonical перестало бы быть сравнением: другая схема, путь-база,
 *   параметры, учётные данные в URL.
 */
export function resolveAcceptanceTarget(env: EnvLike = process.env): AcceptanceTarget {
  const raw = (env[BASE_URL_ENV_KEY] ?? '').trim();
  if (raw === '') {
    fail(
      `${BASE_URL_ENV_KEY} не задан. Значения по умолчанию здесь нет намеренно: приёмка, ` +
        'молча ушедшая на другой адрес, проверяет не тот сайт.',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${BASE_URL_ENV_KEY}=«${raw}» не является абсолютным URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${BASE_URL_ENV_KEY}=«${raw}»: допустимы только схемы http и https.`);
  }
  if (url.username !== '' || url.password !== '') {
    fail(
      `${BASE_URL_ENV_KEY}=«${raw}» содержит логин или пароль. Basic Auth стенда (Ч-18) ` +
        'задаётся заголовком, а не внутри адреса: иначе он попал бы в сравнение origin.',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    fail(`${BASE_URL_ENV_KEY}=«${raw}» содержит параметры или фрагмент.`);
  }
  if (url.pathname !== '/') {
    fail(
      `${BASE_URL_ENV_KEY}=«${raw}» содержит путь «${url.pathname}». Сайт живёт в корне хоста ` +
        '(ровно один хост на весь сайт, «Правила URL»), а путь-база сдвинул бы все ожидаемые ' +
        'canonical и сравнение перестало бы быть сравнением.',
    );
  }

  return {
    origin: url.origin,
    serverHost: (env['SEO_SERVER_HOST'] ?? '').trim() || '127.0.0.1',
    serverPort: readPort(env, url),
    reuseExistingServer: (env['SEO_REUSE_SERVER'] ?? '') === '1',
  };
}

/**
 * Абсолютный URL для пути на стенде. Путь берётся как есть — в том числе
 * неканонический: именно неканоническими формами проверяется правило слеша.
 */
export function urlFor(target: AcceptanceTarget, pathWithQuery: string): string {
  return `${target.origin}${pathWithQuery}`;
}
