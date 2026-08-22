/**
 * Хуки карточки, связанные с изображением (задачи Э2-05, Э2-06).
 *
 * Три обязанности, и все три — серверные, потому что Payload отдаёт REST и
 * GraphQL сам. Фаз при этом три, и распределение по ним не произвольное:
 * `beforeOperation` — единственное место, где видна сама ПОПЫТКА (данные ещё
 * сырые, ни одно поле не срезано проверкой доступа), поэтому громкий отказ на
 * смену изображения живёт там; `beforeValidate` — там, где данные уже слиты с
 * документом, поэтому там зеркало полей и проверка того, что БУДЕТ записано;
 * `beforeChange` — сброс одноразового подтверждения:
 *
 *   1. **зеркалирование состояния файла в карточку.** Поля `pHash` и
 *      `derivative.{keyBase,nameStem,nameSuffix,revision}` заведены в `cards`
 *      задачей Э1-04 и заполняются отсюда — из связанной записи `card-images`.
 *      Это осознанная денормализация, а не второй источник истины: карточка —
 *      опубликованная сущность, и условие C1 («ключ зафиксирован при первой
 *      публикации») формулируется именно про неё. Плюс поиск визуальных дублей
 *      идёт по СТАТУСУ (`published` и `review`), а статус живёт у карточки:
 *      без зеркала пришлось бы читать все изображения и потом сопоставлять их с
 *      карточками;
 *   2. **смена изображения у публиковавшейся карточки — только `admin`.**
 *      Замена меняет URL всех производных (ТЗ §6.7), а URL файла постоянен
 *      (ТЗ §6.3). Право проверяется и на уровне поля (`cardImageFieldAccess`,
 *      молчаливый отказ Payload), и здесь — громко, потому что молчаливый
 *      отказ внешний клиент принял бы за успех;
 *   3. **блокировка перевода в `review` при визуально похожем изображении.**
 *      Похожие ищутся среди `published` и `review` (ТЗ §6.7 п. 4), решение
 *      принимает редактор, а не порог. Правило и отпечаток набора — в
 *      `./duplicates.ts`.
 *
 * Подтверждение решения (`visualDuplicate.confirm`) устроено как одноразовый
 * флаг операции — тем же приёмом, что подтверждение смены URL в Э1-09.
 * Сохранившись в записи, он подтверждал бы и следующее изображение молча.
 */
import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  PayloadRequest,
  TypeWithID,
} from 'payload';

import { canReplaceImage } from '../access/policies';
import { rethrow } from '../collections/content-hooks';
import { ContentRuleError, readRelationId } from '../collections/status-model';
import {
  type CardId,
  type SimilarMatch,
  DUPLICATE_SEARCH_STATUSES,
  assertVisualDuplicateResolved,
  findSimilarCards,
  isVisualDuplicateDecision,
  similarFingerprint,
} from './duplicates';

/**
 * Отказ «сменить изображение публиковавшейся карточки может только admin».
 *
 * Текст один на две фазы: `beforeOperation` (сырые данные — там отказ ГРОМКИЙ) и
 * `beforeValidate` (слитые данные — там он страхует случаи, до которых сырой
 * слой не дотягивается). Две формулировки одного правила расходятся, и внешний
 * клиент видел бы разные причины для одного запрета.
 */
function imageChangeRefusal(): ContentRuleError {
  return new ContentRuleError(
    'image-change-requires-admin',
    'Сменить изображение у карточки, которая уже публиковалась, может только человек ' +
      'с ролью admin: адреса всех производных при этом меняются (ТЗ §6.7), а URL файла ' +
      'постоянен (ТЗ §6.3). Сервисный аккаунт вправе загружать изображения и привязывать ' +
      'их к черновикам, но не переставлять файлы опубликованной страницы.',
  );
}

/**
 * Пределы обхода при поиске визуальных дублей.
 *
 * ПРОВЕНАНС ЗНАЧЕНИЙ: выбор агента, не решение человека (кандидаты в реестр
 * решений вместе с `MAX_BATCH_SELECTION`, `MAX_UPLOAD_BYTES` и диапазоном года в
 * slug). Норма, которую они обслуживают, задана ТЗ §6.7 п. 4: круг поиска —
 * `published` и `review`, целиком.
 *
 * Что здесь исправлено (находка ревизии от 2026-08-22). Раньше стоял ОДИН
 * предел — `limit: 500` без сортировки и курсора, — и он молча обрезал круг
 * поиска: после 500 карточек в `published`/`review` ответ «похожих не найдено»
 * означал «искали не везде», причём ни в журнале, ни в ответе редактору этого
 * факта не было. Теперь обход постраничный по курсору (`id` по возрастанию,
 * `greater_than`), а предел один — на ЧИСЛО ПРОСМОТРЕННЫХ записей, и его
 * достижение попадает и в журнал, и в поля записи
 * (`visualDuplicate.scanned`, `visualDuplicate.scanTruncated`).
 *
 *   - `pageSize` = 500: размер одного запроса к базе. Компромисс между числом
 *     round-trip'ов и объёмом ответа; на результат поиска не влияет вовсе,
 *     потому что обход продолжается до конца выборки;
 *   - `maxRecords` = 20 000: страховка от неограниченной работы в хуке
 *     сохранения. При достижении обход прекращается, и это ЯВНО отмечается —
 *     «не искали дальше» перестаёт выглядеть как «не нашли». Курсорный обход
 *     делает предел достижимым только при действительно большом каталоге, где
 *     поиск дублей всё равно надо переносить в бакеты pHash (задача этапа 5).
 */
export interface SimilarityScanLimits {
  /** Жёсткий предел просмотренных записей за одно сохранение. */
  readonly maxRecords: number;
  /** Сколько записей читается одним запросом. */
  readonly pageSize: number;
}

export const SIMILARITY_SCAN_LIMITS: SimilarityScanLimits = {
  maxRecords: 20_000,
  pageSize: 500,
};

interface CardRecord extends TypeWithID {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

interface ImagePipelineState {
  readonly keyBase: string | null;
  readonly nameStem: string | null;
  readonly nameSuffix: number | null;
  readonly pHash: string | null;
  readonly revision: string | null;
}

const EMPTY_STATE: ImagePipelineState = {
  keyBase: null,
  nameStem: null,
  nameSuffix: null,
  pHash: null,
  revision: null,
};

async function readImageState(args: {
  readonly imageId: string;
  readonly req: PayloadRequest;
}): Promise<ImagePipelineState> {
  const image = await args.req.payload.findByID({
    collection: 'card-images',
    id: args.imageId,
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req: args.req,
  });

  if (image === null) {
    return EMPTY_STATE;
  }

  const doc = asRecord(image);
  return {
    keyBase: readString(doc.keyBase),
    nameStem: readString(doc.nameStem),
    nameSuffix: typeof doc.nameSuffix === 'number' ? doc.nameSuffix : null,
    pHash: readString(doc.pHash),
    revision: readString(doc.revision),
  };
}

/** Страница выборки при обходе: только те поля, которые запрошены в `select`. */
interface SimilarityScanPage {
  readonly docs: readonly {
    readonly id: number | string;
    readonly pHash?: string | null;
  }[];
}

/** Результат обхода каталога: что нашли и сколько записей при этом просмотрели. */
interface SimilarityScanResult {
  readonly matches: readonly SimilarMatch[];
  /** Сколько записей просмотрено. */
  readonly scanned: number;
  /** Оборвался ли обход по пределу: «похожих не найдено» тогда неполно. */
  readonly truncated: boolean;
}

/**
 * Кандидаты на визуальный дубль: карточки в `published` и `review` с известным
 * pHash — ВСЕ, постраничным обходом по курсору.
 *
 * Курсор (`id > последнего`), а не смещение (`page`): выборка живая, и при
 * смещении вставка записи между запросами сдвигает окно, из-за чего одна запись
 * читается дважды, а другая пропускается. Пропущенная запись здесь — это
 * незамеченный дубль.
 */
async function readSimilarCandidates(args: {
  readonly excludeId: CardId | null;
  readonly hash: string;
  readonly limits: SimilarityScanLimits;
  readonly req: PayloadRequest;
}): Promise<SimilarityScanResult> {
  const candidates: { hash: string; id: CardId }[] = [];
  let cursor: number | string | null = null;
  let truncated = false;

  for (;;) {
    // Тип страницы объявлен ЯВНО, а не выведен. Иначе вывод замыкается сам на
    // себя: тип `page` зависел бы от сужения `cursor`, а сужение `cursor` — от
    // присваивания `cursor = last.id`, то есть от `page` (TS7022).
    const page: SimilarityScanPage = await args.req.payload.find({
      collection: 'cards',
      depth: 0,
      limit: args.limits.pageSize,
      overrideAccess: true,
      req: args.req,
      select: { pHash: true },
      sort: 'id',
      where: {
        and: [
          { status: { in: [...DUPLICATE_SEARCH_STATUSES] } },
          { pHash: { exists: true } },
          ...(cursor === null ? [] : [{ id: { greater_than: cursor } }]),
        ],
      },
    });

    for (const doc of page.docs) {
      candidates.push({
        hash: typeof doc.pHash === 'string' ? doc.pHash : '',
        id: doc.id,
      });
    }

    const last = page.docs.at(-1);
    if (last === undefined || page.docs.length < args.limits.pageSize) {
      break;
    }
    if (candidates.length >= args.limits.maxRecords) {
      truncated = true;
      break;
    }
    cursor = last.id;
  }

  return {
    matches: findSimilarCards({
      candidates,
      excludeId: args.excludeId,
      hash: args.hash,
    }),
    scanned: candidates.length,
    truncated,
  };
}

/**
 * Зеркалит состояние файла в карточку и проверяет два правила: право заменить
 * изображение и решение о визуальном дубле.
 *
 * Фаза — `beforeValidate` коллекции: данные уже слиты с документом, поэтому
 * проверяется то, что БУДЕТ записано, а проверки доступа к полям уже прошли —
 * значит служебные поля, выставленные здесь, не будут срезаны.
 */
function mirrorImageAndGuardDuplicates(
  limits: SimilarityScanLimits,
): CollectionBeforeValidateHook<CardRecord> {
  return async ({ data, operation, originalDoc, req }) => {
    const next: Record<string, unknown> = { ...asRecord(data) };
    const previous = asRecord(originalDoc);

    const imageId = readRelationId(next.image);
    const previousImageId = readRelationId(previous.image);

    if (operation === 'update' && imageId !== previousImageId && !canReplaceImage(req.user, previous)) {
      rethrow(imageChangeRefusal());
    }

    const state = imageId === null ? EMPTY_STATE : await readImageState({ imageId, req });

    next.pHash = state.pHash;
    next.derivative = {
      ...asRecord(next.derivative),
      keyBase: state.keyBase,
      nameStem: state.nameStem,
      nameSuffix: state.nameSuffix,
      revision: state.revision,
    };

    const gate = asRecord(next.visualDuplicate);
    const storedGate = asRecord(previous.visualDuplicate);

    if (state.pHash === null) {
      // Нет изображения — нет и набора похожих: прежний список обязан исчезнуть,
      // иначе он остался бы «висеть» от предыдущего изображения.
      next.visualDuplicate = {
        ...gate,
        decisionFor: null,
        scanTruncated: false,
        scanned: 0,
        similar: [],
      };
      return next;
    }

    const scan = await readSimilarCandidates({
      excludeId: operation === 'update' ? (previous.id as CardId | undefined) ?? null : null,
      hash: state.pHash,
      limits,
      req,
    });
    const similar = scan.matches;
    const fingerprint = similarFingerprint({
      hash: state.pHash,
      ids: similar.map((match) => match.id),
    });

    const decision = isVisualDuplicateDecision(gate.decision) ? gate.decision : null;
    const confirmed = gate.confirm === true;
    // Отпечаток переписывается ТОЛЬКО вместе с явным подтверждением: иначе
    // сохранение формы админки, где значение решения приходит в каждом запросе,
    // само продлевало бы устаревшую визу.
    const decisionFor = confirmed ? fingerprint : readString(storedGate.decisionFor);

    next.visualDuplicate = {
      ...gate,
      decidedAt: confirmed ? new Date().toISOString() : (storedGate.decidedAt ?? null),
      decision,
      decisionFor,
      // Полнота проверки — часть её результата: без этих двух полей «похожих не
      // найдено» невозможно отличить от «дальше не искали».
      scanTruncated: scan.truncated,
      scanned: scan.scanned,
      similar: similar.map((match) => ({ card: match.id, distance: match.distance })),
    };

    if (scan.truncated) {
      req.payload.logger.warn(
        `[cards] Поиск визуальных дублей ОБОРВАН по пределу: просмотрено ` +
          `${String(scan.scanned)} записей из published и review (предел ` +
          `${String(limits.maxRecords)}). Результат неполный — «похожих не найдено» здесь ` +
          'означает «дальше не искали». Требуется поиск по бакетам pHash вместо полного ' +
          'обхода (ТЗ §6.7 п. 4).',
      );
    }

    if (similar.length > 0) {
      req.payload.logger.warn(
        `[cards] Изображение карточки «${readString(next.slug) ?? readString(previous.slug) ?? '—'}» ` +
          'похоже на ' +
          `${String(similar.length)} уже существующих (${similar
            .map((match) => `#${String(match.id)}:${String(match.distance)}`)
            .join(', ')}). Круг поиска — published и review.`,
      );
    }

    try {
      assertVisualDuplicateResolved({
        decision,
        decisionFor,
        fingerprint,
        nextStatus: next.status,
        previousStatus: previous.status,
        similar,
      });
    } catch (error) {
      rethrow(error);
    }

    return next;
  };
}

/**
 * Сбрасывает одноразовое подтверждение решения о дубле.
 *
 * Тот же приём, что у подтверждения смены URL: флаг — свойство ОПЕРАЦИИ, а не
 * записи. Сохранившись, он подтверждал бы и следующее изображение молча.
 */
function resetDuplicateConfirmation(): CollectionBeforeChangeHook<CardRecord> {
  return ({ data }) => {
    const next: Record<string, unknown> = { ...asRecord(data) };
    next.visualDuplicate = { ...asRecord(next.visualDuplicate), confirm: false };
    return next;
  };
}

/**
 * Аргументы `beforeOperation` в том объёме, который нужен защите. Форма ровно та
 * же, что в `content-hooks.ts`, и по той же причине: в Payload это размеченное
 * объединение по виду операции, и описание конкретной формы либо не примет
 * union, либо потребует приведения типа.
 */
interface BeforeOperationArgs {
  readonly args: object;
  readonly operation: string;
  readonly req: PayloadRequest;
}

/**
 * ГРОМКИЙ отказ на попытку сменить изображение публиковавшейся карточки.
 *
 * Почему без этого хука защиты недостаточно, хотя поле уже закрыто
 * `cardImageFieldAccess`: отказ на уровне ПОЛЯ в Payload молчаливый — поле
 * удаляется из входных данных, на его место возвращается прежнее значение, и
 * запрос отдаёт 200. Изображение при этом действительно не меняется (проверено
 * смоуком), но внешний AI-редактор получает «успех» и считает, что подмена
 * применена. Отсюда правило проекта: там, где есть молчаливый отказ, обязана
 * быть и громкая ошибка — а увидеть саму ПОПЫТКУ можно только здесь, до фазы
 * полей, пока данные ещё сырые.
 *
 * Пакетная операция (без `id`) здесь не разбирается, и защиту ей даёт НЕ «общий
 * запрет пакетных операций для сервисного аккаунта» — такого запрета в
 * `content-hooks.ts` нет (неверное утверждение в этом докстринге — находка
 * ревизии от 2026-08-22; неверное описание защиты опаснее отсутствующего:
 * следующий читатель на него полагается). Пакетную подмену изображения
 * останавливают два других механизма: молчаливое срезание поля `image` по
 * `cardImageFieldAccess` и проверка КАЖДОЙ записи в `beforeValidate`
 * ({@link mirrorImageAndGuardDuplicates}) — Payload прогоняет её на каждую
 * запись выборки, поэтому публиковавшаяся карточка отклоняется громко и там.
 * Здесь же — поштучная правка, основной путь внешнего клиента.
 */
function guardIncomingImageChange(): (input: BeforeOperationArgs) => Promise<void> {
  return async ({ args, operation, req }) => {
    if (operation !== 'update' && operation !== 'updateByID') {
      return;
    }

    const operationArgs = asRecord(args);
    const incoming = asRecord(operationArgs.data);
    const id = operationArgs.id;

    if (!('image' in incoming) || (typeof id !== 'number' && typeof id !== 'string')) {
      return;
    }

    const stored = await req.payload.findByID({
      collection: 'cards',
      id,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    });

    if (stored === null) {
      return;
    }

    const previous = asRecord(stored);
    if (readRelationId(incoming.image) === readRelationId(previous.image)) {
      return;
    }

    if (!canReplaceImage(req.user, previous)) {
      rethrow(imageChangeRefusal());
    }
  };
}

export interface CardImageHooks {
  readonly beforeChange: CollectionBeforeChangeHook<CardRecord>[];
  readonly beforeOperation: CollectionBeforeOperationHook[];
  readonly beforeValidate: CollectionBeforeValidateHook<CardRecord>[];
}

export interface CardImageHookOptions {
  /**
   * Пределы обхода при поиске похожих. Параметр существует для тестов:
   * достижимость предела проверяется на маленьких значениях, а не созданием
   * двадцати тысяч записей. Продуктовый путь берёт {@link SIMILARITY_SCAN_LIMITS}.
   */
  readonly scan?: Partial<SimilarityScanLimits>;
}

export function cardImageHooks(options: CardImageHookOptions = {}): CardImageHooks {
  const limits: SimilarityScanLimits = { ...SIMILARITY_SCAN_LIMITS, ...options.scan };
  return {
    beforeChange: [resetDuplicateConfirmation()],
    beforeOperation: [guardIncomingImageChange()],
    beforeValidate: [mirrorImageAndGuardDuplicates(limits)],
  };
}
