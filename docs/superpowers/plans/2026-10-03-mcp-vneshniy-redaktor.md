# MCP-слой для внешнего AI-редактора — план реализации

> **Для агентов-исполнителей:** обязательная под-скилл — `superpowers:subagent-driven-development` или `superpowers:executing-plans`. Шаги помечены чекбоксами.

**Цель:** внешняя LLM создаёт и правит карточки и подборки на проде через MCP-ручку `/api/mcp`, не получая возможности публиковать и открывать в индекс.

**Архитектура:** кастомный Payload `Endpoint` в `apps/cms`; свой разбор JSON-RPC (дуальная эра MCP `2026-07-28` + legacy `initialize`); все обращения к данным — через единственный `gateway.ts` с жёстким `overrideAccess: false` и пользователем-владельцем предъявленного API-ключа.

**Стек:** TypeScript strict, Payload 3.88, Vitest. **Новых runtime-зависимостей не добавляется** — ни `@modelcontextprotocol/sdk`, ни `zod`.

**Спека:** `docs/superpowers/specs/2026-10-03-mcp-vneshniy-redaktor-design.md`

## Глобальные ограничения

- TypeScript strict, без `any`. Типы Payload — из `src/payload-types.ts`, вручную не дублировать.
- Ни один файл `src/mcp/**`, кроме `gateway.ts`, не вправе касаться `payload.*`, `req.payload`, `overrideAccess`. Покрыто тестом-стражем (задача 4).
- Ручка выключена по умолчанию: `MCP_ENABLED` без значения = `false`.
- Мусорное значение любой `MCP_*` переменной валит старт приложения, а не подменяется дефолтом молча.
- Публикация, `index/noindex`, `canonical`, slug после публикации, редиректы, sitemap, `updatedContentAt`, пользователи и ключи — вне набора инструментов и отдельно запрещены access control.
- Поддерживаемые версии протокола: `2026-07-28` (modern), `2025-11-25`, `2025-06-18`, `2025-03-26` (legacy).
- Коды ошибок: `-32020` HeaderMismatch, `-32022` UnsupportedProtocolVersion, `-32601` Method not found, `-32602` Invalid params, `-32700` Parse error.
- HTTP: POST только; GET/DELETE → `405`; чужой `Origin` → `403`; нет/битый токен → `401` + `WWW-Authenticate: Bearer`; перебор → `429` + `Retry-After`; нотификация → `202` без тела.
- `pnpm verify` зелёный после каждой задачи.

## Фокус ревью

Пять входов, которые спека подразумевает, но на которые легко не написать тест:

1. **`Mcp-Name` в sentinel-кодировке `=?base64?…?=`** — обязан декодироваться перед сравнением с телом, иначе валидный запрос клиента с не-ASCII именем отвергается как HeaderMismatch. Тест — задача 3.
2. **Ключ с `enableAPIKey: false`** — своя стратегия Payload флаг не смотрит; без явной проверки отозванный ключ продолжает работать через MCP. Тест — задачи 8 и 9.
3. **`externalKey` при гонке двух одинаковых вызовов** — уникальный индекс БД бросит ошибку записи; инструмент обязан вернуть существующую запись, а не `500`. Тест — задача 6.
4. **Молчаливый отказ Payload на уровне поля** — запрошенное поле вырезается, ответ `200`. Инструмент обязан увидеть расхождение и вернуть `isError`. Тест — задача 6.
5. **Запрос с `Origin` при пустом белом списке** — должен отвергаться, а не пропускаться «потому что список не настроен». Тест — задача 8.

---

### Задача 1: конфигурация и выключатель

**Файлы:**
- Создать: `apps/cms/src/mcp/config.ts`, `apps/cms/src/mcp/config.test.ts`
- Изменить: `apps/cms/src/payload.config.ts` (вызов проверки при старте), `.env.example`

**Интерфейсы — отдаёт:**
```ts
export const MCP_ENABLED_ENV_KEY = 'MCP_ENABLED';
export const MCP_ALLOWED_ORIGINS_ENV_KEY = 'MCP_ALLOWED_ORIGINS';
export const MCP_AUTH_FAILURE_LIMIT_ENV_KEY = 'MCP_AUTH_FAILURE_LIMIT';
export const MCP_AUTH_FAILURE_WINDOW_ENV_KEY = 'MCP_AUTH_FAILURE_WINDOW_SECONDS';
export const MCP_DEFAULTS: { readonly failureLimit: 10; readonly failureWindowSeconds: 60 };
export interface McpConfig {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly failureLimit: number;
  readonly failureWindowSeconds: number;
}
export function resolveMcpConfig(env?: SharedEnv): McpConfig;
export function isOriginAllowed(origin: string | null, allowed: readonly string[]): boolean;
```

- [ ] **Шаг 1: тест** — `config.test.ts`: пустой env → `enabled === false`; `MCP_ENABLED=true` → `true`; `MCP_ENABLED=1` → бросает (принимаются только `true`/`false`); `MCP_AUTH_FAILURE_LIMIT=0` → бросает; `=abc` → бросает; пустое → дефолт 10; `MCP_ALLOWED_ORIGINS='https://a.test, https://b.test'` → два элемента без пробелов; `isOriginAllowed(null, [])` → `true` (нет заголовка — не нарушение); `isOriginAllowed('https://evil.test', [])` → `false`.
- [ ] **Шаг 2:** `pnpm exec vitest run apps/cms/src/mcp/config.test.ts` — FAIL, модуля нет.
- [ ] **Шаг 3:** реализовать `config.ts`, повторяя стиль `readPositiveInt` из `src/http/api-rate-limit.ts` (текст ошибки называет переменную, полученное значение и утверждённое).
- [ ] **Шаг 4:** тест PASS.
- [ ] **Шаг 5:** в `payload.config.ts` рядом с `resolveApiRateLimit()` добавить `resolveMcpConfig()` с комментарием «мусор в MCP_* валит старт, а не проявляется на первом запросе внешнего клиента». В `.env.example` — четыре ключа с пустыми значениями и комментарием, что `MCP_ENABLED` по умолчанию выключен.
- [ ] **Шаг 6:** `pnpm --filter @otkritka/cms run check` + коммит.

---

### Задача 2: декларация схем аргументов

**Файлы:** создать `apps/cms/src/mcp/schema.ts`, `apps/cms/src/mcp/schema.test.ts`

Одна декларация — два потребителя: JSON Schema для `tools/list` и рантайм-валидатор для `tools/call`. Две записи одной истины дали бы инструмент, чья схема обещает одно, а проверка требует другого.

**Интерфейсы — отдаёт:**
```ts
export type FieldSpec =
  | { readonly kind: 'string'; readonly description: string; readonly required?: boolean;
      readonly maxLength?: number; readonly enum?: readonly string[] }
  | { readonly kind: 'integer'; readonly description: string; readonly required?: boolean;
      readonly min?: number; readonly max?: number }
  | { readonly kind: 'boolean'; readonly description: string; readonly required?: boolean }
  | { readonly kind: 'idList'; readonly description: string; readonly required?: boolean;
      readonly maxItems?: number };
export type ToolSchema = Readonly<Record<string, FieldSpec>>;
export function toJsonSchema(schema: ToolSchema): Record<string, unknown>;
export class InvalidArgumentsError extends Error { readonly details: readonly string[]; }
export function parseArguments<T extends ToolSchema>(
  schema: T, raw: unknown,
): Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>;
```

- [ ] **Шаг 1: тест.**
```ts
const SCHEMA = {
  title: { kind: 'string', description: 'Заголовок', required: true, maxLength: 10 },
  limit: { kind: 'integer', description: 'Сколько', min: 1, max: 50 },
  ids: { kind: 'idList', description: 'Идентификаторы', maxItems: 2 },
} as const satisfies ToolSchema;

it('выводит JSON Schema с required только из обязательных полей', () => {
  expect(toJsonSchema(SCHEMA)).toEqual({
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Заголовок', maxLength: 10 },
      limit: { type: 'integer', description: 'Сколько', minimum: 1, maximum: 50 },
      ids: { type: 'array', description: 'Идентификаторы', maxItems: 2,
             items: { type: ['string', 'integer'] } },
    },
    required: ['title'],
  });
});

it('отвергает отсутствие обязательного поля с указанием имени', () => {
  expect(() => parseArguments(SCHEMA, {})).toThrow(/title/);
});

it('отвергает лишнее поле, а не игнорирует его', () => {
  expect(() => parseArguments(SCHEMA, { title: 'a', robots: 'index,follow' }))
    .toThrow(/robots/);
});
```
Плюс: превышение `maxLength`; `limit` строкой `'5'` → отказ (не приводим типы молча); `limit` вне диапазона; `ids` не массив; `ids` длиннее `maxItems`; пустая строка в обязательном поле → отказ; `raw === null` → отказ.
- [ ] **Шаг 2:** FAIL.
- [ ] **Шаг 3:** реализовать. `additionalProperties: false` обязателен: лишнее поле в аргументах почти всегда означает, что модель пытается записать то, чего ей нельзя (`status`, `robots`), и молчаливое игнорирование скрыло бы попытку.
- [ ] **Шаг 4:** PASS. **Шаг 5:** коммит.

---

### Задача 3: протокол

**Файлы:** создать `apps/cms/src/mcp/protocol.ts`, `apps/cms/src/mcp/protocol.test.ts`

**Интерфейсы — отдаёт:**
```ts
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[];
export const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
export const MCP_ERROR_CODES: { readonly headerMismatch: -32020; readonly unsupportedVersion: -32022;
  readonly methodNotFound: -32601; readonly invalidParams: -32602; readonly parseError: -32700 };
export type McpEra = 'modern' | 'legacy';
export interface JsonRpcRequest {
  readonly id: string | number | null;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly isNotification: boolean;
}
export interface ParsedEnvelope {
  readonly request: JsonRpcRequest;
  readonly era: McpEra;
  readonly protocolVersion: string;
}
export class McpProtocolError extends Error {
  constructor(args: { code: number; message: string; httpStatus: number; data?: unknown; id?: string | number | null });
  readonly code: number; readonly httpStatus: number; readonly data: unknown;
  readonly id: string | number | null;
}
export function decodeHeaderValue(value: string): string;   // sentinel =?base64?…?=
export function parseEnvelope(args: {
  readonly body: unknown;
  readonly headers: { get(name: string): string | null };
}): ParsedEnvelope;
export function jsonRpcResult(id: string | number | null, result: unknown): Record<string, unknown>;
export function jsonRpcError(error: McpProtocolError): Record<string, unknown>;
```

- [ ] **Шаг 1: тест.** Полный перечень случаев:
```ts
it('декодирует Mcp-Name из sentinel-кодировки перед сравнением', () => {
  const name = '=?base64?' + Buffer.from('открытка', 'utf8').toString('base64') + '?=';
  expect(decodeHeaderValue(name)).toBe('открытка');
});

it('принимает modern-запрос с совпадающими заголовками и телом', () => {
  const parsed = parseEnvelope({
    headers: headers({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'card_get' }),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'card_get', arguments: {},
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
  });
  expect(parsed.era).toBe('modern');
  expect(parsed.request.method).toBe('tools/call');
});
```
Дальше, каждый — отдельным `it`: версия в заголовке не совпала с `_meta` → `-32020`, HTTP 400; нет `MCP-Protocol-Version` при modern-теле → `-32020`; `Mcp-Method` не совпал с `method` → `-32020`; `Mcp-Name` не совпал с `params.name` → `-32020`; `Mcp-Name` отсутствует при `tools/call` → `-32020`; версия `1900-01-01` → `-32022`, HTTP 400, `data.supported` содержит `2026-07-28`; тело `initialize` без заголовков → `era === 'legacy'`, заголовки не требуются; legacy `tools/call` без `Mcp-Name` → проходит (требование только у modern); тело не JSON-объект → `-32700`; `jsonrpc !== '2.0'` → `-32600`; отсутствие `id` → `isNotification === true`; `id: null` у запроса с методом → нотификация.
- [ ] **Шаг 2:** FAIL. **Шаг 3:** реализовать. **Шаг 4:** PASS. **Шаг 5:** коммит.

---

### Задача 4: шлюз и страж изоляции

**Файлы:** создать `apps/cms/src/mcp/gateway.ts`, `apps/cms/src/mcp/gateway.test.ts`, `apps/cms/src/mcp/gateway-isolation.test.ts`

**Интерфейсы — отдаёт:**
```ts
export interface McpActor { readonly id: number | string; readonly role: string; readonly email?: string }
export interface McpGateway {
  readonly actor: McpActor;
  findCards(args: { where?: Where; limit?: number; depth?: number }): Promise<{ docs: Card[]; totalDocs: number }>;
  findCollections(args: { where?: Where; limit?: number; depth?: number }): Promise<{ docs: Collection[]; totalDocs: number }>;
  findCardImages(args: { where?: Where; limit?: number }): Promise<{ docs: CardImage[]; totalDocs: number }>;
  createCard(data: Record<string, unknown>): Promise<Card>;
  updateCard(args: { id: number | string; data: Record<string, unknown> }): Promise<Card>;
  createCollection(data: Record<string, unknown>): Promise<Collection>;
  updateCollection(args: { id: number | string; data: Record<string, unknown> }): Promise<Collection>;
}
export function createGateway(args: { req: PayloadRequest; actor: McpActor }): McpGateway;
export const GATEWAY_LIMIT_CEILING = 200;
```

- [ ] **Шаг 1: тест `gateway.test.ts`** на поддельном `req` с рукописным `payload`-двойником: каждая из семи операций вызвана с `overrideAccess: false` и с `user`, равным актору; `limit` больше `GATEWAY_LIMIT_CEILING` урезается до потолка; `limit` не передан → подставляется потолок, а не `undefined` (иначе Payload отдаст свой дефолт и выборка окажется короче, чем думает инструмент).
- [ ] **Шаг 2: тест `gateway-isolation.test.ts`.**
```ts
const FORBIDDEN = [/\breq\.payload\b/, /\bpayload\./, /overrideAccess/];
it('только gateway.ts касается Payload', async () => {
  const files = await readdirDeep(resolve(import.meta.dirname));
  const offenders = files
    .filter((f) => f.endsWith('.ts') && !f.endsWith('gateway.ts') && !f.endsWith('gateway-isolation.test.ts'))
    .filter((f) => FORBIDDEN.some((re) => re.test(readFileSync(f, 'utf8'))));
  expect(offenders).toEqual([]);
});
```
- [ ] **Шаг 3:** FAIL (файлов нет). **Шаг 4:** реализовать `gateway.ts`: `overrideAccess: false` и `user` зашиты в каждый вызов, параметра для их переключения в сигнатурах нет. **Шаг 5:** оба теста PASS. **Шаг 6:** коммит.

---

### Задача 5: инструменты чтения

**Файлы:** создать `apps/cms/src/mcp/tools/read-tools.ts`, `apps/cms/src/mcp/tools/read-tools.test.ts`

**Интерфейсы — отдаёт:**
```ts
export interface ToolContext { readonly gateway: McpGateway }
export interface ToolDefinition {
  readonly name: string; readonly title: string; readonly description: string;
  readonly schema: ToolSchema; readonly readOnly: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}
export const READ_TOOLS: readonly ToolDefinition[];  // catalog_overview, collection_get, card_get, find_weak_content, check_duplicates
```

- [ ] **Шаг 1: тест** на подменённом шлюзе: `catalog_overview` считает опубликованные карточки узла и отдаёт `missingForIndex = max(0, порог − число)`, где порог берётся из `resolveMinPublishedCards`; у узла вида `group` счёт идёт по поддереву (`VOLUME_SCOPE`); при упоре в лимит в ответе `truncated: true`; `card_get` по несуществующему пути → ошибка с текстом, а не `null`; `find_weak_content` находит две карточки с одинаковым `metaDescription` и помечает их как конфликт; `check_duplicates` с `imageId` зовёт `findCards` по pHash-полям и отдаёт расстояния, не превышающие порог.
- [ ] **Шаг 2:** FAIL. **Шаг 3:** реализовать, переиспользуя `collection-volume.ts`, `meta-duplicates.ts`, `seo/paths.ts`. **Шаг 4:** PASS. **Шаг 5:** коммит.

---

### Задача 6: инструменты записи по карточкам

**Файлы:** создать `apps/cms/src/mcp/tools/card-tools.ts`, `apps/cms/src/mcp/tools/card-tools.test.ts`

**Интерфейсы — отдаёт:**
```ts
export interface WriteOutcome {
  readonly id: number | string; readonly path: string; readonly created: boolean;
  readonly applied: Readonly<Record<string, unknown>>;
  readonly ignored: readonly { readonly field: string; readonly requested: unknown;
                               readonly actual: unknown; readonly reason: string }[];
}
export class ToolRefusal extends Error { readonly field?: string }
export const CARD_TOOLS: readonly ToolDefinition[];
// create_card_draft, update_card_text, attach_card_to_collections,
// detach_card_from_collections, attach_image
export function diffApplied(args: {
  requested: Readonly<Record<string, unknown>>; saved: Readonly<Record<string, unknown>>;
}): WriteOutcome['ignored'];
```

- [ ] **Шаг 1: тест.** Критические случаи:
```ts
it('ловит молчаливо проигнорированное поле', () => {
  expect(diffApplied({ requested: { title: 'Новый' }, saved: { title: 'Старый' } }))
    .toEqual([{ field: 'title', requested: 'Новый', actual: 'Старый',
                reason: expect.stringContaining('не применилось') }]);
});

it('повторный вызов с тем же externalKey возвращает существующую карточку', async () => {
  const gateway = gatewayWithExistingCard({ sourceImportKey: 'mcp:abc', id: 7 });
  const out = await tool('create_card_draft').run({ gateway },
    { externalKey: 'abc', title: 'Открытка', alt: 'Описание' }) as WriteOutcome;
  expect(out).toMatchObject({ id: 7, created: false });
  expect(gateway.calls.createCard).toHaveLength(0);
});

it('переживает гонку: уникальный индекс бросил, запись найдена повторным чтением', async () => {
  const gateway = gatewayWhereCreateThrowsDuplicate({ id: 9 });
  const out = await tool('create_card_draft').run({ gateway },
    { externalKey: 'abc', title: 'Открытка', alt: 'Описание' }) as WriteOutcome;
  expect(out).toMatchObject({ id: 9, created: false });
});
```
Плюс: `create_card_draft` всегда посылает `status: 'draft'` и никогда `robots`/`status: 'published'`; попытка передать `status` в аргументах отвергается схемой (задача 2); `attach_card_to_collections` добавляет к существующим привязкам, а не заменяет их; `attach_image` у опубликованной карточки при роли `ai-editor` → `ToolRefusal` с указанием, что замена изображения опубликованной записи — право `admin`; непустой `ignored` поднимает `isError`.
- [ ] **Шаг 2:** FAIL. **Шаг 3:** реализовать. **Шаг 4:** PASS. **Шаг 5:** коммит.

---

### Задача 7: инструменты записи по подборкам и перевод в review

**Файлы:** создать `apps/cms/src/mcp/tools/collection-tools.ts`, `apps/cms/src/mcp/tools/collection-tools.test.ts`

**Интерфейсы — отдаёт:** `export const COLLECTION_TOOLS: readonly ToolDefinition[];` — `create_collection_draft`, `update_collection_text`, `send_to_review`.

- [ ] **Шаг 1: тест.** `create_collection_draft` с `nodeKind: 'group'` и заданным `parent` → `ToolRefusal` (группа живёт только в корне `/otkrytki`); `send_to_review` при незаполненном `metaDescription` → отказ, в тексте перечислены поля из `missingReviewFields`, запись осталась в `draft`; `send_to_review` на полной записи → `status: 'review'` и `robots` не тронут; попытка `send_to_review` для записи в `published` → отказ по `ALLOWED_STATUS_TRANSITIONS`; `update_collection_text` не посылает `slug`, даже если он пришёл в аргументах (схема его не объявляет — проверяется отказом).
- [ ] **Шаг 2:** FAIL. **Шаг 3:** реализовать через `status-model.ts`. **Шаг 4:** PASS. **Шаг 5:** коммит.

---

### Задача 8: ручка, аутентификация, реестр

**Файлы:**
- Создать: `apps/cms/src/mcp/registry.ts`, `apps/cms/src/mcp/auth.ts`, `apps/cms/src/mcp/endpoint.ts` и тесты к каждому
- Изменить: `apps/cms/src/payload.config.ts` (`endpoints: [seoInventoryEndpoint, mcpEndpoint]`)

**Интерфейсы — отдаёт:**
```ts
export const MCP_PATH = '/mcp';                       // полный адрес — /api/mcp
export const ALL_TOOLS: readonly ToolDefinition[];    // READ_TOOLS + CARD_TOOLS + COLLECTION_TOOLS
export function listToolsResult(): { tools: Record<string, unknown>[] };
export function discoverResult(): Record<string, unknown>;
export interface AuthOutcome { readonly actor: McpActor | null; readonly reason: 'ok' | 'missing' | 'unknown' | 'revoked' }
export function apiKeyFingerprintFor(presented: string): string;   // переиспользует HMAC из api-rate-limit.ts
export async function authenticate(args: {
  readonly header: string | null; readonly req: PayloadRequest;
}): Promise<AuthOutcome>;
export const mcpEndpoint: Endpoint;
```

- [ ] **Шаг 1: тест `auth.test.ts`** — заголовок отсутствует → `missing`; `Basic xxx` → `missing`; неизвестный ключ → `unknown` и ни одного обращения к записи пользователя сверх одного поиска; найденный пользователь с `enableAPIKey: false` → `revoked`; с `true` → `ok` и актор несёт роль владельца, а не константу `ai-editor`; сравнение отпечатка идёт через `timingSafeEqual` (проверяется подменой модуля `node:crypto` и фактом вызова).
- [ ] **Шаг 2: тест `endpoint.test.ts`** на поддельном `PayloadRequest`:
  `MCP_ENABLED` не задан → `404` (ручки как будто нет); GET → `405`; `Origin: https://evil.test` при пустом белом списке → `403`; без `Authorization` → `401` + `WWW-Authenticate: Bearer`; три одинаковых `401` подряд при `MCP_AUTH_FAILURE_LIMIT=2` → третий отдаёт `429` + `Retry-After`; тела `401` для «нет ключа», «неизвестный ключ» и «отозванный ключ» совпадают байт в байт; валидный ключ + `tools/list` → `200` со всеми инструментами и JSON Schema из задачи 2; `tools/call` неизвестного имени → `404` + `-32601`; нотификация → `202` с пустым телом; ответ несёт `X-Robots-Tag: noindex`; в логах нет предъявленного токена (проверяется перехватом логгера).
- [ ] **Шаг 3:** FAIL. **Шаг 4:** реализовать `registry.ts`, `auth.ts`, `endpoint.ts`; зарегистрировать в `payload.config.ts`. **Шаг 5:** PASS. **Шаг 6:** `pnpm verify`. **Шаг 7:** коммит.

---

### Задача 9: живые негативные тесты, nginx, документация

**Файлы:**
- Создать: `tests/api/mcp-access-negative.test.ts`, `tests/api/mcp-auth.test.ts`
- Изменить: `deploy/nginx/dobrye-otkrytki.ru.conf`, `tests/api/README.md`, `CLAUDE.md`, `docs/plan-etapov.md`

- [ ] **Шаг 1:** живой негативный набор по схеме каталога («прочитать до → попытка → прочитать после → доказать, что операция выполнилась»), транспорт — вызов `mcpEndpoint` в процессе, как остальные файлы `tests/api/`: через MCP невозможны `published`, `index,follow`, `canonical`, смена slug после публикации, создание редиректа, правка пользователя и ключа, `updatedContentAt`, удаление опубликованной карточки. Каждый сценарий объявляет вид отказа (`loud`/`silent`) параметром.
- [ ] **Шаг 2:** `tests/api/mcp-auth.test.ts` — живой `401` без токена, `401` с чужим токеном, `401` с отозванным ключом, автор правки в `seo-history` равен владельцу ключа после успешного `create_card_draft`.
- [ ] **Шаг 3:** запустить `pnpm exec vitest run tests/api` — PASS.
- [ ] **Шаг 4:** локация nginx из §7.1 спеки, с комментарием дословно оттуда.
- [ ] **Шаг 5:** раздел «Внешнее управление» в `CLAUDE.md` — MCP перестал быть «этапом 2 развития»: путь, выключатель, что умеет и чего не умеет, ссылка на спеку. В `docs/plan-etapov.md:284` снять формулировку «в текущий объём не входит» со ссылкой на Ч-35. В `tests/api/README.md` — абзац про два новых файла.
- [ ] **Шаг 6:** `pnpm verify` целиком + коммит.

---

## Порядок и зависимости

1 → 2 → 3 → 4 — фундамент, строго последовательно (3 и 4 независимы между собой).
5, 6, 7 — поверх 2 и 4, независимы друг от друга.
8 — поверх 5, 6, 7.
9 — последняя, ей нужна зарегистрированная ручка.
