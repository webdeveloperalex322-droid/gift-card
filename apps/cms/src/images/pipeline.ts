/**
 * Прогон пайплайна изображений на стороне CMS (задачи Э2-05 и Э2-06).
 *
 * Здесь собрано всё, что происходит с ФАЙЛОМ при загрузке и при замене, и ничего
 * из того, что происходит с записью: Payload-хук (`./upload-hooks.ts`) вызывает
 * эту функцию и раскладывает результат по полям. Поэтому прогон проверяется
 * обычным тестом на настоящих байтах, а не только смоуком на живой базе.
 *
 * ПОРЯДОК ШАГОВ — часть контракта, а не деталь реализации:
 *
 *   1. валидация типа, размера и минимальной ширины (`./upload-validation.ts`) —
 *      до декодирования и до обращения к хранилищу;
 *   2. ревизия (хеш БАЙТОВ, Ч-28) и pHash;
 *   3. имя файла: при первой загрузке занимается один раз через реестр
 *      (callback {@link RunPipelineInput.allocateStem}), при замене берётся ИЗ
 *      ЗАПИСИ. Пересчёт имени из заголовка после публикации запрещён (C1);
 *   4. генерация производных;
 *   5. ключи и байты, ГОТОВЫЕ к записи ({@link PipelineResult.pending}). Сам
 *      прогон в хранилище НЕ пишет;
 *   6. список ключей, которые больше не нужны ({@link PipelineResult.retired}).
 *      Удаляет их вызывающий ПОСЛЕ фиксации записи: удалить раньше — значит на
 *      время оставить запись, ссылающуюся на несуществующие файлы.
 *
 * ПОЧЕМУ ПАЙПЛАЙН НЕ ПИШЕТ В ХРАНИЛИЩЕ САМ (находка ревизии от 2026-08-22).
 * Прогон выполняется в `beforeChange`, то есть ДО записи документа. Пока файлы
 * писались здесь, любой отказ дальше по операции — валидация поля, ошибка базы,
 * блокировка по визуальному дублю, откат транзакции — оставлял файлы без записи,
 * причём производные лежат в ПУБЛИЧНОМ пространстве и отдаются по `/media`. То
 * есть в открытом доступе оказывался файл, о котором CMS ничего не знает и
 * который никто не удалит. Уборку «по неуспеху» в Payload навесить не на что:
 * хука «операция провалилась» у него нет вовсе (проверено по исходникам,
 * `payload/dist/collections/operations/create.js`: на ошибке вызывается
 * `killTransaction`, и ни один хук коллекции больше не выполняется). Поэтому
 * запись отложена: её выполняет {@link commitPendingObjects} из `afterChange`,
 * когда документ уже записан, но транзакция ещё не зафиксирована. Ошибка самой
 * записи файлов там убирает за собой и валит операцию — база откатывается, и
 * лишних файлов не остаётся ни при каком исходе.
 *
 * Оригинал при замене получает НОВЫЙ непредсказуемый идентификатор, а не
 * перезаписывается на месте. Причина: пока новая запись не зафиксирована, старый
 * оригинал обязан остаться целым — иначе неудачная замена уносит единственный
 * исходник.
 */
import {
  computeImageRevision,
  computePerceptualHash,
  createOpaqueImageStorageId,
  generateDerivatives,
} from '@otkritka/images';

import {
  type StemCandidate,
  type VariantRecord,
  buildKeyBase,
  buildOriginalKey,
  originalExtensionForMimeType,
  stemCandidates,
  toVariantRecords,
} from './keys';
import type { ImageStorage } from './storage';
import { assertAcceptedUpload } from './upload-validation';

/** Состояние пайплайна, уже сохранённое в записи. */
export interface StoredImageState {
  readonly keyBase?: string | null;
  readonly nameStem?: string | null;
  readonly nameSuffix?: number | null;
  readonly originalKey?: string | null;
  readonly revision?: string | null;
  readonly storageId?: string | null;
  readonly variants?: readonly { readonly key?: string | null }[] | null;
}

export interface RunPipelineInput {
  /**
   * Занимает имя файла: получает кандидатов в порядке `имя`, `имя-2`, `имя-3` и
   * возвращает первого свободного. Вызывается ТОЛЬКО при первой загрузке —
   * дальше имя берётся из записи, иначе удаление ранней записи освободило бы
   * `N` и путь другой записи изменился бы незаметно.
   */
  readonly allocateStem: (candidates: readonly StemCandidate[]) => Promise<StemCandidate>;
  readonly buffer: Buffer;
  readonly byteSize: number;
  readonly declaredHeight?: number | null;
  readonly declaredWidth?: number | null;
  /** Описание, из которого строится имя файла при ПЕРВОЙ загрузке. */
  readonly description: string;
  readonly mimeType: string;
  /** Состояние записи до операции; `null` при первой загрузке. */
  readonly stored: StoredImageState | null;
}

/** Объект, готовый к записи в хранилище: ключ и байты. */
export interface PendingObject {
  readonly data: Buffer;
  readonly key: string;
}

/**
 * Всё, что предстоит записать. Пишется ПОСЛЕ записи документа — см. шапку
 * модуля и {@link commitPendingObjects}.
 */
export interface PendingObjects {
  readonly derivatives: readonly PendingObject[];
  readonly original: PendingObject;
}

export interface PipelineSourceInfo {
  readonly exifOrientation: number;
  readonly format: string;
  readonly height: number;
  readonly width: number;
}

export interface PipelineResult {
  /** Общая часть ключей производных: `<префикс>/<revision>/<имя>`. */
  readonly keyBase: string;
  readonly nameStem: string;
  readonly nameSuffix: number | null;
  readonly originalExtension: string;
  readonly originalKey: string;
  readonly pHash: string;
  /** Байты и ключи, ожидающие записи. Пишет вызывающий после записи документа. */
  readonly pending: PendingObjects;
  /** Заменены ли байты (у записи уже была другая ревизия). */
  readonly replaced: boolean;
  /** Объекты, которые после фиксации записи больше не нужны. */
  readonly retired: {
    readonly derivativeKeys: readonly string[];
    readonly originalKey: string | null;
  };
  readonly revision: string;
  readonly source: PipelineSourceInfo;
  readonly variants: readonly VariantRecord[];
}

function readStoredStem(stored: StoredImageState | null): StemCandidate | null {
  const stem = stored?.nameStem;
  if (typeof stem !== 'string' || stem.trim() === '') {
    return null;
  }
  const suffix = stored?.nameSuffix;
  return { stem, suffix: typeof suffix === 'number' ? suffix : null };
}

function storedDerivativeKeys(stored: StoredImageState | null): readonly string[] {
  return (stored?.variants ?? [])
    .map((variant) => variant.key)
    .filter((key): key is string => typeof key === 'string' && key !== '');
}

export async function runImagePipeline(input: RunPipelineInput): Promise<PipelineResult> {
  assertAcceptedUpload({
    byteSize: input.byteSize,
    declaredHeight: input.declaredHeight,
    declaredWidth: input.declaredWidth,
    mimeType: input.mimeType,
  });

  const revision = await computeImageRevision(input.buffer);
  const pHash = await computePerceptualHash(input.buffer);

  // Имя файла: из записи, если оно там есть. Именно здесь выполняется условие
  // C1 — постоянство пути при правке заголовка после публикации.
  const reused = readStoredStem(input.stored);
  const name = reused ?? (await input.allocateStem(stemCandidates(input.description)));

  const derivatives = await generateDerivatives(input.buffer);
  const variants = toVariantRecords({
    derivatives: derivatives.variants,
    revision,
    stem: name.stem,
  });

  const originalExtension = originalExtensionForMimeType(input.mimeType);
  const storageId = createOpaqueImageStorageId();
  const originalKey = buildOriginalKey({ mimeType: input.mimeType, storageId });

  const pendingDerivatives: PendingObject[] = [];
  for (const [index, variant] of variants.entries()) {
    const derivative = derivatives.variants[index];
    if (derivative === undefined) {
      throw new Error('Рассинхронизация вариантов пайплайна — это ошибка реализации.');
    }
    pendingDerivatives.push({ data: derivative.data, key: variant.key });
  }

  const freshKeys = new Set(variants.map((variant) => variant.key));
  const previousOriginalKey =
    typeof input.stored?.originalKey === 'string' && input.stored.originalKey !== ''
      ? input.stored.originalKey
      : null;

  return {
    keyBase: buildKeyBase({ revision, stem: name.stem }),
    nameStem: name.stem,
    nameSuffix: name.suffix,
    originalExtension,
    originalKey,
    pHash,
    pending: {
      derivatives: pendingDerivatives,
      original: { data: input.buffer, key: originalKey },
    },
    replaced: reused !== null,
    retired: {
      // Ключ, который заново занят этой же загрузкой, в отставку не уходит:
      // повторная загрузка ТЕХ ЖЕ байтов даёт ту же ревизию, то есть те же пути,
      // и удалять их нельзя — файлы только что записаны.
      derivativeKeys: storedDerivativeKeys(input.stored).filter((key) => !freshKeys.has(key)),
      originalKey: previousOriginalKey === originalKey ? null : previousOriginalKey,
    },
    revision,
    source: {
      exifOrientation: derivatives.source.exifOrientation,
      format: derivatives.source.format,
      height: derivatives.source.height,
      width: derivatives.source.width,
    },
    variants,
  };
}

/**
 * Записывает подготовленные объекты в хранилище — АТОМАРНО по отношению к
 * лишним файлам.
 *
 * Вызывается из `afterChange`, то есть после записи документа и до фиксации
 * транзакции (см. шапку модуля). Если запись любого объекта сорвалась, функция
 * удаляет всё, что успела записать, и бросает исходную ошибку: операция
 * провалится, база откатится, и в публичном пространстве не останется файла без
 * записи. Обратный порядок («оставим что записалось, авось пригодится») здесь
 * недопустим: `/media/<ключ>` отдаётся наружу, а ключа этого файла не знает
 * никто, кроме упавшей операции.
 *
 * Оригинал пишется первым: если сорвётся производная, исходник для перегенерации
 * уже есть — но при откате он тоже убирается, потому что записи, которая на него
 * ссылалась бы, не будет.
 */
export async function commitPendingObjects(
  storage: ImageStorage,
  pending: PendingObjects,
): Promise<void> {
  const writtenDerivatives: string[] = [];
  let writtenOriginal: string | null = null;

  try {
    await storage.putOriginal(pending.original.key, pending.original.data);
    writtenOriginal = pending.original.key;

    for (const derivative of pending.derivatives) {
      await storage.putDerivative(derivative.key, derivative.data);
      writtenDerivatives.push(derivative.key);
    }
  } catch (error) {
    for (const key of writtenDerivatives) {
      // Уборка не должна заслонять исходную причину: ошибка удаления
      // проглатывается, ошибка записи поднимается наверх.
      await storage.deleteDerivative(key).catch(() => undefined);
    }
    if (writtenOriginal !== null) {
      await storage.deleteOriginal(writtenOriginal).catch(() => undefined);
    }
    throw error;
  }
}
