/**
 * Форматы вывода пайплайна изображений.
 *
 * ТЗ §6.2 и CLAUDE.md: AVIF и WebP плюс резервный JPEG. Порядок массива —
 * порядок предпочтения в `<picture>`: первым идёт самый экономный формат,
 * последним — резервный, который понимает любой браузер.
 */

/** Форматы вывода в порядке предпочтения; последний — резервный. */
export const OUTPUT_FORMATS = ['avif', 'webp', 'jpeg'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Резервный формат для браузеров без AVIF/WebP. */
export const FALLBACK_FORMAT: OutputFormat = 'jpeg';

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Сужение строки до формата вывода на ГРАНИЦЕ пакета.
 *
 * Граница принимает `string`, а не `OutputFormat`, намеренно: пакет зовут из
 * Payload и через внешний API AI-редактора, то есть из кода без проверки типов.
 * Проверка, недостижимая для типизированного вызова, была бы проверкой на
 * бумаге — её нельзя было бы даже протестировать без приведения типов.
 */
export function assertOutputFormat(value: string): OutputFormat {
  if (!isOutputFormat(value)) {
    throw new Error(
      `Формат «${value}» не входит в набор вывода пайплайна: ожидается ` +
        `${OUTPUT_FORMATS.join(', ')} (регистр и пробелы значимы).`,
    );
  }
  return value;
}
