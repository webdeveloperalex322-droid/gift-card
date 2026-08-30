/**
 * Пайплайн изображений: sharp, размеры, форматы, pHash-дедупликация.
 *
 * Владелец пакета: агент `images-pipeline`.
 *
 * Реализовано:
 *   - генерация производных AVIF/WebP/JPEG в окончательном наборе ширин
 *     320/640/960/1280/1920 (Ч-09) с фактическими `width`/`height` каждого
 *     варианта (`derivatives.ts`, ТЗ §6.2, §6.5); исходник уже 640 px
 *     отклоняется (`assertSourceImageWidth`), апскейл не делается;
 *   - перцептивный хеш и сравнение с порогом 14 (Ч-08), настраиваемым через
 *     `PHASH_DISTANCE_THRESHOLD` (`phash.ts`, ТЗ §6.4, §8.3.2);
 *   - имена файлов на транслите (через `slugify` из `packages/shared`),
 *     ревизия как короткий хеш байтов оригинала (Ч-28), суффикс `-N`
 *     параметром, постоянство пути файла и разделение пространств «оригиналы /
 *     производные» (`naming.ts`, ТЗ §6.1, §6.3, §6.7, §11).
 *
 * Границы пакета (это НЕ пробелы, а разделение обязанностей):
 *   - абсолютный URL изображения здесь не собирается: пакет отдаёт только
 *     относительный ключ объекта. Хост добавляет единственный хелпер над
 *     `SITE_URL` из `packages/shared` — по решению Ч-03 отдельного домена
 *     изображений нет, производные отдаются с собственного домена по пути
 *     `/media/...` с `Cache-Control: public, max-age=31536000, immutable`;
 *   - запись производных в хранилище (до переезда на S3 — локальная ФС за
 *     адаптером) и хук загрузки в Payload — Э2-04 и Э2-05 в `apps/cms`. Здесь
 *     только чистые функции без побочных эффектов на диске;
 *   - присвоение и хранение суффикса `-N`, а также решение о публикации и
 *     вердикт «дубль» — вне пакета: он не пишет данные и не решает за человека.
 *
 * Этот файл — только реэкспорт: логика живёт в модулях рядом.
 */

export {
  DEFAULT_ENCODE_QUALITY,
  DEFAULT_PHASH_DISTANCE_THRESHOLD,
  IMAGE_ENCODE_QUALITY_ENV_KEY,
  IMAGE_WIDTHS,
  MIN_SOURCE_IMAGE_WIDTH,
  PHASH_BITS,
  PHASH_DISTANCE_THRESHOLD_ENV_KEY,
  resolveDerivativeWidths,
  resolveEncodeQuality,
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

/**
 * Контракт публичной отдачи производных (`/media/<ключ>`). Реэкспорт — для
 * потребителей, которым пакет нужен целиком (`apps/cms`); входной сервер
 * `apps/web` берёт те же имена подпутём `@otkritka/images/media`, чтобы не
 * тянуть в процесс отдачи файлов нативный `sharp`.
 */
export {
  assertStorageKey,
  derivativeCacheHeaders,
  derivativeKeyFromPublicPath,
  derivativePublicPath,
  IMMUTABLE_CACHE_CONTROL,
  isStorageKey,
  MEDIA_ROUTE_PREFIX,
} from './media.js';

export {
  assertSourceImageWidth,
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
  computeImageRevision,
  createOpaqueImageStorageId,
  DEFAULT_IMAGE_NAME_MAX_LENGTH,
  FILE_EXTENSION_BY_FORMAT,
  IMAGE_REVISION_HASH_ALGORITHM,
  IMAGE_REVISION_LENGTH,
  IMAGE_REVISION_MAX_LENGTH,
  isOpaqueImageStorageId,
  type DerivativeObjectKeyInput,
  type ImageNameOptions,
  type OriginalObjectKeyInput,
} from './naming.js';

export { type ImageSource } from './source.js';
