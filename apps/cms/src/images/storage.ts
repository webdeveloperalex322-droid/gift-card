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
 * контракт заголовков, а не роут. Константы {@link MEDIA_ROUTE_PREFIX} и
 * {@link IMMUTABLE_CACHE_CONTROL} существуют, чтобы `apps/web` взял их отсюда, а
 * не написал заново: два написания одного заголовка расходятся молча.
 */
import { buildAbsoluteUrl, currentEnv, type SharedEnv } from '@otkritka/shared';
import { FILE_EXTENSION_BY_FORMAT, OUTPUT_FORMATS, type OutputFormat } from '@otkritka/images';

/**
 * Публичный префикс пути производных (решение Ч-03). Не путать с корнем
 * файловой системы: это адрес, по которому отдаёт `apps/web`.
 */
export const MEDIA_ROUTE_PREFIX = '/media';

/**
 * Заголовок кеширования производных — дословно из решения Ч-03.
 *
 * `immutable` законен ровно потому, что путь производной постоянен: он содержит
 * `revision` (короткий хеш байтов, Ч-28), поэтому замена изображения даёт другой
 * путь, а не другое содержимое по тому же пути.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Префикс пространства ПУБЛИЧНЫХ производных внутри хранилища.
 *
 * Константа, а не параметр окружения: префикс — часть постоянного URL файла
 * (ТЗ §6.3). Настраиваемость означала бы, что смена значения в `.env` переносит
 * все уже опубликованные изображения на другие адреса.
 */
export const DERIVATIVE_KEY_PREFIX = 'cards';

/**
 * Префикс пространства НЕПУБЛИЧНЫХ оригиналов внутри хранилища оригиналов.
 * Публичного адреса у этого пространства нет вообще.
 */
export const ORIGINAL_KEY_PREFIX = 'originals';

/** MIME-тип по расширению файла производной. Набор закрыт набором форматов вывода. */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    OUTPUT_FORMATS.map((format: OutputFormat) => [
      FILE_EXTENSION_BY_FORMAT[format],
      format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
    ]),
  ),
);

/** Промежуточный сегмент ключа: те же символы, что и в slug. */
const KEY_SEGMENT = /^[a-z0-9-]+$/;
/** Последний сегмент: имя файла с расширением. */
const KEY_FILE_SEGMENT = /^[a-z0-9-]+\.[a-z0-9]{2,5}$/;

/**
 * Проверяет форму ключа объекта: относительный путь из допустимых сегментов.
 *
 * Что отклоняется и почему: ведущий слеш и схема (это уже не ключ, а адрес),
 * `..` и пустые сегменты (выход за пределы пространства), обратный слеш (на
 * Windows он разделитель пути, и `cards\..\..` вышел бы наружу), верхний
 * регистр и пробелы (один файл получил бы два написания одного адреса),
 * параметры запроса (в ключе объекта их не бывает).
 *
 * @throws Error с указанием ключа: сообщение попадает в журнал загрузки.
 */
export function assertStorageKey(key: string): string {
  const segments = key.split('/');
  const valid =
    key !== '' &&
    !key.includes('\\') &&
    !key.includes('?') &&
    !key.includes('#') &&
    !key.includes(':') &&
    segments.length >= 2 &&
    segments.every((segment, index) =>
      index === segments.length - 1 ? KEY_FILE_SEGMENT.test(segment) : KEY_SEGMENT.test(segment),
    );

  if (!valid) {
    throw new Error(
      `Ключ объекта «${key}» недопустим: ожидается относительный путь вида ` +
        '«<префикс>/<сегменты>/<имя>.<расширение>» из символов [a-z0-9-], без схемы, хоста, ' +
        'ведущего слеша, «..» и обратных слешей. Ключ приходит из данных записи, поэтому ' +
        'проверяется до обращения к хранилищу: иначе путь мог бы указать наружу пространства.',
    );
  }

  return key;
}

/**
 * Публичный путь производной: `/media/<ключ>`.
 *
 * Хоста в результате нет. Абсолютный адрес — {@link derivativeAbsoluteUrl}.
 */
export function derivativePublicPath(key: string): string {
  return `${MEDIA_ROUTE_PREFIX}/${assertStorageKey(key)}`;
}

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
 * Заголовки ответа для производной: тип содержимого и immutable-кеш.
 *
 * Возвращаются вместе, потому что вместе и применяются: `apps/web` (Э2-04b)
 * отдаёт файл именно с этой парой, а тест сравнивает ответ с этой функцией, а не
 * с переписанной строкой.
 */
export function derivativeCacheHeaders(key: string): Record<string, string> {
  assertStorageKey(key);
  const extension = key.slice(key.lastIndexOf('.') + 1);
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension];

  if (contentType === undefined) {
    throw new Error(
      `Расширение «${extension}» не входит в набор вывода пайплайна ` +
        `(${Object.keys(CONTENT_TYPE_BY_EXTENSION).join(', ')}). Публичное пространство ` +
        'производных содержит только файлы, созданные пайплайном.',
    );
  }

  return { 'Cache-Control': IMMUTABLE_CACHE_CONTROL, 'Content-Type': contentType };
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
  deleteDerivative(key: string): Promise<void>;
  deleteOriginal(key: string): Promise<void>;
  hasDerivative(key: string): Promise<boolean>;
  hasOriginal(key: string): Promise<boolean>;
}
