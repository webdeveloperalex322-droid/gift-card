/**
 * Параметры пайплайна изображений.
 *
 * Здесь живут все числа пайплайна, ЧИТАЕМЫЕ ИЗ ОКРУЖЕНИЯ, и ни одно из них не
 * зашито в логику: решения человека нет ни по одному (docs/etap-0-resheniya.md).
 *
 * Настраиваемые числа есть и вне этого файла: `DEFAULT_IMAGE_NAME_MAX_LENGTH` в
 * `naming.ts` — параметр вызова, а не переменная окружения (Ч-26), потому что
 * влияет на постоянный URL файла.
 *
 *   - `IMAGE_WIDTHS` (Ч-09 открыт) — ряд ширин производных. ТЗ §6.2 приводит
 *     320/640/960/1280/1920 как ПРИМЕР, а не как норму, поэтому этот ряд
 *     является значением по умолчанию параметра и решением человека не
 *     является. Добавить ширину дешево, убрать после публикации дорого
 *     (исчезают URL производных, ТЗ §6.3).
 *   - `PHASH_DISTANCE_THRESHOLD` (Ч-08 открыт) — порог похожести pHash.
 *     Числа нет ни в ТЗ, ни в решениях, ни как нормы, ни как примера: оно
 *     подбирается эмпирически на эталонной выборке (Ч-06). Поэтому значения по
 *     умолчанию здесь НЕТ и быть не должно: без настройки сравнение отказывает
 *     с внятной ошибкой, а не подставляет догаданное число. Догаданный порог
 *     тихо решал бы за редактора, что считать дублем.
 *   - `IMAGE_ENCODE_QUALITY` (Ч-29 открыт) — качество кодирования по форматам.
 *     ТЗ качеством не оперирует вообще; дефолты подбираются замером веса и
 *     артефактов (ТЗ §10) и решением человека не являются.
 */

import { assertOutputFormat, OUTPUT_FORMATS, type OutputFormat } from './formats.js';

/** Срез окружения: то, что нужно пайплайну, без завязки на `process.env`. */
export type ImagesEnv = Readonly<Record<string, string | undefined>>;

export const IMAGE_WIDTHS_ENV_KEY = 'IMAGE_WIDTHS';
export const PHASH_DISTANCE_THRESHOLD_ENV_KEY = 'PHASH_DISTANCE_THRESHOLD';
export const IMAGE_ENCODE_QUALITY_ENV_KEY = 'IMAGE_ENCODE_QUALITY';

/**
 * Ряд ширин по умолчанию — из примера ТЗ §6.2. Не утверждённая норма:
 * решение Ч-09 человеком не принято.
 */
export const DEFAULT_IMAGE_WIDTHS: readonly number[] = Object.freeze([
  320, 640, 960, 1280, 1920,
]);

/** Длина pHash в битах: задаёт диапазон допустимых значений порога. */
export const PHASH_BITS = 64;

/**
 * Качество кодирования по умолчанию для каждого формата вывода.
 * Вопрос реестра **Ч-29**.
 *
 * Это **значения по умолчанию настраиваемого параметра** (`IMAGE_ENCODE_QUALITY`
 * и опция `quality`), а не норма: ТЗ качеством не оперирует, решения человека по
 * этим числам нет. Подбираются замером веса страницы и артефактов (ТЗ §10) —
 * поэтому переопределяются без правки кода.
 */
export const DEFAULT_ENCODE_QUALITY: Readonly<Record<OutputFormat, number>> = Object.freeze({
  avif: 50,
  webp: 80,
  jpeg: 82,
});

function currentEnv(): ImagesEnv {
  return process.env;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Ширины производных: из окружения, иначе — дефолт из примера ТЗ §6.2.
 *
 * Пустое значение переменной означает «не сконфигурировано» (соглашение
 * `.env.example`) и даёт дефолт. Непустое, но некорректное — ошибка: опечатка
 * в наборе ширин не должна молча превращаться в другой набор URL производных.
 */
export function resolveImageWidths(env: ImagesEnv = currentEnv()): readonly number[] {
  const raw = env[IMAGE_WIDTHS_ENV_KEY]?.trim() ?? '';
  if (raw === '') {
    return [...DEFAULT_IMAGE_WIDTHS];
  }

  const parsed = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => Number(part));

  if (parsed.length === 0 || !parsed.every(isPositiveInteger)) {
    throw new Error(
      `${IMAGE_WIDTHS_ENV_KEY} должен быть списком целых положительных ширин через запятую ` +
        `(например «320,640,960»), получено: «${raw}».`,
    );
  }

  return [...new Set(parsed)].sort((left, right) => left - right);
}

/**
 * Порог расстояния pHash. Дефолта нет намеренно (Ч-08): без настройки
 * функция обязана отказать, а не выбрать число за человека.
 */
export function resolvePhashDistanceThreshold(env: ImagesEnv = currentEnv()): number {
  const raw = env[PHASH_DISTANCE_THRESHOLD_ENV_KEY]?.trim() ?? '';
  if (raw === '') {
    throw new Error(
      `${PHASH_DISTANCE_THRESHOLD_ENV_KEY} не задан. Значения по умолчанию у порога нет: ` +
        'решение Ч-08 не принято человеком, число подбирается эмпирически на эталонной ' +
        'выборке. Расчёт pHash работает без настройки, сравнение с порогом — нет.',
    );
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > PHASH_BITS) {
    throw new Error(
      `${PHASH_DISTANCE_THRESHOLD_ENV_KEY} должен быть целым числом от 0 до ${String(PHASH_BITS)} ` +
        `(расстояние Хэмминга по ${String(PHASH_BITS)} битам), получено: «${raw}». ` +
        'Решение Ч-08 остаётся за человеком.',
    );
  }

  return parsed;
}

/**
 * Качество кодирования: дефолты, поверх которых накладывается
 * `IMAGE_ENCODE_QUALITY` в форме `avif=45,webp=78,jpeg=80`.
 *
 * Указывать можно любое подмножество форматов — остальные остаются на дефолте.
 * Непустое, но некорректное значение — ошибка: опечатка не должна тихо вернуть
 * вес производных к другому компромиссу.
 */
export function resolveEncodeQuality(
  env: ImagesEnv = currentEnv(),
): Readonly<Record<OutputFormat, number>> {
  const quality: Record<OutputFormat, number> = { ...DEFAULT_ENCODE_QUALITY };
  const raw = env[IMAGE_ENCODE_QUALITY_ENV_KEY]?.trim() ?? '';
  if (raw === '') {
    return quality;
  }

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') {
      continue;
    }
    const [rawFormat = '', rawValue = '', ...rest] = trimmed.split('=');
    const value = Number(rawValue.trim());
    if (
      rest.length > 0 ||
      rawValue.trim() === '' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 100
    ) {
      throw new Error(
        `${IMAGE_ENCODE_QUALITY_ENV_KEY} должен быть списком «формат=качество» через запятую ` +
          `(форматы: ${OUTPUT_FORMATS.join(', ')}; качество — целое 1..100), ` +
          `получено: «${raw}».`,
      );
    }
    try {
      quality[assertOutputFormat(rawFormat.trim())] = value;
    } catch (cause) {
      throw new Error(
        `${IMAGE_ENCODE_QUALITY_ENV_KEY}: неизвестный формат в «${trimmed}». ` +
          `Допустимы только ${OUTPUT_FORMATS.join(', ')}.`,
        { cause },
      );
    }
  }

  return quality;
}
