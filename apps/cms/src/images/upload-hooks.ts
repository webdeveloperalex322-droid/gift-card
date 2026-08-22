/**
 * Хуки коллекции изображений (задачи Э2-05 и Э2-06).
 *
 * Всё, что здесь есть, — серверная логика, а не логика формы админки: Payload
 * сам отдаёт REST и GraphQL, поэтому загрузка через внешний API проходит ровно
 * через эти же хуки. Правило, реализованное в интерфейсе, внешний AI-редактор
 * обошёл бы первым же запросом.
 *
 * РАСКЛАДКА ПО ФАЗАМ (порядок фаз Payload проверен по исходникам,
 * `payload/dist/collections/operations/create.js`: generateFileData →
 * beforeValidate поля → beforeValidate коллекция → beforeChange коллекция →
 * beforeChange поля → запись → afterChange):
 *
 *   - `beforeChange` коллекции — прогон пайплайна и заполнение служебных полей.
 *     Именно здесь, а не в `beforeValidate`: к этому моменту `generateFileData`
 *     уже определил mime-тип по СОДЕРЖИМОМУ файла и размеры, а проверки доступа
 *     к полям отработали, поэтому служебные значения не будут срезаны. Файлы на
 *     этой фазе НЕ пишутся — только считаются (см. ниже);
 *   - `afterChange` — запись подготовленных файлов, пересинхронизация зеркала в
 *     карточках и уборка объектов, которые заменённая версия оставила позади.
 *     Запись именно здесь (находка ревизии от 2026-08-22): на фазе
 *     `beforeChange` документа ещё нет, и любой отказ дальше по операции
 *     оставлял бы производные в ПУБЛИЧНОМ пространстве без записи, а хука
 *     «операция провалилась» у Payload нет. Уборка тоже здесь и после записи
 *     новых файлов: удалить прежние раньше значит на время оставить запись,
 *     ссылающуюся на несуществующие файлы. Пересинхронизация зеркала стоит
 *     МЕЖДУ ними — см. {@link resyncMirroredCards};
 *   - `afterDelete` — удаление и производных, и оригинала удалённой записи.
 *     Имя файла при этом НЕ освобождается: реестр `image-name-claims` строк не
 *     теряет, поэтому суффикс `-N` после удаления не переиспользуется.
 *
 * Файлы пишет не Payload, а адаптер хранилища: у коллекции стоит
 * `disableLocalStorage: true`, потому что собственный механизм Payload разложил
 * бы оригиналы в каталог, который отдаётся по HTTP, и оригинал стал бы доступен
 * по угадываемому URL (ТЗ §6.1).
 */
import { readFile } from 'node:fs/promises';

import {
  APIError,
  type CollectionAfterChangeHook,
  type CollectionAfterDeleteHook,
  type CollectionBeforeChangeHook,
  type File,
  type PayloadRequest,
  type TypeWithID,
} from 'payload';

import { isAdmin } from '../access/roles';
import { rethrow } from '../collections/content-hooks';
import { ContentRuleError } from '../collections/status-model';
import { readImageMirror, sameImageMirror } from './image-mirror';
import { type StemCandidate, MAX_NAME_SUFFIX } from './keys';
import {
  type PendingObjects,
  type PipelineResult,
  type StoredImageState,
  commitPendingObjects,
  runImagePipeline,
} from './pipeline';
import type { ImageStorage } from './storage';
import { imageStorage } from './storage-env';

/** Ключ, под которым отставленные объекты передаются из `beforeChange` в `afterChange`. */
const RETIRED_CONTEXT_KEY = 'otkritka:retiredImageObjects';

/**
 * Ключ, под которым подготовленные к записи объекты передаются из `beforeChange`
 * в `afterChange`.
 *
 * Контекст запроса, а не модульная переменная: параллельные загрузки не должны
 * видеть чужие байты. Если операция сорвётся между фазами, контекст умрёт вместе
 * с запросом, и записывать будет нечего — именно этого и надо (файла в публичном
 * пространстве не появится).
 */
const PENDING_CONTEXT_KEY = 'otkritka:pendingImageObjects';

interface RetiredObjects {
  readonly derivativeKeys: readonly string[];
  readonly originalKey: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Байты загруженного файла. При `useTempFiles` данные лежат на диске, а не в буфере. */
async function readUploadBuffer(file: File): Promise<Buffer> {
  if (typeof file.tempFilePath === 'string' && file.tempFilePath !== '') {
    return readFile(file.tempFilePath);
  }
  return file.data;
}

/**
 * Занимает имя файла в реестре `image-name-claims`.
 *
 * Две особенности, обе принципиальные:
 *
 *   1. запись в реестр идёт ВНЕ транзакции операции (`disableTransaction: true`).
 *      Занятость имени обязана переживать откат: если загрузка сорвётся после
 *      того, как имя выдано, номер `N` не должен вернуться в оборот — иначе
 *      следующее изображение получит путь, который уже мог утечь наружу;
 *   2. сначала читаются занятые имена одним запросом, и только потом идёт
 *      вставка. Гонку это не закрывает — её закрывает уникальный индекс, — но
 *      избавляет от серии заведомо неудачных вставок в обычном случае.
 */
function claimStem(req: PayloadRequest, description: string) {
  return async (candidates: readonly StemCandidate[]): Promise<StemCandidate> => {
    const known = await req.payload.find({
      collection: 'image-name-claims',
      depth: 0,
      limit: candidates.length,
      overrideAccess: true,
      pagination: false,
      req,
      where: { stem: { in: candidates.map((candidate) => candidate.stem) } },
    });

    const taken = new Set(
      known.docs.map((doc) => (typeof doc.stem === 'string' ? doc.stem : '')),
    );

    let lastError: unknown = null;
    for (const candidate of candidates) {
      if (taken.has(candidate.stem)) {
        continue;
      }
      try {
        await req.payload.create({
          collection: 'image-name-claims',
          data: {
            claimedAt: new Date().toISOString(),
            description,
            stem: candidate.stem,
            suffix: candidate.suffix,
          },
          disableTransaction: true,
          overrideAccess: true,
        });
        return candidate;
      } catch (error) {
        // Скорее всего сработал уникальный индекс: имя заняли параллельно.
        // Пробуем следующего кандидата, а причину сохраняем — если свободных не
        // окажется вовсе, она попадёт в отказ.
        lastError = error;
      }
    }

    throw new APIError(
      `Не удалось занять имя файла для «${description}»: перебраны все варианты до ` +
        `суффикса -${String(MAX_NAME_SUFFIX)}. Дайте изображению другое описательное ` +
        'название — путь вида «имя-137» бессмысленен как адрес файла.' +
        (lastError instanceof Error ? ` Последняя причина: ${lastError.message}` : ''),
      400,
      undefined,
      true,
    );
  };
}

function storedStateOf(doc: Record<string, unknown>): StoredImageState {
  const variants = Array.isArray(doc.variants)
    ? doc.variants.map((variant) => ({ key: readString(asRecord(variant).key) }))
    : [];

  return {
    keyBase: readString(doc.keyBase),
    nameStem: readString(doc.nameStem),
    nameSuffix: typeof doc.nameSuffix === 'number' ? doc.nameSuffix : null,
    originalKey: readString(doc.originalKey),
    revision: readString(doc.revision),
    storageId: readString(doc.storageId),
    variants,
  };
}

/**
 * Замена БАЙТОВ изображения, на которое ссылается уже публиковавшаяся карточка,
 * — действие человека.
 *
 * Почему не «любой, кто вправе править контент»: URL файла постоянен (ТЗ §6.3), и
 * замена изображения меняет адреса всех производных (ТЗ §6.7). Это то же по
 * природе решение, что смена slug опубликованной страницы, и принимать его
 * молча от имени сервисного аккаунта нельзя — иначе агент незаметно переписал бы
 * файлы опубликованной страницы. Загрузка НОВОГО изображения и работа с
 * черновиками сервисному аккаунту при этом полностью открыты.
 */
async function assertReplacementAllowed(args: {
  readonly id: number | string;
  readonly req: PayloadRequest;
}): Promise<void> {
  if (isAdmin(args.req.user)) {
    return;
  }

  const published = await args.req.payload.count({
    collection: 'cards',
    overrideAccess: true,
    req: args.req,
    where: { and: [{ image: { equals: args.id } }, { publishedAt: { exists: true } }] },
  });

  if (published.totalDocs > 0) {
    throw new ContentRuleError(
      'image-change-requires-admin',
      'Заменить изображение, которое стоит на публиковавшейся карточке, может только ' +
        'человек с ролью admin: замена меняет URL всех производных (ТЗ §6.7), а URL файла ' +
        'постоянен (ТЗ §6.3). Сервисный аккаунт вправе загрузить НОВОЕ изображение и ' +
        'работать с черновиками, но не переписывать файлы опубликованной страницы.',
    );
  }
}

export interface UploadHookOptions {
  /** Хранилище. Параметр существует для тестов; продуктовый путь берёт из окружения. */
  readonly storage?: ImageStorage;
}

/** Запись изображения в том виде, в каком её видят хуки. */
interface ImageRecord extends TypeWithID {
  readonly [key: string]: unknown;
}

/**
 * Прогон пайплайна при загрузке и при замене файла.
 *
 * Без нового файла хук НЕ пересчитывает ничего: служебные поля восстанавливаются
 * из записи. Это и есть условие C1 в действии — правка описания или заголовка
 * после публикации не меняет ни одного ключа, потому что ключи не выводятся из
 * изменяемых входов, а хранятся.
 */
function runPipelineOnUpload(): CollectionBeforeChangeHook<ImageRecord> {
  return async ({ data, operation, originalDoc, req }) => {
    const next: Record<string, unknown> = { ...asRecord(data) };
    const stored = operation === 'update' ? storedStateOf(asRecord(originalDoc)) : null;
    const file = req.file;

    if (file === undefined) {
      if (stored !== null) {
        // Служебные поля не приходят снаружи (systemFieldAccess), но и потеряться
        // при частичном обновлении не должны.
        next.keyBase = stored.keyBase;
        next.nameStem = stored.nameStem;
        next.nameSuffix = stored.nameSuffix;
        next.originalKey = stored.originalKey;
        next.revision = stored.revision;
        next.storageId = stored.storageId;
      }
      return next;
    }

    if (operation === 'update' && originalDoc !== undefined) {
      try {
        await assertReplacementAllowed({ id: originalDoc.id, req });
      } catch (error) {
        // Тот же перевод отказа, что у статусной модели: 403 и машинный
        // признак `rule`, а не 500 с «Something went wrong».
        rethrow(error);
      }
    }

    const buffer = await readUploadBuffer(file);
    const description =
      readString(next.title) ??
      readString(asRecord(originalDoc).title) ??
      file.name.replace(/\.[^.]+$/, '');

    const result: PipelineResult = await runImagePipeline({
      allocateStem: claimStem(req, description),
      buffer,
      byteSize: typeof next.filesize === 'number' ? next.filesize : buffer.byteLength,
      declaredHeight: typeof next.height === 'number' ? next.height : null,
      declaredWidth: typeof next.width === 'number' ? next.width : null,
      description,
      mimeType: readString(next.mimeType) ?? file.mimetype,
      stored,
    });

    // Байты ждут фазы afterChange: до записи документа в публичном пространстве
    // не должно появиться ни одного файла.
    req.context[PENDING_CONTEXT_KEY] = result.pending;

    next.keyBase = result.keyBase;
    next.nameStem = result.nameStem;
    next.nameSuffix = result.nameSuffix;
    next.originalKey = result.originalKey;
    next.pHash = result.pHash;
    next.revision = result.revision;
    next.storageId = result.originalKey.slice(
      result.originalKey.lastIndexOf('/') + 1,
      result.originalKey.lastIndexOf('.'),
    );
    next.source = {
      exifOrientation: result.source.exifOrientation,
      format: result.source.format,
      height: result.source.height,
      width: result.source.width,
    };
    next.variants = result.variants.map((variant) => ({
      byteSize: variant.byteSize,
      format: variant.format,
      height: variant.height,
      key: variant.key,
      width: variant.width,
    }));

    // Имя файла в записи приводится к имени, которое реально стоит в путях
    // производных. Иначе в админке лежало бы имя из загрузки («IMG_2024.png»), а
    // в URL — другое, и разбор инцидента начинался бы с их сопоставления.
    next.filename = `${result.nameStem}.${result.originalExtension}`;

    if (result.retired.derivativeKeys.length > 0 || result.retired.originalKey !== null) {
      const retired: RetiredObjects = result.retired;
      req.context[RETIRED_CONTEXT_KEY] = retired;
    }

    req.payload.logger.info(
      `[card-images] ${operation === 'create' ? 'Загрузка' : 'Замена'} «${result.nameStem}»: ` +
        `revision=${result.revision}, вариантов ${String(result.variants.length)}, ` +
        `pHash=${result.pHash}. Оригинал вне публичного пространства. Файлы будут записаны ` +
        'после записи документа.',
    );

    return next;
  };
}

/**
 * Пишет подготовленные файлы — после записи документа, до фиксации транзакции.
 *
 * Порядок с уборкой значим: сначала записываются новые объекты, потом удаляются
 * прежние. Ошибка записи убирает за собой ({@link commitPendingObjects}) и валит
 * операцию — транзакция откатывается, и лишних файлов не остаётся ни при каком
 * исходе.
 */
function writePendingObjects(
  options: UploadHookOptions,
): CollectionAfterChangeHook<ImageRecord> {
  return async ({ doc, req }) => {
    const pending = req.context[PENDING_CONTEXT_KEY] as PendingObjects | undefined;
    if (pending === undefined) {
      return doc;
    }
    delete req.context[PENDING_CONTEXT_KEY];

    const storage = options.storage ?? imageStorage();
    await commitPendingObjects(storage, pending);

    req.payload.logger.info(
      `[card-images] Записано в хранилище: оригинал и производных ` +
        `${String(pending.derivatives.length)}. Запись файлов идёт ПОСЛЕ записи документа: ` +
        'иначе отказ дальше по операции оставил бы производные в публичном пространстве ' +
        'без записи.',
    );

    return doc;
  };
}

/** Удаляет объекты, оставшиеся после замены изображения. */
function retireReplacedObjects(
  options: UploadHookOptions,
): CollectionAfterChangeHook<ImageRecord> {
  return async ({ doc, req }) => {
    const retired = req.context[RETIRED_CONTEXT_KEY] as RetiredObjects | undefined;
    if (retired === undefined) {
      return doc;
    }
    delete req.context[RETIRED_CONTEXT_KEY];

    const storage = options.storage ?? imageStorage();
    for (const key of retired.derivativeKeys) {
      await storage.deleteDerivative(key);
    }
    if (retired.originalKey !== null) {
      await storage.deleteOriginal(retired.originalKey);
    }

    req.payload.logger.info(
      `[card-images] После замены удалено производных: ${String(retired.derivativeKeys.length)}` +
        `${retired.originalKey === null ? '' : ' и прежний оригинал'}. Ключи не ` +
        'переиспользуются: путь производной содержит revision — хеш байтов.',
    );

    return doc;
  };
}

/**
 * Пределы обхода карточек при пересинхронизации зеркала.
 *
 * ПРОВЕНАНС ЗНАЧЕНИЙ: выбор агента, не решение человека (кандидаты в реестр
 * решений). Практически одно изображение стоит на одной карточке — поле `image`
 * не `hasMany`, — но уникальность этой связи ничем не обеспечена, и молчаливое
 * усечение обхода оставило бы часть карточек с зеркалом на УДАЛЁННЫЕ файлы.
 * Поэтому обход постраничный по курсору, а достижение предела — громкое
 * предупреждение, а не тихий выход.
 */
const MIRROR_RESYNC_PAGE_SIZE = 100;
const MIRROR_RESYNC_MAX_CARDS = 1000;

/**
 * Обновляет зеркало у карточек, ссылающихся на это изображение (задача Э3-03a).
 *
 * ЗАЧЕМ. Зеркало (`cards.derivative.*`, `cards.derivative.variants[]`,
 * `cards.pHash`) заполняет хук КАРТОЧКИ при её сохранении. Значит, замена байтов
 * изображения (Э2-06) сама по себе зеркало не обновляет: у записи изображения
 * появляются новая `revision` и новые ключи, прежние файлы удаляются
 * ({@link retireReplacedObjects}), а опубликованная карточка продолжает ссылаться
 * на ключи, которых больше нет, — до следующего сохранения карточки, которого
 * может не случиться никогда. На публичной странице это отсутствующее
 * изображение при 200 в HTML.
 *
 * ПОЧЕМУ `data: {}`, а не подстановка новых значений. Единственный автор зеркала
 * — хук карточки: он перечитывает связанную запись и пишет то, что там лежит.
 * Передать значения отсюда значило бы завести второй автор одного поля, и
 * расхождение между ними было бы видно только на странице.
 *
 * ПОЧЕМУ это не «публикация кодом» и не обход правил. Операция не меняет ни
 * статус, ни `robots`, ни slug: все проверки статусной модели построены на
 * ИЗМЕНЕНИИ этих значений (`statusChanged` в `planStatusTransition`,
 * `assertVisualDuplicateResolved`), поэтому сохранение без их изменения проходит
 * ровно те же хуки и ничего не открывает. Право заменить байты уже проверено
 * выше ({@link assertReplacementAllowed}) — до пайплайна и до этой фазы.
 *
 * ПОЧЕМУ ФАЗА ИМЕННО ЗДЕСЬ И В ЭТОМ ПОРЯДКЕ: после записи новых файлов и ДО
 * удаления прежних. Обратный порядок оставлял бы промежуток, в котором зеркало
 * карточки указывает на уже удалённые объекты.
 */
function resyncMirroredCards(): CollectionAfterChangeHook<ImageRecord> {
  return async ({ doc, operation, previousDoc, req }) => {
    if (operation !== 'update') {
      return doc;
    }

    const next = readImageMirror(asRecord(doc));
    const previous = readImageMirror(asRecord(previousDoc));
    if (sameImageMirror(previous, next)) {
      // Несодержательное сохранение изображения (правка названия): ключи те же,
      // трогать карточки незачем. Это и есть условие C1 со стороны карточки.
      return doc;
    }

    let cursor: number | string | null = null;
    const touched: string[] = [];
    let truncated = false;

    for (;;) {
      // Тип страницы объявлен ЯВНО по той же причине, что в поиске визуальных
      // дублей: иначе вывод типа замыкается на сужение `cursor` (TS7022).
      const page: { docs: { id: number | string; slug?: string | null }[] } =
        await req.payload.find({
          collection: 'cards',
          depth: 0,
          limit: MIRROR_RESYNC_PAGE_SIZE,
          overrideAccess: true,
          req,
          select: { slug: true },
          sort: 'id',
          where: {
            and: [
              { image: { equals: doc.id } },
              ...(cursor === null ? [] : [{ id: { greater_than: cursor } }]),
            ],
          },
        });

      for (const card of page.docs) {
        // Пустые данные: зеркало пишет хук карточки, перечитывая изображение.
        await req.payload.update({
          collection: 'cards',
          id: card.id,
          data: {},
          depth: 0,
          overrideAccess: true,
          req,
        });
        touched.push(readString(card.slug) ?? `#${String(card.id)}`);
      }

      const last = page.docs.at(-1);
      if (last === undefined || page.docs.length < MIRROR_RESYNC_PAGE_SIZE) {
        break;
      }
      if (touched.length >= MIRROR_RESYNC_MAX_CARDS) {
        truncated = true;
        break;
      }
      cursor = last.id;
    }

    req.payload.logger.info(
      `[card-images] Ключи производных изменились (revision ${String(previous.revision)} → ` +
        `${String(next.revision)}): зеркало обновлено у карточек ${String(touched.length)} ` +
        `(${touched.join(', ')}). Иначе опубликованная страница ссылалась бы на удалённые ` +
        'файлы до следующего сохранения карточки.',
    );

    if (truncated) {
      req.payload.logger.error(
        `[card-images] Обход карточек ОБОРВАН по пределу ${String(MIRROR_RESYNC_MAX_CARDS)}: ` +
          'часть карточек осталась с зеркалом на удалённые файлы. Требуется ручная ' +
          'пересинхронизация — молчать об этом нельзя, на страницах не будет изображений.',
      );
    }

    return doc;
  };
}

/** Удаляет файлы удалённой записи. Имя файла при этом остаётся занятым навсегда. */
function deleteStoredObjects(options: UploadHookOptions): CollectionAfterDeleteHook<ImageRecord> {
  return async ({ doc, req }) => {
    const storage = options.storage ?? imageStorage();
    const stored = storedStateOf(asRecord(doc));

    for (const variant of stored.variants ?? []) {
      if (typeof variant.key === 'string' && variant.key !== '') {
        await storage.deleteDerivative(variant.key);
      }
    }
    if (stored.originalKey !== null && stored.originalKey !== undefined) {
      await storage.deleteOriginal(stored.originalKey);
    }

    req.payload.logger.info(
      `[card-images] Удалена запись «${String(stored.nameStem)}»: файлы убраны, имя файла ` +
        'остаётся занятым в реестре image-name-claims — суффикс -N после удаления не ' +
        'переиспользуется.',
    );

    return doc;
  };
}

export interface UploadHooks {
  readonly afterChange: CollectionAfterChangeHook<ImageRecord>[];
  readonly afterDelete: CollectionAfterDeleteHook<ImageRecord>[];
  readonly beforeChange: CollectionBeforeChangeHook<ImageRecord>[];
}

export function cardImageUploadHooks(options: UploadHookOptions = {}): UploadHooks {
  return {
    // Порядок значим: записать новое → перевести на него зеркало карточек →
    // убрать прежнее. Любая другая расстановка оставляет промежуток, в котором
    // запись или зеркало ссылаются на файлы, которых нет.
    afterChange: [writePendingObjects(options), resyncMirroredCards(), retireReplacedObjects(options)],
    afterDelete: [deleteStoredObjects(options)],
    // Хранилище этой фазе больше не нужно: она только считает, а пишет
    // `writePendingObjects` из afterChange.
    beforeChange: [runPipelineOnUpload()],
  };
}
