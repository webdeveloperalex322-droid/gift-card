/**
 * Гарнизон живых API-тестов (задача П0 этапа 6).
 *
 * ЗАЧЕМ ОН НУЖЕН. Все защитные правила проекта живут в access control и хуках
 * Payload, а Payload сам отдаёт REST и GraphQL. Значит, доказательством права
 * является не юнит-тест на предикате (предикат может быть верен, но его никто не
 * спрашивает — так уже случилось с коллекцией `payload-jobs`), а ЗАПРОС по тому
 * же пути, которым ходит внешний AI-редактор. Юнит-тест отвечает на вопрос
 * «правильно ли записано правило», этот гарнизон — на вопрос «применяется ли
 * оно».
 *
 * ВЫБРАННЫЙ ТРАНСПОРТ: вариант A — обработчики маршрутов Next вызываются В
 * ПРОЦЕССЕ. Импортируются не `@payloadcms/next/routes`, а ФАЙЛЫ МАРШРУТОВ
 * приложения (`src/app/(payload)/api/[...slug]/route.ts` и
 * `.../api/graphql/route.ts`) — то есть ровно те модули, которые обслуживают
 * продакшн-запросы. Проверено: они разрешаются и выполняются вне Next, потому
 * что оба состоят из вызовов `payload` (`handleEndpoints`, `createPayloadRequest`)
 * и `next/headers` не трогают. Поднимать `next start` (вариант B) не
 * потребовалось: сборка Next заняла бы минуты на каждом `pnpm verify`, а
 * фидбек-петля TDD этого не переживает. Цена выбора названа честно: маршрутизация
 * Next (rewrites `PAYLOAD_ADMIN_PATH`, заголовки `X-Robots-Tag`) этими тестами не
 * покрывается — она проверяется приёмкой `tests/seo/`.
 *
 * ПОЧЕМУ НЕТ SKIP БЕЗ БАЗЫ. Тестам нужен живой PostgreSQL из `DATABASE_URL`.
 * Пропуск при недоступной базе означал бы, что негативные сценарии «зелёные»
 * ровно тогда, когда они ничего не проверяли, — это та же подмена, что выдача
 * `SEO_ACCEPTANCE: SKIPPED` за `PASSED`. Поэтому {@link getTestPayload} падает с
 * внятным текстом, а не пропускает набор.
 *
 * ЧТО ЗДЕСЬ НЕ ЖИВЁТ: ни одного правила проекта. Гарнизон только доставляет
 * запрос и возвращает ответ; все решения принимает конфиг Payload.
 */
import { randomUUID } from 'node:crypto';

import type { CollectionSlug, GlobalSlug, Payload, PayloadRequest } from 'payload';
import { formatNames, getPayload } from 'payload';

import type { User } from '../payload-types';

import {
  DELETE as REST_DELETE,
  GET as REST_GET,
  PATCH as REST_PATCH,
  POST as REST_POST,
} from '../app/(payload)/api/[...slug]/route';
import { POST as GRAPHQL_POST } from '../app/(payload)/api/graphql/route';
import config from '../payload.config';

/**
 * Слаги коллекций и глобалов пробрасываются наружу из `payload`.
 *
 * Тесты лежат в `tests/api/` и пакет `payload` оттуда не разрешается (он —
 * зависимость `apps/cms`, а не корня). Реэкспорт даёт им точные типы вместо
 * строк: коллекция с опечаткой в имени иначе была бы «успешно проверенным»
 * запретом к несуществующей коллекции.
 */
export type { CollectionSlug, GlobalSlug } from 'payload';

/* ------------------------------------------------------------------ */
/* Поднятие Payload                                                    */
/* ------------------------------------------------------------------ */

let payloadPromise: Promise<Payload> | null = null;

/**
 * Единственный экземпляр Payload на весь прогон.
 *
 * Тот же экземпляр получают и обработчики маршрутов: `handleEndpoints` зовёт
 * `getPayload` с тем же конфигом, а он кеширует инстанс. Поэтому Local API здесь
 * и REST/GraphQL снаружи работают с ОДНОЙ базой и одним пулом подключений.
 *
 * @throws Error с указанием параметра окружения, если база недоступна.
 */
export async function getTestPayload(): Promise<Payload> {
  payloadPromise ??= getPayload({ config }).catch((error: unknown) => {
    payloadPromise = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Живые API-тесты (tests/api) не поднялись: Payload не подключился к базе. ' +
        'Им нужен работающий PostgreSQL из DATABASE_URL — пропускать набор при недоступной ' +
        'базе запрещено, иначе негативные сценарии «зелёные» ровно тогда, когда ничего не ' +
        `проверяют. Создайте базу (pnpm --filter @otkritka/cms run ensure-db). Причина: ${detail}`,
    );
  });
  return payloadPromise;
}

/* ------------------------------------------------------------------ */
/* Действующее лицо запроса                                            */
/* ------------------------------------------------------------------ */

/**
 * Кто делает запрос. Аутентификация ТОЛЬКО по API-ключу — это и есть путь
 * внешнего AI-редактора (ТЗ §9). `null` означает аноним.
 */
export interface ApiActor {
  readonly apiKey: string;
  /** Человекочитаемое имя для сообщений теста. */
  readonly label: string;
}

/** Аноним: запрос без заголовка авторизации. */
export const ANONYMOUS: null = null;

function authHeaders(actor: ApiActor | null): Record<string, string> {
  if (actor === null) {
    return {};
  }
  // Форма заголовка задана самим Payload (`auth/strategies/apiKey.js`):
  // `<slug коллекции пользователей> API-Key <ключ>`.
  return { Authorization: `users API-Key ${actor.apiKey}` };
}

/* ------------------------------------------------------------------ */
/* Ответ                                                               */
/* ------------------------------------------------------------------ */

/**
 * Результат операции через API.
 *
 * ВАЖНО ПРО `applied`. Он означает «Payload не вернул ошибку», а НЕ «значение
 * записано». Отказ на уровне поля у Payload молчаливый: поле вырезается из
 * входных данных, на его место встаёт прежнее значение, ответ — 200. Поэтому ни
 * один негативный сценарий не вправе опираться только на `status`/`applied`:
 * состояние читается до и после операции (см. {@link readStored}).
 */
export interface ApiResult {
  readonly applied: boolean;
  /** Документ из ответа, если он есть. */
  readonly doc: Record<string, unknown> | null;
  /** Сообщения об ошибках — из `errors[]` REST или GraphQL. */
  readonly errors: readonly string[];
  readonly status: number;
  readonly transport: Transport;
}

export type Transport = 'graphql' | 'rest';

/** Оба транспорта одним списком: тест обязан прогнать сценарий и там, и там. */
export const TRANSPORTS: readonly Transport[] = ['graphql', 'rest'];

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

/** Хост запроса. Значение не влияет ни на что: Payload читает из URL только путь и query. */
const REQUEST_ORIGIN = 'http://cms.test';

type RestMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST';

const REST_HANDLERS: Record<
  RestMethod,
  (request: Request, args: { params: Promise<{ slug: string[] }> }) => Promise<Response>
> = {
  DELETE: REST_DELETE,
  GET: REST_GET,
  PATCH: REST_PATCH,
  POST: REST_POST,
};

export interface RestCall {
  readonly actor: ApiActor | null;
  /** Тело: объект (уйдёт JSON) либо готовый `FormData` для загрузки файла. */
  readonly body?: FormData | Record<string, unknown>;
  readonly method: RestMethod;
  /** Сегменты пути ПОСЛЕ `/api`: `['cards', '12']`. */
  readonly segments: readonly string[];
  readonly query?: Record<string, string>;
}

/** Сырой ответ REST: нужен там, где тест смотрит на код и заголовки. */
export async function restRaw(call: RestCall): Promise<Response> {
  const search = new URLSearchParams(call.query ?? {}).toString();
  const url = `${REQUEST_ORIGIN}/api/${call.segments.join('/')}${search === '' ? '' : `?${search}`}`;

  const headers: Record<string, string> = { ...authHeaders(call.actor) };
  const init: RequestInit = { headers, method: call.method };

  if (call.body instanceof FormData) {
    // Content-Type для multipart проставляет сам Request вместе с boundary.
    init.body = call.body;
  } else if (call.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(call.body);
  }

  const request = new Request(url, init);

  const handler = REST_HANDLERS[call.method];
  return handler(request, { params: Promise.resolve({ slug: [...call.segments] }) });
}

function readErrors(payloadBody: unknown): readonly string[] {
  if (typeof payloadBody !== 'object' || payloadBody === null) {
    return [];
  }
  const record: Record<string, unknown> = { ...payloadBody };
  const errors = record.errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((error): string => {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message: unknown = (error as { message: unknown }).message;
      return typeof message === 'string' ? message : JSON.stringify(error);
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
  });
}

function readDoc(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return { ...(value as Record<string, unknown>) };
}

async function restResult(call: RestCall): Promise<ApiResult> {
  const response = await restRaw(call);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = { errors: [{ message: text.slice(0, 400) }] };
  }
  const errors = readErrors(parsed);
  const envelope = readDoc(parsed);
  const doc = envelope === null ? null : (readDoc(envelope.doc) ?? envelope);

  return {
    applied: response.status < 400 && errors.length === 0,
    doc,
    errors,
    status: response.status,
    transport: 'rest',
  };
}

/* ------------------------------------------------------------------ */
/* GraphQL                                                             */
/* ------------------------------------------------------------------ */

export interface GraphqlCall {
  readonly actor: ApiActor | null;
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

/**
 * Ошибка ЗАПРОСА, а не ответа: мутация не дошла до Payload.
 *
 * ЗАЧЕМ ЭТО ЗДЕСЬ. Негативный сценарий доказывает запрет тем, что операция
 * ВЫПОЛНИЛАСЬ и была отклонена. Запрос, разобранный GraphQL как неверный
 * (не передано обязательное поле входного типа, запрошено несуществующее поле
 * выборки), возвращает `errors` и `applied: false` — ровно то же, что и отказ по
 * правам. Тест на этом зеленеет и остаётся зелёным даже при полностью открытом
 * access control: до проверки прав дело не доходит. Такой дефект уже был найден
 * в наборе дважды (createRedirect без обязательного `code`, updateSiteSetting с
 * выборкой несуществующего поля `id`), поэтому проверка живёт не в тестах, а
 * здесь — иначе следующий сценарий повторит её забыть.
 *
 * ПРИЗНАК, ПО КОТОРОМУ ЭТО РАЗЛИЧИМО. У ошибки, возникшей в резолвере, есть
 * `path` — имя поля мутации (`path: ["createRedirect"]`, `extensions.name:
 * "Forbidden"`). У ошибки разбора запроса и приведения переменных `path` нет
 * вовсе: она относится к документу целиком, а не к полю. Признак проверен на
 * живых ответах обоих видов, не выведен из документации.
 */
function assertGraphqlReachedPayload(
  body: { data?: Record<string, unknown> | null; errors?: unknown[] },
  call: GraphqlCall,
): void {
  const schemaLevel = (body.errors ?? []).filter(
    (error) => typeof error === 'object' && error !== null && !('path' in error),
  );
  if (schemaLevel.length === 0) {
    return;
  }
  throw new Error(
    'GraphQL-запрос не дошёл до Payload: он отклонён на разборе документа или на ' +
      'приведении переменных, то есть ни один резолвер не выполнялся и права никто не ' +
      'спрашивал. Негативный сценарий на таком запросе зелёный при ЛЮБОМ access control. ' +
      `Ошибки: ${JSON.stringify(schemaLevel).slice(0, 600)}. Запрос: ${call.query.slice(0, 300)}. ` +
      `Переменные: ${JSON.stringify(call.variables ?? {}).slice(0, 400)}`,
  );
}

/**
 * Сырой ответ GraphQL: конверт `{ data, errors }` целиком.
 *
 * Падает громко, если запрос не дошёл до резолвера — см.
 * {@link assertGraphqlReachedPayload}.
 */
export async function graphqlRaw(call: GraphqlCall): Promise<{
  readonly body: { data?: Record<string, unknown> | null; errors?: unknown[] };
  readonly status: number;
}> {
  const request = new Request(`${REQUEST_ORIGIN}/api/graphql`, {
    body: JSON.stringify({ query: call.query, variables: call.variables ?? {} }),
    headers: {
      accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders(call.actor),
    },
    method: 'POST',
  });

  const response = await GRAPHQL_POST(request);
  const text = await response.text();
  let body: { data?: Record<string, unknown> | null; errors?: unknown[] } = {};
  try {
    body = text === '' ? {} : (JSON.parse(text) as typeof body);
  } catch {
    body = { errors: [{ message: text.slice(0, 400) }] };
  }
  assertGraphqlReachedPayload(body, call);
  return { body, status: response.status };
}

function graphqlErrors(errors: unknown[] | undefined): readonly string[] {
  return (errors ?? []).map((error): string => {
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error;
      return typeof message === 'string' ? message : JSON.stringify(error);
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
  });
}

async function graphqlResult(call: GraphqlCall, field: string): Promise<ApiResult> {
  const { body, status } = await graphqlRaw(call);
  const errors = graphqlErrors(body.errors);
  const data = body.data ?? null;
  const doc = data === null ? null : readDoc(data[field]);
  return {
    applied: errors.length === 0 && doc !== null,
    doc,
    errors,
    status,
    transport: 'graphql',
  };
}

/* ------------------------------------------------------------------ */
/* Имена в схеме GraphQL и значения перечислений                       */
/* ------------------------------------------------------------------ */

/**
 * Имена типов GraphQL выводятся из slug ТОЙ ЖЕ функцией Payload, что и в схеме
 * (`@payloadcms/graphql/schema/initCollections`): `formatNames(slug)`. Копировать
 * правило сюда нельзя — разойдясь, копия дала бы «поля нет в схеме» на верном
 * запросе.
 */
export function graphqlNames(slug: string): { plural: string; singular: string } {
  const names = formatNames(slug);
  return {
    plural: names.plural === names.singular ? `all${names.singular}` : names.plural,
    singular: names.singular,
  };
}

/**
 * Имя значения перечисления в схеме GraphQL.
 *
 * Payload делает из значения опции ИМЯ enum'а (`formatName` в
 * `@payloadcms/graphql/utilities`): `index,follow` в схеме зовётся
 * `index_follow`, а значением остаётся `index,follow`. Переменная GraphQL
 * приводится к enum по ИМЕНИ, поэтому послать в переменных `"index,follow"`
 * нельзя — запрос упадёт на валидации.
 *
 * Правило воспроизведено здесь, а не импортировано, потому что
 * `@payloadcms/graphql` не экспортирует `formatName` наружу. Расхождение
 * заметно сразу и громко: неверное имя даёт ошибку валидации GraphQL, а не
 * тихо прошедший тест.
 */
export function graphqlEnumName(value: string): string {
  const prefixed = /^[0-9]/.test(value) ? `_${value}` : value;
  return (
    prefixed
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[./\-+,()'[\]]/g, '_')
      .replace(/ /g, '') || '_'
  );
}

type FieldLike = {
  readonly fields?: readonly FieldLike[];
  readonly name?: string;
  readonly tabs?: readonly FieldLike[];
  readonly type?: string;
};

/**
 * Пути полей-перечислений коллекции («status», «withdrawal.mode», …).
 *
 * Считаются из САНИТИЗИРОВАННОГО конфига Payload, а не из ручного списка:
 * ручной список молча устарел бы при добавлении нового `select`, и тест ушёл бы
 * в отказ GraphQL с невнятной формулировкой.
 */
function selectFieldPaths(fields: readonly FieldLike[], prefix = ''): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const field of fields) {
    const name = typeof field.name === 'string' ? field.name : null;
    const path = name === null ? prefix : prefix === '' ? name : `${prefix}.${name}`;
    if (field.type === 'select' || field.type === 'radio') {
      if (name !== null) {
        paths.add(path);
      }
      continue;
    }
    for (const nested of field.fields ?? []) {
      for (const found of selectFieldPaths([nested], path)) {
        paths.add(found);
      }
    }
    for (const tab of field.tabs ?? []) {
      for (const found of selectFieldPaths(tab.fields ?? [], path)) {
        paths.add(found);
      }
    }
  }
  return paths;
}

const selectPathCache = new Map<string, ReadonlySet<string>>();

/**
 * Конфиг ищется перебором по `payload.config`, а не индексацией
 * `payload.collections[slug]`: у коллекций и глобалов одна и та же функция, и
 * индексация потребовала бы приведения типа, то есть утверждения о слаге,
 * которое компилятор не проверяет.
 */
async function selectPathsOf(slug: string): Promise<ReadonlySet<string>> {
  const cached = selectPathCache.get(slug);
  if (cached !== undefined) {
    return cached;
  }
  const payload = await getTestPayload();
  const collectionConfig = payload.config.collections.find(
    (candidate) => candidate.slug === slug,
  );
  const globalConfig = payload.config.globals.find((candidate) => candidate.slug === slug);
  const fields = (collectionConfig?.fields ?? globalConfig?.fields ?? []) as readonly FieldLike[];
  const paths = selectFieldPaths(fields);
  selectPathCache.set(slug, paths);
  return paths;
}

/** Приводит значения перечислений к их именам в схеме GraphQL. */
function toGraphqlInput(
  data: Record<string, unknown>,
  selectPaths: ReadonlySet<string>,
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (selectPaths.has(path) && typeof value === 'string') {
      result[key] = graphqlEnumName(value);
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = toGraphqlInput(value as Record<string, unknown>, selectPaths, path);
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** Тип переменной идентификатора: у Postgres-адаптера это `Int`. */
function idVariableType(id: number | string): string {
  return typeof id === 'number' ? 'Int!' : 'String!';
}

/* ------------------------------------------------------------------ */
/* Операции над коллекциями — одинаково через оба транспорта           */
/* ------------------------------------------------------------------ */

export interface DocOperation {
  readonly actor: ApiActor | null;
  readonly collection: CollectionSlug;
  readonly data: Record<string, unknown>;
  readonly transport: Transport;
}

/**
 * Поля, которые запрашиваются у документа в ответе GraphQL.
 *
 * Список короткий НАМЕРЕННО: ответ мутации в этих тестах ничего не доказывает
 * (см. {@link ApiResult}), доказывает сравнение сохранённого состояния. Полный
 * набор полей в выборке потребовал бы перечислять их для каждой коллекции и
 * ломался бы при любой правке схемы.
 */
const DOC_SELECTION = 'id';

/**
 * ОТЛИЧИЕ GraphQL ОТ REST, о которое спотыкается каждый первый вызов. Обязательное
 * поле со значением по умолчанию (`status`, `robots`) в схеме создания GraphQL
 * объявлено НЕ-nullable, и значение по умолчанию за клиента там не
 * подставляется: запрос падает на валидации переменных ещё до Payload. REST в
 * том же случае подставит дефолт. Поэтому тесты передают `status` и `robots`
 * явно — это не обход правил (обе величины проверяются хуками как обычно), а
 * плата за одинаковую форму вызова у двух транспортов.
 */
export async function createDoc(operation: DocOperation): Promise<ApiResult> {
  if (operation.transport === 'rest') {
    return restResult({
      actor: operation.actor,
      body: operation.data,
      method: 'POST',
      segments: [operation.collection],
    });
  }

  const { singular } = graphqlNames(operation.collection);
  const variables = {
    data: toGraphqlInput(operation.data, await selectPathsOf(operation.collection)),
  };
  return graphqlResult(
    {
      actor: operation.actor,
      query:
        `mutation Create($data: mutation${singular}Input!) { ` +
        `create${singular}(data: $data) { ${DOC_SELECTION} } }`,
      variables,
    },
    `create${singular}`,
  );
}

export interface UpdateOperation extends DocOperation {
  readonly id: number | string;
}

export async function updateDoc(operation: UpdateOperation): Promise<ApiResult> {
  if (operation.transport === 'rest') {
    return restResult({
      actor: operation.actor,
      body: operation.data,
      method: 'PATCH',
      segments: [operation.collection, String(operation.id)],
    });
  }

  const { singular } = graphqlNames(operation.collection);
  return graphqlResult(
    {
      actor: operation.actor,
      query:
        `mutation Upd($id: ${idVariableType(operation.id)}, $data: mutation${singular}UpdateInput!) { ` +
        `update${singular}(id: $id, data: $data) { ${DOC_SELECTION} } }`,
      variables: {
        data: toGraphqlInput(operation.data, await selectPathsOf(operation.collection)),
        id: operation.id,
      },
    },
    `update${singular}`,
  );
}

export interface DeleteOperation {
  readonly actor: ApiActor | null;
  readonly collection: CollectionSlug;
  readonly id: number | string;
  readonly transport: Transport;
}

export async function deleteDoc(operation: DeleteOperation): Promise<ApiResult> {
  if (operation.transport === 'rest') {
    return restResult({
      actor: operation.actor,
      method: 'DELETE',
      segments: [operation.collection, String(operation.id)],
    });
  }

  const { singular } = graphqlNames(operation.collection);
  return graphqlResult(
    {
      actor: operation.actor,
      query:
        `mutation Del($id: ${idVariableType(operation.id)}) { ` +
        `delete${singular}(id: $id) { ${DOC_SELECTION} } }`,
      variables: { id: operation.id },
    },
    `delete${singular}`,
  );
}

/**
 * Пакетное обновление по условию — то самое, чем делается пакетная публикация
 * (Э5-06). В схеме GraphQL Payload аналога нет вовсе: мутаций «обновить по
 * where» он не выпускает, поэтому сценарий существует только для REST, и это
 * факт устройства Payload, а не пробел набора.
 */
export async function bulkUpdate(args: {
  readonly actor: ApiActor | null;
  readonly collection: CollectionSlug;
  readonly data: Record<string, unknown>;
  readonly where: Record<string, unknown>;
}): Promise<ApiResult> {
  return restResult({
    actor: args.actor,
    body: args.data,
    method: 'PATCH',
    query: { where: JSON.stringify(args.where) },
    segments: [args.collection],
  });
}

/** Чтение через API правами действующего лица (не то же, что {@link readStored}). */
export async function findDocs(args: {
  readonly actor: ApiActor | null;
  readonly collection: CollectionSlug;
  readonly fields: string;
  readonly limit?: number;
  readonly transport: Transport;
  readonly where?: Record<string, unknown>;
}): Promise<{
  readonly docs: readonly Record<string, unknown>[];
  readonly errors: readonly string[];
  readonly status: number;
}> {
  if (args.transport === 'rest') {
    const query: Record<string, string> = { limit: String(args.limit ?? 50) };
    if (args.where !== undefined) {
      query.where = JSON.stringify(args.where);
    }
    const response = await restRaw({
      actor: args.actor,
      method: 'GET',
      query,
      segments: [args.collection],
    });
    const parsed: unknown = await response.json().catch(() => null);
    const envelope = readDoc(parsed);
    const docs = Array.isArray(envelope?.docs)
      ? (envelope.docs as unknown[]).flatMap((doc) => {
          const record = readDoc(doc);
          return record === null ? [] : [record];
        })
      : [];
    return { docs, errors: readErrors(parsed), status: response.status };
  }

  const { plural } = graphqlNames(args.collection);
  const { body, status } = await graphqlRaw({
    actor: args.actor,
    query:
      `query List($limit: Int) { ${plural}(limit: $limit) { docs { ${args.fields} } } }`,
    variables: { limit: args.limit ?? 50 },
  });
  const list = readDoc(body.data?.[plural] ?? null);
  const docs = Array.isArray(list?.docs)
    ? (list.docs as unknown[]).flatMap((doc) => {
        const record = readDoc(doc);
        return record === null ? [] : [record];
      })
    : [];
  return { docs, errors: graphqlErrors(body.errors), status };
}

/** Обновление глобала. */
export async function updateGlobal(args: {
  readonly actor: ApiActor | null;
  readonly data: Record<string, unknown>;
  readonly slug: GlobalSlug;
  readonly transport: Transport;
}): Promise<ApiResult> {
  if (args.transport === 'rest') {
    return restResult({
      actor: args.actor,
      body: args.data,
      method: 'POST',
      segments: ['globals', args.slug],
    });
  }
  const { singular } = graphqlNames(args.slug);
  // Выбирается `updatedAt`, а НЕ `id`: у объектного типа глобала в схеме
  // GraphQL поля `id` нет вовсе (Payload строит тип из полей самого глобала —
  // `initGlobals` в @payloadcms/graphql). Выборка `{ id }` отклонялась разбором
  // документа, до резолвера запрос не доходил, и «отказ» получался при любом
  // access control. `updatedAt` у глобала есть всегда.
  return graphqlResult(
    {
      actor: args.actor,
      query:
        `mutation UpdG($data: mutation${singular}Input!) { ` +
        `update${singular}(data: $data) { updatedAt } }`,
      variables: { data: toGraphqlInput(args.data, await selectPathsOf(args.slug)) },
    },
    `update${singular}`,
  );
}

/* ------------------------------------------------------------------ */
/* Состояние в базе                                                    */
/* ------------------------------------------------------------------ */

/**
 * Что РЕАЛЬНО лежит в базе — правами системы, в обход access control.
 *
 * Это опорная точка каждого негативного сценария: «прочитать до → попытка →
 * прочитать после». Читать состояние тем же ключом, которым делалась попытка,
 * нельзя: если правило чтения тоже нарушено, обе половины теста ошиблись бы
 * согласованно.
 */
export async function readStored(
  collection: CollectionSlug,
  id: number | string,
): Promise<Record<string, unknown>> {
  const payload = await getTestPayload();
  const doc = await payload.findByID({ collection, depth: 0, id, overrideAccess: true });
  return { ...(doc as unknown as Record<string, unknown>) };
}

/** Снимок значений перечисленных полей — то, что сравнивается «до» и «после». */
export async function snapshot(
  collection: CollectionSlug,
  id: number | string,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const doc = await readStored(collection, id);
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    picked[field] = doc[field] ?? null;
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Пользователи и ключи                                                */
/* ------------------------------------------------------------------ */

export interface TestUser extends ApiActor {
  readonly email: string;
  /** Тип идентификатора взят из сгенерированных типов: у Postgres это число. */
  readonly id: User['id'];
  readonly role: User['role'];
}

/**
 * Заводит пользователя с ролью и выдаёт ему API-ключ.
 *
 * Ключ ставится через Local API с правами системы: это моделирует действие
 * администратора, а не проверяет его. Проверка «кто вправе выпустить ключ» —
 * отдельные сценарии Э6-01, и они ходят через REST и GraphQL.
 */
export async function createUserWithKey(args: {
  readonly email: string;
  readonly label: string;
  readonly role: User['role'];
}): Promise<TestUser> {
  const payload = await getTestPayload();
  // randomUUID, а не время плюс Math.random: ключ кладётся в РАБОЧУЮ базу с
  // `enableAPIKey: true`, и предсказуемое значение — это работающий доступ,
  // который можно угадать по времени прогона.
  const apiKey = `${args.role}-${randomUUID()}`;

  const created: User = await payload.create({
    collection: 'users',
    data: {
      apiKey,
      email: args.email,
      enableAPIKey: true,
      password: `${apiKey}-pass`,
      role: args.role,
    },
    overrideAccess: true,
  });

  return {
    apiKey,
    email: created.email,
    id: created.id,
    label: args.label,
    role: created.role,
  };
}

/**
 * Уборка НЕ ГЛУШИТ ошибки — и это принципиально.
 *
 * Прогон идёт на рабочей базе разработчика. Проглоченная ошибка уборки означает
 * оставленную в базе запись — в худшем случае опубликованную карточку или
 * живой API-ключ, — про которую никто не узнает: набор при этом зелёный. Поэтому
 * сбои копятся и выбрасываются одной ошибкой в конце: прервать уборку на первой
 * неудаче тоже нельзя, иначе остальное точно останется в базе.
 */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deleteOrRecord(
  run: () => Promise<unknown>,
  what: string,
  failures: string[],
): Promise<void> {
  try {
    const result = await run();
    // Удаление по условию (`where`) у Payload не бросает: неудачные документы
    // приходят списком `errors` в ответе, и без этой проверки массовая уборка
    // «успешна» всегда.
    const bulk = result as { errors?: { message?: string }[] } | null;
    const reported = Array.isArray(bulk?.errors) ? bulk.errors : [];
    if (reported.length > 0) {
      failures.push(`${what}: ${JSON.stringify(reported).slice(0, 300)}`);
    }
  } catch (error) {
    failures.push(`${what}: ${describeFailure(error)}`);
  }
}

function throwIfFailed(failures: readonly string[], what: string): void {
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    `Уборка после ${what} не удалась, и это не мелочь: тесты идут на рабочей базе, ` +
      'а несделанная уборка оставляет в ней записи и ключи прогона. ' +
      `Неудачи: ${failures.join('; ')}`,
  );
}

/**
 * Убирает созданные тестом записи ВМЕСТЕ с их журналом изменений.
 *
 * Журнал удаляется отдельным запросом, потому что каскада на него нет и быть не
 * должно: `seo-history` переживает удаление документа сознательно. Но записи
 * журнала о документах, которых не существовало нигде, кроме прогона тестов, —
 * это мусор, который копится с каждым `pnpm verify`.
 *
 * Порядок ОБРАТНЫЙ порядку создания: узел удаляется раньше своего родителя.
 * Подборка с потомками не удаляется вовсе, и прямой порядок молча оставлял бы
 * группы в базе — уборка выглядела бы успешной и не была бы полной.
 *
 * @throws Error, если хоть одна запись не удалилась.
 */
export async function removeContent(
  collection: 'card-images' | 'cards' | 'collections',
  ids: readonly (number | string)[],
): Promise<void> {
  const payload = await getTestPayload();
  const failures: string[] = [];

  for (const id of [...ids].reverse()) {
    await deleteOrRecord(
      () => payload.delete({ collection, id, overrideAccess: true }),
      `${collection}#${String(id)}`,
      failures,
    );
    if (collection === 'card-images') {
      continue;
    }
    await deleteOrRecord(
      () =>
        payload.delete({
          collection: 'seo-history',
          overrideAccess: true,
          where: {
            and: [
              { documentCollection: { equals: collection } },
              { documentId: { equals: String(id) } },
            ],
          },
        }),
      `seo-history для ${collection}#${String(id)}`,
      failures,
    );
  }

  throwIfFailed(failures, `удалением записей ${collection}`);
}

/**
 * Удаляет тестовых пользователей, не оставляя ключей в базе.
 *
 * @throws Error, если аккаунт остался: живой API-ключ в базе — не мусор, а доступ.
 */
export async function removeUsers(ids: readonly (number | string)[]): Promise<void> {
  const payload = await getTestPayload();
  const failures: string[] = [];
  for (const id of ids) {
    await deleteOrRecord(
      () => payload.delete({ collection: 'users', id, overrideAccess: true }),
      `users#${String(id)}`,
      failures,
    );
  }
  throwIfFailed(failures, 'удалением тестовых пользователей');
}

/**
 * Требует, чтобы перечисленных записей в базе не осталось.
 *
 * Проверка отдельная от удаления намеренно: удаление может «пройти», а запись
 * остаться — например, если её вернул хук. Утверждение об ИТОГОВОМ состоянии
 * этот случай ловит, а утверждение об успешности вызова — нет.
 *
 * @throws Error со списком уцелевших записей.
 */
export async function assertRemoved(
  collection: CollectionSlug,
  ids: readonly (number | string)[],
): Promise<void> {
  const payload = await getTestPayload();
  const survived: string[] = [];
  for (const id of ids) {
    const found = await payload
      .findByID({ collection, depth: 0, disableErrors: true, id, overrideAccess: true })
      .catch(() => null);
    if (found !== null) {
      survived.push(`${collection}#${String(id)}`);
    }
  }
  if (survived.length > 0) {
    throw new Error(
      'Уборка отчиталась об успехе, но записи остались в базе: ' +
        `${survived.join(', ')}. Прогон оставляет за собой состояние, на котором ` +
        'следующий прогон получит другой результат.',
    );
  }
}

/**
 * Запрос «кто я» по ключу. Единственный способ доказать, что ключ ОТОЗВАН:
 * успешный ответ содержит пользователя, отозванный ключ даёт `user: null`.
 */
export async function whoAmI(actor: ApiActor): Promise<{
  readonly status: number;
  readonly user: Record<string, unknown> | null;
}> {
  const response = await restRaw({ actor, method: 'GET', segments: ['users', 'me'] });
  const parsed: unknown = await response.json().catch(() => null);
  const envelope = readDoc(parsed);
  return { status: response.status, user: envelope === null ? null : readDoc(envelope.user) };
}

/* ------------------------------------------------------------------ */
/* Фикстуры контента                                                   */
/* ------------------------------------------------------------------ */

/** Уникальный хвост имени: прогоны не должны спорить за slug и e-mail. */
export function stamp(): string {
  return `${String(Date.now()).slice(-8)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Запрос Local API от имени пользователя — для подготовки состояния, которого
 * тестируемая роль достичь не вправе (например, опубликованной записи).
 */
export async function asUser(user: TestUser): Promise<PayloadRequest['user']> {
  const payload = await getTestPayload();
  const doc = await payload.findByID({
    collection: 'users',
    id: user.id,
    overrideAccess: true,
  });
  return { ...doc, collection: 'users' } as unknown as PayloadRequest['user'];
}
