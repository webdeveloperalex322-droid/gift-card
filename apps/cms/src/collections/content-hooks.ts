import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  Field,
  PayloadRequest,
  TypeWithID,
} from 'payload';
import { APIError } from 'payload';

import { hasBeenPublished } from '../access/policies';
import { ensureSingleRedirect, releaseRedirectsFrom } from './redirect-sync';
import { describeHistoryAuthor, diffSeoFields } from './seo-history-diff';
import {
  ContentRuleError,
  type ContentRuleCode,
  type ReviewRequirement,
  assertBulkChangeAllowed,
  assertCreateStatus,
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
  'bulk-requires-admin',
  'bulk-requires-explicit-selection',
  'bulk-too-large',
  'bulk-url-change',
  'index-requires-admin',
  'publish-requires-admin',
  'unpublish-requires-admin',
  'url-change-requires-admin',
  'url-locked',
]);

/**
 * Переводит отказ правила в ответ API.
 *
 * `APIError` с `isPublic = true`: текст обязан дойти до внешнего клиента
 * дословно. Отказ, который в продакшене превращается в «Something went wrong»,
 * заставляет интеграцию AI-редактора угадывать причину — а угадывание в правилах
 * индексации заканчивается страницей в поиске.
 */
function toApiError(error: unknown): unknown {
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

function rethrow(error: unknown): never {
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
 * Идентификатор пользователя в том виде, в каком его принимает связь коллекции.
 *
 * Идентификаторы в этой базе числовые (`defaultIDType: number` в сгенерированных
 * типах), но `req.user.id` объявлен шире. Строковое числовое значение приводится,
 * а не отбрасывается: потерять автора изменения в журнале аудита хуже, чем
 * выполнить одно приведение.
 */
function readUserId(value: number | string | null): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

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
 * Проверяет то, что БУДЕТ записано: переход статуса, полноту перед `review`,
 * решение о судьбе URL и блокировку формы URL после первой публикации.
 */
function enforceContentRules(
  options: ContentHooksOptions,
): CollectionBeforeValidateHook<ContentRecord> {
  return ({ data, operation, originalDoc, req }) => {
    const next = asRecord(data);

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
    const changedBy = readUserId(author.userId);
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
    beforeValidate: [enforceContentRules(options)],
  };
}
