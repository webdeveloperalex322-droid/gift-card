/**
 * Пайплайн изображений: sharp, размеры, форматы, pHash-дедупликация.
 *
 * Владелец пакета: агент `images-pipeline`.
 *
 * Реализовано:
 *   - генерация производных AVIF/WebP/JPEG в наборе ширин с фактическими
 *     `width`/`height` каждого варианта (`derivatives.ts`, ТЗ §6.2, §6.5);
 *   - перцептивный хеш и сравнение с настраиваемым порогом (`phash.ts`,
 *     ТЗ §6.4, §8.3.2);
 *   - имена файлов на транслите (через `slugify` из `packages/shared`),
 *     постоянство пути файла и разделение пространств «оригиналы /
 *     производные» (`naming.ts`, ТЗ §6.1, §6.3, §6.7, §11).
 *
 * Запланировано ТЗ и CLAUDE.md, пока не реализовано:
 *   - сборка абсолютного URL изображения: она вне пакета намеренно — домен
 *     изображений (`IMAGES_CDN_ORIGIN`, Ч-03) и `SITE_URL` человеком не
 *     заданы, а хост собирает единственный хелпер из `packages/shared`;
 *   - запись производных в S3 и хук загрузки в Payload (Э2-04, Э2-05) — это
 *     `apps/cms`, здесь только чистые функции без побочных эффектов на диске.
 *
 * Этот файл — только реэкспорт: логика живёт в модулях рядом.
 */

export {
  DEFAULT_ENCODE_QUALITY,
  DEFAULT_IMAGE_WIDTHS,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS_ENV_KEY,
  PHASH_BITS,
  PHASH_DISTANCE_THRESHOLD_ENV_KEY,
  resolveEncodeQuality,
  resolveImageWidths,
  resolvePhashDistanceThreshold,
  type ImagesEnv,
} from './config.js';

export {
  assertOutputFormat,
  FALLBACK_FORMAT,
  isOutputFormat,
  OUTPUT_FORMATS,
  type OutputFormat,
} from './formats.js';

export {
  generateDerivatives,
  METADATA_CONTAINER_BY_FORMAT,
  type DerivativeSet,
  type GenerateDerivativesOptions,
  type ImageDerivative,
  type MetadataContainer,
  type SourceImageInfo,
} from './derivatives.js';

export {
  comparePerceptualHashes,
  computePerceptualHash,
  findSimilarPerceptualHashes,
  hammingDistance,
  type PerceptualHashCandidate,
  type PerceptualHashComparison,
  type PerceptualHashMatch,
  type PerceptualHashThresholdOptions,
} from './phash.js';

export {
  buildDerivativeObjectKey,
  buildImageFileStem,
  buildOriginalObjectKey,
  createOpaqueImageStorageId,
  DEFAULT_IMAGE_NAME_MAX_LENGTH,
  FILE_EXTENSION_BY_FORMAT,
  isOpaqueImageStorageId,
  type DerivativeObjectKeyInput,
  type ImageNameOptions,
  type OriginalObjectKeyInput,
} from './naming.js';

export { type ImageSource } from './source.js';
