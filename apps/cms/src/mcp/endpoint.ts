/**
 * Ручка MCP: `POST /api/mcp` (задача Ч-35, спека
 * `docs/superpowers/specs/2026-10-03-mcp-vneshniy-redaktor-design.md`).
 *
 * ═══ ПОЧЕМУ КАСТОМНЫЙ ENDPOINT PAYLOAD, А НЕ СВОЙ МАРШРУТ NEXT ═══
 *
 * Ручка под `/api` обслуживается тем же файлом `api/[...slug]/route.ts`, который
 * уже обёрнут `withApiRateLimit`, то есть новой точки входа в приложение не
 * появляется. Отдельный маршрут Next означал бы второй вход, который пришлось бы
 * оборачивать отдельно — и о котором пришлось бы помнить при каждой правке
 * лимитера.
 *
 * ОДНАКО «бесплатно» это ограничение не досталось, и первая версия этой шапки
 * утверждала обратное — неверно. Лимитер Ч-14 распознавал ключ ТОЛЬКО в форме
 * Payload (`users API-Key …`), а MCP предъявляет `Bearer`, потому что на проде
 * Basic Auth занимает тот же заголовок. Пока это расхождение не было закрыто,
 * успешные вызовы MCP не попадали ни в один бакет — на единственном входе, с
 * которого снят Basic Auth. Закрыто в `http/api-rate-limit.ts`: схема `Bearer`
 * распознаётся как предъявление ключа, отпечаток считается от значения, поэтому
 * MCP и прямой REST с одним ключом делят ОДИН бакет и сменой схемы квота не
 * удваивается.
 *
 * ═══ ПОРЯДОК ПРОВЕРОК ЗАФИКСИРОВАН ═══
 *
 * Сначала дешёвое, потом обращения к базе. Иначе ручка сама становится рычагом:
 * один запрос без токена стоил бы запроса к Postgres. Тот же довод, по которому
 * лимитер Ч-14 считает отпечаток предъявленного ключа, не спрашивая базу.
 *
 *   1. выключатель `MCP_ENABLED` → `404`. Именно `404`, а не `403`: выключенная
 *      ручка не должна подтверждать своё существование;
 *   2. метод не POST → `405`. GET и DELETE в ревизии 2026-07-28 не используются;
 *   3. нет `Authorization: Bearer` → `401`;
 *   4. бакет неудачных попыток для адреса исчерпан → `429` + `Retry-After`.
 *      Проверка НЕразрушающая: успешная аутентификация токен попыток не тратит;
 *   5. поиск владельца ключа (единственный запрос к базе до разбора тела);
 *   6. `Origin` присутствует и не в белом списке → `403` (DNS rebinding). ПОСЛЕ
 *      аутентификации: анонимный `403` подтверждал бы существование адреса;
 *   7. разбор конверта, вызов инструмента.
 *
 * ═══ ОТВЕТ 401 ОДИНАКОВ ВСЕГДА ═══
 *
 * «Нет ключа», «ключ неизвестен», «ключ отозван» отдают байт в байт одно и то же
 * тело. Различимые ответы — это оракул: по ним перебор отличает «такого ключа
 * нет» от «ключ есть, но выключен». В журнал при этом пишется отпечаток, а не
 * значение.
 */
import type { Endpoint, PayloadRequest } from 'payload';

import { requireEnv } from '../env.mjs';
import { createRateLimitStore } from '../http/token-bucket';
import { type McpConfig, isOriginAllowed, resolveMcpConfig } from './config';
import { findActorByApiKey, logFingerprint, readBearerToken } from './actor-lookup';
import { createGateway } from './gateway';
import {
  MCP_ERROR_CODES,
  McpProtocolError,
  jsonRpcError,
  jsonRpcResult,
  parseEnvelope,
} from './protocol';
import { discoverResult, findTool, initializeResult, listToolsResult } from './registry';
import { InvalidArgumentsError, parseArguments } from './schema';
import { ToolRefusal } from './tools/types';

/** Путь ручки. Полный адрес — `/api` + это значение. */
export const MCP_PATH = '/mcp';

/** Тело отказа аутентификации. Одно на все причины — см. шапку. */
const UNAUTHORIZED_BODY = {
  error: {
    code: MCP_ERROR_CODES.invalidRequest,
    message:
      'Требуется действующий API-ключ в заголовке Authorization: Bearer <ключ>. Ключ выпускается ' +
      'и отзывается администратором в админке.',
  },
  id: null,
  jsonrpc: '2.0',
} as const;

/**
 * Бакеты неудачных попыток — по IP.
 *
 * Отдельно от лимитера Ч-14 и потому, что тот считает только запросы С ключом:
 * неудачная попытка ключа не несёт, и перебор он не видит вовсе. Хранилище
 * ограничено по размеру, как и там: поток разных адресов иначе превратил бы карту
 * бакетов в канал исчерпания памяти.
 */
let failureStore: ReturnType<typeof createRateLimitStore> | null = null;

function activeFailureStore(config: McpConfig): ReturnType<typeof createRateLimitStore> {
  failureStore ??= createRateLimitStore({
    maxKeys: config.failureMaxKeys,
    settings: {
      capacity: config.failureLimit,
      refillTokens: config.failureLimit,
      refillWindowMs: config.failureWindowSeconds * 1000,
    },
  });
  return failureStore;
}

/** Только для тестов: сбросить счётчики попыток между сценариями. */
export function resetFailureStore(): void {
  failureStore = null;
}

/**
 * Адрес клиента для бакета неудачных попыток.
 *
 * ПОРЯДОК ИСТОЧНИКОВ ЗДЕСЬ — ЗАЩИТА, А НЕ ВКУС. Сначала стояло обратное: брался
 * ПЕРВЫЙ элемент `X-Forwarded-For` «потому что остальные дописывают прокси». Под
 * нашим прокси это неверно и ровно наоборот: `deploy/nginx/otkritka-proxy.conf`
 * использует `$proxy_add_x_forwarded_for`, то есть СОХРАНЯЕТ присланное клиентом
 * значение и дописывает настоящий адрес В КОНЕЦ. Клиент, подставляя свой
 * `X-Forwarded-For` на каждом запросе, выбирал себе новый бакет — и перебирал
 * токены без всякого предела. Защита существовала, но управлял ею атакующий.
 *
 * Поэтому: сначала `X-Real-IP`, который снипет ставит из `$remote_addr` и который
 * клиент подделать не может (nginx перезаписывает присланное значение); если его
 * нет — ПОСЛЕДНИЙ элемент `X-Forwarded-For`, то есть тот, который дописал наш
 * прокси. Непонятно откуда пришедший запрос попадает в общий бакет `unknown`:
 * «адрес неизвестен» не должно означать «предела нет».
 */
function clientAddress(req: PayloadRequest): string {
  const realIp = req.headers.get('x-real-ip')?.trim() ?? '';
  if (realIp !== '') {
    return realIp;
  }
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const last = parts.at(-1);
    if (last !== undefined) {
      return last;
    }
  }
  return 'unknown';
}

function jsonResponse(
  body: unknown,
  status: number,
  // Пары «имя: значение», а не `HeadersInit`: типы DOM в проверке типов apps/cms
  // не подключены, и ссылка на них разошлась бы между `tsc` и рантаймом.
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  // Ручка в индексе не нужна никому — тот же приём, что у выгрузки инвентаря.
  headers.set('X-Robots-Tag', 'noindex');
  return new Response(JSON.stringify(body), { headers, status });
}

function toolErrorResult(id: number | string | null, message: string): Record<string, unknown> {
  // Ошибка ИНСТРУМЕНТА, а не протокола: по спеке MCP она едет успешным
  // JSON-RPC-результатом с `isError: true`, чтобы модель могла её прочитать и
  // исправиться, а не получить транспортный сбой.
  return jsonRpcResult(id, {
    content: [{ text: message, type: 'text' }],
    isError: true,
  });
}

async function callTool(args: {
  readonly id: number | string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly req: PayloadRequest;
}): Promise<Record<string, unknown>> {
  const { id, params, req } = args;
  const tool = findTool(params.name);
  if (tool === null) {
    throw new McpProtocolError({
      code: MCP_ERROR_CODES.methodNotFound,
      httpStatus: 404,
      id,
      message: `Инструмент «${String(params.name)}» не существует.`,
    });
  }

  const user = req.user as { id?: number | string; role?: string | null } | null;
  if (user === null || user.id === undefined) {
    throw new McpProtocolError({
      code: MCP_ERROR_CODES.internalError,
      httpStatus: 500,
      id,
      message: 'Актор не установлен: вызов инструмента без аутентификации невозможен.',
    });
  }

  const gateway = createGateway({
    actor: { id: user.id, role: typeof user.role === 'string' ? user.role : '' },
    req,
  });

  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = parseArguments(tool.schema, params.arguments);
  } catch (error) {
    if (error instanceof InvalidArgumentsError) {
      return toolErrorResult(id, error.message);
    }
    throw error;
  }

  try {
    const result = await tool.run({ gateway }, parsed);
    const payload = result as { ignored?: readonly unknown[] };
    // Непустой `ignored` — ОШИБКА, а не успех с оговоркой: у Payload отказ на
    // уровне поля молчаливый, и модель, получив «успех», отрапортует человеку о
    // сделанном, чего не произошло.
    if (Array.isArray(payload.ignored) && payload.ignored.length > 0) {
      return jsonRpcResult(id, {
        content: [
          {
            text:
              'Часть запрошенных полей НЕ применилась — почти всегда это запрет прав на ' +
              `уровне поля: ${JSON.stringify(payload.ignored)}`,
            type: 'text',
          },
        ],
        isError: true,
        structuredContent: result,
      });
    }
    return jsonRpcResult(id, {
      content: [{ text: JSON.stringify(result), type: 'text' }],
      structuredContent: result,
    });
  } catch (error) {
    if (error instanceof ToolRefusal) {
      return toolErrorResult(id, error.message);
    }
    // Отказ хука Payload передаётся наружу ДОСЛОВНО: его текст написан для
    // человека и объясняет причину — именно он нужен модели, чтобы исправиться.
    const message = error instanceof Error ? error.message : String(error);
    req.payload.logger.warn(`[mcp] Инструмент ${tool.name} отказал: ${message}`);
    return toolErrorResult(id, message);
  }
}

async function handle(req: PayloadRequest): Promise<Response> {
  const config = resolveMcpConfig();

  if (!config.enabled) {
    // Выключенная ручка не подтверждает своё существование.
    return jsonResponse({ errors: [{ message: 'Not Found' }] }, 404);
  }

  if ((req.method ?? '').toUpperCase() !== 'POST') {
    return jsonResponse(
      {
        errors: [
          {
            message:
              'MCP-ручка принимает только POST. Отдельного GET-потока и DELETE в ревизии ' +
              '2026-07-28 нет: каждое сообщение едет своим POST-запросом.',
          },
        ],
      },
      405,
      { Allow: 'POST' },
    );
  }

  const secret = requireEnv('PAYLOAD_SECRET');
  const presentedKey = readBearerToken(req.headers.get('authorization'));
  const address = clientAddress(req);
  const store = activeFailureStore(config);

  const spendFailure = (): Response => {
    const decision = store.consume(logFingerprint(address, secret), Date.now());
    if (!decision.allowed) {
      return jsonResponse(
        {
          errors: [
            {
              message:
                'Слишком много неудачных попыток аутентификации. Повторите позже: предел на ' +
                'адрес существует отдельно от ограничения частоты на ключ, потому что ' +
                'неудачная попытка ключа не несёт и тем лимитом не считается.',
            },
          ],
        },
        429,
        { 'Retry-After': String(decision.retryAfterSeconds) },
      );
    }
    return jsonResponse(UNAUTHORIZED_BODY, 401, { 'WWW-Authenticate': 'Bearer' });
  };

  if (presentedKey === null) {
    return spendFailure();
  }

  // ПРЕДЕЛ СПРАШИВАЕТСЯ ДО ЗАПРОСА К БАЗЕ, и это не оптимизация.
  //
  // Сначала порядок был обратный: владелец ключа искался, а бакет тратился только
  // внутри `spendFailure`. Значит перебор поддельных токенов стоил запроса к
  // Postgres на КАЖДУЮ попытку — ровно то, от чего предел и поставлен, и на входе,
  // с которого снят Basic Auth. Находка ревью 2026-10-03.
  //
  // Проверка неразрушающая (`hasCapacity`): успешная аутентификация токен попыток
  // не расходует, иначе честный клиент с десятком вызовов в минуту упирался бы в
  // предел, поставленный против перебора.
  if (!store.hasCapacity(logFingerprint(address, secret), Date.now())) {
    return spendFailure();
  }

  const lookup = await findActorByApiKey({ presentedKey, req, secret });
  if (lookup.outcome !== 'ok') {
    req.payload.logger.warn(
      `[mcp] Отказ аутентификации (${lookup.outcome}) для отпечатка ключа ` +
        `${logFingerprint(presentedKey, secret)} с адреса ${logFingerprint(address, secret)}. ` +
        'Ни ключ, ни адрес в журнал не пишутся.',
    );
    return spendFailure();
  }

  // ORIGIN ПРОВЕРЯЕТСЯ ПОСЛЕ АУТЕНТИФИКАЦИИ, И ЭТО ИСПРАВЛЕНИЕ.
  //
  // Сначала проверка стояла первой, до токена. Тогда анонимный запрос с любым
  // `Origin` получал отличимый `403` — то есть подтверждал существование адреса
  // ровно тому, от кого его скрывает выключатель. Теперь до этой точки доходит
  // только предъявивший действующий ключ, и `403` ему уже ничего не раскрывает.
  // Находка ревью 2026-10-03.
  //
  // Защита от DNS rebinding этим не ослаблена: браузерная страница чужого сайта
  // ключа не имеет и получает тот же `401`, что любой аноним.
  const origin = req.headers.get('origin');
  if (!isOriginAllowed(origin, config.allowedOrigins)) {
    return jsonResponse(
      {
        errors: [
          {
            message:
              `Origin «${String(origin)}» не разрешён. Список задаётся MCP_ALLOWED_ORIGINS; ` +
              'пустой список означает, что браузерные клиенты не допускаются вовсе.',
          },
        ],
      },
      403,
    );
  }

  // Актор установлен: дальше все обращения к данным идут его правами через шлюз.
  // Приведение одно и названо: роль пришла из базы строкой, а сгенерированный
  // тип сужает её до объединения литералов. Проверять литерал здесь значило бы
  // держать второй список ролей — он уже есть в `access/roles.ts`, и сужение
  // всё равно делают предикаты прав, которым эта запись и достаётся.
  (req as { user: unknown }).user = {
    // `_strategy` обязателен, и это не формальность: по нему `seo-history`
    // отличает приход ПО КЛЮЧУ от правки человеком в админке
    // (`collections/seo-history-diff.ts`: `apiKey: user._strategy === 'api-key'`).
    // Без него каждая правка внешней LLM выглядела бы в аудите как сделанная
    // руками, и прослеживаемость шагов агента (ТЗ §9) держалась бы ни на чём.
    // Живой набор `tests/api/mcp-live.test.ts` проверяет этот признак отдельно.
    _strategy: 'api-key',
    collection: 'users',
    email: lookup.actor.email,
    id: lookup.actor.id,
    role: lookup.actor.role,
  };

  let body: unknown;
  try {
    body = await req.json?.();
  } catch {
    return jsonResponse(
      jsonRpcError(
        new McpProtocolError({
          code: MCP_ERROR_CODES.parseError,
          httpStatus: 400,
          message: 'Тело запроса не является корректным JSON.',
        }),
      ),
      400,
    );
  }

  let envelope;
  try {
    envelope = parseEnvelope({ body, headers: req.headers });
  } catch (error) {
    if (error instanceof McpProtocolError) {
      return jsonResponse(jsonRpcError(error), error.httpStatus);
    }
    throw error;
  }

  const { request } = envelope;

  // Нотификация: подтверждаем приём и ничего не отвечаем — требование транспорта.
  if (request.isNotification) {
    return new Response(null, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      status: 202,
    });
  }

  try {
    switch (request.method) {
      case 'initialize':
        return jsonResponse(
          jsonRpcResult(request.id, initializeResult(envelope.protocolVersion)),
          200,
        );
      case 'server/discover':
        return jsonResponse(jsonRpcResult(request.id, discoverResult()), 200);
      case 'ping':
        return jsonResponse(jsonRpcResult(request.id, {}), 200);
      case 'tools/list':
        return jsonResponse(jsonRpcResult(request.id, listToolsResult()), 200);
      case 'tools/call':
        return jsonResponse(
          await callTool({ id: request.id, params: request.params, req }),
          200,
        );
      default:
        throw new McpProtocolError({
          code: MCP_ERROR_CODES.methodNotFound,
          httpStatus: 404,
          id: request.id,
          message:
            `Метод «${request.method}» этим сервером не реализован. Доступны: initialize, ` +
            'server/discover, ping, tools/list, tools/call.',
        });
    }
  } catch (error) {
    if (error instanceof McpProtocolError) {
      return jsonResponse(jsonRpcError(error), error.httpStatus);
    }
    const message = error instanceof Error ? error.message : String(error);
    req.payload.logger.error(`[mcp] Необработанная ошибка: ${message}`);
    return jsonResponse(
      jsonRpcError(
        new McpProtocolError({
          code: MCP_ERROR_CODES.internalError,
          httpStatus: 500,
          id: request.id,
          message: 'Внутренняя ошибка сервера.',
        }),
      ),
      500,
    );
  }
}

export const mcpEndpoint: Endpoint = {
  handler: handle,
  method: 'post',
  path: MCP_PATH,
};

/**
 * Та же ручка на остальные методы — чтобы отвечать `405`, а не чужой ошибкой.
 *
 * Payload сопоставляет метод вместе с путём, поэтому без этих регистраций запрос
 * ушёл бы в общий обработчик коллекций и вернул бы отказ про неизвестную
 * коллекцию — ответ, по которому клиент не отличит «так нельзя» от «такого адреса
 * нет». Перечислены ВСЕ методы, которые Payload умеет маршрутизировать, а не один
 * GET: на входе, с которого снят Basic Auth, PATCH и DELETE уходили в общий
 * обработчик наравне с GET. Находка ревью 2026-10-03.
 */
export const mcpMethodNotAllowedEndpoints: readonly Endpoint[] = (
  ['delete', 'get', 'patch', 'put'] as const
).map((method) => ({ handler: handle, method, path: MCP_PATH }));
