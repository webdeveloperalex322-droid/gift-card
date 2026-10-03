/**
 * Двойник шлюза для юнит-тестов инструментов.
 *
 * Лежит в исходниках, а не в тесте, потому что нужен трём тестовым файлам сразу,
 * а копия двойника в каждом означала бы три разных представления об одном
 * контракте. Payload здесь не упоминается ВООБЩЕ — что и проверяет
 * `gateway-isolation.test.ts`: двойник обязан быть заменой шлюза, а не второй
 * дорожкой к данным.
 *
 * Фильтрация реализована ровно в том объёме, который нужен инструментам:
 * `equals` по полю, `in` по связи и `and` из двух условий. Полноценный движок
 * `Where` здесь был бы имитацией базы — а инструменты проверяются не на том, как
 * Payload фильтрует, а на том, что они просят и как поступают с ответом.
 */
import type { FindArgs, GatewayPage, McpActor, McpGateway } from '../gateway';

export type Row = Record<string, unknown>;

export interface GatewayCalls {
  createCard: Row[];
  createCollection: Row[];
  findCardImages: FindArgs[];
  findCards: FindArgs[];
  findCollections: FindArgs[];
  updateCard: { data: Row; id: number | string }[];
  updateCollection: { data: Row; id: number | string }[];
}

export interface FakeGateway extends McpGateway {
  readonly calls: GatewayCalls;
  readonly rows: { cardImages: Row[]; cards: Row[]; collections: Row[] };
}

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) {
    return true;
  }
  const clause = where as Record<string, unknown>;

  if (Array.isArray(clause.and)) {
    return clause.and.every((part) => matches(row, part));
  }

  for (const [field, condition] of Object.entries(clause)) {
    if (typeof condition !== 'object' || condition === null) {
      continue;
    }
    const spec = condition as Record<string, unknown>;
    if ('equals' in spec) {
      const expected = spec.equals;
      const actual = row[field];
      const normalized = Array.isArray(actual) ? actual.map((item) => String(item)) : null;
      const ok =
        normalized === null
          ? String(actual) === String(expected)
          : normalized.includes(String(expected));
      if (!ok) {
        return false;
      }
    }
    if ('in' in spec && Array.isArray(spec.in)) {
      const wanted = spec.in.map((item) => String(item));
      const actual = row[field];
      const values = Array.isArray(actual) ? actual.map((item) => String(item)) : [String(actual)];
      if (!values.some((value) => wanted.includes(value))) {
        return false;
      }
    }
  }
  return true;
}

export function createFakeGateway(args: {
  readonly actor?: McpActor;
  readonly cardImages?: readonly Row[];
  readonly cards?: readonly Row[];
  readonly collections?: readonly Row[];
  /** Заставить создание карточки упасть ошибкой уникального индекса один раз. */
  readonly createCardThrowsDuplicateOnce?: boolean;
}): FakeGateway {
  const rows = {
    cardImages: [...(args.cardImages ?? [])],
    cards: [...(args.cards ?? [])],
    collections: [...(args.collections ?? [])],
  };
  const calls: GatewayCalls = {
    createCard: [],
    createCollection: [],
    findCardImages: [],
    findCards: [],
    findCollections: [],
    updateCard: [],
    updateCollection: [],
  };
  let duplicatePending = args.createCardThrowsDuplicateOnce === true;
  let nextId = 1000;

  const page = <T>(source: readonly Row[], findArgs: FindArgs): GatewayPage<T> => {
    const filtered = source.filter((row) => matches(row, findArgs.where));
    const limit = findArgs.limit ?? filtered.length;
    return { docs: filtered.slice(0, limit) as readonly T[], totalDocs: filtered.length };
  };

  const update = (source: Row[], id: number | string, data: Row): Row => {
    const index = source.findIndex((row) => String(row.id) === String(id));
    if (index === -1) {
      throw new Error(`Запись ${String(id)} не найдена в двойнике шлюза`);
    }
    const current = source[index] as Row;
    const updated = { ...current, ...data };
    source[index] = updated;
    return updated;
  };

  return {
    actor: args.actor ?? { id: 42, role: 'ai-editor' },
    calls,
    rows,

    createCard: (data) => {
      calls.createCard.push({ ...data });
      if (duplicatePending) {
        duplicatePending = false;
        const slug = String(data.slug);
        rows.cards.push({ ...data, id: nextId++, slug });
        return Promise.reject(
          new Error('duplicate key value violates unique constraint "cards_slug_idx"'),
        );
      }
      const created = { ...data, id: nextId++ };
      rows.cards.push(created);
      return Promise.resolve(created as never);
    },

    createCollection: (data) => {
      calls.createCollection.push({ ...data });
      const created = { ...data, id: nextId++, path: `/otkrytki/${String(data.slug)}` };
      rows.collections.push(created);
      return Promise.resolve(created as never);
    },

    findCardImages: (findArgs) => {
      calls.findCardImages.push(findArgs);
      return Promise.resolve(page(rows.cardImages, findArgs));
    },

    findCards: (findArgs) => {
      calls.findCards.push(findArgs);
      return Promise.resolve(page(rows.cards, findArgs));
    },

    findCollections: (findArgs) => {
      calls.findCollections.push(findArgs);
      return Promise.resolve(page(rows.collections, findArgs));
    },

    updateCard: ({ data, id }) => {
      calls.updateCard.push({ data: { ...data }, id });
      return Promise.resolve(update(rows.cards, id, data) as never);
    },

    updateCollection: ({ data, id }) => {
      calls.updateCollection.push({ data: { ...data }, id });
      return Promise.resolve(update(rows.collections, id, data) as never);
    },
  };
}
