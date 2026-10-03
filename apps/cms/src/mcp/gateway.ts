/**
 * ЕДИНСТВЕННОЕ место MCP-слоя, которое касается Payload.
 *
 * ═══ ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ ═══
 *
 * Решение Ч-35e разместило MCP-ручку внутри `apps/cms`, то есть на Local API. У
 * Local API `overrideAccess` по умолчанию равен `true` — он ходит МИМО всех прав
 * (разбор — в шапке `src/access/policies.ts`). Для слоя, который обслуживает
 * внешнюю LLM, это означает, что граница автоматизации проекта — «агент доводит
 * до review, публикует человек» — держалась бы на том, что никто не забыл
 * написать одну строку в одном из двенадцати инструментов.
 *
 * Поэтому здесь не «правило», а устройство:
 *
 *   1. `overrideAccess: false` и `user` зашиты в каждый вызов, и ПАРАМЕТРА, которым
 *      их можно переключить, в сигнатурах нет. Не «по умолчанию false» — такой
 *      возможности не существует;
 *   2. инструменты получают шлюз аргументом и другого доступа к данным не имеют;
 *   3. `gateway-isolation.test.ts` падает, если любой другой файл `src/mcp/**`
 *      упоминает `payload.`, `req.payload` или `overrideAccess`.
 *
 * Третий пункт — не придирка. Правило, живущее в комментарии, нарушается при
 * первой правке под давлением срока; правило, живущее в тесте, — нет.
 *
 * ═══ ПОЛЬЗОВАТЕЛЬ — ВЛАДЕЛЕЦ КЛЮЧА, НО КАНАЛ ОТКРЫТ ОДНОЙ РОЛИ ═══
 *
 * Актор берётся из предъявленного API-ключа, а не подставляется константой: автор
 * правки в `seo-history` обязан совпадать с владельцем ключа, иначе аудит теряет
 * смысл. Но сам канал допускает только роль `ai-editor` — это ограничение решения
 * Ч-35f, и оно проверяется до шлюза (`actor-lookup.ts`, {@link MCP_ALLOWED_ROLE}).
 *
 * Сначала здесь стоял довод «права принадлежат аккаунту, а не каналу», и ключ
 * любого аккаунта принимался. Довод неверен по последствиям: ключом `admin`
 * внешняя модель правила бы тексты уже опубликованных индексируемых страниц и
 * меняла изображение опубликованной карточки, минуя `review`, — для роли `admin`
 * правила прав этого не запрещают. Расширение канала на другие роли — решение
 * человека со своим номером.
 *
 * ═══ ПОЧЕМУ У ВЫБОРКИ ЕСТЬ ПОТОЛОК, А НЕ ТОЛЬКО ДЕФОЛТ ═══
 *
 * Внешняя модель охотно просит «все». Без потолка один вызов превращался бы в
 * выборку всего каталога в память процесса, обслуживающего ещё и рендер сайта.
 * Потолок применяется молча не бывает: инструменты обязаны сообщать признак
 * усечения (см. `tools/read-tools.ts`), иначе модель сочтёт тему готовой, не
 * увидев остатка.
 */
import type { PayloadRequest, Where } from 'payload';

import type { Card, CardImage, Collection } from '../payload-types';

/** Кто действует. Роль нужна инструментам для предсказания отказов по правам. */
export interface McpActor {
  readonly email?: string;
  readonly id: number | string;
  readonly role: string;
}

/** Максимум записей в одной выборке. Выше — урезается. */
export const GATEWAY_LIMIT_CEILING = 200;

export interface GatewayPage<T> {
  readonly docs: readonly T[];
  readonly totalDocs: number;
}

export interface FindArgs {
  readonly depth?: number;
  readonly limit?: number;
  readonly sort?: string;
  readonly where?: Where;
}

export interface McpGateway {
  readonly actor: McpActor;
  /**
   * Сколько карточек подходит под условие. Агрегат, а не длина выборки.
   *
   * Существует потому, что объём темы нельзя считать по выборке документов:
   * у неё есть потолок {@link GATEWAY_LIMIT_CEILING}, и при 200+ опубликованных
   * карточках порог Ч-06 считался бы по усечённому списку — то есть инструмент
   * сообщал бы заниженный объём и завышенную нехватку. Находка ревью 2026-10-03.
   */
  countCards(where?: Where): Promise<number>;
  /** Сколько узлов подходит под условие. Нужен, чтобы увидеть усечение дерева. */
  countCollections(where?: Where): Promise<number>;
  createCard(data: Readonly<Record<string, unknown>>): Promise<Card>;
  createCollection(data: Readonly<Record<string, unknown>>): Promise<Collection>;
  findCardImages(args: FindArgs): Promise<GatewayPage<CardImage>>;
  findCards(args: FindArgs): Promise<GatewayPage<Card>>;
  findCollections(args: FindArgs): Promise<GatewayPage<Collection>>;
  updateCard(args: {
    readonly data: Readonly<Record<string, unknown>>;
    readonly id: number | string;
  }): Promise<Card>;
  updateCollection(args: {
    readonly data: Readonly<Record<string, unknown>>;
    readonly id: number | string;
  }): Promise<Collection>;
}

/** Потолок применяется и к незаданному лимиту: иначе Payload подставил бы свой, более короткий. */
export function cappedLimit(limit: number | undefined): number {
  if (limit === undefined || limit > GATEWAY_LIMIT_CEILING) {
    return GATEWAY_LIMIT_CEILING;
  }
  return limit < 1 ? 1 : limit;
}

export function createGateway(args: {
  readonly actor: McpActor;
  readonly req: PayloadRequest;
}): McpGateway {
  const { actor, req } = args;

  // Общая часть каждого вызова. Собрана один раз и ровно потому, что повторение
  // `overrideAccess: false` в семи местах — это семь мест, где его можно забыть.
  const guarded = { overrideAccess: false, req, user: req.user } as const;

  const find = async <T>(
    collection: 'card-images' | 'cards' | 'collections',
    findArgs: FindArgs,
  ): Promise<GatewayPage<T>> => {
    const page = await req.payload.find({
      ...guarded,
      collection,
      depth: findArgs.depth ?? 0,
      limit: cappedLimit(findArgs.limit),
      ...(findArgs.sort === undefined ? {} : { sort: findArgs.sort }),
      ...(findArgs.where === undefined ? {} : { where: findArgs.where }),
    });
    // Приведение через unknown: `find` типизирован объединением трёх коллекций,
    // а вызывающий знает, какую именно просил. Сузить объединение параметром
    // нельзя, не продублировав сигнатуру на каждую коллекцию.
    return { docs: page.docs as unknown as readonly T[], totalDocs: page.totalDocs };
  };

  return {
    actor,

    countCards: async (where) => {
      const { totalDocs } = await req.payload.count({
        ...guarded,
        collection: 'cards',
        ...(where === undefined ? {} : { where }),
      });
      return totalDocs;
    },

    countCollections: async (where) => {
      const { totalDocs } = await req.payload.count({
        ...guarded,
        collection: 'collections',
        ...(where === undefined ? {} : { where }),
      });
      return totalDocs;
    },

    createCard: async (data) =>
      (await req.payload.create({
        ...guarded,
        collection: 'cards',
        data: data as never,
      })),

    createCollection: async (data) =>
      (await req.payload.create({
        ...guarded,
        collection: 'collections',
        data: data as never,
      })),

    findCardImages: async (findArgs) => find<CardImage>('card-images', findArgs),

    findCards: async (findArgs) => find<Card>('cards', findArgs),

    findCollections: async (findArgs) => find<Collection>('collections', findArgs),

    updateCard: async ({ data, id }) =>
      (await req.payload.update({
        ...guarded,
        collection: 'cards',
        data: data,
        id,
      })),

    updateCollection: async ({ data, id }) =>
      (await req.payload.update({
        ...guarded,
        collection: 'collections',
        data: data,
        id,
      })),
  };
}
