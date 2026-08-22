/**
 * Имена и ключи объектов на стороне CMS (задачи Э2-05, Э2-06).
 *
 * `@otkritka/images` строит ключ как ЧИСТУЮ функцию входа и не знает состояния
 * хранилища. Отсюда обязанности, которые остаются здесь и закрывают условия
 * вето V3:
 *
 *   - **C1. Источник имени — запись, а не заголовок.** Ключ собирается из
 *     сохранённого `nameStem`, поэтому правка заголовка карточки после
 *     публикации, смена лимита длины имени или пополнение таблицы
 *     транслитерации не меняют ни одного уже выданного пути. Пересчёт из
 *     заголовка означал бы, что содержимое то же, а URL файла другой — прямое
 *     нарушение ТЗ §6.3.
 *   - **C2. Ключ меняется только вместе с `revision`.** Ревизия — короткий хеш
 *     БАЙТОВ (Ч-28), её считает `computeImageRevision`. Ни `updatedAt`, ни
 *     счётчик сохранений источником быть не могут.
 *   - **C8. Ширина в ключе — фактическая ширина варианта.** Здесь она берётся
 *     из `variant.width` и в ту же запись попадает как `width`, поэтому
 *     дескриптор `w` в `srcset` и атрибут `width` в разметке (Э3-04) читают
 *     ровно то число, что стоит в имени файла. Диагностическое `targetWidth`
 *     сюда не попадает вообще.
 *   - **Суффикс `-N`.** Пакет его не вычисляет (без состояния хранилища это
 *     невозможно). Здесь строится ПОРЯДОК кандидатов, а занимает их реестр
 *     `image-name-claims`: записи реестра не удаляются, поэтому `N` не
 *     переиспользуется после удаления изображения.
 *
 * Расширение оригинала выводится из mime-типа, а НЕ из имени файла клиента: имя
 * приходит извне, и «kartinka.php.jpg» не должен превратиться в путь с чужим
 * расширением.
 */
import {
  type OutputFormat,
  buildDerivativeObjectKey,
  buildImageFileStem,
  buildOriginalObjectKey,
} from '@otkritka/images';

import { DERIVATIVE_KEY_PREFIX, ORIGINAL_KEY_PREFIX, assertStorageKey } from './storage';

/**
 * Предел перебора суффиксов `-N` за одну загрузку.
 *
 * Зачем предел: занятые имена перебираются попытками записи в реестр, и без
 * границы редкая патология (сотни изображений с одинаковым описанием) выродилась
 * бы в длинную серию запросов вместо внятного отказа. 50 — заведомо больше, чем
 * бывает осмысленных одноимённых открыток; упёршийся в предел редактор обязан
 * дать другое описание, а не получить имя вида `otkrytka-137`.
 */
export const MAX_NAME_SUFFIX = 50;

/** Расширение файла оригинала по mime-типу. Набор совпадает с принимаемыми типами. */
const ORIGINAL_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'image/avif': 'avif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export interface StemCandidate {
  /** Имя файла без расширения: `<имя>` или `<имя>-N`. */
  readonly stem: string;
  /** `null` у первого кандидата — у него суффикса нет вовсе. */
  readonly suffix: number | null;
}

/**
 * Кандидаты на имя файла в порядке занятия: сначала без суффикса, затем `-2`,
 * `-3`, … Отсчёт с 2 — правило `@otkritka/images`: у первого имени суффикса нет,
 * иначе у одного изображения было бы два законных пути (`имя` и `имя-1`).
 *
 * Место под суффикс вычитается из лимита длины самим пакетом, поэтому кандидат с
 * суффиксом не длиннее кандидата без него.
 *
 * @throws Error если из описания не получается имени (нет букв, только цифры,
 *   неподдерживаемая письменность) — решение «попросить у редактора другое
 *   описание» принимает вызывающий код.
 */
export function stemCandidates(description: string): readonly StemCandidate[] {
  const candidates: StemCandidate[] = [{ stem: buildImageFileStem(description), suffix: null }];
  for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    candidates.push({ stem: buildImageFileStem(description, { uniqueSuffix: suffix }), suffix });
  }
  return candidates;
}

export interface DerivativeKeyInput {
  /** Формат производной. Тип `string`: сужение делает сам пакет в рантайме. */
  readonly format: string;
  readonly revision: string;
  /** СОХРАНЁННОЕ имя файла из записи (вместе с суффиксом `-N`, если он есть). */
  readonly stem: string;
  /** ФАКТИЧЕСКАЯ ширина варианта (`variant.width`), не `targetWidth`. */
  readonly width: number;
}

/**
 * Ключ производной из сохранённого имени.
 *
 * `description: stem` — не обход контракта пакета, а его использование по
 * назначению: `stem` уже прошёл `slugify`, поэтому повторное построение имени из
 * него идемпотентно и суффикс `-N` остаётся тем же (проверено тестом). Передать
 * сюда текущий заголовок вместо сохранённого имени означало бы нарушить C1.
 */
export function derivativeKey(input: DerivativeKeyInput): string {
  return assertStorageKey(
    buildDerivativeObjectKey({
      description: input.stem,
      format: input.format,
      prefix: DERIVATIVE_KEY_PREFIX,
      revision: input.revision,
      width: input.width,
    }),
  );
}

/**
 * Общая часть ключей всех вариантов: `<префикс>/<revision>/<имя>`.
 *
 * Хранится в записи (`derivative.keyBase` у карточки) как машинный признак того,
 * что путь зафиксирован: сравнение сохранённого значения с пересчитанным ловит
 * попытку изменить путь опубликованного файла.
 */
export function buildKeyBase(input: { readonly revision: string; readonly stem: string }): string {
  const key = derivativeKey({ ...input, format: 'jpeg', width: 1 });
  return key.slice(0, key.lastIndexOf('-1.'));
}

/** Вариант производной в том виде, в каком его отдаёт `@otkritka/images`. */
export interface DerivativeLike {
  readonly byteSize: number;
  readonly format: OutputFormat;
  readonly height: number;
  /** Ширина, под которую делался ресайз. Здесь НЕ используется (условие C8). */
  readonly targetWidth: number;
  /** Фактическая ширина готового файла. Единственный источник ширины. */
  readonly width: number;
}

/** Вариант в том виде, в каком он ложится в запись CMS. */
export interface VariantRecord {
  readonly byteSize: number;
  readonly format: OutputFormat;
  readonly height: number;
  readonly key: string;
  readonly width: number;
}

/**
 * Записи вариантов: ключ и размеры из ОДНОГО источника.
 *
 * Здесь замыкается условие C8: `key` и `width` считаются из одного и того же
 * `variant.width`, поэтому разойтись они не могут — а `apps/web` (Э3-04) обязан
 * брать и путь, и дескриптор `w`, и атрибут `width` из этой записи, а не
 * пересчитывать из настроек.
 */
export function toVariantRecords(input: {
  readonly derivatives: readonly DerivativeLike[];
  readonly revision: string;
  readonly stem: string;
}): readonly VariantRecord[] {
  return input.derivatives.map((derivative) => ({
    byteSize: derivative.byteSize,
    format: derivative.format,
    height: derivative.height,
    key: derivativeKey({
      format: derivative.format,
      revision: input.revision,
      stem: input.stem,
      width: derivative.width,
    }),
    width: derivative.width,
  }));
}

/**
 * Расширение оригинала по mime-типу.
 *
 * @throws Error для типа вне набора принимаемых: в непубличное пространство не
 *   попадает файл, которого пайплайн не понимает.
 */
export function originalExtensionForMimeType(mimeType: string): string {
  const extension = ORIGINAL_EXTENSION_BY_MIME_TYPE[mimeType.trim().toLowerCase()];
  if (extension === undefined) {
    throw new Error(
      `Тип «${mimeType}» не входит в набор принимаемых изображений ` +
        `(${Object.keys(ORIGINAL_EXTENSION_BY_MIME_TYPE).join(', ')}), расширение оригинала ` +
        'определить нечем.',
    );
  }
  return extension;
}

/**
 * Ключ оригинала: `<непубличный префикс>/<непредсказуемый id>.<расширение>`.
 *
 * Описательного имени в пути нет намеренно — по опубликованному имени файла
 * оригинал не должен угадываться (ТЗ §6.1, §11). Идентификатор принимается,
 * только если его выдал `createOpaqueImageStorageId`: проверку формы делает сам
 * пакет.
 */
export function buildOriginalKey(input: {
  readonly mimeType: string;
  readonly storageId: string;
}): string {
  return assertStorageKey(
    buildOriginalObjectKey({
      extension: originalExtensionForMimeType(input.mimeType),
      prefix: ORIGINAL_KEY_PREFIX,
      storageId: input.storageId,
    }),
  );
}
