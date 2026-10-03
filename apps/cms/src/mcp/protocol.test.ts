import { describe, expect, it } from 'vitest';

import {
  HEADER_METHOD,
  HEADER_NAME,
  HEADER_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
  META_VERSION_KEY,
  MODERN_PROTOCOL_VERSION,
  type McpProtocolError,
  decodeHeaderValue,
  parseEnvelope,
} from './protocol';

function headers(entries: Readonly<Record<string, string>>): { get(name: string): string | null } {
  const bag = new Headers(entries);
  return { get: (name) => bag.get(name) };
}

function modernBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      _meta: { [META_VERSION_KEY]: MODERN_PROTOCOL_VERSION },
      arguments: {},
      name: 'card_get',
    },
    ...overrides,
  };
}

const MODERN_HEADERS = {
  [HEADER_METHOD]: 'tools/call',
  [HEADER_NAME]: 'card_get',
  [HEADER_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
};

function refusal(call: () => unknown): McpProtocolError {
  try {
    call();
  } catch (error) {
    return error as McpProtocolError;
  }
  return expect.unreachable('разбор обязан был отказать') as never;
}

describe('decodeHeaderValue', () => {
  it('декодирует sentinel-форму', () => {
    const encoded = `=?base64?${Buffer.from('открытка', 'utf8').toString('base64')}?=`;
    expect(decodeHeaderValue(encoded)).toBe('открытка');
  });

  it('обычное ASCII-значение оставляет как есть', () => {
    expect(decodeHeaderValue('card_get')).toBe('card_get');
  });
});

describe('parseEnvelope, modern-эра', () => {
  it('принимает запрос с совпадающими заголовками и телом', () => {
    const parsed = parseEnvelope({ body: modernBody(), headers: headers(MODERN_HEADERS) });
    expect(parsed.era).toBe('modern');
    expect(parsed.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(parsed.request.method).toBe('tools/call');
    expect(parsed.request.isNotification).toBe(false);
  });

  it('сравнивает Mcp-Name после декодирования sentinel-формы', () => {
    const name = 'инструмент';
    const body = modernBody({
      params: { _meta: { [META_VERSION_KEY]: MODERN_PROTOCOL_VERSION }, arguments: {}, name },
    });
    const encoded = `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`;
    const parsed = parseEnvelope({
      body,
      headers: headers({ ...MODERN_HEADERS, [HEADER_NAME]: encoded }),
    });
    expect(parsed.era).toBe('modern');
  });

  it('отвергает расхождение версии в заголовке и теле', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: modernBody(),
        headers: headers({ ...MODERN_HEADERS, [HEADER_PROTOCOL_VERSION]: '2025-06-18' }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
    expect(error.httpStatus).toBe(400);
  });

  it('отвергает отсутствие MCP-Protocol-Version при modern-теле', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: modernBody(),
        headers: headers({ [HEADER_METHOD]: 'tools/call', [HEADER_NAME]: 'card_get' }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });

  it('отвергает расхождение Mcp-Method с методом тела', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: modernBody(),
        headers: headers({ ...MODERN_HEADERS, [HEADER_METHOD]: 'tools/list' }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });

  it('отвергает расхождение Mcp-Name с params.name', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: modernBody(),
        headers: headers({ ...MODERN_HEADERS, [HEADER_NAME]: 'catalog_overview' }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });

  it('отвергает tools/call без Mcp-Name', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: modernBody(),
        headers: headers({
          [HEADER_METHOD]: 'tools/call',
          [HEADER_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
        }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });

  it('у метода без name заголовок Mcp-Name не требуется', () => {
    const body = {
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: { _meta: { [META_VERSION_KEY]: MODERN_PROTOCOL_VERSION } },
    };
    const parsed = parseEnvelope({
      body,
      headers: headers({
        [HEADER_METHOD]: 'tools/list',
        [HEADER_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
      }),
    });
    expect(parsed.era).toBe('modern');
  });

  it('отвергает неподдерживаемую версию, перечисляя свои', () => {
    const body = modernBody({
      params: {
        _meta: { [META_VERSION_KEY]: '1900-01-01' },
        arguments: {},
        name: 'card_get',
      },
    });
    const error = refusal(() =>
      parseEnvelope({
        body,
        headers: headers({ ...MODERN_HEADERS, [HEADER_PROTOCOL_VERSION]: '1900-01-01' }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.unsupportedVersion);
    expect(error.httpStatus).toBe(400);
    expect(error.data).toEqual({
      requested: '1900-01-01',
      supported: expect.arrayContaining([MODERN_PROTOCOL_VERSION]),
    });
  });

  it('отвергает заголовок modern-версии без метаданных в теле', () => {
    const error = refusal(() =>
      parseEnvelope({
        body: { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
        headers: headers({
          [HEADER_METHOD]: 'tools/list',
          [HEADER_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
        }),
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });
});

describe('parseEnvelope, legacy-эра', () => {
  it('initialize не требует заголовков', () => {
    const parsed = parseEnvelope({
      body: {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      headers: headers({}),
    });
    expect(parsed.era).toBe('legacy');
    expect(parsed.protocolVersion).toBe('2025-06-18');
  });

  it('initialize без версии получает предпочтительную поддерживаемую', () => {
    const parsed = parseEnvelope({
      body: { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} },
      headers: headers({}),
    });
    expect(parsed.protocolVersion).toBe(MODERN_PROTOCOL_VERSION);
  });

  it('legacy tools/call без Mcp-Name проходит', () => {
    const parsed = parseEnvelope({
      body: {
        id: 3,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: {}, name: 'card_get' },
      },
      headers: headers({ [HEADER_PROTOCOL_VERSION]: '2025-06-18' }),
    });
    expect(parsed.era).toBe('legacy');
    expect(parsed.protocolVersion).toBe('2025-06-18');
  });

  it('запрос без версии вовсе считается самой старой поддерживаемой', () => {
    const parsed = parseEnvelope({
      body: { id: 4, jsonrpc: '2.0', method: 'tools/list', params: {} },
      headers: headers({}),
    });
    expect(parsed.era).toBe('legacy');
    expect(parsed.protocolVersion).toBe('2025-03-26');
  });
});

describe('parseEnvelope, негодное тело', () => {
  it('не объект', () => {
    expect(refusal(() => parseEnvelope({ body: 'x', headers: headers({}) })).code).toBe(
      MCP_ERROR_CODES.parseError,
    );
  });

  it('массив сообщений не принимается', () => {
    expect(refusal(() => parseEnvelope({ body: [], headers: headers({}) })).code).toBe(
      MCP_ERROR_CODES.parseError,
    );
  });

  it('чужая версия jsonrpc', () => {
    expect(
      refusal(() =>
        parseEnvelope({ body: { id: 1, jsonrpc: '1.0', method: 'ping' }, headers: headers({}) }),
      ).code,
    ).toBe(MCP_ERROR_CODES.invalidRequest);
  });

  it('метод отсутствует', () => {
    expect(
      refusal(() => parseEnvelope({ body: { id: 1, jsonrpc: '2.0' }, headers: headers({}) })).code,
    ).toBe(MCP_ERROR_CODES.invalidRequest);
  });

  it('сообщение без id считается нотификацией', () => {
    const parsed = parseEnvelope({
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: headers({}),
    });
    expect(parsed.request.isNotification).toBe(true);
  });

  it('id: null тоже нотификация', () => {
    const parsed = parseEnvelope({
      body: { id: null, jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: headers({}),
    });
    expect(parsed.request.isNotification).toBe(true);
  });
});
