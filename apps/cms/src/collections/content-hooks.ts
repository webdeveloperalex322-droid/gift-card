import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  Field,
  PayloadRequest,
  TypeWithID,
  Where,
} from 'payload';
import { APIError } from 'payload';

import { findYearInSlug } from '@otkritka/shared';

import { hasBeenPublished } from '../access/policies';
import { contentDocumentPath, yearInPathRefusal } from '../seo/paths';
import { isIndexableRobots } from '../seo/robots';
import { markBulkUpdate } from './card-collections';
import {
  type MetaConflict,
  type MetaConflictFacts,
  type MetaDocumentCollection,
  type MetaDuplicateField,
  MAX_LISTED_META_CONFLICTS,
  META_DUPLICATE_SEARCH_STATUSES,
  assertMetaConflictResolved,
  assertMetaUniqueForIndex,
  describeMetaConflicts,
  metaConflictFingerprint,
  normalizeMetaValue,
} from './meta-duplicates';
import { ensureSingleRedirect, releaseRedirectsFrom } from './redirect-sync';
import { describeHistoryAuthor, diffSeoFields, readAuthorUserId } from './seo-history-diff';
import {
  ContentRuleError,
  type ContentRuleCode,
  type ReviewRequirement,
  assertBulkChangeAllowed,
  assertBulkDeleteAllowed,
  assertCreateStatus,
  assertDescriptionForIndex,
  assertIncomingChangeAllowed,
  assertUrlShapeChangeAllowed,
  missingReviewFields,
  planStatusTransition,
  readUrlChangeConfirmation,
  readWithdrawalDecisionOrNull,
} from './status-model';

/**
 * Хуки контентных коллекций: статусная модель (Э1-08), неизменяемость URL с
 * атомарным 301 (Э1-09) и запись истории (Э1-07).
 *
 * ОДНА фабрика на две коллекции — не экономия строк, а требование к защите:
 * `cards` и `collections` обязаны подчиняться одинаковым правилам индексации, а
 * две копии правил расходятся не ошибкой сборки, а страницей в индексе, которой
 * там быть не должно. Различия коллекций вынесены в параметры
 * {@link ContentHooksOptions}: как из записи получается путь и какие поля
 * обязательны перед `review`.
 *
 * РАСПРЕДЕЛЕНИЕ ПО ФАЗАМ. Порядок фаз Payload (проверено по исходникам,
 * `payload/dist/collections/operations/utilities/update.js`):
 *
 *   beforeOperation (коллекция) → beforeValidate (ПОЛЯ: access, слияние с
 *   документом) → beforeValidate (коллекция) → beforeChange (коллекция) →
 *   beforeChange (ПОЛЯ: validate) → запись → afterChange (поля) → afterChange
 *   (коллекция)
 *
 * Отсюда три следствия, определяющие всю раскладку:
 *
 *   1. запрещённое значение поля срезается на фазе ПОЛЕЙ beforeValidate и тут же
 *      заменяется прежним значением документа. Значит, увидеть саму ПОПЫТКУ
 *      можно только в `beforeOperation` — единственном месте, где данные ещё
 *      сырые. Там и живёт громкая ошибка (см. `status-model.ts`);
 *   2. в `beforeValidate` коллекции данные уже слиты с документом, поэтому
 *      правила проверяются по тому, что БУДЕТ записано. Там же понижается
 *      robots: сделать это позже нельзя — на фазе `beforeChange` полей уже
 *      выполняется `validate`, и он отклонил бы `index,follow` у неопубликованной
 *      записи с невнятным для редактора текстом;
 *   3. служебные поля (`publishedAt`) заполняются в `beforeChange` коллекции —
 *      ПОСЛЕ проверок доступа к полям. В `beforeValidate` значение было бы
 *      срезано собственным правилом «снаружи не пишется».
 */

/** Запись контента в том виде, в каком её видят хуки: форму гарантирует не тип. */
export interface ContentRecord extends TypeWithID {
  readonly [key: string]: unknown;
}

export interface ContentHooksOptions {
  readonly collectionSlug: 'cards' | 'collections';
  /**
   * Запрещён ли год в slug записи (условие C3).
   *
   * `true` у карточек: их адрес один навсегда, а повод повторяется каждый год.
   * У подборок правило зависит от вида узла, поэтому там оно применяется в
   * `collection-path.ts` — там, где вид узла известен. Проверка стоит в ХУКЕ, а
   * не только в `validate` поля, потому что валидацию полей Payload умеет
   * пропускать (`skipValidation` при сохранении черновика версии), а хук
   * `beforeValidate` коллекции выполняется всегда.
   */
  readonly forbidYearInSlug?: boolean;
  /**
   * Поля, существующие в коллекции. Нужны, чтобы требование к полю, которого в
   * схеме пока нет (`image` до Э2-04), не блокировало переход в `review`.
   */
  readonly knownFields: ReadonlySet<string>;
  /** Путь записи. У карточки выводится из slug, у подборки хранится в `path`. */
  readonly pathOf: (doc: Readonly<Record<string, unknown>>) => string | null;
  readonly reviewRequirements: readonly ReviewRequirement[];
}

/** Отказы по правам отдаются как 403, отказы по данным — как 400. */
const FORBIDDEN_RULES: ReadonlySet<ContentRuleCode> = new Set<ContentRuleCode>([
  'bulk-delete-published-forbidden',
  'bulk-requires-admin',
  'bulk-requires-explicit-selection',
  'bulk-too-large',
  'bulk-url-change',
  'bulk-withdrawal-forbidden',
  'image-change-requires-admin',
  'index-requires-admin',
  'publish-requires-admin',
  'unpublish-requires-admin',
  'url-change-requires-admin',
  'url-locked',
]);

/**
 * Переводит отказ правила в ответ API.
 *
 * Экспортируется, потому что тем же переводом обязаны пользоваться хуки
 * изображений (Э2-05, Э2-06): у отказа «замену опубликованного изображения
 * делает admin» должен быть тот же 403 и тот же машинный признак `rule`, что у
 * отказов статусной модели. Вторая копия перевода дала бы 500 вместо 403 на
 * части правил.
 *
 * `APIError` с `isPublic = true`: текст обязан дойти до внешнего клиента
 * дословно. Отказ, который в продакшене превращается в «Something went wrong»,
 * заставляет интеграцию AI-редактора угадывать причину — а угадывание в правилах
 * индексации заканчивается страницей в поиске.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof ContentRuleError) {
    return new APIError(
      error.message,
      FORBIDDEN_RULES.has(error.rule) ? 403 : 400,
      { rule: error.rule },
      true,
    );
  }
  return error;
}

export function rethrow(error: unknown): never {
  throw toApiError(error);
}

/** Имена полей верхнего уровня коллекции. */
export function collectFieldNames(fields: readonly Field[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of fields) {
    if ('name' in field && typeof field.name === 'string') {
      names.add(field.name);
    }
  }
  return names;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

/**
 * Имя поля описания. Константа, а не литерал в двух местах: от совпадения имени
 * зависит, сработает ли проверка вовсе, а расхождение здесь не сломало бы
 * сборку — правило увидело бы `undefined` и честно отказало БЕЗ повода либо
 * пропустило бы запись молча.
 */
const META_DESCRIPTION_FIELD = 'metaDescription';

/** Имя поля заголовка. Та же причина, что у {@link META_DESCRIPTION_FIELD}. */
const TITLE_FIELD = 'title';

/** Поля, из-за которых стоит читать документ в `beforeOperation`. */
const CONTESTED_FIELDS = ['status', 'robots', 'slug', 'parent', 'nodeKind', 'urlChange'] as const;

function touchesContestedField(data: Record<string, unknown>): boolean {
  return CONTESTED_FIELDS.some((field) => field in data);
}

/**
 * Аргументы `beforeOperation` в том объёме, который нужен защите.
 *
 * `args` объявлен как `object`, а не как форма с полями, СОЗНАТЕЛЬНО: в Payload
 * это размеченное объединение по виду операции (у `count` там вообще нет ни
 * `data`, ни `where`), и описание конкретной формы либо не примет union, либо
 * потребует приведения типа. Поля читаются ниже через сужение из `unknown` —
 * то есть без `any` и без утверждений о типе, которых компилятор не проверяет.
 */
interface BeforeOperationArgs {
  readonly args: object;
  readonly operation: string;
  readonly req: PayloadRequest;
}

/** Идентификатор документа из аргументов операции. */
function readOperationId(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

/**
 * Условие выборки из аргументов операции — или `null`, если его нет.
 *
 * `null` НЕ означает «пустая выборка»: он означает «условие неизвестно», и
 * вызывающий обязан трактовать это как самый широкий случай. Разница важна: у
 * пакетного удаления неизвестное условие должно считаться «может задеть всё»,
 * а не «не задевает ничего».
 */
function readOperationWhere(value: unknown): Where | null {
  return typeof value === 'object' && value !== null ? { ...value } : null;
}

/**
 * Громкий отказ на запрещённую попытку — на СЫРЫХ данных запроса.
 *
 * Здесь же разделяются одиночная и пакетная операции, и различаются они по
 * АРГУМЕНТАМ, а не по названию операции. Это не стилистика: в Payload 3.88
 * `updateByID` вызывает `beforeOperation` со строкой `'update'` — той же, что и
 * обновление по `where` (проверено на живом ядре и подтверждено исходником,
 * `payload/dist/collections/operations/updateByID.js`: `operation: 'update'`,
 * хотя объявление типа обещает `updateByID`). Различие по строке дало бы
 * зеркально неверный результат: правка одной записи считалась бы пакетной
 * операцией, а значит любая публикация поштучно была бы отклонена как «массовая
 * по фильтру». Надёжный признак — наличие `id` (одна запись) против `where`
 * (выборка).
 *
 * По тому же признаку разбирается и УДАЛЕНИЕ: `deleteByID` и `delete` по `where`
 * тоже приходят сюда с одной строкой `'delete'` (проверено по исходникам,
 * `collections/operations/delete.js` и `deleteByID.js`). Удаление выборки, в
 * которой есть опубликованные записи, отклоняется целиком — разбор в
 * `assertBulkDeleteAllowed`.
 */
function guardIncomingOperation(options: ContentHooksOptions) {
  return async (input: BeforeOperationArgs): Promise<void> => {
    const { operation, req } = input;
    const args = asRecord(input.args);

    if (operation === 'create') {
      try {
        assertIncomingChangeAllowed({
          incoming: asRecord(args.data),
          operation: 'create',
          stored: null,
          user: req.user,
        });
      } catch (error) {
        rethrow(error);
      }
      return;
    }

    if (operation === 'delete') {
      if (readOperationId(args.id) !== null) {
        // Удаление ОДНОЙ записи. Пакетным оно не является, и правило пакета к
        // нему не применяется — см. `assertBulkDeleteAllowed` и названный там
        // пробел Э5-08-A.
        return;
      }
      // Удаление по условию. Считаем ОПУБЛИКОВАННЫЕ записи, которых оно
      // коснётся; неизвестное условие трактуется как «вся коллекция» — иначе
      // мусорный `where` был бы способом обойти проверку.
      const scope = readOperationWhere(args.where);
      const published = await req.payload.count({
        collection: options.collectionSlug,
        overrideAccess: true,
        req,
        where:
          scope === null
            ? { status: { equals: 'published' } }
            : { and: [scope, { status: { equals: 'published' } }] },
      });
      try {
        assertBulkDeleteAllowed({ publishedInSelection: published.totalDocs });
      } catch (error) {
        rethrow(error);
      }
      return;
    }

    if (operation !== 'update' && operation !== 'updateByID') {
      return;
    }

    const incoming = asRecord(args.data);
    const id = readOperationId(args.id);

    if (id === null) {
      // Ни одной записи не адресовано по id — значит операция идёт по условию,
      // то есть это пакет (решение Ч-07, точка вето V11).
      try {
        assertBulkChangeAllowed({ incoming, user: req.user, where: args.where });
      } catch (error) {
        rethrow(error);
      }
      // Признак пакета ставится ПОСЛЕ гейта: отклонённая операция пакетом не
      // считается. Дальше его читают хуки записи — им аргументы операции не
      // видны, а различить пакет и одиночную правку можно только здесь
      // (задача Э5-06, `./card-collections.ts`).
      markBulkUpdate(req, options.collectionSlug);
      return;
    }

    if (!touchesContestedField(incoming)) {
      // Правка контента, не затрагивающая ни статус, ни форму URL: лишнего
      // чтения из базы такая операция не стоит.
      return;
    }

    const stored = await req.payload.findByID({
      collection: options.collectionSlug,
      id,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    });

    if (stored === null) {
      return;
    }

    try {
      assertIncomingChangeAllowed({
        incoming,
        operation: 'update',
        stored: asRecord(stored),
        user: req.user,
      });
    } catch (error) {
      rethrow(error);
    }
  };
}

/**
 * Условие C3: год не попадает в адрес записи.
 *
 * Правило одно и живёт в `@otkritka/shared` (`findYearInSlug`), формулировка
 * отказа — одна и живёт в `../seo/paths` (`yearInPathRefusal`). Здесь только
 * применение к записи коллекции, у которой год запрещён всегда (карточка).
 *
 * Проверка идёт на КАЖДОМ сохранении, а не только при смене slug, и это выбор со
 * известной ценой: запись, у которой год в адресе уже есть, нельзя будет
 * сохранить вовсе, пока адрес не исправлен (а после первой публикации slug
 * неизменяем, то есть выход один — снять с публикации с решением о судьбе URL).
 * Обратный вариант — «проверять только смену slug» — оставлял бы такую запись
 * тихо живой и позволял довести её до публикации: год попал бы в индекс. Из двух
 * неудобств выбрано то, которое громко останавливает, а не то, которое молча
 * пропускает.
 *
 * @throws APIError 400 через {@link rethrow}
 */
function assertYearFreeSlug(
  options: ContentHooksOptions,
  next: Readonly<Record<string, unknown>>,
): void {
  if (options.forbidYearInSlug !== true) {
    return;
  }
  const slug = typeof next.slug === 'string' ? next.slug.trim() : '';
  if (slug === '') {
    return;
  }
  // Проверяется ИТОГОВЫЙ путь, а не сегмент: правило одно и то же и здесь, и в
  // `collection-path.ts`, а адрес складывается из префикса и slug. У карточки
  // префикс постоянен (`/otkrytki`), поэтому разницы в результате нет — но
  // формулировка «год не попадает в АДРЕС» проверяется буквально, и при
  // появлении второго пространства имён проверка не отстанет от него молча.
  const target = options.pathOf({ ...next, slug }) ?? slug;
  const year = findYearInSlug(target);
  if (year === null) {
    return;
  }
  rethrow(
    new ContentRuleError(
      'year-in-path',
      yearInPathRefusal({
        subject:
          'У карточки открытки канонический адрес один навсегда, а поводы повторяются ' +
          'каждый год.',
        target,
        year,
      }),
    ),
  );
}

/**
 * Проверяет то, что БУДЕТ записано: переход статуса, полноту перед `review`,
 * решение о судьбе URL и блокировку формы URL после первой публикации.
 */
function enforceContentRules(
  options: ContentHooksOptions,
): CollectionBeforeValidateHook<ContentRecord> {
  return ({ data, operation, originalDoc, req }) => {
    const next = asRecord(data);

    assertYearFreeSlug(options, next);

    if (operation === 'create') {
      try {
        assertCreateStatus(next.status);
      } catch (error) {
        rethrow(error);
      }
      return data;
    }

    if (originalDoc === undefined) {
      return data;
    }

    const previous = asRecord(originalDoc);

    try {
      const plan = planStatusTransition({
        missingForReview: missingReviewFields({
          data: next,
          knownFields: options.knownFields,
          requirements: options.reviewRequirements,
        }),
        next: { robots: next.robots, status: next.status, withdrawal: next.withdrawal },
        previous: {
          publishedAt: previous.publishedAt,
          robots: previous.robots,
          status: previous.status,
        },
        user: req.user,
      });

      assertUrlShapeChangeAllowed({
        confirmed: readUrlChangeConfirmation(next.urlChange),
        next,
        previous,
        user: req.user,
      });

      if (options.knownFields.has(META_DESCRIPTION_FIELD)) {
        // Проверяется ИТОГОВАЯ директива (`plan.robots`), а не входящая: уход из
        // published понижает её тем же сохранением, и отказ на входящем значении
        // держал бы страницу в индексе дольше необходимого.
        //
        // Описание берётся из слитых данных, но с оглядкой на отсутствие ключа:
        // явная очистка поля (`''`) обязана дойти до правила, а PATCH, в котором
        // поля нет вовсе, не должен читаться как очистка.
        assertDescriptionForIndex({
          metaDescription:
            META_DESCRIPTION_FIELD in next
              ? next[META_DESCRIPTION_FIELD]
              : previous[META_DESCRIPTION_FIELD],
          path: options.pathOf(next) ?? options.pathOf(previous),
          robots: plan.robots,
        });
      }

      if (plan.robotsCoerced) {
        req.payload.logger.warn(
          `[${options.collectionSlug}] Запись «${String(previous.slug ?? previous.id)}» ` +
            `уходит из published, поэтому robots понижена до «${plan.robots}»: ` +
            'index,follow допустим только для опубликованной страницы.',
        );
      }

      return { ...next, robots: plan.robots };
    } catch (error) {
      return rethrow(error);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Дубли метатегов (задача Э5-01, ТЗ §8.3.1)                          */
/* ------------------------------------------------------------------ */

/**
 * Коллекции, по которым идёт поиск совпадений: ОБЕ контентные, всегда.
 *
 * Пространства имён карточек и подборок разведены, но title и description — это
 * выдача поисковика, а не путь: одинаковый заголовок у карточки и у подборки
 * конкурирует в выдаче ровно так же, как у двух карточек. Поиск «внутри своей
 * коллекции» пропускал бы половину случаев, причём молча.
 */
const META_DUPLICATE_COLLECTIONS: readonly MetaDocumentCollection[] = ['cards', 'collections'];

/** Страница выборки: только те поля, которые запрошены в `select`. */
interface MetaScanPage {
  readonly docs: readonly {
    readonly id: number | string;
    readonly metaDescriptionKey?: string | null;
    readonly path?: string | null;
    readonly slug?: string | null;
    readonly status?: string | null;
    readonly title?: string | null;
    readonly titleKey?: string | null;
  }[];
  readonly totalDocs?: number;
}

type MetaKeyClause = Readonly<Record<string, { readonly equals: string }>>;

/**
 * Конфликтующие записи из ОБЕИХ контентных коллекций.
 *
 * Поиск идёт по НОРМАЛИЗОВАННЫМ ключам под индексом (`titleKey`,
 * `metaDescriptionKey`), а не обходом каталога: обход уже стоит у визуальных
 * дублей и стоит дорого, а здесь сравнение точное и ложится на индекс.
 *
 * Своя запись исключается ДВАЖДЫ: условием выборки и фильтром в коде. Условие
 * снимает её из подсчёта `totalDocs`, фильтр страхует от того, что условие не
 * применилось, — а если бы запись нашла сама себя, ни одна из них не могла бы
 * уйти в `review` вовсе.
 */
async function findMetaConflicts(args: {
  readonly descriptionKey: string | null;
  readonly ownCollection: MetaDocumentCollection;
  /** Идентификатор своей записи; `null` — записи ещё нет (create). */
  readonly ownId: number | string | null;
  readonly req: PayloadRequest;
  readonly titleKey: string | null;
}): Promise<MetaConflictFacts> {
  const valueClauses: MetaKeyClause[] = [
    ...(args.titleKey === null ? [] : [{ titleKey: { equals: args.titleKey } }]),
    ...(args.descriptionKey === null
      ? []
      : [{ metaDescriptionKey: { equals: args.descriptionKey } }]),
  ];

  if (valueClauses.length === 0) {
    // Пустые метатеги конфликтом не являются: пустоту наказывает другое правило
    // (`index-requires-description`), а «все пустые совпадают со всеми пустыми»
    // сделало бы предупреждение бессмысленным.
    return { conflicts: [], total: 0, truncated: false };
  }

  const ownId = args.ownId === null ? null : String(args.ownId);
  const rows: MetaConflict[] = [];
  let total = 0;
  let truncated = false;

  for (const collection of META_DUPLICATE_COLLECTIONS) {
    const where = {
      and: [
        { status: { in: [...META_DUPLICATE_SEARCH_STATUSES] } },
        { or: valueClauses },
        ...(collection === args.ownCollection && ownId !== null
          ? [{ id: { not_equals: ownId } }]
          : []),
      ],
    };
    // Предел на один больше показываемого: так видно, что найдено больше, чем
    // помещается в список, даже если база не вернула общего числа.
    const limit = MAX_LISTED_META_CONFLICTS + 1;

    // Ветвление по литералу коллекции, а не переменная в одном вызове: состав
    // `select` у коллекций разный (у карточки адрес выводится из slug, у
    // подборки хранится в path), и лишнее имя поля в выборке — это запрос к
    // несуществующей колонке.
    const page: MetaScanPage =
      collection === 'cards'
        ? await args.req.payload.find({
            collection: 'cards',
            depth: 0,
            limit,
            overrideAccess: true,
            req: args.req,
            select: {
              metaDescriptionKey: true,
              slug: true,
              status: true,
              title: true,
              titleKey: true,
            },
            sort: 'id',
            where,
          })
        : await args.req.payload.find({
            collection: 'collections',
            depth: 0,
            limit,
            overrideAccess: true,
            req: args.req,
            select: {
              metaDescriptionKey: true,
              path: true,
              status: true,
              title: true,
              titleKey: true,
            },
            sort: 'id',
            where,
          });

    const docs = page.docs.filter(
      (doc) => !(collection === args.ownCollection && ownId !== null && String(doc.id) === ownId),
    );
    const rawTotal = typeof page.totalDocs === 'number' ? page.totalDocs : page.docs.length;
    const selfInPage = page.docs.length - docs.length;
    const found = Math.max(rawTotal - selfInPage, docs.length);

    total += found;
    truncated = truncated || found > docs.length;

    for (const doc of docs) {
      const matched: MetaDuplicateField[] = [
        ...(args.titleKey !== null && doc.titleKey === args.titleKey
          ? (['title'] as const)
          : []),
        ...(args.descriptionKey !== null && doc.metaDescriptionKey === args.descriptionKey
          ? (['metaDescription'] as const)
          : []),
      ];
      for (const field of matched) {
        rows.push({
          documentCollection: collection,
          documentId: String(doc.id),
          field,
          path: contentDocumentPath(collection, { ...doc }),
          status: typeof doc.status === 'string' ? doc.status : null,
          title: typeof doc.title === 'string' ? doc.title : null,
        });
      }
    }
  }

  const conflicts = rows.slice(0, MAX_LISTED_META_CONFLICTS);
  return { conflicts, total, truncated: truncated || conflicts.length < rows.length };
}

/**
 * Проверка дублей метатегов при сохранении (ТЗ §8.3.1).
 *
 * ДВЕ РАЗНЫЕ ВЕЩИ в одном хуке, и обе обязательны:
 *
 *   1. ПРЕДУПРЕЖДЕНИЕ. Снимок найденных совпадений пишется в саму запись
 *      (группа `metaConflict`), поэтому возвращается в ответе на то же
 *      сохранение — одинаково в админке, в REST и в GraphQL. Сохранение при
 *      этом проходит: ТЗ требует предупредить, а не отказать. Строка в журнале
 *      добавляется рядом, но самостоятельным каналом не является: внешний
 *      AI-редактор журнала не видит;
 *   2. КАЛИТКА ПЕРЕХОДА. Перевод вперёд по статусам при неразрешённом совпадении
 *      отклоняется (`assertMetaConflictResolved`) — там же разобрано, почему это
 *      отказ, а не второе предупреждение, и почему подтверждение, выданное на
 *      переходе в `review`, не переносится на публикацию;
 *   3. КАЛИТКА ИНДЕКСАЦИИ. Включение `index,follow` при совпадении отклоняется
 *      (`assertMetaUniqueForIndex`). Это ОТДЕЛЬНЫЙ момент: у уже опубликованной
 *      записи ни статус, ни метатеги не меняются, поэтому калитка перехода на
 *      нём не срабатывает вовсе — а условие п. 5.1 «уникальные title/H1/вводный
 *      текст» применяется именно здесь.
 *
 * Нормализованные ключи пишутся ВСЕГДА, даже когда конфликтов нет: по ним
 * работает и сам поиск, и будущий дашборд (Э5-04), которому иначе пришлось бы
 * обходить каталог заново.
 */
function checkMetaDuplicates(
  options: ContentHooksOptions,
): CollectionBeforeValidateHook<ContentRecord> {
  return async ({ data, operation, originalDoc, req }) => {
    if (!options.knownFields.has(TITLE_FIELD) && !options.knownFields.has(META_DESCRIPTION_FIELD)) {
      return data;
    }

    const next: Record<string, unknown> = { ...asRecord(data) };
    const previous = asRecord(originalDoc);
    // Значение берётся из слитых данных, но с оглядкой на отсутствие ключа:
    // явная очистка поля обязана дойти до правила, а PATCH, в котором поля нет
    // вовсе, не должен читаться как очистка.
    const pick = (field: string): unknown => (field in next ? next[field] : previous[field]);

    const titleKey = normalizeMetaValue(pick(TITLE_FIELD));
    const descriptionKey = normalizeMetaValue(pick(META_DESCRIPTION_FIELD));
    const nextRobots = pick('robots');

    const facts = await findMetaConflicts({
      descriptionKey,
      ownCollection: options.collectionSlug,
      ownId:
        operation === 'update' &&
        (typeof previous.id === 'number' || typeof previous.id === 'string')
          ? previous.id
          : null,
      req,
      titleKey,
    });
    const fingerprint = metaConflictFingerprint({
      conflicts: facts.conflicts,
      descriptionKey,
      titleKey,
      total: facts.total,
    });

    const gate = asRecord(next.metaConflict);
    const storedGate = asRecord(previous.metaConflict);
    const confirmed = gate.confirm === true;
    // Отпечаток переписывается ТОЛЬКО вместе с явным подтверждением: иначе
    // сохранение формы админки, где значения приходят в каждом запросе, само
    // продлевало бы устаревшую визу. Тот же приём, что у визуальных дублей.
    const confirmedFor = confirmed
      ? fingerprint
      : typeof storedGate.confirmedFor === 'string' && storedGate.confirmedFor !== ''
        ? storedGate.confirmedFor
        : null;
    const now = new Date().toISOString();

    next[`${TITLE_FIELD}Key`] = titleKey;
    next[`${META_DESCRIPTION_FIELD}Key`] = descriptionKey;
    next.metaConflict = {
      ...gate,
      checkedAt: now,
      confirmedAt: confirmed ? now : (storedGate.confirmedAt ?? null),
      confirmedBy: confirmed
        ? readAuthorUserId(describeHistoryAuthor(req.user).userId)
        : (storedGate.confirmedBy ?? null),
      confirmedFor,
      conflicts: facts.conflicts.map((conflict) => ({ ...conflict })),
      total: facts.total,
      truncated: facts.truncated,
    };

    if (facts.conflicts.length > 0) {
      const subject =
        options.pathOf(next) ??
        options.pathOf(previous) ??
        (typeof previous.id === 'number' || typeof previous.id === 'string'
          ? `#${String(previous.id)}`
          : 'новая запись');
      req.payload.logger.warn(
        `[${options.collectionSlug}] ${subject}: ${describeMetaConflicts(facts)}`,
      );
    }

    try {
      assertMetaConflictResolved({
        conflicts: facts.conflicts,
        confirmedFor,
        confirmedNow: confirmed,
        fingerprint,
        metaChanged:
          operation === 'update' &&
          (titleKey !== normalizeMetaValue(previous[TITLE_FIELD]) ||
            descriptionKey !== normalizeMetaValue(previous[META_DESCRIPTION_FIELD])),
        nextStatus: 'status' in next ? next.status : previous.status,
        previousStatus: previous.status,
      });

      // Директива читается ИТОГОВАЯ: `enforceContentRules` стоит раньше в той же
      // фазе и уже подставил `plan.robots` в данные, поэтому здесь видно то, что
      // будет записано, а не то, что прислали. Порядок хуков зафиксирован в
      // `contentHooks` и значим — см. комментарий там.
      assertMetaUniqueForIndex({
        conflicts: facts.conflicts,
        confirmedNow: confirmed,
        indexOpening:
          operation === 'update' &&
          isIndexableRobots(nextRobots) &&
          nextRobots !== previous.robots,
        path: options.pathOf(next) ?? options.pathOf(previous),
      });
    } catch (error) {
      rethrow(error);
    }

    return next;
  };
}

/**
 * Заполняет служебные поля: дату первой публикации и сброс одноразовых флагов.
 *
 * `publishedAt` ставится ровно один раз и снаружи не пишется вовсе: от него
 * зависит блокировка URL, поэтому возможность заполнить его руками означала бы
 * возможность разблокировать адрес опубликованной страницы.
 *
 * Подтверждение смены URL сбрасывается ВСЕГДА. Флаг — свойство операции, а не
 * записи: сохранившись в документе, он разрешил бы следующую смену URL молча.
 */
function stampSystemFields(
  options: ContentHooksOptions,
): CollectionBeforeChangeHook<ContentRecord> {
  return ({ data, operation, originalDoc, req }) => {
    const next: Record<string, unknown> = { ...asRecord(data) };

    next.urlChange = { ...asRecord(next.urlChange), confirm: false };
    // Подтверждение конфликта метатегов сбрасывается по той же причине и тем же
    // приёмом: флаг — свойство ОПЕРАЦИИ, а не записи. Сохранившись в документе,
    // он подтверждал бы и следующее совпадение молча.
    next.metaConflict = { ...asRecord(next.metaConflict), confirm: false };

    if (operation === 'create') {
      return next;
    }

    const previous = asRecord(originalDoc);

    if (next.status === 'published' && !hasBeenPublished(previous)) {
      const publishedAt = new Date().toISOString();
      next.publishedAt = publishedAt;
      req.payload.logger.info(
        `[${options.collectionSlug}] Первая публикация «${String(next.slug ?? previous.id)}»: ` +
          `URL зафиксирован (publishedAt = ${publishedAt}), дальше он меняется только ` +
          'вместе с одиночным 301.',
      );
    }

    if (next.status === 'published') {
      // Запись вернулась в публикацию: прежнее решение о судьбе её URL устарело.
      // Если не очистить, следующее снятие с публикации применило бы старое
      // решение молча — например, увело бы страницу на путь, откуда её однажды
      // уже переносили.
      next.withdrawal = { mode: null, redirectTo: null };
    }

    return next;
  };
}

/** Пишет в `seo-history` по одной записи на каждое изменившееся SEO-поле. */
function recordSeoHistory(
  options: ContentHooksOptions,
): CollectionAfterChangeHook<ContentRecord> {
  return async ({ doc, operation, previousDoc, req }) => {
    const next = asRecord(doc);
    const changes = diffSeoFields(operation === 'create' ? null : asRecord(previousDoc), next);

    if (changes.length === 0) {
      return doc;
    }

    const author = describeHistoryAuthor(req.user);
    const changedBy = readAuthorUserId(author.userId);
    const changedAt = new Date().toISOString();
    const documentPath = options.pathOf(next);

    for (const change of changes) {
      await req.payload.create({
        collection: 'seo-history',
        data: {
          authorRole: author.authorRole,
          changedAt,
          changedBy,
          documentCollection: options.collectionSlug,
          documentId: String(doc.id),
          documentPath,
          field: change.field,
          nextValue: change.nextValue,
          operation,
          previousValue: change.previousValue,
          viaApiKey: author.apiKey,
        },
        overrideAccess: true,
        req,
      });
    }

    return doc;
  };
}

/**
 * Приводит таблицу редиректов в соответствие с новым состоянием записи.
 *
 * Здесь замыкается атомарность Э1-09: 301 создаётся в той же транзакции, что и
 * смена URL. Для подборок хук срабатывает и на каждом потомке — путь потомка
 * пересобирает `syncDescendantPaths` штатным `payload.update`, а значит у
 * потомка выполняется его собственный `afterChange`. Поэтому перенос узла даёт
 * ровно по одному 301 на каждый переехавший путь, и ни один из них не собирается
 * в цепочку: схлопывание уже реализовано в `redirects-plan.ts`.
 */
function syncUrlRedirects(options: ContentHooksOptions): CollectionAfterChangeHook<ContentRecord> {
  return async ({ doc, operation, previousDoc, req }) => {
    if (operation !== 'update') {
      return doc;
    }

    const next = asRecord(doc);
    const previous = asRecord(previousDoc);
    const nextPath = options.pathOf(next);
    const previousPath = options.pathOf(previous);
    const everPublished = hasBeenPublished(previous) || hasBeenPublished(next);

    if (
      everPublished &&
      previousPath !== null &&
      nextPath !== null &&
      previousPath !== nextPath
    ) {
      // Порядок важен: сначала освобождаем новый путь (по нему теперь отвечает
      // страница), потом ставим 301 со старого. Обратный порядок на короткое
      // время оставил бы редирект с живого адреса.
      await releaseRedirectsFrom({ path: nextPath, req });
      const reason = asRecord(next.urlChange).reason;
      await ensureSingleRedirect({
        code: '301',
        comment:
          `Автоматически: ${options.collectionSlug} переехала с «${previousPath}» на ` +
          `«${nextPath}». Смена URL выполняется только одной операцией вместе с 301.` +
          (typeof reason === 'string' && reason.trim() !== ''
            ? ` Причина: ${reason.trim()}`
            : ''),
        from: previousPath,
        req,
        to: nextPath,
      });
    }

    const wasPublished = previous.status === 'published';
    const isPublished = next.status === 'published';

    if (wasPublished && !isPublished && nextPath !== null) {
      const decision = readWithdrawalDecisionOrNull(next.withdrawal);
      if (decision === null) {
        // Недостижимо: решение проверено в beforeValidate. Молчать здесь нельзя —
        // это означало бы снятую с публикации страницу без решения о её URL.
        req.payload.logger.error(
          `[${options.collectionSlug}] Запись «${nextPath}» снята с публикации без ` +
            'решения о судьбе URL. Проверьте хуки статусной модели.',
        );
      } else if (decision.mode === '404') {
        req.payload.logger.warn(
          `[${options.collectionSlug}] «${nextPath}» снята с публикации по решению 404: ` +
            'запись в redirects не создаётся сознательно, путь просто перестаёт ' +
            'отвечать 200.',
        );
      } else {
        await ensureSingleRedirect({
          code: decision.mode === '301' ? '301' : '410',
          comment:
            `Автоматически: ${options.collectionSlug} «${nextPath}» снята с публикации, ` +
            `решение администратора — ${decision.mode}.`,
          from: nextPath,
          req,
          to: decision.mode === '301' ? decision.redirectTo : null,
        });
      }
    }

    if (!wasPublished && isPublished && nextPath !== null) {
      // Публикация (в том числе повторная): по этому пути снова отвечает
      // страница, поэтому редирект с него обязан исчезнуть.
      await releaseRedirectsFrom({ path: nextPath, req });
    }

    return doc;
  };
}

export interface ContentHooks {
  readonly afterChange: CollectionAfterChangeHook<ContentRecord>[];
  readonly beforeChange: CollectionBeforeChangeHook<ContentRecord>[];
  readonly beforeOperation: CollectionBeforeOperationHook[];
  readonly beforeValidate: CollectionBeforeValidateHook<ContentRecord>[];
}

/**
 * Собирает набор хуков для контентной коллекции.
 *
 * Порядок внутри фаз значим: история пишется ПОСЛЕ синхронизации редиректов
 * только потому, что так читается журнал (сначала факт переезда, потом запись о
 * нём); зависимости между ними нет. А вот `syncDescendantPaths` у подборок
 * обязан идти до этих хуков — иначе потомки переехали бы после того, как их
 * родитель уже отчитался о своём новом пути.
 */
export function contentHooks(options: ContentHooksOptions): ContentHooks {
  return {
    afterChange: [syncUrlRedirects(options), recordSeoHistory(options)],
    beforeChange: [stampSystemFields(options)],
    beforeOperation: [guardIncomingOperation(options)],
    // Порядок значим: сначала правила статусной модели (право на переход,
    // полнота записи), потом проверка дублей метатегов. Отказ по правам обязан
    // звучать раньше отказа «такой заголовок уже есть», и лишний запрос к базе
    // на запись, которая всё равно будет отклонена, тратить незачем.
    beforeValidate: [enforceContentRules(options), checkMetaDuplicates(options)],
  };
}
