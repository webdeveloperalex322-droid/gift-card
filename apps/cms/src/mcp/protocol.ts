/**
 * Разбор конверта MCP: JSON-RPC плюс транспортные правила streamable HTTP.
 *
 * ПОЧЕМУ СВОЯ РЕАЛИЗАЦИЯ, А НЕ `@modelcontextprotocol/sdk`. Транспорт SDK
 * работает с Node-стримами (`IncomingMessage`/`ServerResponse`), а кастомная
 * ручка Payload получает веб-стандартный `Request` и обязана вернуть `Response`.
 * Между ними нужен был бы адаптер с поддельными объектами Node — ровно та
 * прослойка, которая ломается молча при обновлении любой из сторон. А нужная
 * часть протокола мала: ручка не отдаёт прогресс, не делает sampling и не держит
 * подписок, поэтому SSE не нужен вовсе — ревизия 2026-07-28 прямо разрешает
 * отвечать одним JSON-объектом. Цена выбора названа: следующие ревизии спеки
 * придётся отслеживать руками, и поэтому каждый код ошибки здесь покрыт тестом.
 *
 * ДВЕ ЭРЫ, И ОБЕ ОБЯЗАТЕЛЬНЫ.
 *
 *   - **modern** (2026-07-28): рукопожатия нет, каждый запрос несёт версию,
 *     сведения о клиенте и возможности в `_meta`, а транспорт дублирует часть
 *     полей в заголовки, чтобы посредники могли маршрутизировать без разбора
 *     тела. Тело при этом остаётся источником правды, и расхождение заголовка с
 *     телом обязано отвергаться — иначе балансировщик и сервер судили бы о
 *     запросе по разным данным. Это требование спеки, а не перестраховка;
 *   - **legacy** (2025-03-26 … 2025-11-25): рукопожатие `initialize`, заголовков
 *     не требуется. Поддерживается потому, что так ходят сегодняшние клиенты —
 *     Gemini/Antigravity CLI и Claude Code.
 *
 * Эра определяется формой запроса: метод `initialize` → legacy; версия в
 * `_meta` → modern. Так предписывает раздел спеки про двойную эру: сервер
 * выбирает поведение по тому, как клиент открывает разговор.
 */

/** Ревизия с per-request метаданными. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Версии, которые сервер обслуживает. Порядок значим: первая считается
 * предпочтительной и подставляется legacy-клиенту, не назвавшему версию.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const;

/** Ключи `_meta`, заданные спекой. */
export const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';

export const HEADER_PROTOCOL_VERSION = 'MCP-Protocol-Version';
export const HEADER_METHOD = 'Mcp-Method';
export const HEADER_NAME = 'Mcp-Name';

/**
 * Коды ошибок. `-32020` и `-32022` выделены спекой MCP из поддиапазона
 * протокольных ошибок, остальные — стандартный JSON-RPC.
 */
export const MCP_ERROR_CODES = {
  headerMismatch: -32_020,
  internalError: -32_603,
  invalidParams: -32_602,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  parseError: -32_700,
  unsupportedVersion: -32_022,
} as const;

export type McpEra = 'legacy' | 'modern';

export interface JsonRpcRequest {
  readonly id: number | string | null;
  readonly isNotification: boolean;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ParsedEnvelope {
  readonly era: McpEra;
  readonly protocolVersion: string;
  readonly request: JsonRpcRequest;
}

export interface HeaderBag {
  get(name: string): string | null;
}

export class McpProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly httpStatus: number;
  readonly id: number | string | null;

  constructor(args: {
    readonly code: number;
    readonly data?: unknown;
    readonly httpStatus: number;
    readonly id?: number | string | null;
    readonly message: string;
  }) {
    super(args.message);
    this.name = 'McpProtocolError';
    this.code = args.code;
    this.data = args.data ?? null;
    this.httpStatus = args.httpStatus;
    this.id = args.id ?? null;
  }
}

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/**
 * Декодирует значение заголовка из sentinel-формы `=?base64?…?=`.
 *
 * Нужно НЕ для экзотики: значения заголовков HTTP ограничены видимым ASCII, а
 * имена инструментов и подписи у нас русские. Клиент обязан закодировать такое
 * значение, а сервер — декодировать ПЕРЕД сравнением с телом. Без этого шага
 * законный запрос с не-ASCII именем отвергался бы как расхождение заголовка и
 * тела — то есть защита срабатывала бы на том, кого защищает.
 */
export function decodeHeaderValue(value: string): string {
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return value;
  }
  const encoded = value.slice(
    BASE64_SENTINEL_PREFIX.length,
    value.length - BASE64_SENTINEL_SUFFIX.length,
  );
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function headerMismatch(message: string, id: number | string | null): McpProtocolError {
  return new McpProtocolError({
    code: MCP_ERROR_CODES.headerMismatch,
    httpStatus: 400,
    id,
    message,
  });
}

function readMeta(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const meta = params._meta;
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    return meta as Readonly<Record<string, unknown>>;
  }
  return {};
}

function assertSupportedVersion(version: string, id: number | string | null): void {
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return;
  }
  throw new McpProtocolError({
    code: MCP_ERROR_CODES.unsupportedVersion,
    data: { requested: version, supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
    httpStatus: 400,
    id,
    message:
      `Версия протокола «${version}» не поддерживается. Поддерживаются: ` +
      `${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
  });
}

/**
 * Проверка заголовков modern-эры. Каждое из условий — требование спеки, и каждое
 * даёт `-32020`: отсутствующий обязательный заголовок и заголовок, не совпавший с
 * телом, спека относит к одному и тому же отказу.
 */
function assertModernHeaders(args: {
  readonly headers: HeaderBag;
  readonly id: number | string | null;
  readonly metaVersion: string;
  readonly request: JsonRpcRequest;
}): void {
  const { headers, id, metaVersion, request } = args;

  const headerVersion = headers.get(HEADER_PROTOCOL_VERSION);
  if (headerVersion === null || headerVersion.trim() === '') {
    throw headerMismatch(
      `Запрос без обязательного заголовка ${HEADER_PROTOCOL_VERSION}. Версия в теле — ` +
        `«${metaVersion}»; тело остаётся источником правды, но заголовок обязателен, чтобы ` +
        'посредники могли судить о запросе, не разбирая его.',
      id,
    );
  }
  if (headerVersion.trim() !== metaVersion) {
    throw headerMismatch(
      `Заголовок ${HEADER_PROTOCOL_VERSION} («${headerVersion.trim()}») не совпадает с ` +
        `${META_VERSION_KEY} в теле («${metaVersion}»).`,
      id,
    );
  }

  const headerMethod = headers.get(HEADER_METHOD);
  if (headerMethod === null || headerMethod.trim() === '') {
    throw headerMismatch(`Запрос без обязательного заголовка ${HEADER_METHOD}.`, id);
  }
  if (headerMethod.trim() !== request.method) {
    throw headerMismatch(
      `Заголовок ${HEADER_METHOD} («${headerMethod.trim()}») не совпадает с методом в теле ` +
        `(«${request.method}»).`,
      id,
    );
  }

  // `Mcp-Name` обязателен только у методов, у которых спека называет источник
  // значения: tools/call, resources/read, prompts/get. Из них реализован первый.
  if (request.method !== 'tools/call') {
    return;
  }
  const bodyName = typeof request.params.name === 'string' ? request.params.name : '';
  const headerNameRaw = headers.get(HEADER_NAME);
  if (headerNameRaw === null || headerNameRaw.trim() === '') {
    throw headerMismatch(
      `Запрос tools/call без обязательного заголовка ${HEADER_NAME}.`,
      id,
    );
  }
  const headerName = decodeHeaderValue(headerNameRaw.trim());
  if (headerName !== bodyName) {
    throw headerMismatch(
      `Заголовок ${HEADER_NAME} («${headerName}») не совпадает с params.name в теле ` +
        `(«${bodyName}»).`,
      id,
    );
  }
}

/**
 * Разбирает тело и заголовки в конверт.
 *
 * @throws McpProtocolError с кодом и HTTP-статусом, которые требует спека.
 */
export function parseEnvelope(args: {
  readonly body: unknown;
  readonly headers: HeaderBag;
}): ParsedEnvelope {
  const { body, headers } = args;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new McpProtocolError({
      code: MCP_ERROR_CODES.parseError,
      httpStatus: 400,
      message:
        'Тело запроса должно быть одним объектом JSON-RPC. Пакетные массивы этой ручкой не ' +
        'принимаются: каждое сообщение MCP едет своим POST-запросом.',
    });
  }

  const envelope = body as Readonly<Record<string, unknown>>;
  const rawId = envelope.id;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

  if (envelope.jsonrpc !== '2.0') {
    throw new McpProtocolError({
      code: MCP_ERROR_CODES.invalidRequest,
      httpStatus: 400,
      id,
      message: `Поле jsonrpc должно быть «2.0», получено: ${JSON.stringify(envelope.jsonrpc)}.`,
    });
  }

  if (typeof envelope.method !== 'string' || envelope.method === '') {
    throw new McpProtocolError({
      code: MCP_ERROR_CODES.invalidRequest,
      httpStatus: 400,
      id,
      message: 'Поле method обязательно и должно быть непустой строкой.',
    });
  }

  const params =
    typeof envelope.params === 'object' && envelope.params !== null && !Array.isArray(envelope.params)
      ? (envelope.params as Readonly<Record<string, unknown>>)
      : {};

  const request: JsonRpcRequest = {
    id,
    // Нотификация — сообщение БЕЗ `id`. `id: null` спека JSON-RPC тоже относит к
    // сообщениям без ответа, поэтому оба случая считаются нотификацией.
    isNotification: id === null,
    method: envelope.method,
    params,
  };

  // Legacy-эра: рукопожатие. Заголовков не требуется, версия берётся из params.
  if (request.method === 'initialize') {
    const requested = params.protocolVersion;
    const version =
      typeof requested === 'string' && requested !== ''
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    assertSupportedVersion(version, id);
    return { era: 'legacy', protocolVersion: version, request };
  }

  const meta = readMeta(params);
  const metaVersion = meta[META_VERSION_KEY];

  if (typeof metaVersion === 'string' && metaVersion !== '') {
    assertSupportedVersion(metaVersion, id);
    assertModernHeaders({ headers, id, metaVersion, request });
    return { era: 'modern', protocolVersion: metaVersion, request };
  }

  // Версии в `_meta` нет. Это либо legacy-клиент после рукопожатия, либо
  // modern-клиент, забывший метаданные. Различаем по заголовку: спека разрешает
  // серверу, поддерживающему клиентов старше 2025-06-18, считать запрос без
  // заголовка версией 2025-03-26 — чем мы и пользуемся, потому что legacy-эру
  // обслуживаем намеренно.
  const headerVersion = headers.get(HEADER_PROTOCOL_VERSION);
  if (headerVersion !== null && headerVersion.trim() !== '') {
    const version = headerVersion.trim();
    assertSupportedVersion(version, id);
    if (version === MODERN_PROTOCOL_VERSION) {
      throw headerMismatch(
        `Заголовок ${HEADER_PROTOCOL_VERSION} объявляет «${version}», но в теле нет ` +
          `${META_VERSION_KEY}. В этой ревизии метаданные обязаны ехать в теле: заголовок — ` +
          'лишь его отражение для посредников.',
        id,
      );
    }
    return { era: 'legacy', protocolVersion: version, request };
  }

  return { era: 'legacy', protocolVersion: '2025-03-26', request };
}

export function jsonRpcResult(
  id: number | string | null,
  result: unknown,
): Record<string, unknown> {
  return { id, jsonrpc: '2.0', result };
}

export function jsonRpcError(error: McpProtocolError): Record<string, unknown> {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === null ? {} : { data: error.data }),
    },
    id: error.id,
    jsonrpc: '2.0',
  };
}
