import type { PayloadRequest } from 'payload';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiKeyFingerprint } from '../http/api-rate-limit';
import {
  HEADER_METHOD,
  HEADER_NAME,
  HEADER_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
  META_VERSION_KEY,
  MODERN_PROTOCOL_VERSION,
} from './protocol';
import { mcpEndpoint, mcpMethodNotAllowedEndpoint, resetFailureStore } from './endpoint';

const SECRET = 'endpoint-test-secret';
const KEY = 'c0ffee00-0000-4000-8000-000000000002';
const KEY_INDEX = apiKeyFingerprint(KEY, SECRET);

interface Row {
  readonly [key: string]: unknown;
  readonly id: number;
}

interface Harness {
  readonly logs: string[];
  readonly req: PayloadRequest;
}

function harness(args: {
  readonly address?: string;
  readonly body?: unknown;
  readonly cards?: readonly Row[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: string;
  readonly users?: readonly Row[];
}): Harness {
  const logs: string[] = [];
  const cards = [...(args.cards ?? [])];
  const users = [
    ...(args.users ?? [
      { apiKeyIndex: KEY_INDEX, email: 'bot@test', enableAPIKey: true, id: 42, role: 'ai-editor' },
    ]),
  ];
  const headers = new Headers({
    'x-forwarded-for': args.address ?? '203.0.113.7',
    ...(args.headers ?? {}),
  });

  const find = (findArgs: Record<string, unknown>) => {
    if (findArgs.collection === 'users') {
      const where = findArgs.where as { apiKeyIndex?: { equals?: string } };
      const wanted = where.apiKeyIndex?.equals ?? '';
      return Promise.resolve({
        docs: users.filter((user) => user.apiKeyIndex === wanted),
        totalDocs: 1,
      });
    }
    if (findArgs.collection === 'cards') {
      return Promise.resolve({ docs: cards, totalDocs: cards.length });
    }
    return Promise.resolve({ docs: [], totalDocs: 0 });
  };

  const req = {
    headers,
    json: () => Promise.resolve(args.body),
    method: args.method ?? 'POST',
    payload: {
      create: (createArgs: Record<string, unknown>) =>
        Promise.resolve({ ...(createArgs.data as Record<string, unknown>), id: 1001 }),
      find,
      logger: {
        error: (message: string) => logs.push(`error ${message}`),
        info: (message: string) => logs.push(`info ${message}`),
        warn: (message: string) => logs.push(`warn ${message}`),
      },
      update: (updateArgs: Record<string, unknown>) =>
        Promise.resolve({ ...(updateArgs.data as Record<string, unknown>), id: updateArgs.id }),
    },
    user: null,
  } as unknown as PayloadRequest;

  return { logs, req };
}

async function call(h: Harness): Promise<Response> {
  return (await mcpEndpoint.handler(h.req));
}

function modernRequest(method: string, params: Record<string, unknown> = {}) {
  return {
    body: {
      id: 1,
      jsonrpc: '2.0',
      method,
      params: { ...params, _meta: { [META_VERSION_KEY]: MODERN_PROTOCOL_VERSION } },
    },
    headers: {
      authorization: `Bearer ${KEY}`,
      [HEADER_METHOD]: method,
      [HEADER_PROTOCOL_VERSION]: MODERN_PROTOCOL_VERSION,
      ...(typeof params.name === 'string' ? { [HEADER_NAME]: params.name } : {}),
    },
  };
}

beforeEach(() => {
  process.env.PAYLOAD_SECRET = SECRET;
  process.env.MCP_ENABLED = 'true';
  delete process.env.MCP_ALLOWED_ORIGINS;
  delete process.env.MCP_AUTH_FAILURE_LIMIT;
  resetFailureStore();
});

afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_AUTH_FAILURE_LIMIT;
  resetFailureStore();
});

describe('выключатель', () => {
  it('без MCP_ENABLED ручка отдаёт 404 и не подтверждает своё существование', async () => {
    process.env.MCP_ENABLED = 'false';
    const response = await call(harness(modernRequest('tools/list')));
    expect(response.status).toBe(404);
  });
});

describe('метод и Origin', () => {
  it('GET отдаёт 405 с заголовком Allow', async () => {
    const h = harness({ ...modernRequest('tools/list'), method: 'GET' });
    const response = (await mcpMethodNotAllowedEndpoint.handler(h.req));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('присланный Origin при пустом белом списке отвергается', async () => {
    const base = modernRequest('tools/list');
    const response = await call(
      harness({ ...base, headers: { ...base.headers, origin: 'https://evil.test' } }),
    );
    expect(response.status).toBe(403);
  });

  it('разрешённый Origin проходит', async () => {
    process.env.MCP_ALLOWED_ORIGINS = 'https://ok.test';
    const base = modernRequest('tools/list');
    const response = await call(
      harness({ ...base, headers: { ...base.headers, origin: 'https://ok.test' } }),
    );
    expect(response.status).toBe(200);
  });
});

describe('аутентификация', () => {
  it('без заголовка Authorization — 401 с WWW-Authenticate', async () => {
    const base = modernRequest('tools/list');
    const response = await call(
      harness({ body: base.body, headers: { ...base.headers, authorization: '' } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('тела 401 совпадают для «нет ключа», «неизвестный ключ» и «отозванный ключ»', async () => {
    const base = modernRequest('tools/list');

    const noKey = await call(
      harness({ body: base.body, headers: { ...base.headers, authorization: '' } }),
    );
    resetFailureStore();
    const unknownKey = await call(
      harness({ body: base.body, headers: { ...base.headers, authorization: 'Bearer nope' } }),
    );
    resetFailureStore();
    const revoked = await call(
      harness({
        ...base,
        users: [{ apiKeyIndex: KEY_INDEX, enableAPIKey: false, id: 42, role: 'ai-editor' }],
      }),
    );

    expect(noKey.status).toBe(401);
    expect(unknownKey.status).toBe(401);
    expect(revoked.status).toBe(401);
    const bodies = await Promise.all([noKey.text(), unknownKey.text(), revoked.text()]);
    expect(new Set(bodies).size).toBe(1);
  });

  it('перебор упирается в 429 с Retry-After', async () => {
    process.env.MCP_AUTH_FAILURE_LIMIT = '2';
    resetFailureStore();
    const base = modernRequest('tools/list');
    const attempt = async () =>
      call(harness({ body: base.body, headers: { ...base.headers, authorization: 'Bearer nope' } }));

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('предъявленный токен в журнал не попадает', async () => {
    const base = modernRequest('tools/list');
    const h = harness({
      body: base.body,
      headers: { ...base.headers, authorization: 'Bearer sekret-token-value' },
    });
    await call(h);
    expect(h.logs.join(' ')).not.toContain('sekret-token-value');
    expect(h.logs.join(' ')).toMatch(/Отказ аутентификации/);
  });

  it('адрес клиента в журнал не попадает', async () => {
    const base = modernRequest('tools/list');
    const h = harness({
      address: '198.51.100.9',
      body: base.body,
      headers: { ...base.headers, authorization: 'Bearer nope' },
    });
    await call(h);
    expect(h.logs.join(' ')).not.toContain('198.51.100.9');
  });
});

describe('методы протокола', () => {
  it('tools/list отдаёт все инструменты со схемами', async () => {
    const response = await call(harness(modernRequest('tools/list')));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { annotations: { readOnlyHint: boolean }; inputSchema: unknown; name: string }[] };
    };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain('catalog_overview');
    expect(names).toContain('create_card_draft');
    expect(names).toContain('send_to_review');
    const overview = body.result.tools.find((tool) => tool.name === 'catalog_overview');
    expect(overview?.annotations.readOnlyHint).toBe(true);
    expect(overview?.inputSchema).toMatchObject({ additionalProperties: false, type: 'object' });
  });

  it('ни один объявленный инструмент не умеет публиковать', async () => {
    const response = await call(harness(modernRequest('tools/list')));
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    for (const tool of body.result.tools) {
      expect(tool.name).not.toMatch(/publish|robots|redirect|canonical|sitemap/u);
    }
  });

  it('server/discover перечисляет поддерживаемые версии', async () => {
    const response = await call(harness(modernRequest('server/discover')));
    const body = (await response.json()) as { result: { protocolVersions: string[] } };
    expect(body.result.protocolVersions).toContain(MODERN_PROTOCOL_VERSION);
  });

  it('legacy initialize отвечает рукопожатием с инструкцией про границу', async () => {
    const h = harness({
      body: { id: 1, jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      headers: { authorization: `Bearer ${KEY}` },
    });
    const response = await call(h);
    const body = (await response.json()) as {
      result: { instructions: string; protocolVersion: string };
    };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.instructions).toMatch(/решение человека/);
  });

  it('нотификация подтверждается 202 без тела', async () => {
    const h = harness({
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { authorization: `Bearer ${KEY}` },
    });
    const response = await call(h);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('неизвестный метод — 404 и код -32601', async () => {
    const response = await call(harness(modernRequest('resources/read')));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(MCP_ERROR_CODES.methodNotFound);
  });

  it('расхождение заголовка и тела — 400 и код -32020', async () => {
    const base = modernRequest('tools/list');
    const response = await call(
      harness({ ...base, headers: { ...base.headers, [HEADER_METHOD]: 'tools/call' } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(MCP_ERROR_CODES.headerMismatch);
  });

  it('все ответы помечены noindex', async () => {
    const response = await call(harness(modernRequest('tools/list')));
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('tools/call', () => {
  it('неизвестный инструмент — 404 и код -32601', async () => {
    const response = await call(
      harness(modernRequest('tools/call', { arguments: {}, name: 'publish_card' })),
    );
    expect(response.status).toBe(404);
  });

  it('аргументы не по схеме отдаются ошибкой инструмента, а не сбоем транспорта', async () => {
    const response = await call(
      harness(
        modernRequest('tools/call', {
          arguments: { robots: 'index,follow', slug: 'a', title: 'A' },
          name: 'create_card_draft',
        }),
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/robots/);
  });

  it('успешный вызов читающего инструмента отдаёт структурированный результат', async () => {
    const response = await call(
      harness(modernRequest('tools/call', { arguments: {}, name: 'catalog_overview' })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError?: boolean; structuredContent: { nodes: unknown[] } };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.nodes).toEqual([]);
  });

  it('отказ хука передаётся наружу дословно как ошибка инструмента', async () => {
    const h = harness(
      modernRequest('tools/call', {
        arguments: { alt: 'Алт', slug: 'a', title: 'A' },
        name: 'create_card_draft',
      }),
    );
    const payload = h.req.payload as unknown as { create: unknown };
    payload.create = () =>
      Promise.reject(new Error('Сегмент «page» запрещён на любой позиции пути.'));

    const response = await call(h);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/Сегмент «page» запрещён/);
  });
});
