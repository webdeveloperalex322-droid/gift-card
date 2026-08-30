/**
 * Публичный контракт отдачи производных: путь `/media/<ключ>`, форма ключа и
 * заголовки ответа.
 *
 * ## Почему этот код живёт здесь, а не в `apps/cms`
 *
 * Он ЖИЛ в `apps/cms/src/images/storage.ts` (задача Э2-04) — там, где
 * появляются байты файлов. Отдаёт же файлы по HTTP другое приложение
 * (`apps/web`, задача Э2-04b), и достать оттуда модуль `apps/cms` нельзя: из
 * `apps/cms` наружу экспортируются только сгенерированные типы, а его исходники
 * — `.ts`, которые запускает либо Next, либо Vite, но не Node напрямую. Входной
 * сервер `apps/web` — настоящий Node ESM из `dist/`, поэтому импортировать он
 * может только СОБРАННЫЙ пакет.
 *
 * Альтернативой был второй экземпляр правила: `apps/web` пишет `Cache-Control`
 * и таблицу `Content-Type` своей строкой. Это запрещено по существу — два
 * написания одного заголовка расходятся молча, и обнаруживается расхождение
 * кешем на год (`immutable`). Поэтому правило перенесено в общий пакет, а
 * `apps/cms/src/images/storage.ts` его РЕЭКСПОРТИРУЕТ: у обоих приложений
 * остаётся один источник, и ни один существующий импорт не сломан.
 *
 * Тот же приём и по той же причине уже применён к предикатам настроек сайта
 * (`packages/shared/src/site-settings-rules.ts`, задача Э3-00).
 *
 * ## Почему модуль отдельный, а не часть `index.ts`
 *
 * `packages/images/src/index.ts` тянет `sharp` (нативный модуль): его требуют
 * `derivatives.ts` и `phash.ts`. Веб-серверу sharp не нужен вовсе, а грузить
 * нативную библиотеку в процесс, который только отдаёт готовые файлы, — лишний
 * риск на старте. Отсюда подпуть `@otkritka/images/media`: он импортирует
 * только чистые модули (`formats.ts`, `naming.ts`), поэтому sharp не
 * подключается. Из `index.ts` эти же имена реэкспортированы — для потребителей,
 * которым пакет уже нужен целиком (`apps/cms`).
 */
import { FILE_EXTENSION_BY_FORMAT } from './naming.js';
import { OUTPUT_FORMATS, type OutputFormat } from './formats.js';

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

/** Ключ объекта прошёл проверку формы (`true`) или нет. Исключений не бросает. */
export function isStorageKey(key: string): boolean {
  try {
    assertStorageKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Публичный путь производной: `/media/<ключ>`.
 *
 * Хоста в результате нет. Абсолютный адрес собирает `derivativeAbsoluteUrl` в
 * `apps/cms/src/images/storage.ts` — единственным хелпером над `SITE_URL`.
 */
export function derivativePublicPath(key: string): string {
  return `${MEDIA_ROUTE_PREFIX}/${assertStorageKey(key)}`;
}

/**
 * Обратная операция к {@link derivativePublicPath}: ключ объекта из пути запроса.
 *
 * Нужна отдаче `/media/...` в `apps/web`, и именно поэтому она ЗДЕСЬ, а не там:
 * иначе разбор пути был бы вторым, независимым от сборки пути правилом, и
 * достаточно было бы одной правки формы ключа, чтобы отдача перестала совпадать
 * с раскладкой файлов.
 *
 * Функция ничего не «чинит»: ни завершающий слеш, ни процентное кодирование, ни
 * повторные слеши. Всё это — не адрес производной, а другой путь, и ответ на
 * него не 200 (а форму цели запроса проверяет политика пути `apps/web` до вызова
 * этой функции).
 *
 * @param pathname путь запроса от корня, без строки запроса.
 * @returns ключ объекта либо `null`, если путь не является адресом производной.
 */
export function derivativeKeyFromPublicPath(pathname: string): string | null {
  const prefix = `${MEDIA_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const key = pathname.slice(prefix.length);
  return isStorageKey(key) ? key : null;
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
