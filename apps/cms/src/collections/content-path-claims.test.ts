import type { PayloadRequest } from 'payload';
import { describe, expect, it } from 'vitest';

import {
  ContentPathClaims,
  assignContentPathClaimKey,
  contentPathClaimKeyField,
  reserveContentDocumentPath,
  reserveContentPath,
} from './content-path-claims';

interface Claim {
  readonly ownerCollection: 'cards' | 'collections';
  readonly ownerKey: string;
  readonly path: string;
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const candidate = record[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function requestStand(): {
  readonly claims: Claim[];
  readonly nestedCreateCalls: { count: number };
  readonly req: PayloadRequest;
  readonly transactionDB: object;
} {
  const claims: Claim[] = [];
  const nestedCreateCalls = { count: 0 };
  const transactionDB = { transaction: 'active' };
  const fallbackDB = { transaction: 'outside-request' };
  const pathColumn = { name: 'path' };
  const req = {
    transactionID: 'tx-content-save',
    payload: {
      // Реальный Local API при ошибке вызывает killTransaction(req). Если
      // production helper всё ещё пойдёт сюда, stand моделирует именно этот
      // разрушительный эффект, а не безобидный reject.
      create: () => {
        nestedCreateCalls.count += 1;
        delete req.transactionID;
        return Promise.reject(new Error('nested create killed the outer transaction'));
      },
      db: {
        drizzle: fallbackDB,
        insert: ({
          db,
          onConflictDoUpdate,
          tableName,
          values,
        }: {
          db: unknown;
          onConflictDoUpdate: { set: { path: string }; target: unknown };
          tableName: string;
          values: Claim;
        }) => {
          expect(db).toBe(transactionDB);
          expect(tableName).toBe('content_path_claims');
          expect(onConflictDoUpdate).toEqual({
            set: { path: values.path },
            target: pathColumn,
          });
          const existing = claims.find((claim) => claim.path === values.path);
          if (existing !== undefined) {
            return Promise.resolve([{ ...existing }]);
          }
          claims.push({
            ownerCollection: values.ownerCollection,
            ownerKey: values.ownerKey,
            path: values.path,
          });
          return Promise.resolve([{ ...values }]);
        },
        name: 'postgres',
        sessions: {
          'tx-content-save': {
            db: transactionDB,
            reject: () => Promise.resolve(),
            resolve: () => Promise.resolve(),
          },
        },
        tableNameMap: new Map([['content_path_claims', 'content_path_claims']]),
        tables: { content_path_claims: { path: pathColumn } },
      },
    },
  } as unknown as PayloadRequest;

  return { claims, nestedCreateCalls, req, transactionDB };
}

describe('content-path-claims: системный атомарный реестр путей', () => {
  it('закрыт на все CRUD-операции, а path уникален в базе', () => {
    expect(ContentPathClaims.access?.create?.({} as never)).toBe(false);
    expect(ContentPathClaims.access?.read?.({} as never)).toBe(false);
    expect(ContentPathClaims.access?.update?.({} as never)).toBe(false);
    expect(ContentPathClaims.access?.delete?.({} as never)).toBe(false);

    const path = ContentPathClaims.fields.find(
      (field) => 'name' in field && field.name === 'path',
    );
    expect(path).toMatchObject({ index: true, required: true, type: 'text', unique: true });
  });

  it('скрытый ключ назначается на create и сохраняется неизменным на update', async () => {
    const created: unknown = await assignContentPathClaimKey({
      data: {},
      operation: 'create',
    } as never);
    expect(stringField(created, 'pathClaimKey')).toMatch(/^[0-9a-f-]{36}$/);

    const updated: unknown = await assignContentPathClaimKey({
      data: { pathClaimKey: 'подмена' },
      operation: 'update',
      originalDoc: { pathClaimKey: 'исходный-ключ' },
    } as never);
    expect(updated).toMatchObject({ pathClaimKey: 'исходный-ключ' });

    expect(contentPathClaimKeyField()).toMatchObject({
      admin: { hidden: true },
      name: 'pathClaimKey',
      type: 'text',
    });
  });

  it('существующей записи без ключа назначает его при миграционном resave', async () => {
    const migrated: unknown = await assignContentPathClaimKey({
      data: { title: 'Старая запись' },
      operation: 'update',
      originalDoc: { title: 'Старая запись' },
    } as never);

    expect(stringField(migrated, 'pathClaimKey')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('duplicate create получает новый ключ, а не ключ originalDoc', async () => {
    const duplicated: unknown = await assignContentPathClaimKey({
      data: { title: 'Копия' },
      operation: 'create',
      originalDoc: { pathClaimKey: 'key-original-document' },
    } as never);

    expect(stringField(duplicated, 'pathClaimKey')).toMatch(/^[0-9a-f-]{36}$/);
    expect(stringField(duplicated, 'pathClaimKey')).not.toBe('key-original-document');
  });

  it('идемпотентный конфликт не вызывает nested Local API и не убивает transactionID', async () => {
    const { claims, nestedCreateCalls, req } = requestStand();
    const args = {
      collection: 'collections' as const,
      ownerKey: 'collections:stable-key',
      path: '/otkrytki/prazdniki',
      req,
    };

    await reserveContentPath(args);
    await reserveContentPath(args);

    expect(claims).toHaveLength(1);
    expect(nestedCreateCalls.count).toBe(0);
    expect(req.transactionID).toBe('tx-content-save');
  });

  it('не занимает путь вне транзакции текущего content request', async () => {
    const { claims, req } = requestStand();
    Reflect.deleteProperty(req, 'transactionID');

    await expect(
      reserveContentPath({
        collection: 'cards',
        ownerKey: 'cards:no-transaction',
        path: '/otkrytki/bez-tranzaktsii',
        req,
      }),
    ).rejects.toThrow(/транзакц/i);
    expect(claims).toEqual([]);
  });

  it('документный хук выводит финальный путь и резервирует его тем же req', async () => {
    const { claims, req } = requestStand();
    await reserveContentDocumentPath('cards')({
      data: { pathClaimKey: 'card-key', slug: 'piony' },
      operation: 'create',
      req,
    } as never);

    expect(claims).toMatchObject([
      {
        ownerCollection: 'cards',
        ownerKey: 'cards:card-key',
        path: '/otkrytki/piony',
      },
    ]);
  });

  it('карточка не занимает путь, уже атомарно занятый подборкой', async () => {
    const { req } = requestStand();
    await reserveContentPath({
      collection: 'collections',
      ownerKey: 'collection:prazdniki',
      path: '/otkrytki/prazdniki',
      req,
    });

    await expect(
      reserveContentPath({
        collection: 'cards',
        ownerKey: 'card:prazdniki',
        path: '/otkrytki/prazdniki',
        req,
      }),
    ).rejects.toThrow(/путь.*занят.*подборк/i);
  });

  it('подборка не занимает путь, уже атомарно занятый карточкой', async () => {
    const { req } = requestStand();
    await reserveContentPath({
      collection: 'cards',
      ownerKey: 'card:prazdniki',
      path: '/otkrytki/prazdniki',
      req,
    });

    await expect(
      reserveContentPath({
        collection: 'collections',
        ownerKey: 'collection:prazdniki',
        path: '/otkrytki/prazdniki',
        req,
      }),
    ).rejects.toThrow(/путь.*занят.*открытк/i);
  });

  it('повтор владельца идемпотентен и не создаёт вторую запись', async () => {
    const { claims, req } = requestStand();
    const args = {
      collection: 'collections' as const,
      ownerKey: 'collection:prazdniki',
      path: '/otkrytki/prazdniki',
      req,
    };

    await reserveContentPath(args);
    await reserveContentPath(args);

    expect(claims).toHaveLength(1);
  });

  it('вложенная подборка занимает отдельный непротиворечивый путь', async () => {
    const { claims, req } = requestStand();
    await reserveContentPath({
      collection: 'collections',
      ownerKey: 'collection:prazdniki',
      path: '/otkrytki/prazdniki',
      req,
    });
    await reserveContentPath({
      collection: 'collections',
      ownerKey: 'collection:8-marta',
      path: '/otkrytki/prazdniki/8-marta',
      req,
    });

    expect(claims.map((claim) => claim.path)).toEqual([
      '/otkrytki/prazdniki',
      '/otkrytki/prazdniki/8-marta',
    ]);
  });
});
