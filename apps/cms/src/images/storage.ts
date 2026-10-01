/**
 * Контракт хранилища изображений (задача Э2-04) — ТЗ §6.1, §6.7, §11.
 *
 * Решение Ч-03 (2026-08-21): S3 снят с обязательных, до переезда хранилище —
 * локальная ФС за адаптером (`./local-fs-storage.ts`). Поэтому здесь объявлен
 * ИНТЕРФЕЙС, а не реализация: замена локальной ФС на S3 не должна трогать ни
 * хук загрузки, ни коллекции. Условие переезда, принятое человеком, — «тот же
 * путь, другой origin»: публичный путь производной остаётся `/media/<ключ>`.
 *
 * Три правила этого модуля и цена их нарушения:
 *
 *   1. **Два пространства — два метода.** `putDerivative` и `putOriginal`
 *      различаются НЕ параметром, а именем. Флаг «публичный/непубличный» —
 *      это одна опечатка между оригиналом в открытом каталоге и требованием
 *      ТЗ §6.1 «оригиналы недоступны по угадываемому URL». Обратной функции
 *      «по публичному пути получить оригинал» в интерфейсе нет намеренно.
 *   2. **Хост здесь не появляется.** Методы принимают и возвращают
 *      относительные ключи объектов — ровно то, что отдаёт `@otkritka/images`.
 *      Абсолютный адрес собирает {@link derivativeAbsoluteUrl} через
 *      единственный хелпер `buildAbsoluteUrl` над `SITE_URL`. `IMAGES_CDN_ORIGIN`
 *      не вводится (Ч-03), поэтому именованного исключения из правила
 *      «единственный источник хоста» не требуется.
 *   3. **Ключ проверяется до обращения к хранилищу** ({@link assertStorageKey}).
 *      Ключ приходит из данных записи, а данные записи правит внешний клиент;
 *      `..` или ведущий слеш в ключе означали бы путь наружу пространства.
 *
 * Чего здесь НЕТ и почему: HTTP-отдачи `/media/...`. Маршрут принадлежит
 * `apps/web` (задача Э2-04b, этап 3) — CMS обеспечивает раскладку файлов и
 * контракт заголовков, а не роут.
 *
 * ПЕРЕЕЗД (задача Э2-04b): сам контракт публичной отдачи —
 * {@link MEDIA_ROUTE_PREFIX}, {@link IMMUTABLE_CACHE_CONTROL},
 * {@link assertStorageKey}, {@link derivativePublicPath},
 * {@link derivativeCacheHeaders} — переехал в `@otkritka/images/media` и здесь
 * только РЕЭКСПОРТИРУЕТСЯ. Причина: те же значения нужны входному серверу
 * `apps/web`, а он настоящий Node ESM из `dist/` и импортировать `.ts` из
 * `apps/cms` не может. Оставить их здесь означало бы второе написание
 * `Cache-Control` в `apps/web` — расхождение, которое обнаруживается кешем на
 * год. Реэкспорт сохранён, чтобы ни один существующий импорт из `apps/cms` не
 * пришлось переписывать: источник один, адресов обращения к нему два.
 */
import { buildAbsoluteUrl, currentEnv, type SharedEnv } from '@otkritka/shared';

export {
  assertStorageKey,
  derivativeCacheHeaders,
  derivativeKeyFromPublicPath,
  derivativePublicPath,
  DERIVATIVE_KEY_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  isDerivativeKey,
  isOriginalKey,
  isStorageKey,
  MEDIA_ROUTE_PREFIX,
  ORIGINAL_KEY_PREFIX,
} from '@otkritka/images/media';

import { derivativePublicPath } from '@otkritka/images/media';

/**
 * Абсолютный адрес производной. Хост берётся ТОЛЬКО из `SITE_URL` через
 * единственный хелпер `buildAbsoluteUrl` из `@otkritka/shared`.
 *
 * @throws Error если `SITE_URL` не задан или некорректен.
 */
export function derivativeAbsoluteUrl(key: string, env: SharedEnv = currentEnv()): string {
  return buildAbsoluteUrl(derivativePublicPath(key), env);
}

/**
 * Хранилище изображений: два раздельных пространства за одним интерфейсом.
 *
 * Реализация на локальной ФС — `./local-fs-storage.ts`. Реализация на S3 (когда
 * человек закроет открытую часть Ч-03) обязана реализовать этот же интерфейс и
 * не имеет права переименовывать объекты, менять регистр, что-либо дописывать к
 * ключу или выводить путь оригинала из публичного пути производной.
 */
export interface ImageStorage {
  /** Вид реализации: попадает в журнал загрузки и в отчёт смоука. */
  readonly kind: string;
  /** Записывает производную в ПУБЛИЧНОЕ пространство (то, что отдаётся по /media). */
  putDerivative(key: string, data: Buffer): Promise<void>;
  /** Записывает оригинал в НЕПУБЛИЧНОЕ пространство. */
  putOriginal(key: string, data: Buffer): Promise<void>;
  /** Читает оригинал: нужен перегенерации производных без повторной загрузки. */
  readOriginal(key: string): Promise<Buffer>;
  /** Читает производную для защищённых серверных потребителей (например, админки). */
  readDerivative(key: string): Promise<Buffer>;
  deleteDerivative(key: string): Promise<void>;
  deleteOriginal(key: string): Promise<void>;
  hasDerivative(key: string): Promise<boolean>;
  hasOriginal(key: string): Promise<boolean>;
}
