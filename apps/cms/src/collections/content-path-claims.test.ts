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

function requestStand(): { readonly claims: Claim[]; readonly req: PayloadRequest } {
  const claims: Claim[] = [];
  const req = {
    payload: {
      create: (args: Record<string, unknown>) => {
        expect(args.req).toBe(req);
        expect(args).not.toHaveProperty('disableTransaction');
        const data = args.data as Claim;
        if (claims.some((claim) => claim.path === data.path)) {
          // Payload/Drizzle преобразует PostgreSQL 23505 в ValidationError:
          // признак уникальности находится во вложенной ошибке поля, а не в
          // верхнеуровневом message.
          const error = new Error('The following field is invalid: path');
          Object.assign(error, {
            data: {
              errors: [{ message: 'Value must be unique', path: 'path' }],
            },
          });
          throw error;
        }
        claims.push(data);
        return Promise.resolve({ id: claims.length, ...data });
      },
      find: (args: Record<string, unknown>) => {
        expect(args.req).toBe(req);
        const path = ((args.where as { path: { equals: string } }).path).equals;
        return Promise.resolve({ docs: claims.filter((claim) => claim.path === path) });
      },
    },
  } as unknown as PayloadRequest;
  return { claims, req };
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
