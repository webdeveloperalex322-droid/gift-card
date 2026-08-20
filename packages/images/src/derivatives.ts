/**
 * Генерация производных изображений (ТЗ §6.2, §6.5).
 *
 * Что здесь важно и почему:
 *   - набор ширин и качество кодирования приходят из конфигурации
 *     (`IMAGE_WIDTHS`, `IMAGE_ENCODE_QUALITY`), а не зашиты в логику;
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
import { type ImagesEnv, resolveEncodeQuality, resolveImageWidths } from './config.js';
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
 * Прогрессивный JPEG — константа пайплайна, а не параметр: это практика
 * §10 (раньше показать что-то, чем ничего), она не про компромисс качества и
 * решением человека не является. Если понадобится настраивать — это отдельный
 * вопрос в реестр, а не молчаливая правка здесь.
 */
const JPEG_PROGRESSIVE = true;

/** Один готовый вариант: то, что уйдёт в хранилище и в `srcset`. */
export interface ImageDerivative {
  readonly format: OutputFormat;
  /**
   * Ширина, под которую делался ресайз: настроенная ширина, а в режиме
   * `nativeWidthFallback` — натуральная ширина исходника. Поле
   * ДИАГНОСТИЧЕСКОЕ: в ключ объекта, в `srcset` и в разметку оно не идёт
   * никогда. Прежнее имя `requestedWidth` было снято: в режиме fallback этой
   * ширины никто не запрашивал, и имя утверждало неправду.
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
   * сравнение полей между собой тавтологично. Условие закрывается на
   * Э2-05/Э3-04, где появляются ключ объекта и разметка: там видно, из какого
   * поля собраны URL и дескриптор `w`.
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
   * Ширины, которые пропущены как превышающие исходную: апскейл не делается,
   * вариант не выдумывается.
   */
  readonly skippedWidths: readonly number[];
  /**
   * `true`, если НИ ОДНА настроенная ширина не подошла (исходник меньше самой
   * малой) и производные сделаны в натуральную ширину исходника. Признак нужен
   * Э2-05, чтобы предупредить редактора: изображение мелкое для страницы.
   * Решение о публикации принимает человек, пайплайн лишь не молчит.
   *
   * ВАЖНАЯ ОГОВОРКА ПРО ПОСТОЯНСТВО URL (условие C7). В этом режиме
   * опубликованный ключ зависит от значения `IMAGE_WIDTHS`, и правило
   * «только добавлять ширины» его НЕ защищает. Пример: исходник 500 px при
   * ширинах 640/960 даёт fallback и ключ с суффиксом `-500`; после ДОБАВЛЕНИЯ
   * ширины 320 fallback исчезает, пайплайн отдаёт вариант 320, и ключ `-500`
   * повторным вызовом уже не воспроизводится. Поэтому Э2-05 обязан считать
   * ключи производных данными записи, а не вычислимой функцией настроек:
   * ширина для ключа берётся из сохранённого `variant.width`, а не
   * пересчитывается из текущего `IMAGE_WIDTHS`. Иначе замена настроек ломает
   * URL уже опубликованных файлов (ТЗ §6.3).
   *
   * Тут же перестаёт работать удобное, но неверное допущение
   * «`requestedWidths` минус `skippedWidths` = ширины вариантов»: слева пусто,
   * а варианты есть.
   */
  readonly nativeWidthFallback: boolean;
  /** Никогда не пустой: хотя бы один вариант на каждый запрошенный формат. */
  readonly variants: readonly ImageDerivative[];
}

export interface GenerateDerivativesOptions {
  /** Явный набор ширин: важнее окружения. Нужен тестам и разовым прогонам. */
  readonly widths?: readonly number[];
  /**
   * Подмножество форматов; по умолчанию — все из `OUTPUT_FORMATS`. Тип —
   * `string`, потому что граница пакета вызывается и из нетипизированного кода
   * (Payload, внешний API). Резервный JPEG обязателен в любом наборе.
   */
  readonly formats?: readonly string[];
  /** Переопределение качества кодирования: важнее окружения. */
  readonly quality?: Readonly<Partial<Record<OutputFormat, number>>>;
  /** Срез окружения для чтения `IMAGE_WIDTHS` и `IMAGE_ENCODE_QUALITY`. */
  readonly env?: ImagesEnv;
}

function normalizeWidths(widths: readonly number[]): readonly number[] {
  for (const width of widths) {
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error(
        `Ширина производного изображения должна быть целым положительным числом, получено: ${String(width)}.`,
      );
    }
  }
  return [...new Set(widths)].sort((left, right) => left - right);
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
  const requestedWidths = normalizeWidths(options.widths ?? resolveImageWidths(options.env));
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

  const sourceInfo: SourceImageInfo = {
    format: sourceMetadata.format,
    width: orientedWidth,
    height: orientedHeight,
    exifOrientation: sourceMetadata.orientation ?? 1,
  };

  const fittingWidths = requestedWidths.filter((width) => width <= sourceInfo.width);
  const skippedWidths = requestedWidths.filter((width) => width > sourceInfo.width);
  // Апскейла нет: если не подошла ни одна ширина, берётся натуральная. Пустой
  // набор вариантов вернуть нельзя — он неотличим от успеха для вызывающего.
  const nativeWidthFallback = fittingWidths.length === 0;
  const targetWidths = nativeWidthFallback ? [sourceInfo.width] : fittingWidths;

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
        'набор форматов непуст, натуральная ширина исходника известна.',
    );
  }

  return {
    source: sourceInfo,
    requestedWidths,
    skippedWidths,
    nativeWidthFallback,
    variants,
  };
}
