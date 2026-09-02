import { randomUUID } from 'node:crypto';

import type { PostgresAdapter } from '@payloadcms/db-postgres';
import {
  APIError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type Field,
  type PayloadRequest,
} from 'payload';

import { systemFieldAccess } from '../access/policies';
import { type ContentCollectionSlug, contentDocumentPath } from '../seo/paths';

/**
 * Неудаляемый межколлекционный реестр публичных путей.
 *
 * Уникальный индекс `path` — атомарная граница между `cards` и `collections`:
 * две параллельные записи не могут одновременно занять один URL. Строки не
 * освобождаются автоматически, потому что уже показанный наружу URL нельзя
 * незаметно выдать другому документу после удаления или переноса.
 */
export const ContentPathClaims: CollectionConfig = {
  slug: 'content-path-claims',
  labels: {
    singular: 'Занятый путь контента',
    plural: 'Занятые пути контента',
  },
  admin: {
    description:
      'Системный неизменяемый реестр публичных URL карточек и подборок. ' +
      'Записи создают только серверные хуки в транзакции сохранения контента.',
    hidden: true,
    useAsTitle: 'path',
  },
  access: {
    create: () => false,
    delete: () => false,
    read: () => false,
    update: () => false,
  },
  fields: [
    {
      name: 'path',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { readOnly: true },
    },
    {
      name: 'ownerCollection',
      type: 'select',
      required: true,
      options: [
        { label: 'Открытка', value: 'cards' },
        { label: 'Подборка', value: 'collections' },
      ],
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { readOnly: true },
    },
    {
      name: 'ownerKey',
      type: 'text',
      required: true,
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { readOnly: true },
    },
    {
      name: 'claimedAt',
      type: 'date',
      required: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { readOnly: true },
    },
  ],
};

export interface ReserveContentPathArgs {
  readonly collection: ContentCollectionSlug;
  readonly ownerKey: string;
  readonly path: string;
  readonly req: PayloadRequest;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

const CLAIM_TABLE_MAP_KEY = 'content_path_claims';
type ClaimInsertDatabase = Parameters<PostgresAdapter['insert']>[0]['db'];
type ClaimInsert = (
  this: PostgresAdapter,
  args: {
    readonly db: ClaimInsertDatabase;
    readonly onConflictDoUpdate: unknown;
    readonly tableName: string;
    readonly values: Readonly<Record<string, unknown>>;
  },
) => Promise<Record<string, unknown>[]>;

function postgresAdapter(req: PayloadRequest): PostgresAdapter {
  const adapter = req.payload.db;
  if (adapter.name !== 'postgres') {
    throw new APIError(
      'Атомарный реестр публичных путей требует настроенный PostgreSQL adapter.',
      500,
      { rule: 'content-path-adapter-unsupported' },
      true,
    );
  }
  return adapter as unknown as PostgresAdapter;
}

async function transactionDatabase(
  adapter: PostgresAdapter,
  req: PayloadRequest,
): Promise<ClaimInsertDatabase> {
  const transactionID = await req.transactionID;
  if (transactionID === undefined || transactionID === null) {
    throw new APIError(
      'Транзакция сохранения контента не начата: занять публичный путь вне неё нельзя.',
      500,
      { rule: 'content-path-transaction-missing' },
      true,
    );
  }

  const session = adapter.sessions[String(transactionID)];
  if (session === undefined) {
    throw new APIError(
      'Транзакция сохранения контента недоступна: занять публичный путь вне неё нельзя.',
      500,
      { rule: 'content-path-transaction-missing' },
      true,
    );
  }
  return session.db;
}

function ownerLabel(collection: unknown): string {
  return collection === 'collections' ? 'подборкой' : 'открыткой';
}

/**
 * Атомарно занимает путь в текущей транзакции Payload.
 *
 * DB handle берётся из transaction session текущего `req`. Nested Local API
 * здесь запрещён: его ошибка вызвала бы Payload `killTransaction(req)` и
 * откатила внешнее сохранение до проверки владельца. Adapter-upsert не бросает
 * unique error (`path = path` на конфликте) и возвращает фактического владельца;
 * поэтому claim откатывается вместе с контентом, а гонку закрывает индекс БД.
 */
export async function reserveContentPath(args: ReserveContentPathArgs): Promise<void> {
  const adapter = postgresAdapter(args.req);
  const tableName = adapter.tableNameMap.get(CLAIM_TABLE_MAP_KEY);
  if (tableName === undefined) {
    throw new APIError(
      'Системная таблица content-path-claims не зарегистрирована в Payload.',
      500,
      { rule: 'content-path-table-missing' },
      true,
    );
  }
  const table: unknown = adapter.tables[tableName];
  if (!isUnknownRecord(table) || !('path' in table)) {
    throw new APIError(
      'Системная таблица content-path-claims не содержит уникального поля path.',
      500,
      { rule: 'content-path-column-missing' },
      true,
    );
  }

  const now = new Date().toISOString();
  const insert = adapter.insert as unknown as ClaimInsert;
  const rows = await insert.call(adapter, {
    db: await transactionDatabase(adapter, args.req),
    onConflictDoUpdate: {
      set: { path: args.path },
      target: table.path,
    },
    tableName,
    values: {
      claimedAt: now,
      createdAt: now,
      ownerCollection: args.collection,
      ownerKey: args.ownerKey,
      path: args.path,
      updatedAt: now,
    },
  });
  const claim = rows[0];

  if (claim?.ownerKey === args.ownerKey) {
    return;
  }

  throw new APIError(
    `Путь «${args.path}» уже занят ${ownerLabel(claim?.ownerCollection)}. ` +
      'У карточек и подборок единое пространство /otkrytki; выберите другой slug.',
    400,
    { rule: 'content-path-occupied' },
    true,
  );
}

/** Скрытое поле владельца claim, одинаковое в обеих контентных коллекциях. */
export function contentPathClaimKeyField(): Field {
  return {
    name: 'pathClaimKey',
    type: 'text',
    access: { create: systemFieldAccess, update: systemFieldAccess },
    admin: { hidden: true, readOnly: true },
  };
}

/** Назначает отсутствующий ключ и не даёт подменить уже сохранённый. */
export const assignContentPathClaimKey: CollectionBeforeValidateHook = ({
  data,
  operation,
  originalDoc,
}) => {
  const rawData: unknown = data;
  const rawOriginalDoc: unknown = originalDoc;
  const next = isUnknownRecord(rawData) ? { ...rawData } : {};
  if (operation === 'create') {
    return { ...next, pathClaimKey: randomUUID() };
  }
  const stored =
    isUnknownRecord(rawOriginalDoc) &&
    typeof rawOriginalDoc.pathClaimKey === 'string' &&
    rawOriginalDoc.pathClaimKey !== ''
      ? rawOriginalDoc.pathClaimKey
      : null;

  if (stored !== null) {
    return { ...next, pathClaimKey: stored };
  }
  if (operation === 'update') {
    return { ...next, pathClaimKey: randomUUID() };
  }
  return next;
};

/** Резервирует финальный путь документа после его сборки предыдущими хуками. */
export function reserveContentDocumentPath(
  collection: ContentCollectionSlug,
): CollectionBeforeChangeHook {
  return async ({ data, originalDoc, req }) => {
    const rawData: unknown = data;
    const rawOriginalDoc: unknown = originalDoc;
    const previous = isUnknownRecord(rawOriginalDoc) ? rawOriginalDoc : {};
    const next = isUnknownRecord(rawData) ? { ...previous, ...rawData } : previous;
    const path = contentDocumentPath(collection, next);

    if (path === null) {
      return data;
    }

    const key =
      typeof next.pathClaimKey === 'string' && next.pathClaimKey.trim() !== ''
        ? next.pathClaimKey
        : null;
    if (key === null) {
      throw new APIError(
        `Путь «${path}» нельзя занять: у записи отсутствует системный pathClaimKey.`,
        400,
        { rule: 'content-path-owner-missing' },
        true,
      );
    }

    await reserveContentPath({
      collection,
      ownerKey: `${collection}:${key}`,
      path,
      req,
    });
    return data;
  };
}
