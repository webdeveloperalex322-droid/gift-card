import { randomUUID } from 'node:crypto';

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

function isUniquePathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = 'code' in error ? String(error.code) : '';
  if (
    code === '23505' ||
    /duplicate key|unique constraint|already exists/i.test(error.message)
  ) {
    return true;
  }

  // Payload/Drizzle превращает 23505 в ValidationError и оставляет признак
  // уникальности в `data.errors[]`. Проверяем именно поле path, чтобы не
  // принять за коллизию любой другой validation failure вставки claim.
  const payloadErrorData: unknown = 'data' in error ? error.data : null;
  if (
    typeof payloadErrorData !== 'object' ||
    payloadErrorData === null ||
    !('errors' in payloadErrorData)
  ) {
    return false;
  }
  const errors: unknown = payloadErrorData.errors;
  const entries: readonly unknown[] = Array.isArray(errors) ? errors : [];
  return entries.some(
    (entry) =>
      isUnknownRecord(entry) &&
      entry.path === 'path' &&
      typeof entry.message === 'string' &&
      /unique|уникальн/i.test(entry.message),
  );
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function ownerLabel(collection: unknown): string {
  return collection === 'collections' ? 'подборкой' : 'открыткой';
}

/**
 * Атомарно занимает путь в текущей транзакции Payload.
 *
 * `req` передаётся и во вставку, и в чтение конфликта; `disableTransaction`
 * намеренно отсутствует. Поэтому claim откатывается вместе с неудачным
 * сохранением контента, а уникальный индекс закрывает гонку двух коллекций.
 */
export async function reserveContentPath(args: ReserveContentPathArgs): Promise<void> {
  try {
    await args.req.payload.create({
      collection: 'content-path-claims',
      data: {
        claimedAt: new Date().toISOString(),
        ownerCollection: args.collection,
        ownerKey: args.ownerKey,
        path: args.path,
      },
      overrideAccess: true,
      req: args.req,
    });
    return;
  } catch (error) {
    if (!isUniquePathError(error)) {
      throw error;
    }
  }

  const existing = await args.req.payload.find({
    collection: 'content-path-claims',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req: args.req,
    where: { path: { equals: args.path } },
  });
  const claim = existing.docs[0];

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
  const stored =
    isUnknownRecord(rawOriginalDoc) &&
    typeof rawOriginalDoc.pathClaimKey === 'string' &&
    rawOriginalDoc.pathClaimKey !== ''
      ? rawOriginalDoc.pathClaimKey
      : null;

  if (stored !== null) {
    return { ...next, pathClaimKey: stored };
  }
  if (operation === 'create' || operation === 'update') {
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
