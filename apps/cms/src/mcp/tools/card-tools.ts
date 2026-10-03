/**
 * Пишущие инструменты по карточкам.
 *
 * ═══ ИДЕМПОТЕНТНОСТЬ ПО SLUG, А НЕ ПО ВЫДУМАННОМУ КЛЮЧУ ═══
 *
 * Внешняя модель ретраит охотно, а лишняя карточка — это лишний канонический URL
 * и занятый навсегда claim пути (`content_path_claims` не освобождается). Значит
 * повторный вызов обязан вернуть существующую запись, а не создать вторую.
 *
 * Ключом идемпотентности взят `slug`. Рассматривался и отвергнут
 * `sourceImportKey`: он привязан к пространству `generated-library-2026-08`,
 * проверяется регексом на sha256 и пишется только из доверенного контекста
 * (`src/import/source-import-identity.ts`), поэтому использовать его здесь
 * значило бы расширить протестированную идентичность импорта под чужую задачу.
 * А у домена уже есть идентичность сильнее любого внешнего ключа — канонический
 * путь, и он же защищён уникальным индексом и claim'ом. Поэтому: сначала поиск по
 * slug, и вторая попытка чтения, если создание упёрлось в уникальный индекс
 * (гонка двух одинаковых вызовов — не ошибка вызывающего, а ровно тот случай,
 * для которого идемпотентность и нужна).
 *
 * ═══ СТАТУС ЗАДАЁТСЯ ЗДЕСЬ И ТОЛЬКО `draft` ═══
 *
 * Новая запись создаётся в `draft` с `noindex` — это правило модели, а не
 * предпочтение. Передать статус аргументом нельзя: его нет в схемах
 * инструментов, а лишнее поле схема отвергает громко. Даже если бы передали,
 * `canSetStatus` отклонил бы `published` для `ai-editor`, — но полагаться на
 * второй рубеж, не выставив первый, здесь незачем.
 */
import { contentDocumentPath } from '../../seo/paths';
import type { ToolSchema } from '../schema';
import { findCard } from './read-tools';
import {
  type IgnoredField,
  type ToolContext,
  type ToolDefinition,
  ToolRefusal,
  type WriteOutcome,
  appliedValues,
  definedOnly,
  diffApplied,
} from './types';

/** Поля карточки, которые внешний редактор вправе заполнять. */
const TEXT_FIELDS = {
  alt: {
    kind: 'string',
    description:
      'Естественное описание изображения для alt. Не перечень ключевых слов: alt читают ' +
      'люди со скринридером, и перечисление ключей им бесполезно.',
    maxLength: 300,
  },
  caption: {
    kind: 'string',
    description: 'Видимая подпись или текст поздравления на странице',
    maxLength: 2000,
  },
  description: { kind: 'string', description: 'Видимое описание открытки', maxLength: 2000 },
  metaDescription: {
    kind: 'string',
    description:
      'Содержимое meta description. Обязательно для перехода в review. Шаблонный текст с ' +
      'заменой пары слов запрещён (п. 23 ТЗ): совпадение с другой записью блокирует индексацию.',
    maxLength: 500,
  },
  title: { kind: 'string', description: 'Заголовок страницы (title)', maxLength: 200 },
  usageTerms: { kind: 'string', description: 'Условия использования открытки', maxLength: 1000 },
} as const satisfies ToolSchema;

const CREATE_CARD_SCHEMA = {
  ...TEXT_FIELDS,
  alt: { ...TEXT_FIELDS.alt, required: true },
  collectionIds: {
    kind: 'idList',
    description: 'Подборки, в которые входит открытка. Копий URL не создаёт — путь один.',
    maxItems: 50,
  },
  imageId: {
    kind: 'string',
    description:
      'Идентификатор уже загруженного изображения из коллекции card-images. Байты через MCP ' +
      'не передаются (решение Ч-35c): файлы грузятся скриптами импорта или руками в админке.',
  },
  slug: {
    kind: 'string',
    description:
      'Сегмент URL карточки: её адрес — /otkrytki/<slug>. Строчные латинские буквы, цифры и ' +
      'дефисы, максимум 80 символов. Адрес неизменяем после первой публикации, поэтому ' +
      'повторный вызов с тем же slug ничего не создаёт, а возвращает существующую карточку.',
    maxLength: 80,
    required: true,
  },
  title: { ...TEXT_FIELDS.title, required: true },
} as const satisfies ToolSchema;

const UPDATE_CARD_SCHEMA = {
  ...TEXT_FIELDS,
  id: { kind: 'string', description: 'Идентификатор карточки. Либо id, либо slug' },
  slug: { kind: 'string', description: 'slug карточки для поиска. Сам slug этим не меняется' },
} as const satisfies ToolSchema;

const ATTACH_COLLECTIONS_SCHEMA = {
  collectionIds: {
    kind: 'idList',
    description: 'Подборки, которые нужно добавить к привязкам карточки',
    maxItems: 50,
    required: true,
  },
  id: { kind: 'string', description: 'Идентификатор карточки. Либо id, либо slug' },
  slug: { kind: 'string', description: 'slug карточки' },
} as const satisfies ToolSchema;

const ATTACH_IMAGE_SCHEMA = {
  id: { kind: 'string', description: 'Идентификатор карточки. Либо id, либо slug' },
  imageId: {
    kind: 'string',
    description: 'Идентификатор записи card-images',
    required: true,
  },
  slug: { kind: 'string', description: 'slug карточки' },
} as const satisfies ToolSchema;

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

function textPayload(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return definedOnly({
    alt: args.alt,
    caption: args.caption,
    description: args.description,
    metaDescription: args.metaDescription,
    title: args.title,
    usageTerms: args.usageTerms,
  });
}

function outcome(args: {
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
    path: contentDocumentPath('cards', saved),
    status: (saved.status as string | null) ?? null,
  };
}

/** Похоже ли на отказ уникального индекса. Текст у адаптеров разный, поэтому проверяется по признакам. */
function looksLikeDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('duplicate') ||
    message.includes('unique') ||
    message.includes('уже занят') ||
    message.includes('уже существует')
  );
}

async function runCreateCardDraft(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const slug = args.slug as string;

  const existingPage = await ctx.gateway.findCards({ limit: 1, where: { slug: { equals: slug } } });
  const existing = existingPage.docs[0] as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    return {
      ...outcome({ created: false, requested: {}, saved: existing }),
      note:
        `Карточка со slug «${slug}» уже существует, повторный вызов ничего не создал. ` +
        'Тексты этим вызовом НЕ перезаписаны: для правки есть update_card_text — иначе ' +
        'повторный вызов втихую затирал бы чужую работу.',
    };
  }

  const collectionIds = relationIds(args.collectionIds);
  const data = {
    ...textPayload(args),
    slug,
    // Статус задаётся здесь и только `draft`: новая запись начинается с noindex
    // и вне sitemap, а публикует человек (п. 7.1, п. 23 ТЗ).
    status: 'draft',
    ...(collectionIds.length > 0 ? { collections: collectionIds } : {}),
    ...(typeof args.imageId === 'string' ? { image: args.imageId } : {}),
  };

  let saved: Record<string, unknown>;
  try {
    saved = (await ctx.gateway.createCard(data)) as unknown as Record<string, unknown>;
  } catch (error) {
    if (!looksLikeDuplicate(error)) {
      throw error;
    }
    // Гонка: пока шло создание, запись со тем же slug появилась. Это и есть
    // случай, ради которого идемпотентность существует, — отдаём существующую.
    const racedPage = await ctx.gateway.findCards({ limit: 1, where: { slug: { equals: slug } } });
    const raced = racedPage.docs[0] as Record<string, unknown> | undefined;
    if (raced === undefined) {
      throw error;
    }
    return {
      ...outcome({ created: false, requested: {}, saved: raced }),
      note:
        `Карточка со slug «${slug}» была создана параллельным вызовом. Отдана существующая ` +
        'запись: второй канонический URL для одной открытки не создаётся.',
    };
  }

  const requested = { ...textPayload(args), slug };
  return outcome({ created: true, requested, saved });
}

async function runUpdateCardText(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const card = await findCard(ctx, args);
  const requested = textPayload(args);
  if (Object.keys(requested).length === 0) {
    throw new ToolRefusal('Не передано ни одного текстового поля для правки.');
  }
  const saved = (await ctx.gateway.updateCard({
    data: requested,
    id: card.id,
  })) as unknown as Record<string, unknown>;
  return outcome({ created: false, requested, saved });
}

async function changeCollections(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
  mode: 'attach' | 'detach',
): Promise<unknown> {
  const card = await findCard(ctx, args);
  const current = relationIds(card.collections).map((id) => String(id));
  const asked = relationIds(args.collectionIds).map((id) => String(id));

  // Привязки ДОБАВЛЯЮТСЯ к существующим, а не заменяют их: инструмент с именем
  // «прикрепить» не должен отцеплять то, о чём его не просили.
  const next =
    mode === 'attach'
      ? [...new Set([...current, ...asked])]
      : current.filter((id) => !asked.includes(id));

  const requested = { collections: next };
  const saved = (await ctx.gateway.updateCard({
    data: requested,
    id: card.id,
  })) as unknown as Record<string, unknown>;

  const savedIds = relationIds(saved.collections).map((id) => String(id));
  const ignored: readonly IgnoredField[] = diffApplied({
    requested: { collections: next },
    saved: { collections: savedIds },
  });

  return {
    applied: { collections: savedIds },
    created: false,
    id: saved.id as number | string,
    ignored,
    path: contentDocumentPath('cards', saved),
    status: (saved.status as string | null) ?? null,
  } satisfies WriteOutcome;
}

async function runAttachImage(
  ctx: ToolContext,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const card = await findCard(ctx, args);
  const imageId = args.imageId as string;

  const imagePage = await ctx.gateway.findCardImages({
    limit: 1,
    where: { id: { equals: imageId } },
  });
  if (imagePage.docs.length === 0) {
    throw new ToolRefusal(
      `Изображение с id «${imageId}» не найдено в card-images. Загрузка байтов через MCP не ` +
        'идёт (решение Ч-35c): файл грузится скриптом импорта или вручную в админке, и только ' +
        'потом привязывается этим инструментом.',
      'imageId',
    );
  }

  const requested = { image: imageId };
  const saved = (await ctx.gateway.updateCard({
    data: requested,
    id: card.id,
  })) as unknown as Record<string, unknown>;

  const savedImage = relationIds(saved.image).map((id) => String(id))[0] ?? null;
  return {
    applied: { image: savedImage },
    created: false,
    id: saved.id as number | string,
    ignored: diffApplied({ requested: { image: imageId }, saved: { image: savedImage } }),
    path: contentDocumentPath('cards', saved),
    status: (saved.status as string | null) ?? null,
  } satisfies WriteOutcome;
}

export const CARD_TOOLS: readonly ToolDefinition[] = [
  {
    description:
      'Создать черновик карточки открытки. Запись появляется в статусе draft с noindex и вне ' +
      'sitemap; публикует и открывает в индекс только человек. Повторный вызов с тем же slug ' +
      'ничего не создаёт и возвращает существующую карточку.',
    name: 'create_card_draft',
    readOnly: false,
    run: runCreateCardDraft,
    schema: CREATE_CARD_SCHEMA,
    title: 'Создать черновик карточки',
  },
  {
    description:
      'Поправить тексты существующей карточки: title, alt, подпись, описание, meta ' +
      'description, условия использования. slug, статус и robots этим инструментом не меняются.',
    name: 'update_card_text',
    readOnly: false,
    run: runUpdateCardText,
    schema: UPDATE_CARD_SCHEMA,
    title: 'Поправить тексты карточки',
  },
  {
    description:
      'Прикрепить карточку к подборкам. Добавляет к имеющимся привязкам, не заменяет их. ' +
      'Копии карточки по другим URL не создаются: адрес открытки один — /otkrytki/<slug>.',
    name: 'attach_card_to_collections',
    readOnly: false,
    run: async (ctx, args) => changeCollections(ctx, args, 'attach'),
    schema: ATTACH_COLLECTIONS_SCHEMA,
    title: 'Прикрепить к подборкам',
  },
  {
    description: 'Отцепить карточку от названных подборок. Остальные привязки сохраняются.',
    name: 'detach_card_from_collections',
    readOnly: false,
    run: async (ctx, args) => changeCollections(ctx, args, 'detach'),
    schema: ATTACH_COLLECTIONS_SCHEMA,
    title: 'Отцепить от подборок',
  },
  {
    description:
      'Привязать к карточке уже загруженное изображение по его id в card-images. Байты через ' +
      'MCP не передаются. Замена изображения опубликованной карточки — право администратора.',
    name: 'attach_image',
    readOnly: false,
    run: runAttachImage,
    schema: ATTACH_IMAGE_SCHEMA,
    title: 'Привязать изображение',
  },
];
