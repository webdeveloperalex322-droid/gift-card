/**
 * Пишущие инструменты по подборкам и перевод записи в `review`.
 *
 * ═══ ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕ ПРОВЕРЯЕТСЯ ═══
 *
 * Допустимость родителя по виду узла (решение Ч-04-7 «порядок только повод →
 * уточнение»), сборка итогового пути из цепочки родителей, уникальность пути,
 * запрет года в адресе, зарезервированные маршруты — всё это живёт в
 * `collections/collection-path.ts` и хуках коллекции и применяется к ЛЮБОМУ
 * каналу записи. Повторять их здесь означало бы второй источник правды о форме
 * URL: разойдясь, две копии дали бы инструмент, который обещает принять то, что
 * хук отклонит, или наоборот — молча запрещает законное.
 *
 * Поэтому инструмент передаёт данные и ПЕРЕДАЁТ ОТКАЗ ХУКА НАРУЖУ дословно.
 * Текст отказа у хуков проекта написан для человека и объясняет причину — именно
 * он и нужен внешней модели, чтобы исправиться со второй попытки.
 *
 * ═══ `send_to_review` — ЕДИНСТВЕННЫЙ ПЕРЕХОД, ДОСТУПНЫЙ АГЕНТУ ═══
 *
 * `draft` → `review` и всё. `review` → `published` этим инструментом недостижим:
 * аргумента для статуса нет, а `canSetStatus` отклонил бы `published` у роли
 * `ai-editor` (п. 7.1, п. 23 ТЗ).
 *
 * ПОЛНОТУ ЗАПИСИ ЗДЕСЬ НЕ ПРОВЕРЯЕМ — и это исправление, а не упущение. Сначала
 * она проверялась и тут, вызовом `missingReviewFields`. Выяснилось, что набор
 * полей ему нужно передавать (`knownFields`), а взять его вне модуля коллекции
 * неоткуда: хуки берут его из `collectFieldNames(cardFields)`, то есть из
 * собственной схемы. Переданный вместо него список ключей ПРОЧИТАННОЙ записи
 * включал бы ровно те поля, что база отдала, а требование к отсутствующему ключу
 * `missingReviewFields` ПРОПУСКАЕТ — это предусмотренный люк для полей, которых
 * в схеме ещё нет. В результате незаполненное поле, отсутствующее в ответе базы,
 * проходило бы проверку инструмента: предварительный контроль оказался слабее
 * того, который он изображал.
 *
 * Поэтому полноту проверяет один хук, а инструмент передаёт его отказ наружу
 * дословно — в тексте отказа хука список незаполненных полей уже есть
 * (`planStatusTransition` строит его из `missingForReview`).
 *
 * Таблица допустимых переходов при этом ИМПОРТИРУЕТСЯ
 * (`ALLOWED_STATUS_TRANSITIONS`), а не повторяется: это данные, доступные вне
 * коллекции, и проверка по ним вторым источником правды не становится.
 */
import { COLLECTION_NODE_KINDS } from '../../collections/collection-path';
import { ALLOWED_STATUS_TRANSITIONS } from '../../collections/status-model';
import { contentDocumentPath } from '../../seo/paths';
import type { ToolSchema } from '../schema';
import { findCard } from './read-tools';
import {
  type ToolContext,
  type ToolDefinition,
  ToolRefusal,
  type WriteOutcome,
  appliedValues,
  definedOnly,
  diffApplied,
} from './types';

const NODE_TEXT_FIELDS = {
  description: {
    kind: 'string',
    description: 'Краткое видимое описание подборки. Обязательно для перехода в review.',
    maxLength: 2000,
  },
  h1: {
    kind: 'string',
    description: 'Заголовок H1. Если не задан, берётся из title — ТЗ требует раздельности полей.',
    maxLength: 200,
  },
  metaDescription: {
    kind: 'string',
    description:
      'Содержимое meta description. Обязательно для перехода в review; совпадение с другой ' +
      'записью каталога блокирует индексацию.',
    maxLength: 500,
  },
  title: { kind: 'string', description: 'Заголовок страницы (title)', maxLength: 200 },
} as const satisfies ToolSchema;

const CREATE_COLLECTION_SCHEMA = {
  ...NODE_TEXT_FIELDS,
  nodeKind: {
    kind: 'string',
    description:
      'Вид узла. group — группирующий узел, живёт только в корне /otkrytki (например ' +
      'prazdniki, adresaty). occasion — повод, то есть праздник, живёт под группой. ' +
      'recipient — уточнение (адресат), живёт под группой или под поводом. Порядок сегментов ' +
      'только «повод → уточнение»: обратный не создаётся никогда (решение Ч-04-7).',
    enum: COLLECTION_NODE_KINDS,
    required: true,
  },
  parentId: {
    kind: 'string',
    description:
      'Идентификатор родительского узла. Для вида group не задаётся: группа живёт в корне. ' +
      'Допустимость пары «вид × родитель» проверяет сервер и отказывает с объяснением.',
  },
  slug: {
    kind: 'string',
    description:
      'Сегмент URL узла. Для праздника с фиксированной датой — <число>-<месяц> (8-marta, ' +
      '9-maya), иначе короткое название (paskha, novyy-god). Год в адрес не добавляется. ' +
      'Максимум 80 символов.',
    maxLength: 80,
    required: true,
  },
  title: { ...NODE_TEXT_FIELDS.title, required: true },
} as const satisfies ToolSchema;

const UPDATE_COLLECTION_SCHEMA = {
  ...NODE_TEXT_FIELDS,
  id: { kind: 'string', description: 'Идентификатор узла. Либо id, либо path' },
  path: { kind: 'string', description: 'Итоговый путь узла, например /otkrytki/prazdniki/8-marta' },
} as const satisfies ToolSchema;

const SEND_TO_REVIEW_SCHEMA = {
  id: { kind: 'string', description: 'Идентификатор записи', required: true },
  kind: {
    kind: 'string',
    description: 'Что переводим: card — карточку открытки, collection — подборку',
    enum: ['card', 'collection'],
    required: true,
  },
} as const satisfies ToolSchema;

function nodeTextPayload(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return definedOnly({
    description: args.description,
    h1: args.h1,
    metaDescription: args.metaDescription,
    title: args.title,
  });
}

function nodeOutcome(args: {
  readonly created: boolean;
  readonly requested: Readonly<Record<string, unknown>>;
  readonly saved: Readonly<Record<string, unknown>>;
}): WriteOutcome {
  const { created, requested, saved } = args;
  return {
    applied: appliedValues({ requested, saved }),
    created,
    id: saved.id as number | string,
    ignored: diffApplied({ requested, saved }),
    path: contentDocumentPath('collections', saved),
    status: (saved.status as string | null) ?? null,
  };
}

async function findNodeByIdOrPath(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const id = typeof args.id === 'string' ? args.id : undefined;
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (id === undefined && path === undefined) {
    throw new ToolRefusal('Нужен либо id, либо path узла.');
  }
  const page = await ctx.gateway.findCollections({
    limit: 1,
    where: id === undefined ? { path: { equals: path } } : { id: { equals: id } },
  });
  const node = page.docs[0] as Record<string, unknown> | undefined;
  if (node === undefined) {
    throw new ToolRefusal(
      `Подборка не найдена: ${id === undefined ? `path «${String(path)}»` : `id «${String(id)}»`}.`,
    );
  }
  return node;
}

async function runCreateCollectionDraft(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const slug = args.slug as string;
  const nodeKind = args.nodeKind as string;
  const parentId = typeof args.parentId === 'string' ? args.parentId : undefined;

  // Идемпотентность по паре «slug + родитель»: у подборок уникален ИТОГОВЫЙ путь,
  // а не сегмент (slug «mame» законно живёт и под праздником, и в ветке адресатов).
  const existingPage = await ctx.gateway.findCollections({
    limit: 1,
    where:
      parentId === undefined
        // Родитель НЕ задан — ищем узел того же уровня, то есть корневой. Без
        // условия `parent: { exists: false }` поиск по одному slug находил бы
        // одноимённый узел, живущий под каким-то родителем, и вызов отвечал бы
        // «уже существует на этом уровне», отдавая путь ЧУЖОГО узла. URL при этом
        // не создавался и не менялся, но модель получала не ту запись, о которой
        // спрашивала, — а дальше правила бы её тексты.
        ? { and: [{ slug: { equals: slug } }, { parent: { exists: false } }] }
        : { and: [{ slug: { equals: slug } }, { parent: { equals: parentId } }] },
  });
  const existing = existingPage.docs[0] as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    return {
      ...nodeOutcome({ created: false, requested: {}, saved: existing }),
      note:
        `Подборка со slug «${slug}» на этом уровне уже существует, повторный вызов ничего не ` +
        'создал. Тексты не перезаписаны: для правки есть update_collection_text.',
    };
  }

  const data = {
    ...nodeTextPayload(args),
    nodeKind,
    slug,
    status: 'draft',
    ...(parentId === undefined ? {} : { parent: parentId }),
  };

  const saved = (await ctx.gateway.createCollection(data)) as unknown as Record<string, unknown>;
  const requested = { ...nodeTextPayload(args), nodeKind, slug };
  return nodeOutcome({ created: true, requested, saved });
}

async function runUpdateCollectionText(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const node = await findNodeByIdOrPath(ctx, args);
  const requested = nodeTextPayload(args);
  if (Object.keys(requested).length === 0) {
    throw new ToolRefusal('Не передано ни одного текстового поля для правки.');
  }
  const saved = (await ctx.gateway.updateCollection({
    data: requested,
    id: node.id as number | string,
  })) as unknown as Record<string, unknown>;
  return nodeOutcome({ created: false, requested, saved });
}

async function runSendToReview(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const kind = args.kind as 'card' | 'collection';
  const id = args.id as string;

  const doc =
    kind === 'card'
      ? ((await findCard(ctx, { id })) as unknown as Record<string, unknown>)
      : await findNodeByIdOrPath(ctx, { id });

  const status = typeof doc.status === 'string' ? doc.status : null;
  const allowed =
    status === null
      ? []
      : (ALLOWED_STATUS_TRANSITIONS[status as keyof typeof ALLOWED_STATUS_TRANSITIONS] ?? []);
  if (!allowed.includes('review') || status !== 'draft') {
    throw new ToolRefusal(
      `Запись в статусе «${status ?? 'неизвестно'}»; в review переводится только draft. ` +
        'Обратных переходов и перехода в published у этого инструмента нет: публикация — ' +
        'решение человека (п. 7.1 и п. 23 ТЗ).',
      'status',
    );
  }

  const requested = { status: 'review' };
  const saved =
    kind === 'card'
      ? ((await ctx.gateway.updateCard({
          data: requested,
          id: doc.id as number | string,
        })) as unknown as Record<string, unknown>)
      : ((await ctx.gateway.updateCollection({
          data: requested,
          id: doc.id as number | string,
        })) as unknown as Record<string, unknown>);

  return {
    applied: { status: saved.status ?? null },
    created: false,
    id: saved.id as number | string,
    ignored: diffApplied({ requested, saved }),
    note:
      'Запись в review: контент готов к проверке человеком. Она по-прежнему noindex и вне ' +
      'sitemap — публикует и открывает в индекс только человек.',
    path: contentDocumentPath(kind === 'card' ? 'cards' : 'collections', saved),
    status: (saved.status as string | null) ?? null,
  };
}

export const COLLECTION_TOOLS: readonly ToolDefinition[] = [
  {
    description:
      'Создать черновик подборки — узла таксономии. Итоговый путь собирается сервером из ' +
      'цепочки родителей, его передавать не нужно. Запись появляется в draft с noindex. ' +
      'Повторный вызов с тем же slug на том же уровне ничего не создаёт.',
    name: 'create_collection_draft',
    readOnly: false,
    run: runCreateCollectionDraft,
    schema: CREATE_COLLECTION_SCHEMA,
    title: 'Создать черновик подборки',
  },
  {
    description:
      'Поправить тексты подборки: title, H1, описание, meta description. slug, путь, статус, ' +
      'robots и canonical этим инструментом не меняются.',
    name: 'update_collection_text',
    readOnly: false,
    run: runUpdateCollectionText,
    schema: UPDATE_COLLECTION_SCHEMA,
    title: 'Поправить тексты подборки',
  },
  {
    description:
      'Перевести запись из draft в review — «готово к проверке человеком». Перед переводом ' +
      'проверяется полнота; при незаполненных полях вызов отказывает и перечисляет их. ' +
      'Публикация и открытие в index,follow этим инструментом недостижимы.',
    name: 'send_to_review',
    readOnly: false,
    run: runSendToReview,
    schema: SEND_TO_REVIEW_SCHEMA,
    title: 'Перевести в review',
  },
];
