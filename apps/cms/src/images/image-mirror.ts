/**
 * Зеркало состояния файла в записи карточки: поля пути И варианты производных
 * (задача Э3-03a, блокер публичного рендера Э3-04/Э3-05).
 *
 * ## Зачем зеркало вообще
 *
 * У коллекции `card-images` чтение — `authenticatedAccess`: анонимный запрос
 * получает `Forbidden`. Публичный рендер (`apps/web`) читает как аноним, через
 * Local API с `overrideAccess: false` и без пользователя, — и это не
 * ограничение, а контракт: любой пользователь означает роль, а обе роли проекта
 * видят черновики. При `depth > 0` Payload населяет связь только если её
 * разрешено читать, а иначе подставляет ИДЕНТИФИКАТОР
 * (`payload/dist/fields/hooks/afterRead/relationshipPopulationPromise.js`:
 * «ids are visible regardless of access controls»), поэтому слой данных
 * `apps/web` работает на `depth: 0`.
 *
 * Отсюда следствие, из-за которого этот модуль существует: ширин и высот
 * производных публичному рендеру взять негде. Отклонённая альтернатива —
 * открыть анонимное чтение `card-images`: она потребовала бы фильтра «только
 * изображения, привязанные к опубликованным карточкам» в access control и
 * расширила бы публичную поверхность ради данных, которые нужны исключительно
 * вместе с карточкой.
 *
 * ## Условие C8 — почему в зеркале именно эти четыре поля
 *
 * Ключ производной, дескриптор `w` в `srcset` и атрибуты `width`/`height`
 * обязаны собираться из ОДНОГО значения — фактической ширины, прочитанной
 * пайплайном из метаданных ГОТОВОГО файла (`packages/images/derivatives.ts`).
 * Поэтому:
 *
 *   - `targetWidth` (ЗАПРОШЕННАЯ ширина) в зеркало не переносится вовсе. Она
 *     расходится с фактической на пропорциях, не делящихся нацело, и выбор «не
 *     той» ширины даёт расхождение атрибута `width` с картинкой, то есть CLS;
 *   - `byteSize` не переносится: разметка его не использует. Поле «на будущее»
 *     в зеркале — это второй источник данных о файле, который никто не читает и
 *     потому никто не проверяет;
 *   - формы полей `key`/`format`/`width`/`height` берутся из ОДНОЙ фабрики
 *     {@link imageVariantFields}, которой пользуются и источник
 *     (`card-images.variants`), и зеркало (`cards.derivative.variants`).
 *     Разъехаться описаниям нельзя: тест сверяет их поле в поле.
 *
 * ## Границы модуля
 *
 * Здесь только ЧИСТЫЕ функции и описания полей: ни обращений к базе, ни хуков,
 * ни сборки URL. Запись зеркала в карточку — `./card-image-hooks.ts`,
 * пересинхронизация после замены байтов — `./upload-hooks.ts`, публичный путь
 * `/media/<ключ>` — `@otkritka/images` (`derivativePublicPath`).
 */
import type { Field } from 'payload';

import { OUTPUT_FORMATS, isOutputFormat } from '@otkritka/images';

/**
 * Поля строки варианта, которые попадают в зеркало.
 *
 * Порядок значим: он же порядок полей в схеме, и тест сверяет по нему источник с
 * зеркалом.
 */
export const MIRRORED_VARIANT_FIELD_NAMES = ['key', 'format', 'width', 'height'] as const;

/** Строка зеркала: ровно то, из чего собирается `<picture>`. */
export interface MirroredVariant {
  /** Формат вывода: `avif` | `webp` | `jpeg`. Набор закрыт `OUTPUT_FORMATS`. */
  readonly format: string;
  /** ФАКТИЧЕСКАЯ высота файла в пикселях. Атрибут `height` берётся отсюда. */
  readonly height: number;
  /** Ключ объекта в хранилище. Публичный путь — `derivativePublicPath(key)`. */
  readonly key: string;
  /** ФАКТИЧЕСКАЯ ширина файла в пикселях: и дескриптор `w`, и атрибут `width`. */
  readonly width: number;
}

/** Состояние файла, зеркалируемое в карточку целиком. */
export interface ImageMirror {
  readonly keyBase: string | null;
  readonly nameStem: string | null;
  readonly nameSuffix: number | null;
  readonly pHash: string | null;
  readonly revision: string | null;
  readonly variants: readonly MirroredVariant[];
}

/** Пустое состояние: изображения у карточки нет. */
export const EMPTY_IMAGE_MIRROR: ImageMirror = {
  keyBase: null,
  nameStem: null,
  nameSuffix: null,
  pHash: null,
  revision: null,
  variants: [],
};

export interface ImageVariantFieldsOptions {
  /**
   * Включать ли `byteSize`.
   *
   * `true` только у ИСТОЧНИКА (`card-images.variants`): там это факт о файле,
   * который пригодится при разборе «почему производная столько весит». В
   * зеркале его нет — см. шапку модуля.
   */
  readonly includeByteSize: boolean;
}

const formatOptions = OUTPUT_FORMATS.map((format) => ({ label: format, value: format }));

/**
 * Поля одной строки массива вариантов — общие для источника и зеркала.
 *
 * Фабрика, а не две копии литералов: расхождение описаний означало бы, что
 * значение, недопустимое в источнике, проходит в зеркало (или наоборот), и
 * обнаружилось бы это уже на странице.
 */
export function imageVariantFields(options: ImageVariantFieldsOptions): Field[] {
  const fields: Field[] = [
    {
      name: 'key',
      type: 'text',
      required: true,
      admin: {
        description:
          'Ключ объекта в хранилище. Публичный путь собирается из него единственной ' +
          'функцией derivativePublicPath (/media/<ключ>); хост добавляет хелпер над ' +
          'SITE_URL. Ключ содержит revision, поэтому постоянен (ТЗ §6.3, Ч-28).',
      },
    },
    {
      name: 'format',
      type: 'select',
      options: formatOptions,
      required: true,
      admin: { description: 'Формат вывода. Набор закрыт набором вывода пайплайна.' },
    },
    {
      name: 'width',
      type: 'number',
      required: true,
      admin: {
        description:
          'ФАКТИЧЕСКАЯ ширина готового файла из его метаданных. Отсюда берутся и ' +
          'дескриптор w в srcset, и атрибут width — из одного значения (условие C8). ' +
          'Запрошенная ширина (targetWidth) для этого не годится: на пропорциях, не ' +
          'делящихся нацело, она расходится с фактической, и место резервировалось бы ' +
          'не под ту картинку.',
      },
    },
    {
      name: 'height',
      type: 'number',
      required: true,
      admin: {
        description:
          'ФАКТИЧЕСКАЯ высота готового файла. Атрибут height берётся отсюда: без пары ' +
          'width/height браузер не резервирует место, и загрузка изображения даёт CLS.',
      },
    },
  ];

  if (options.includeByteSize) {
    fields.push({
      name: 'byteSize',
      type: 'number',
      required: true,
      admin: {
        description:
          'Размер файла в байтах. В зеркало карточки НЕ переносится: разметка его не ' +
          'использует.',
      },
    });
  }

  return fields;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readPixels(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Варианты из записи `card-images` в форме зеркала.
 *
 * Строка с непригодным значением ОТБРАСЫВАЕТСЯ, а не «чинится» нулём или
 * подстановкой: `width: 0` дал бы дескриптор `0w` и атрибут `width="0"`, то есть
 * нулевое зарезервированное место и сдвиг макета при загрузке. Отбрасывание
 * заметно (вариантов стало меньше — предупреждение пишет хук), подстановка — нет.
 *
 * Порядок строк источника сохраняется один в один: он же попадает в зеркало и
 * дальше в разметку.
 */
export function readMirroredVariants(doc: Readonly<Record<string, unknown>>): readonly MirroredVariant[] {
  if (!Array.isArray(doc.variants)) {
    return [];
  }

  const variants: MirroredVariant[] = [];
  for (const row of doc.variants) {
    const record = asRecord(row);
    const key = readString(record.key);
    const format = readString(record.format);
    const width = readPixels(record.width);
    const height = readPixels(record.height);

    if (key === null || format === null || !isOutputFormat(format) || width === null || height === null) {
      continue;
    }
    variants.push({ format, height, key, width });
  }
  return variants;
}

/** Состояние файла из записи `card-images` целиком. */
export function readImageMirror(doc: Readonly<Record<string, unknown>>): ImageMirror {
  return {
    keyBase: readString(doc.keyBase),
    nameStem: readString(doc.nameStem),
    nameSuffix: typeof doc.nameSuffix === 'number' ? doc.nameSuffix : null,
    pHash: readString(doc.pHash),
    revision: readString(doc.revision),
    variants: readMirroredVariants(doc),
  };
}

/** Совпадают ли наборы вариантов — покомпонентно и по порядку. */
export function sameMirroredVariants(
  left: readonly MirroredVariant[],
  right: readonly MirroredVariant[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((variant, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      variant.key === other.key &&
      variant.format === other.format &&
      variant.width === other.width &&
      variant.height === other.height
    );
  });
}

/**
 * Совпадают ли состояния зеркала целиком.
 *
 * Нужно ровно для одного решения: надо ли пересохранять карточки после
 * сохранения изображения. Несодержательное сохранение изображения (правка
 * названия) состояние не меняет — и карточки трогать незачем; замена байтов
 * меняет и ревизию, и все ключи — тогда зеркало обязано обновиться, иначе
 * опубликованная страница ссылается на файлы, которых уже нет.
 */
export function sameImageMirror(left: ImageMirror, right: ImageMirror): boolean {
  return (
    left.keyBase === right.keyBase &&
    left.nameStem === right.nameStem &&
    left.nameSuffix === right.nameSuffix &&
    left.pHash === right.pHash &&
    left.revision === right.revision &&
    sameMirroredVariants(left.variants, right.variants)
  );
}
