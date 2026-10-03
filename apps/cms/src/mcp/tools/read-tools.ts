/**
 * Инструменты чтения: чем внешняя модель ориентируется, прежде чем писать.
 *
 * Без них LLM пишет вслепую — и первое, что она сделает, это создаст двадцатую
 * открытку в теме, где уже есть сорок, и напишет description, который дословно
 * повторяет чужой. Поэтому читающих инструментов здесь столько же, сколько
 * пишущих, а `catalog_overview` отдаёт не «список тем», а именно то число,
 * которое решает: сколько опубликованных открыток не хватает до порога Ч-06.
 *
 * ЧИСЛА ЗДЕСЬ НЕ ПЕРЕСЧИТЫВАЮТСЯ ЗАНОВО. Порог берётся из
 * `collection-volume.ts` (решение Ч-06 живёт там), область счёта — из
 * `VOLUME_SCOPE` (у группирующего узла своих открыток нет, поэтому порог
 * считается по поддереву), адрес записи — из `contentDocumentPath`. Своя копия
 * любого из трёх правил означала бы, что отчёт показывает одно, а хук при
 * публикации требует другого.
 */
import {
  type CollectionNodeKind,
  COLLECTION_NODE_KINDS,
} from '../../collections/collection-path';
import { VOLUME_SCOPE, resolveMinPublishedCards } from '../../collections/collection-volume';
import { META_DUPLICATE_FIELDS, normalizeMetaValue } from '../../collections/meta-duplicates';
import { contentDocumentPath } from '../../seo/paths';
import type { ToolSchema } from '../schema';
import { type ToolContext, type ToolDefinition, ToolRefusal, truncation } from './types';

/**
 * Поля подборки, которые читают инструменты.
 *
 * Индексная подпись стоит здесь не для вольности: запись уходит в
 * `contentDocumentPath`, который принимает произвольный документ, и без подписи
 * каждый такой вызов требовал бы приведения типа. Приведение в десяти местах
 * прячет ошибку лучше, чем одна честная подпись.
 */
interface NodeRecord {
  readonly [key: string]: unknown;
  readonly id: number | string;
  readonly metaDescription?: string | null;
  readonly nodeKind?: string | null;
  readonly parent?: unknown;
  readonly path?: string | null;
  readonly robots?: string | null;
  readonly slug?: string | null;
  readonly status?: string | null;
  readonly title?: string | null;
}

interface CardRecord {
  readonly [key: string]: unknown;
  readonly alt?: string | null;
  readonly caption?: string | null;
  readonly collections?: unknown;
  readonly description?: string | null;
  readonly id: number | string;
  readonly image?: unknown;
  readonly metaDescription?: string | null;
  readonly pHash?: string | null;
  readonly robots?: string | null;
  readonly slug?: string | null;
  readonly status?: string | null;
  readonly title?: string | null;
  readonly usageTerms?: string | null;
}

/** Идентификатор связи: на `depth: 0` Payload отдаёт число или строку, не объект. */
function relationIds(value: unknown): (number | string)[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => relationIds(item));
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value).id;
    return typeof id === 'number' || typeof id === 'string' ? [id] : [];
  }
  return [];
}


/* ------------------------------------------------------------------ */
/* catalog_overview                                                    */
/* ------------------------------------------------------------------ */

const CATALOG_OVERVIEW_SCHEMA = {
  nodeKind: {
    kind: 'string',
    description:
      'Оставить в ответе только узлы этого вида: group — группирующий узел ' +
      '(/otkrytki/prazdniki), occasion — повод (праздник), recipient — уточнение (адресат). ' +
      'Без значения отдаются все.',
    enum: COLLECTION_NODE_KINDS,
  },
  limit: { kind: 'integer', description: 'Сколько узлов отдать, максимум 200', max: 200, min: 1 },
} as const satisfies ToolSchema;

/**
 * Объём темы считается АГРЕГАТОМ, а не длиной выборки.
 *
 * Сначала здесь читались все опубликованные карточки одним `findCards` и
 * раскладывались по узлам в памяти. У выборки есть потолок
 * `GATEWAY_LIMIT_CEILING` = 200, поэтому при 200+ опубликованных карточках
 * `publishedCards` занижался, `missingForIndex` завышался, а признака усечения по
 * карточкам в ответе не было вовсе — то самое «молчаливое усечение», которое
 * запрещает шапка `tools/types.ts`. Направление ошибки безопасно для индексации
 * (тема выглядит недонаполненной), но оно толкало бы модель создавать открытки
 * сверх ориентира 20–40 из п. 5.1. Совпавшая находка ревью и SEO-приёмки
 * 2026-10-03.
 *
 * Теперь на каждый возвращаемый узел уходит один `count` — цена известна и
 * ограничена пределом `limit` этого инструмента, а потолка у результата нет.
 */
async function runCatalogOverview(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const nodeKind = typeof args.nodeKind === 'string' ? args.nodeKind : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;

  const nodesPage = await ctx.gateway.findCollections({
    ...(limit === undefined ? {} : { limit }),
    sort: 'path',
    ...(nodeKind === undefined ? {} : { where: { nodeKind: { equals: nodeKind } } }),
  });
  const nodes = nodesPage.docs as unknown as readonly NodeRecord[];

  // Дерево целиком нужно для счёта по поддереву: у группирующего узла своих
  // открыток нет, и без полного дерева его объём оказался бы нулевым всегда.
  // Усечение САМОГО дерева тоже обязано быть видно — иначе сумма группы молча
  // потеряла бы дальних детей.
  const treePage = await ctx.gateway.findCollections({});
  const tree = treePage.docs as unknown as readonly NodeRecord[];
  const treeTotal = await ctx.gateway.countCollections();
  const treeTruncated = tree.length < treeTotal;

  const childrenOf = new Map<string, NodeRecord[]>();
  for (const node of tree) {
    for (const parentId of relationIds(node.parent)) {
      const key = String(parentId);
      const list = childrenOf.get(key) ?? [];
      list.push(node);
      childrenOf.set(key, list);
    }
  }

  /** Идентификаторы узла и всего его поддерева. */
  const subtreeIds = (node: NodeRecord): (number | string)[] => {
    const collected: (number | string)[] = [];
    const seen = new Set<string>();
    const walk = (current: NodeRecord): void => {
      const key = String(current.id);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      collected.push(current.id);
      for (const child of childrenOf.get(key) ?? []) {
        walk(child);
      }
    };
    walk(node);
    return collected;
  };

  const threshold = resolveMinPublishedCards();

  const items = await Promise.all(
    nodes.map(async (node) => {
      const kind = (node.nodeKind ?? 'occasion') as CollectionNodeKind;
      const scope = VOLUME_SCOPE[kind] ?? 'own';
      const ids = scope === 'subtree' ? subtreeIds(node) : [node.id];
      const published = await ctx.gateway.countCards({
        and: [{ status: { equals: 'published' } }, { collections: { in: ids } }],
      });
      // При усечённом дереве сумма по поддереву неполна, и выдавать её за объём
      // темы нельзя: честнее не называть число, чем назвать меньшее.
      const volumeKnown = scope === 'own' || !treeTruncated;
      return {
        id: node.id,
        indexThreshold: threshold,
        // Сколько не хватает до порога Ч-06. Ноль означает «порог объёма выполнен»,
        // а НЕ «можно открывать в индекс»: остальные условия п. 5.1 (спрос,
        // уникальность текстов, навигация) машиной не проверяются и остаются за
        // человеком, и решение всё равно его.
        missingForIndex: volumeKnown ? Math.max(0, threshold - published) : null,
        nodeKind: node.nodeKind ?? null,
        path: contentDocumentPath('collections', node),
        publishedCards: volumeKnown ? published : null,
        robots: node.robots ?? null,
        status: node.status ?? null,
        title: node.title ?? null,
        volumeKnown,
        volumeScope: scope,
      };
    }),
  );

  return {
    note:
      'missingForIndex = 0 означает выполненный порог объёма (решение Ч-06), а не разрешение ' +
      'открыть тему в index,follow: это решение принимает человек, и остальные условия п. 5.1 ' +
      'машиной не проверяются. Числа считаются агрегатом по базе, а не по усечённой выборке. ' +
      'volumeKnown: false означает, что дерево таксономии не влезло в выборку целиком и объём ' +
      'поддерева назвать нечем — в этом случае publishedCards и missingForIndex равны null.',
    nodes: items,
    tree: { returned: tree.length, total: treeTotal, truncated: treeTruncated },
    ...truncation({ returned: nodes.length, total: nodesPage.totalDocs }),
  };
}

/* ------------------------------------------------------------------ */
/* collection_get                                                      */
/* ------------------------------------------------------------------ */

const COLLECTION_GET_SCHEMA = {
  id: { kind: 'string', description: 'Идентификатор узла. Либо id, либо path' },
  path: { kind: 'string', description: 'Итоговый путь узла, например /otkrytki/prazdniki/8-marta' },
} as const satisfies ToolSchema;

async function findNode(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<NodeRecord> {
  const id = typeof args.id === 'string' ? args.id : undefined;
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (id === undefined && path === undefined) {
    throw new ToolRefusal('Нужен либо id, либо path узла.');
  }
  const page = await ctx.gateway.findCollections({
    limit: 1,
    where: id === undefined ? { path: { equals: path } } : { id: { equals: id } },
  });
  const node = page.docs[0] as unknown as NodeRecord | undefined;
  if (node === undefined) {
    throw new ToolRefusal(
      `Узел не найден: ${id === undefined ? `path «${String(path)}»` : `id «${String(id)}»`}. ` +
        'Пустой результат отдаётся отказом, а не null: иначе «узла нет» и «узел пустой» ' +
        'выглядели бы одинаково.',
    );
  }
  return node;
}

async function runCollectionGet(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const node = await findNode(ctx, args);

  const childrenPage = await ctx.gateway.findCollections({
    where: { parent: { equals: node.id } },
  });
  const cardsPage = await ctx.gateway.findCards({
    where: { collections: { in: [node.id] } },
  });

  return {
    cards: (cardsPage.docs as unknown as readonly CardRecord[]).map((card) => ({
      hasImage: relationIds(card.image).length > 0,
      id: card.id,
      path: contentDocumentPath('cards', card),
      robots: card.robots ?? null,
      status: card.status ?? null,
      title: card.title ?? null,
    })),
    cardsTruncation: truncation({
      returned: cardsPage.docs.length,
      total: cardsPage.totalDocs,
    }),
    children: (childrenPage.docs as unknown as readonly NodeRecord[]).map((child) => ({
      id: child.id,
      nodeKind: child.nodeKind ?? null,
      path: contentDocumentPath('collections', child),
      status: child.status ?? null,
      title: child.title ?? null,
    })),
    node: {
      id: node.id,
      metaDescription: node.metaDescription ?? null,
      nodeKind: node.nodeKind ?? null,
      parentId: relationIds(node.parent)[0] ?? null,
      path: contentDocumentPath('collections', node),
      robots: node.robots ?? null,
      slug: node.slug ?? null,
      status: node.status ?? null,
      title: node.title ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* card_get                                                            */
/* ------------------------------------------------------------------ */

const CARD_GET_SCHEMA = {
  id: { kind: 'string', description: 'Идентификатор карточки' },
  slug: { kind: 'string', description: 'slug карточки; её путь — /otkrytki/<slug>' },
} as const satisfies ToolSchema;

export async function findCard(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<CardRecord> {
  const id = typeof args.id === 'string' ? args.id : undefined;
  const slug = typeof args.slug === 'string' ? args.slug : undefined;
  if (id === undefined && slug === undefined) {
    throw new ToolRefusal('Нужен либо id, либо slug карточки.');
  }
  const page = await ctx.gateway.findCards({
    limit: 1,
    where: id === undefined ? { slug: { equals: slug } } : { id: { equals: id } },
  });
  const card = page.docs[0] as unknown as CardRecord | undefined;
  if (card === undefined) {
    throw new ToolRefusal(
      `Карточка не найдена: ${id === undefined ? `slug «${String(slug)}»` : `id «${String(id)}»`}.`,
    );
  }
  return card;
}

async function runCardGet(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const card = await findCard(ctx, args);
  return {
    alt: card.alt ?? null,
    caption: card.caption ?? null,
    collectionIds: relationIds(card.collections),
    description: card.description ?? null,
    hasImage: relationIds(card.image).length > 0,
    id: card.id,
    imageId: relationIds(card.image)[0] ?? null,
    metaDescription: card.metaDescription ?? null,
    path: contentDocumentPath('cards', card),
    robots: card.robots ?? null,
    slug: card.slug ?? null,
    status: card.status ?? null,
    title: card.title ?? null,
    usageTerms: card.usageTerms ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* find_weak_content                                                   */
/* ------------------------------------------------------------------ */

const FIND_WEAK_CONTENT_SCHEMA = {
  limit: { kind: 'integer', description: 'Сколько записей просмотреть, максимум 200', max: 200, min: 1 },
} as const satisfies ToolSchema;

interface WeakFinding {
  readonly id: number | string;
  readonly path: string | null;
  readonly problems: readonly string[];
  readonly status: string | null;
  readonly title: string | null;
}

/**
 * Повторы значения по выборке.
 *
 * Нормализация — та же, что у проверки дублей метатегов (`normalizeMetaValue`):
 * иначе «Открытка  мужу» и «Открытка мужу» считались бы разными, а хук при
 * сохранении назвал бы их дублем.
 */
function duplicateValues(
  docs: readonly Readonly<Record<string, unknown>>[],
  field: string,
): Set<string> {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    const normalized = normalizeMetaValue(doc[field]);
    if (normalized === null) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value));
}

async function runFindWeakContent(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const limit = typeof args.limit === 'number' ? args.limit : undefined;
  const cardsPage = await ctx.gateway.findCards({ ...(limit === undefined ? {} : { limit }) });
  const nodesPage = await ctx.gateway.findCollections({
    ...(limit === undefined ? {} : { limit }),
  });

  const cards = cardsPage.docs as unknown as readonly CardRecord[];
  const nodes = nodesPage.docs as unknown as readonly NodeRecord[];
  const all: readonly Readonly<Record<string, unknown>>[] = [...cards, ...nodes];

  const duplicates = new Map<string, Set<string>>();
  for (const field of META_DUPLICATE_FIELDS) {
    duplicates.set(field, duplicateValues(all, field));
  }

  const describe = (
    doc: Readonly<Record<string, unknown>>,
    collection: 'cards' | 'collections',
  ): WeakFinding | null => {
    const problems: string[] = [];
    for (const field of META_DUPLICATE_FIELDS) {
      const normalized = normalizeMetaValue(doc[field]);
      if (normalized === null) {
        problems.push(`${field} не заполнено`);
        continue;
      }
      if (duplicates.get(field)?.has(normalized) === true) {
        problems.push(`${field} повторяется у другой записи каталога`);
      }
    }
    if (collection === 'cards') {
      if (relationIds(doc.image).length === 0) {
        problems.push('нет изображения');
      }
      if (normalizeMetaValue(doc.alt) === null) {
        problems.push('alt не заполнен');
      }
      if (relationIds(doc.collections).length === 0) {
        problems.push('не привязана ни к одной подборке');
      }
    }
    if (problems.length === 0) {
      return null;
    }
    return {
      id: doc.id as number | string,
      path: contentDocumentPath(collection, doc),
      problems,
      status: (doc.status as string | null) ?? null,
      title: (doc.title as string | null) ?? null,
    };
  };

  const cardFindings = cards
    .map((card) => describe(card as Record<string, unknown>, 'cards'))
    .filter((finding): finding is WeakFinding => finding !== null);
  const nodeFindings = nodes
    .map((node) => describe(node as Record<string, unknown>, 'collections'))
    .filter((finding): finding is WeakFinding => finding !== null);

  return {
    cards: cardFindings,
    cardsTruncation: truncation({ returned: cards.length, total: cardsPage.totalDocs }),
    collections: nodeFindings,
    collectionsTruncation: truncation({ returned: nodes.length, total: nodesPage.totalDocs }),
    note:
      'Повторы считаются по просмотренной выборке. При truncated: true список повторов — ' +
      'нижняя граница: за пределами выборки могут быть ещё.',
  };
}

/* ------------------------------------------------------------------ */
/* check_duplicates                                                    */
/* ------------------------------------------------------------------ */

const CHECK_DUPLICATES_SCHEMA = {
  excludeId: {
    kind: 'string',
    description: 'Не считать совпадением эту запись — её собственный id при правке',
  },
  metaDescription: { kind: 'string', description: 'Проверяемый meta description' },
  title: { kind: 'string', description: 'Проверяемый заголовок' },
} as const satisfies ToolSchema;

/**
 * Совпадения ищутся ЗАПРОСОМ ПО НОРМАЛИЗОВАННЫМ КЛЮЧАМ, а не сверкой выборки.
 *
 * Сначала инструмент выгружал каталог (с потолком 200 карточек и 200 подборок) и
 * сравнивал значения в памяти. Для инструмента, единственное назначение которого —
 * найти дубль, это означало ложное «конфликтов нет» всюду за окном выборки.
 * Находка ревью 2026-10-03.
 *
 * Искать есть по чему: `titleKey` и `metaDescriptionKey` — индексированные поля, в
 * которых лежит ровно `normalizeMetaValue` от соответствующего текста, и тот же
 * способ использует хук проверки дублей (`collections/content-hooks.ts`). Поэтому
 * здесь не появляется второго правила о том, что считать дублем: нормализация
 * одна, поля те же.
 */
async function runCheckDuplicates(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const title = typeof args.title === 'string' ? args.title : undefined;
  const metaDescription =
    typeof args.metaDescription === 'string' ? args.metaDescription : undefined;
  const excludeId = typeof args.excludeId === 'string' ? args.excludeId : undefined;

  const titleKey = normalizeMetaValue(title);
  const descriptionKey = normalizeMetaValue(metaDescription);

  if (titleKey === null && descriptionKey === null) {
    throw new ToolRefusal(
      'Нужно передать хотя бы title или metaDescription непустым значением.',
    );
  }

  const keyMatch = [
    ...(titleKey === null ? [] : [{ titleKey: { equals: titleKey } }]),
    ...(descriptionKey === null ? [] : [{ metaDescriptionKey: { equals: descriptionKey } }]),
  ];
  const where = { or: keyMatch };

  const [cardsPage, nodesPage] = await Promise.all([
    ctx.gateway.findCards({ where }),
    ctx.gateway.findCollections({ where }),
  ]);

  const conflicts: {
    collection: string;
    field: string;
    id: number | string;
    path: string | null;
    status: string | null;
    title: string | null;
  }[] = [];

  const collect = (
    docs: readonly Readonly<Record<string, unknown>>[],
    collection: 'cards' | 'collections',
  ): void => {
    for (const doc of docs) {
      if (excludeId !== undefined && String(doc.id) === excludeId) {
        continue;
      }
      for (const field of META_DUPLICATE_FIELDS) {
        const incoming = field === 'title' ? titleKey : descriptionKey;
        if (incoming === null) {
          continue;
        }
        if (normalizeMetaValue(doc[field]) !== incoming) {
          continue;
        }
        conflicts.push({
          collection,
          field,
          id: doc.id as number | string,
          path: contentDocumentPath(collection, doc),
          status: (doc.status as string | null) ?? null,
          title: (doc.title as string | null) ?? null,
        });
      }
    }
  };

  collect(cardsPage.docs as unknown as readonly Readonly<Record<string, unknown>>[], 'cards');
  collect(
    nodesPage.docs as unknown as readonly Readonly<Record<string, unknown>>[],
    'collections',
  );

  const total = cardsPage.totalDocs + nodesPage.totalDocs;
  const returned = cardsPage.docs.length + nodesPage.docs.length;

  return {
    checked: { metaDescription: metaDescription ?? null, title: title ?? null },
    conflicts,
    note:
      'Поиск идёт запросом по индексированным нормализованным ключам (titleKey, ' +
      'metaDescriptionKey), то есть по всему каталогу, а не по части выборки. Регистр и ' +
      'повторные пробелы на результат не влияют — нормализация та же, что у хука проверки ' +
      'дублей. Визуально похожие изображения этот инструмент не ищет: pHash считается при ' +
      'загрузке файла, а загрузка изображений через MCP не идёт (решение Ч-35c).',
    // Усечение возможно только если СОВПАДЕНИЙ больше потолка выборки. Это уже
    // означает «дубль есть», поэтому вывод инструмента от усечения не меняется, —
    // но признак всё равно отдаётся, а не скрывается.
    matches: truncation({ returned, total }),
  };
}

/* ------------------------------------------------------------------ */

export const READ_TOOLS: readonly ToolDefinition[] = [
  {
    description:
      'Состояние таксономии: узлы с путями, статусами, robots-директивой, числом ' +
      'опубликованных открыток и тем, сколько открыток не хватает до порога индексации ' +
      '(20 по решению Ч-06). Первое, что стоит вызвать перед наполнением темы.',
    name: 'catalog_overview',
    readOnly: true,
    run: runCatalogOverview,
    schema: CATALOG_OVERVIEW_SCHEMA,
    title: 'Обзор каталога',
  },
  {
    description:
      'Подборка (узел таксономии) целиком: её поля, родитель, дочерние узлы и входящие ' +
      'открытки со статусами. Ищется по path или id.',
    name: 'collection_get',
    readOnly: true,
    run: runCollectionGet,
    schema: COLLECTION_GET_SCHEMA,
    title: 'Прочитать подборку',
  },
  {
    description: 'Карточка открытки целиком: тексты, привязки, наличие изображения, статус.',
    name: 'card_get',
    readOnly: true,
    run: runCardGet,
    schema: CARD_GET_SCHEMA,
    title: 'Прочитать карточку',
  },
  {
    description:
      'Слабые места каталога: незаполненные и повторяющиеся title и meta description, ' +
      'карточки без изображения, без alt и без привязки к подборкам. Список того, что ' +
      'нужно починить перед переводом в review.',
    name: 'find_weak_content',
    readOnly: true,
    run: runFindWeakContent,
    schema: FIND_WEAK_CONTENT_SCHEMA,
    title: 'Найти слабый контент',
  },
  {
    description:
      'Проверить, не повторяют ли предложенные title и meta description уже существующие ' +
      'в каталоге. Вызывать ДО записи: совпадение метатегов блокирует переход записи в ' +
      'индексируемое состояние.',
    name: 'check_duplicates',
    readOnly: true,
    run: runCheckDuplicates,
    schema: CHECK_DUPLICATES_SCHEMA,
    title: 'Проверить дубли',
  },
];
