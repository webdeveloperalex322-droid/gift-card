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
 *   - `beforeDelete` — ОТКАЗ, если на изображение ссылается хоть одна карточка.
 *     Почему отказ, а не уборка: связь `cards.image` живёт в `cards_rels` с
 *     `onDelete: 'cascade'`
 *     (`@payloadcms/drizzle/dist/schema/build.js`), поэтому удаление записи
 *     изображения МОЛЧА обнуляет поле у карточки, а зеркало
 *     (`cards.derivative.variants[]`) остаётся заполненным ключами уже удалённых
 *     файлов. Опубликованная страница после этого отдаёт 200 с `<img src>` в
 *     никуда. См. {@link rejectDeleteWhileReferenced};
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
  type CollectionBeforeDeleteHook,
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

/**
 * Ключ признака «обход карточек оборвался по пределу».
 *
 * Ставит {@link resyncMirroredCards}, читает {@link retireReplacedObjects}: при
 * обрыве уборка прежних объектов ПРОПУСКАЕТСЯ. Иначе часть карточек осталась бы
 * и с зеркалом на прежние ключи, и без файлов по этим ключам — то есть
 * гарантированно без изображений на опубликованной странице до ручного
 * пересохранения. Лишние файлы в хранилище дешевле отсутствующих: они занимают
 * место, но ни одна страница из-за них не ломается.
 */
const RESYNC_TRUNCATED_CONTEXT_KEY = 'otkritka:imageMirrorResyncTruncated';

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
  /**
   * Пределы обхода карточек при пересинхронизации зеркала. Параметр существует
   * для тестов: и многостраничный обход, и ветка обрыва проверяются на
   * маленьких значениях, а не созданием тысячи карточек. Продуктовый путь берёт
   * {@link MIRROR_RESYNC_LIMITS}.
   */
  readonly resync?: Partial<MirrorResyncLimits>;
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

/**
 * Удаляет объекты, оставшиеся после замены изображения.
 *
 * Уборка ПРОПУСКАЕТСЯ, если обход карточек оборвался по пределу
 * ({@link resyncMirroredCards}): у части карточек зеркало осталось на прежних
 * ключах, и удаление файлов по этим ключам оставило бы уже опубликованные
 * страницы вовсе без изображений. Лишние файлы в хранилище — потерянное место;
 * отсутствующие файлы — сломанная страница в индексе.
 */
function retireReplacedObjects(
  options: UploadHookOptions,
): CollectionAfterChangeHook<ImageRecord> {
  return async ({ doc, req }) => {
    const retired = req.context[RETIRED_CONTEXT_KEY] as RetiredObjects | undefined;
    if (retired === undefined) {
      return doc;
    }
    delete req.context[RETIRED_CONTEXT_KEY];

    if (req.context[RESYNC_TRUNCATED_CONTEXT_KEY] === true) {
      delete req.context[RESYNC_TRUNCATED_CONTEXT_KEY];
      req.payload.logger.error(
        `[card-images] Уборка прежних файлов ПРОПУЩЕНА нарочно: обход карточек оборвался, ` +
          `и часть зеркал указывает на эти ${String(retired.derivativeKeys.length)} ключей. ` +
          'Удалить их можно только после ручной пересинхронизации оставшихся карточек — ' +
          'иначе опубликованные страницы остались бы без изображений.',
      );
      return doc;
    }

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
 * предупреждение плюс отказ от уборки прежних файлов, а не тихий выход.
 *
 * Форма — интерфейс с инъекцией через {@link UploadHookOptions}, а не две
 * модульные константы (находка ревизии от 2026-08-22): пока значения были
 * захардкожены, ни многостраничный обход, ни ветка обрыва не покрывались
 * тестами вовсе — «громко, а не молча» было заявлено, но не доказано.
 */
export interface MirrorResyncLimits {
  /** Жёсткий предел числа пересохранённых карточек за одну операцию. */
  readonly maxCards: number;
  /** Сколько карточек читается одним запросом. */
  readonly pageSize: number;
}

export const MIRROR_RESYNC_LIMITS: MirrorResyncLimits = {
  maxCards: 1000,
  pageSize: 100,
};

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
function resyncMirroredCards(limits: MirrorResyncLimits): CollectionAfterChangeHook<ImageRecord> {
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
      const page: {
        docs: { id: number | string; slug?: string | null }[];
        hasNextPage?: boolean | null;
      } = await req.payload.find({
        collection: 'cards',
        depth: 0,
        limit: limits.pageSize,
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
      // Признак «есть ещё» берётся у Payload, а не выводится из размера страницы
      // (находка ревизии от 2026-08-22). При числе карточек, КРАТНОМ размеру
      // страницы, последняя страница приходит полной, и правило
      // «полная страница ⇒ есть ещё» давало ложную тревогу: обход завершился
      // полностью, а в журнал шло «часть карточек осталась с зеркалом на
      // удалённые файлы». Ложная тревога об этом дефекте не лучше молчания —
      // после первой же она перестаёт читаться как настоящая.
      if (last === undefined || page.hasNextPage !== true) {
        break;
      }
      if (touched.length >= limits.maxCards) {
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
      // Признак читает `retireReplacedObjects`: прежние файлы остаются на месте.
      req.context[RESYNC_TRUNCATED_CONTEXT_KEY] = true;
      req.payload.logger.error(
        `[card-images] Обход карточек ОБОРВАН по пределу ${String(limits.maxCards)}: ` +
          'часть карточек осталась с зеркалом на ПРЕЖНИЕ ключи. Уборка прежних файлов ' +
          'пропущена нарочно, поэтому эти страницы продолжают показывать старую картинку, ' +
          'а не пустое место. Требуется ручная пересинхронизация: пересохраните оставшиеся ' +
          'карточки, после чего прежние файлы можно удалить.',
      );
    }

    return doc;
  };
}

/** Сколько ссылающихся карточек перечисляется в тексте отказа. */
const REFERENCE_SAMPLE_SIZE = 5;

/**
 * ОТКАЗ удалить изображение, на которое ссылается хоть одна карточка (задача
 * Э3-03a, находка ревизии от 2026-08-22).
 *
 * ЧТО БЫЛО ОТКРЫТО. Пересинхронизация зеркала закрывала только путь ЗАМЕНЫ
 * байтов. Путь удаления оставался открытым: `afterDelete` сносил файлы, связь
 * `cards.image` обнулялась каскадом на уровне базы
 * (`cards_rels` создаётся с `onDelete: 'cascade'`,
 * `@payloadcms/drizzle/dist/schema/build.js`) — то есть БЕЗ единого хука
 * карточки, — а зеркало `cards.derivative.variants[]` оставалось заполненным
 * ключами удалённых файлов. Опубликованная страница отдавала 200 с `<img src>`
 * в никуда: ровно тот дефект, от которого зеркало и заводилось.
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ ПЕРЕСИНХРОНИЗАЦИЯ. Рассматривались два варианта.
 *
 *   1. Пересинхронизировать зеркало в `afterDelete` до удаления объектов. К
 *      этому моменту каскад уже обнулил `cards.image`, поэтому пересохранение
 *      карточки записало бы ПУСТОЕ зеркало: опубликованная страница осталась бы
 *      без главного изображения — без битой ссылки, но и без картинки, и
 *      молча. Для страницы, чей смысл — одна открытка, это не спасение, а
 *      другой вид того же дефекта. Вдобавок удаление изображения решало бы за
 *      человека судьбу опубликованного URL, а это решение «301 или 404»
 *      (ТЗ §8.2).
 *   2. Отказать. Удаление файла, который стоит на странице, — решение о
 *      странице, а не уборка мусора: сначала человек решает, что происходит с
 *      карточкой (другое изображение, снятие с публикации, удаление с 301 или
 *      404), и только потом файл становится ненужным. Отказ выбран.
 *
 * Круг — ВСЕ карточки, а не только публиковавшиеся. У черновика зеркало точно
 * так же осталось бы с мёртвыми ключами, и всплыло бы это при публикации — то
 * есть в момент, когда страница уже отдаётся наружу.
 *
 * Образец формы отказа — `rejectDeleteWithChildren` в `../collections/collections.ts`:
 * тот же код возврата, тот же машинный признак в `data.rule` и обязательное
 * указание, КУДА идти отвязывать.
 */
function rejectDeleteWhileReferenced(): CollectionBeforeDeleteHook {
  return async ({ id, req }) => {
    const referencing = await req.payload.find({
      collection: 'cards',
      depth: 0,
      limit: REFERENCE_SAMPLE_SIZE,
      overrideAccess: true,
      req,
      select: { slug: true, status: true },
      sort: 'id',
      where: { image: { equals: id } },
    });

    const total = typeof referencing.totalDocs === 'number'
      ? referencing.totalDocs
      : referencing.docs.length;
    if (total === 0) {
      return;
    }

    const sample = referencing.docs
      .map((card) => {
        const record = asRecord(card);
        const slug = readString(record.slug) ?? `#${String(record.id)}`;
        return `${slug} (${readString(record.status) ?? 'без статуса'})`;
      })
      .join(', ');

    throw new APIError(
      `На это изображение ссылаются карточки (${String(total)}): ${sample}` +
        `${total > referencing.docs.length ? ' и другие' : ''}. Удаление обнулило бы у них ` +
        'поле «Изображение» КАСКАДОМ, минуя хуки, а зеркало путей (derivative.variants) ' +
        'осталось бы с ключами удалённых файлов — опубликованная страница отдавала бы 200 ' +
        'с картинкой в никуда. Сначала решите судьбу самих карточек: поставьте другое ' +
        'изображение, снимите с публикации или удалите карточку (для опубликованного URL ' +
        'при этом решается, 301 это или 404). После того как ни одна карточка на файл не ' +
        'ссылается, удаление проходит.',
      400,
      { rule: 'image-in-use' },
      true,
    );
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
  readonly beforeDelete: CollectionBeforeDeleteHook[];
}

export function cardImageUploadHooks(options: UploadHookOptions = {}): UploadHooks {
  const resyncLimits: MirrorResyncLimits = { ...MIRROR_RESYNC_LIMITS, ...options.resync };
  return {
    // Порядок значим: записать новое → перевести на него зеркало карточек →
    // убрать прежнее. Любая другая расстановка оставляет промежуток, в котором
    // запись или зеркало ссылаются на файлы, которых нет.
    afterChange: [
      writePendingObjects(options),
      resyncMirroredCards(resyncLimits),
      retireReplacedObjects(options),
    ],
    afterDelete: [deleteStoredObjects(options)],
    // Отказ стоит ДО удаления записи: после него связь уже обнулена каскадом, и
    // отменять нечего.
    beforeDelete: [rejectDeleteWhileReferenced()],
    // Хранилище этой фазе больше не нужно: она только считает, а пишет
    // `writePendingObjects` из afterChange.
    beforeChange: [runPipelineOnUpload()],
  };
}
