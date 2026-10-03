/**
 * MCP-слой, доказанный ЖИВЫМ запросом (решение Ч-35).
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ НУЖЕН СВЕРХ ЮНИТ-ТЕСТОВ. В `apps/cms/src/mcp/**` около 150
 * юнит-тестов, и все они отвечают на вопрос «правильно ли записано правило».
 * Этот файл отвечает на другой: «применяется ли оно». Разница не теоретическая —
 * ровно так на этапе 5 коллекция `payload-jobs` осталась с дефолтными правами:
 * предикат был верен, его просто не спрашивали.
 *
 * ТРАНСПОРТ — НАСТОЯЩИЙ ФАЙЛ МАРШРУТА. Запросы идут через `restRaw`, то есть
 * через `apps/cms/src/app/(payload)/api/[...slug]/route.ts` — тот же модуль, что
 * обслуживает продакшн, вместе с обёрткой ограничения частоты. Ручка проверяется
 * не в изоляции, а там, где живёт.
 *
 * `actor: ANONYMOUS` во всех вызовах НАМЕРЕННО: харнесс добавляет
 * аутентифицированному актору заголовок `Authorization: users API-Key <ключ>`, и
 * он вытеснил бы наш `Bearer`. MCP предъявляет ключ именно схемой Bearer —
 * ровно потому, что Basic Auth на проде занимает тот же заголовок, а два
 * заголовка `Authorization` в одном запросе невозможны.
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ. Негативные сценарии устроены как в
 * `access-negative.test.ts`: читаем состояние ДО правами системы, пробуем через
 * MCP, читаем ПОСЛЕ и требуем, чтобы оно не изменилось. Плюс отдельно
 * доказывается, что операция вообще дошла до сервера, — иначе совпадение снимков
 * означало бы только опечатку в запросе.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PublishedFixture,
  createPublishedFixture,
  removePublishedFixture,
} from '../../apps/cms/src/testing/api-fixtures';
import {
  ANONYMOUS,
  type TestUser,
  createUserWithKey,
  getTestPayload,
  removeContent,
  removeUsers,
  restRaw,
  stamp,
} from '../../apps/cms/src/testing/api-harness';

const MODERN_VERSION = '2026-07-28';
const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';

const run = stamp();
let admin: TestUser;
let editor: TestUser;
let fixture: PublishedFixture;
let createdCardIds: number[] = [];
let previousEnabled: string | undefined;

interface McpResponse {
  readonly body: Record<string, unknown>;
  readonly raw: Response;
  readonly status: number;
}

/** Вызов MCP настоящим маршрутом. Заголовки собираются по требованиям ревизии 2026-07-28. */
async function mcpCall(args: {
  readonly arguments?: Record<string, unknown>;
  readonly method: string;
  readonly token?: string | null;
  readonly tool?: string;
}): Promise<McpResponse> {
  const { method, token = editor.apiKey, tool } = args;
  const params: Record<string, unknown> = {
    _meta: { [META_VERSION_KEY]: MODERN_VERSION },
    ...(tool === undefined ? {} : { arguments: args.arguments ?? {}, name: tool }),
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': method,
    ...(tool === undefined ? {} : { 'Mcp-Name': tool }),
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  };

  const raw = await restRaw({
    actor: ANONYMOUS,
    body: { id: 1, jsonrpc: '2.0', method, params },
    headers,
    method: 'POST',
    segments: ['mcp'],
  });
  const text = await raw.clone().text();
  let body: Record<string, unknown> = {};
  try {
    body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { body, raw, status: raw.status };
}

/** Результат `tools/call`: инструмент сообщает об ошибке успешным JSON-RPC с `isError`. */
function toolResult(response: McpResponse): {
  readonly isError: boolean;
  readonly structured: Record<string, unknown>;
  readonly text: string;
} {
  const result = response.body.result as
    | { content?: { text?: string }[]; isError?: boolean; structuredContent?: unknown }
    | undefined;
  return {
    isError: result?.isError === true,
    structured: (result?.structuredContent ?? {}) as Record<string, unknown>,
    text: result?.content?.[0]?.text ?? '',
  };
}

/** Состояние записи правами СИСТЕМЫ, а не ключом проверяемой роли. */
async function stored(
  collection: 'cards' | 'collections',
  id: number | string,
): Promise<Record<string, unknown>> {
  const payload = await getTestPayload();
  const doc = await payload.findByID({ collection, id, overrideAccess: true });
  return doc as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  previousEnabled = process.env.MCP_ENABLED;
  // Ручка выключена по умолчанию, и набор включает её явно: именно это состояние
  // и проверяется, а заодно доказывается, что выключатель — не декорация.
  process.env.MCP_ENABLED = 'true';

  admin = await createUserWithKey({
    email: `mcp-admin-${run}@otkritka.test`,
    label: 'admin',
    role: 'admin',
  });
  editor = await createUserWithKey({
    email: `mcp-editor-${run}@otkritka.test`,
    label: 'ai-editor',
    role: 'ai-editor',
  });
  fixture = await createPublishedFixture({ adminId: admin.id, editorId: editor.id, run });
}, 180_000);

afterAll(async () => {
  if (previousEnabled === undefined) {
    delete process.env.MCP_ENABLED;
  } else {
    process.env.MCP_ENABLED = previousEnabled;
  }
  if (createdCardIds.length > 0) {
    await removeContent('cards', createdCardIds);
    createdCardIds = [];
  }
  if (fixture !== undefined) {
    await removePublishedFixture(fixture);
  }
  await removeUsers([admin.id, editor.id]);
});

describe('аутентификация живым запросом', () => {
  it('без токена — 401, и ответ не раскрывает причину', async () => {
    const response = await mcpCall({ method: 'tools/list', token: null });
    expect(response.status).toBe(401);
    expect(response.raw.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('неизвестный токен — 401', async () => {
    const response = await mcpCall({ method: 'tools/list', token: `${editor.apiKey}-forged` });
    expect(response.status).toBe(401);
  });

  it('действующий ключ ai-editor открывает список инструментов', async () => {
    const response = await mcpCall({ method: 'tools/list' });
    expect(response.status).toBe(200);
    const result = response.body.result as { tools: { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toContain('create_card_draft');
  });

  it('отозванный ключ перестаёт работать, хотя отпечаток в базе остаётся', async () => {
    const payload = await getTestPayload();
    const victim = await createUserWithKey({
      email: `mcp-revoked-${run}@otkritka.test`,
      label: 'ai-editor',
      role: 'ai-editor',
    });

    const before = await mcpCall({ method: 'tools/list', token: victim.apiKey });
    expect(before.status).toBe(200);

    await payload.update({
      collection: 'users',
      data: { enableAPIKey: false },
      id: victim.id,
      overrideAccess: true,
    });

    const after = await mcpCall({ method: 'tools/list', token: victim.apiKey });
    expect(after.status).toBe(401);

    await removeUsers([victim.id]);
  });

  it('ключ администратора каналом не принимается (Ч-35f), доказано живым запросом', async () => {
    // admin.apiKey создаётся харнессом и проверяется ЗДЕСЬ, а не лежит
    // неиспользованным: иначе ветка «ключ с другой ролью» не была бы покрыта
    // вовсе, а именно она давала внешней модели права на опубликованные страницы.
    const response = await mcpCall({ method: 'tools/list', token: admin.apiKey });
    expect(response.status).toBe(401);
  });

  it('GET на ручку отдаёт 405', async () => {
    const raw = await restRaw({
      actor: ANONYMOUS,
      headers: { Authorization: `Bearer ${editor.apiKey}` },
      method: 'GET',
      segments: ['mcp'],
    });
    expect(raw.status).toBe(405);
  });
});

describe('запреты: чего MCP не может, доказано состоянием базы', () => {
  it('инструмента публикации не существует вовсе', async () => {
    const response = await mcpCall({
      arguments: { id: String(fixture.reviewCardId) },
      method: 'tools/call',
      tool: 'publish_card',
    });
    expect(response.status).toBe(404);
  });

  it('status в аргументах отвергается схемой, и статус записи не меняется', async () => {
    const before = await stored('cards', fixture.reviewCardId);

    const response = await mcpCall({
      arguments: { id: String(fixture.reviewCardId), status: 'published', title: 'Попытка' },
      method: 'tools/call',
      tool: 'update_card_text',
    });

    // Операция ДОШЛА до сервера и была разобрана — иначе совпадение снимков
    // ничего не значило бы.
    expect(response.status).toBe(200);
    const result = toolResult(response);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/status/);

    const after = await stored('cards', fixture.reviewCardId);
    expect(after.status).toBe(before.status);
    expect(after.title).toBe(before.title);
  });

  it('robots в аргументах отвергается схемой, директива не меняется', async () => {
    const before = await stored('collections', fixture.nodeId);

    const response = await mcpCall({
      arguments: { id: String(fixture.nodeId), robots: 'index,follow' },
      method: 'tools/call',
      tool: 'update_collection_text',
    });

    expect(response.status).toBe(200);
    expect(toolResult(response).isError).toBe(true);

    const after = await stored('collections', fixture.nodeId);
    expect(after.robots).toBe(before.robots);
  });

  it('send_to_review на опубликованной записи отказывает, статус остаётся published', async () => {
    const before = await stored('cards', fixture.cardId);
    expect(before.status).toBe('published');

    const response = await mcpCall({
      arguments: { id: String(fixture.cardId), kind: 'card' },
      method: 'tools/call',
      tool: 'send_to_review',
    });

    expect(response.status).toBe(200);
    expect(toolResult(response).text).toMatch(/только draft/);

    const after = await stored('cards', fixture.cardId);
    expect(after.status).toBe('published');
  });

  it('смена slug опубликованной карточки недоступна: поля нет в схеме инструмента', async () => {
    const before = await stored('cards', fixture.cardId);

    const response = await mcpCall({
      arguments: { id: String(fixture.cardId), slug: `${String(before.slug)}-novyy` },
      method: 'tools/call',
      tool: 'update_card_text',
    });

    expect(response.status).toBe(200);
    const after = await stored('cards', fixture.cardId);
    // slug в схеме update_card_text объявлен ТОЛЬКО как способ найти запись,
    // поэтому значение уходит в поиск, а не в данные: адрес остаётся прежним.
    expect(after.slug).toBe(before.slug);
  });

  it('замена изображения опубликованной карточки ролью ai-editor не проходит', async () => {
    const before = await stored('cards', fixture.cardId);

    const response = await mcpCall({
      arguments: { id: String(fixture.cardId), imageId: String(fixture.otherImageId) },
      method: 'tools/call',
      tool: 'attach_image',
    });

    expect(response.status).toBe(200);
    const after = await stored('cards', fixture.cardId);
    expect(String(after.image)).toBe(String(before.image));
    // Молчаливый отказ на уровне поля обязан дойти до клиента ОШИБКОЙ: иначе
    // модель отрапортует человеку о замене, которой не было.
    expect(toolResult(response).isError).toBe(true);
  });

  it('инструментов для редиректов, sitemap и пользователей в реестре нет', async () => {
    const response = await mcpCall({ method: 'tools/list' });
    const result = response.body.result as { tools: { name: string }[] };
    for (const tool of result.tools) {
      expect(tool.name).not.toMatch(/redirect|sitemap|user|key|robots|canonical|publish/u);
    }
  });
});

describe('разрешённое: черновик создаётся и попадает в seo-history', () => {
  it('create_card_draft создаёт запись в draft с noindex', async () => {
    const slug = `mcp-live-${run}`;
    const response = await mcpCall({
      arguments: {
        alt: 'Тюльпаны в вазе на подоконнике',
        metaDescription: `Открытка маме на 8 марта, прогон ${run}`,
        slug,
        title: `Открытка маме, прогон ${run}`,
      },
      method: 'tools/call',
      tool: 'create_card_draft',
    });

    expect(response.status).toBe(200);
    const result = toolResult(response);
    expect(result.isError).toBe(false);

    const outcome = result.structured as { created: boolean; id: number; path: string };
    expect(outcome.created).toBe(true);
    expect(outcome.path).toBe(`/otkrytki/${slug}`);
    createdCardIds.push(outcome.id);

    const saved = await stored('cards', outcome.id);
    expect(saved.status).toBe('draft');
    // Новая запись закрыта от индексации — и это проверяется в базе, а не в ответе.
    expect(String(saved.robots)).toContain('noindex');
  });

  it('повторный вызов с тем же slug второй карточки не создаёт', async () => {
    const slug = `mcp-live-${run}`;
    const response = await mcpCall({
      arguments: {
        alt: 'Другой alt',
        slug,
        title: 'Другой заголовок',
      },
      method: 'tools/call',
      tool: 'create_card_draft',
    });

    const outcome = toolResult(response).structured as { created: boolean; id: number };
    expect(outcome.created).toBe(false);

    const payload = await getTestPayload();
    const { totalDocs } = await payload.count({
      collection: 'cards',
      overrideAccess: true,
      where: { slug: { equals: slug } },
    });
    expect(totalDocs).toBe(1);
  });

  it('автор правки в seo-history — владелец предъявленного ключа', async () => {
    const payload = await getTestPayload();
    const cardId = createdCardIds[0];
    expect(cardId).toBeDefined();

    const history = await payload.find({
      collection: 'seo-history',
      // depth: 0 — связь `changedBy` нужна идентификатором, а не развёрнутой
      // записью пользователя: сравнивается именно автор, а не его поля.
      depth: 0,
      limit: 10,
      overrideAccess: true,
      sort: '-changedAt',
      where: { documentId: { equals: String(cardId) } },
    });

    expect(history.docs.length).toBeGreaterThan(0);
    const entry = history.docs[0] as unknown as Record<string, unknown>;
    // Автор — владелец ключа, а не «система»: именно это делает каждый шаг агента
    // прослеживаемым (ТЗ §9, аудит).
    expect(String(entry.changedBy)).toBe(String(editor.id));
    expect(entry.authorRole).toBe('ai-editor');
    // Признак прихода по ключу отличает MCP от правки человеком в админке.
    expect(entry.viaApiKey).toBe(true);
  });
});

describe('check_duplicates живым запросом', () => {
  it('находит дубль заголовка опубликованной карточки по нормализованному ключу', async () => {
    // Юнит-тест этого доказать не может: поиск идёт по `titleKey`, а заполняет его
    // хук коллекции. Двойник шлюза заполнил бы поле сам и подтвердил бы то, чего в
    // базе могло не быть.
    const card = await stored('cards', fixture.cardId);
    const title = String(card.title);

    const response = await mcpCall({
      arguments: { title: `  ${title.toUpperCase()}  ` },
      method: 'tools/call',
      tool: 'check_duplicates',
    });

    const result = toolResult(response);
    expect(result.isError).toBe(false);
    const conflicts = (result.structured as { conflicts: { field: string; id: number }[] })
      .conflicts;
    expect(conflicts.map((conflict) => String(conflict.id))).toContain(String(fixture.cardId));
    expect(conflicts.every((conflict) => conflict.field === 'title')).toBe(true);
  });

  it('уникальный заголовок конфликтов не даёт', async () => {
    const response = await mcpCall({
      arguments: { title: `Заведомо уникальный заголовок ${run}` },
      method: 'tools/call',
      tool: 'check_duplicates',
    });
    const conflicts = (toolResult(response).structured as { conflicts: unknown[] }).conflicts;
    expect(conflicts).toEqual([]);
  });
});

describe('протокол живым запросом', () => {
  it('расхождение заголовка и тела отвергается кодом -32020', async () => {
    const raw = await restRaw({
      actor: ANONYMOUS,
      body: {
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: { [META_VERSION_KEY]: MODERN_VERSION } },
      },
      headers: {
        Authorization: `Bearer ${editor.apiKey}`,
        'MCP-Protocol-Version': MODERN_VERSION,
        // Заголовок врёт про метод: именно это и должно быть отвергнуто.
        'Mcp-Method': 'tools/call',
      },
      method: 'POST',
      segments: ['mcp'],
    });

    expect(raw.status).toBe(400);
    const body = (await raw.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32_020);
  });

  it('legacy-рукопожатие initialize работает без заголовков ревизии', async () => {
    const raw = await restRaw({
      actor: ANONYMOUS,
      body: {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      headers: { Authorization: `Bearer ${editor.apiKey}` },
      method: 'POST',
      segments: ['mcp'],
    });

    expect(raw.status).toBe(200);
    const body = (await raw.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('ответы ручки закрыты от индексации', async () => {
    const response = await mcpCall({ method: 'tools/list' });
    expect(response.raw.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('выключатель', () => {
  it('при MCP_ENABLED=false ручка отдаёт 404', async () => {
    process.env.MCP_ENABLED = 'false';
    try {
      const response = await mcpCall({ method: 'tools/list' });
      expect(response.status).toBe(404);
    } finally {
      process.env.MCP_ENABLED = 'true';
    }
  });
});
