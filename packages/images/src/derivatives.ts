/**
 * Генерация производных изображений (ТЗ §6.2, §6.5).
 *
 * Что здесь важно и почему:
 *   - набор ширин — окончательная константа пакета `IMAGE_WIDTHS` (решение
 *     Ч-09): из окружения он не читается и расширить его нельзя, допустимо
 *     только сужение до подмножества. Качество кодирования, наоборот, —
 *     настраиваемое значение (`IMAGE_ENCODE_QUALITY`, Ч-29);
 *   - исходник уже `MIN_SOURCE_IMAGE_WIDTH` (640 px) отклоняется и в пайплайн
 *     не идёт (Ч-09 и блок 5 п. 2). Отсюда следует, что хотя бы одна ширина
 *     всегда подходит, и режим `nativeWidthFallback` недостижим;
 *   - EXIF Orientation применяется ДО ресайза, а размеры отдаются
 *     ориентированные. Иначе ресайз по ширине идёт по не той оси, а в
 *     хранилище уходит повёрнутая производная с постоянным URL — на этапе 3
 *     это уже неисправимо, шаблон получает готовые байты;
 *   - `width`/`height` каждого варианта берутся ПЕРЕЧИТЫВАНИЕМ метаданных
 *     готового буфера, а не арифметикой от запрошенной ширины: шаблон
 *     резервирует место по этим числам, и расхождение на пиксель — это CLS;
 *   - набор вариантов никогда не бывает пустым: пустой результат вызывающий
 *     код не отличит от успеха, и карточка ушла бы без изображения;
 *   - резервный JPEG обязателен всегда (ТЗ §6.2): набор без него отклоняется;
 *   - оригинал не мутируется и никуда не записывается: вход копируется в
 *     собственный буфер, выход возвращается вызывающему. Раскладка по
 *     хранилищу — задача Э2-04/Э2-05, не этого модуля.
 */
import sharp, { type Sharp } from 'sharp';
import {
  type ImagesEnv,
  MIN_SOURCE_IMAGE_WIDTH,
  resolveDerivativeWidths,
  resolveEncodeQuality,
} from './config.js';
import {
  assertOutputFormat,
  FALLBACK_FORMAT,
  OUTPUT_FORMATS,
  type OutputFormat,
} from './formats.js';
import { type ImageSource, readSource } from './source.js';

export interface MetadataContainer {
  /** Значение `format` в метаданных готового файла. */
  readonly container: string;
  /** Кодек внутри контейнера, если контейнер сам по себе его не определяет. */
  readonly compression?: string;
}

/**
 * Как формат вывода опознаётся в метаданных готового файла.
 *
 * AVIF — это HEIF-контейнер с кодеком AV1, и sharp сообщает про него
 * `format: 'heif'`, а не `'avif'`. Проверять формат производного нужно по этой
 * таблице, а не по нашему собственному ярлыку, иначе проверка «получилось ли
 * то, что просили» проходит на веру.
 */
export const METADATA_CONTAINER_BY_FORMAT: Readonly<Record<OutputFormat, MetadataContainer>> =
  Object.freeze({
    avif: { container: 'heif', compression: 'av1' },
    webp: { container: 'webp' },
    jpeg: { container: 'jpeg' },
  });

/**
 * Прогрессивный JPEG — константа пайплайна, а не параметр (решение Ч-29,
 * 2026-08-21: `progressive: true` подтверждён). Это практика §10 — раньше
 * показать что-то, чем ничего. Если однажды понадобится настраивать, это правка
 * с решением человека, а не молчаливое переключение здесь.
 */
const JPEG_PROGRESSIVE = true;

/** Один готовый вариант: то, что уйдёт в хранилище и в `srcset`. */
export interface ImageDerivative {
  readonly format: OutputFormat;
  /**
   * Ширина, под которую делался ресайз, — ширина из набора `IMAGE_WIDTHS`.
   * Поле ДИАГНОСТИЧЕСКОЕ: в ключ объекта, в `srcset` и в разметку оно не идёт
   * никогда, для этого есть {@link ImageDerivative.width}.
   */
  readonly targetWidth: number;
  /**
   * Фактическая ширина готового файла (из его метаданных).
   *
   * ЕДИНСТВЕННЫЙ источник ширины для внешнего мира (условие C8): и ключ
   * производной (`buildDerivativeObjectKey({ width })`), и дескриптор `w` в
   * `srcset`, и атрибут `width` в разметке обязаны собираться из ЭТОГО поля, а
   * не из `targetWidth`. Иначе URL и `srcset` разъезжаются с содержимым файла:
   * ключ обещает 640, файл отдаёт 500 — браузер выбирает вариант по ложному
   * дескриптору, а размеры в разметке дают сдвиг макета.
   *
   * СТАТУС: это оговорка контракта, а НЕ проверенное тестом свойство. Внутри
   * пакета различить два поля нечем — ресайз по одной ширине с
   * `withoutEnlargement` всегда даёт ровно `targetWidth`, поэтому любое
   * сравнение полей между собой тавтологично. Расхождение полей стало ещё и
   * недостижимым: после введения порога 640 px режим `nativeWidthFallback`
   * невозможен. Условие закрывается на Э2-05/Э3-04, где появляются ключ объекта
   * и разметка: там видно, из какого поля собраны URL и дескриптор `w`.
   */
  readonly width: number;
  /** Фактическая высота готового файла (из его метаданных). */
  readonly height: number;
  readonly byteSize: number;
  readonly data: Buffer;
}

/** Что было на входе — по метаданным оригинала. */
export interface SourceImageInfo {
  readonly format: string;
  /** Ширина ПОСЛЕ применения EXIF Orientation: столько пикселей видит человек. */
  readonly width: number;
  /** Высота ПОСЛЕ применения EXIF Orientation. */
  readonly height: number;
  /**
   * Значение тега EXIF Orientation у исходника (1 — тега нет или поворот не
   * нужен). Отдаётся явно, чтобы по записи было видно: ориентация учтена, а не
   * проигнорирована. Пропорция для резервирования места берётся из
   * `width`/`height` выше, они уже ориентированные.
   */
  readonly exifOrientation: number;
}

export interface DerivativeSet {
  readonly source: SourceImageInfo;
  /** Полный запрошенный набор ширин после нормализации. */
  readonly requestedWidths: readonly number[];
  /**
   * Ширины, которые пропущены как превышающие исходную.
   *
   * Апскейла нет — это норма, подтверждённая человеком 2026-08-21 (блок 5 п. 1):
   * растянутый вариант портит качество и раздувает вес без выигрыша, поэтому
   * вариант не выдумывается. У полного набора и исходника 700 px это означает
   * пропуск 960/1280/1920 — обычная, ожидаемая ситуация, а не отклонение.
   */
  readonly skippedWidths: readonly number[];
  /**
   * LEGACY-ПРИЗНАК. Всегда `false` в текущем пайплайне.
   *
   * Смысл поля: производные сделаны не в ширину из набора, а в натуральную
   * ширину исходника — так работал пайплайн до введения минимальной ширины
   * исходника. Поле остаётся в контракте, потому что у записей, загруженных ДО
   * порога 640 px (решение Ч-09 и блока 5 п. 2, 2026-08-21), производные именно
   * такие, и Э2-05 читает признак из записи, чтобы предупредить редактора.
   *
   * Почему признак недостижим сейчас: исходник уже 640 px отклоняется до
   * пайплайна, а минимальная ширина любого допустимого набора не превышает 640
   * (см. `resolveDerivativeWidths`), поэтому хотя бы одна ширина подходит всегда.
   * Этим закрыто условие C8 и снят риск C7: опубликованный ключ больше не
   * зависит от состава настроек, и допущение «`requestedWidths` минус
   * `skippedWidths` = ширины вариантов» снова верно.
   *
   * Что остаётся обязанностью Э2-05 независимо от этого: ключи производных —
   * данные записи, а не вычислимая функция настроек. Ширина для ключа берётся
   * из сохранённого `variant.width`, а не пересчитывается (ТЗ §6.3).
   */
  readonly nativeWidthFallback: boolean;
  /** Никогда не пустой: хотя бы один вариант на каждый запрошенный формат. */
  readonly variants: readonly ImageDerivative[];
}

export interface GenerateDerivativesOptions {
  /**
   * СУЖЕНИЕ набора ширин до подмножества `IMAGE_WIDTHS`. Нужно тестам и
   * разовым прогонам; продуктовый путь параметр не передаёт и работает на
   * полном наборе.
   *
   * Расширить набор через этот параметр нельзя (решение Ч-09): ширина вне
   * `IMAGE_WIDTHS` отклоняется, как и сужение, поднимающее минимум набора выше
   * порога исходника. Из окружения набор не читается вообще.
   */
  readonly widths?: readonly number[];
  /**
   * Подмножество форматов; по умолчанию — все из `OUTPUT_FORMATS`. Тип —
   * `string`, потому что граница пакета вызывается и из нетипизированного кода
   * (Payload, внешний API). Резервный JPEG обязателен в любом наборе.
   */
  readonly formats?: readonly string[];
  /** Переопределение качества кодирования: важнее окружения. */
  readonly quality?: Readonly<Partial<Record<OutputFormat, number>>>;
  /**
   * Срез окружения для чтения `IMAGE_ENCODE_QUALITY`. Набор ширин через
   * окружение НЕ настраивается (Ч-09): он окончателен.
   */
  readonly env?: ImagesEnv;
}

/**
 * Проверка минимальной ширины исходника (Ч-09 и блок 5 п. 2): изображение уже
 * {@link MIN_SOURCE_IMAGE_WIDTH} в пайплайн не идёт.
 *
 * Экспортируется отдельно, чтобы Э2-05 отклонил загрузку по метаданным — до
 * генерации производных и до обращения к хранилищу. Внутри `generateDerivatives`
 * та же проверка выполняется ещё раз: границу пакета зовут и из
 * нетипизированного кода, поэтому она не может опираться на «вызывающий уже
 * проверил».
 */
export function assertSourceImageWidth(width: number): number {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(
      `Ширина исходного изображения должна быть целым положительным числом, получено: ${String(width)}.`,
    );
  }
  if (width < MIN_SOURCE_IMAGE_WIDTH) {
    throw new Error(
      `Ширина исходного изображения ${String(width)} px меньше минимальной ` +
        `${String(MIN_SOURCE_IMAGE_WIDTH)} px (решение Ч-09): такое изображение мелкое для ` +
        'страницы, апскейл ему не делается, и в пайплайн оно не идёт. Нужен исходник крупнее — ' +
        'решение принимает редактор.',
    );
  }
  return width;
}

/**
 * Набор форматов вывода. Резервный JPEG обязателен всегда: без него часть
 * браузеров не получит изображение вообще (ТЗ §6.2, CLAUDE.md).
 */
function normalizeFormats(formats: readonly string[]): readonly OutputFormat[] {
  const normalized = [...new Set(formats.map((format) => assertOutputFormat(format)))];

  if (normalized.length === 0) {
    throw new Error(
      `Набор форматов вывода пуст: ожидается хотя бы ${FALLBACK_FORMAT} ` +
        `(допустимы ${OUTPUT_FORMATS.join(', ')}).`,
    );
  }
  if (!normalized.includes(FALLBACK_FORMAT)) {
    throw new Error(
      `В наборе форматов нет резервного ${FALLBACK_FORMAT}: он обязателен всегда (ТЗ §6.2), ` +
        'иначе браузер без AVIF/WebP не получит изображение. ' +
        `Получено: ${normalized.join(', ')}.`,
    );
  }

  // Порядок предпочтения из OUTPUT_FORMATS, а не порядок аргумента: он
  // определяет порядок источников в <picture>.
  return OUTPUT_FORMATS.filter((format) => normalized.includes(format));
}

/**
 * Качество после наложения опции на конфигурацию. Проверяется здесь, а не
 * только в парсере окружения: опцию передаёт и нетипизированный вызов.
 */
function assertQuality(quality: Readonly<Record<OutputFormat, number>>): Readonly<
  Record<OutputFormat, number>
> {
  for (const format of OUTPUT_FORMATS) {
    const value = quality[format];
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new Error(
        `Качество кодирования для ${format} должно быть целым числом 1..100, получено: ${String(value)}.`,
      );
    }
  }
  return quality;
}

function encode(pipeline: Sharp, format: OutputFormat, quality: number): Sharp {
  switch (format) {
    case 'avif':
      return pipeline.avif({ quality });
    case 'webp':
      return pipeline.webp({ quality });
    case 'jpeg':
      return pipeline.jpeg({ quality, progressive: JPEG_PROGRESSIVE });
  }
}

/**
 * Пайплайн чтения исходника: EXIF Orientation применяется сразу, дальше все
 * операции идут по ориентированному изображению.
 */
function openOriented(input: Buffer): Sharp {
  return sharp(input, { autoOrient: true });
}

export async function generateDerivatives(
  source: ImageSource,
  options: GenerateDerivativesOptions = {},
): Promise<DerivativeSet> {
  const input = await readSource(source);
  const formats = normalizeFormats(options.formats ?? OUTPUT_FORMATS);
  const requestedWidths = resolveDerivativeWidths(options.widths);
  const quality = assertQuality({ ...resolveEncodeQuality(options.env), ...options.quality });

  const sourceMetadata = await sharp(input).metadata();
  // autoOrient.width/height — размеры ПОСЛЕ применения EXIF Orientation;
  // width/height у sharp даны без учёта тега.
  const orientedWidth = sourceMetadata.autoOrient.width;
  const orientedHeight = sourceMetadata.autoOrient.height;
  if (
    !Number.isInteger(orientedWidth) ||
    !Number.isInteger(orientedHeight) ||
    orientedWidth <= 0 ||
    orientedHeight <= 0
  ) {
    throw new Error('Не удалось определить размеры исходного изображения.');
  }

  // Порог минимальной ширины — до всякой работы с байтами: мелкий исходник в
  // пайплайн не идёт (Ч-09, блок 5 п. 2). Проверяется ориентированная ширина —
  // именно столько пикселей увидит человек.
  assertSourceImageWidth(orientedWidth);

  const sourceInfo: SourceImageInfo = {
    format: sourceMetadata.format,
    width: orientedWidth,
    height: orientedHeight,
    exifOrientation: sourceMetadata.orientation ?? 1,
  };

  // Апскейла нет (блок 5 п. 1): ширина больше исходной пропускается.
  const targetWidths = requestedWidths.filter((width) => width <= sourceInfo.width);
  const skippedWidths = requestedWidths.filter((width) => width > sourceInfo.width);

  if (targetWidths.length === 0) {
    // Недостижимо: минимальная ширина допустимого набора не превышает порога
    // исходника (см. resolveDerivativeWidths), а исходник уже порога отклонён
    // выше. Оставлено явной ошибкой, а не молчаливым fallback: если инвариант
    // однажды нарушат правкой набора, это обязано упасть, а не тихо выдать
    // ключ с натуральной шириной, который потом не воспроизводится (C7).
    throw new Error(
      `Ни одна ширина из набора ${requestedWidths.join(', ')} не подошла к исходнику ` +
        `${String(sourceInfo.width)} px — это ошибка реализации: минимальная ширина набора ` +
        `обязана быть не больше порога ${String(MIN_SOURCE_IMAGE_WIDTH)} px.`,
    );
  }

  const variants: ImageDerivative[] = [];
  for (const format of formats) {
    for (const targetWidth of targetWidths) {
      const data = await encode(
        openOriented(input).resize({
          width: targetWidth,
          fit: 'inside',
          // Апскейл запрещён отдельно от фильтрации ширин: страховка на случай
          // округлений внутри sharp.
          withoutEnlargement: true,
          // Качество важнее скорости генерации (производные считаются один раз
          // при загрузке): ускоренное уменьшение при декодировании даёт муар на
          // части изображений.
          fastShrinkOnLoad: false,
        }),
        format,
        quality[format],
      ).toBuffer();

      // Фактические размеры — только из метаданных готового файла.
      const metadata = await sharp(data).metadata();
      if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
        throw new Error(
          `Не удалось прочитать размеры производного изображения ${format}@${String(targetWidth)}.`,
        );
      }

      const expected = METADATA_CONTAINER_BY_FORMAT[format];
      if (
        metadata.format !== expected.container ||
        (expected.compression !== undefined && metadata.compression !== expected.compression)
      ) {
        throw new Error(
          `Производное изображение ${format}@${String(targetWidth)} закодировано не в тот формат: ` +
            `в метаданных ${metadata.format}/${metadata.compression ?? '—'}.`,
        );
      }

      variants.push({
        format,
        targetWidth,
        width: metadata.width,
        height: metadata.height,
        byteSize: data.byteLength,
        data,
      });
    }
  }

  if (variants.length === 0) {
    throw new Error(
      'Пайплайн не создал ни одного производного изображения — это ошибка реализации: ' +
        'набор форматов непуст, подходящая ширина есть.',
    );
  }

  return {
    source: sourceInfo,
    requestedWidths,
    skippedWidths,
    // Всегда false: см. docstring `DerivativeSet.nativeWidthFallback` — поле
    // осталось legacy-признаком для записей, загруженных до порога 640 px.
    nativeWidthFallback: false,
    variants,
  };
}
