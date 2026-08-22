/**
 * Пути записей контента: префиксы пространств имён и валидация slug.
 *
 * Своих правил slug здесь НЕТ: форму проверяет `isValidSlug`, занятость пути —
 * реестр `checkReservedPath`, оба из `@otkritka/shared`. Этот модуль отвечает
 * только за то, ЧТО проверяется — итоговый путь записи, а не отдельный slug — и
 * за формулировку отказа, который увидит редактор (в админке) и внешний
 * AI-редактор (в ответе API): сообщение одно и то же, потому что правило одно.
 *
 * Пространства имён разведены решением человека от 2026-08-22:
 *
 *   /otkrytki                        каталог карточек
 *   /otkrytki/<slug>                 карточка
 *   /podborki                        каталог подборок
 *   /podborki/prazdniki              группирующий узел
 *   /podborki/prazdniki/8-marta      праздничная посадочная
 *   /podborki/prazdniki/8-marta/mame пара «праздник × адресат»
 *
 * Практическое следствие для CMS: коллизия «карточка со slug `prazdniki` против
 * узла подборок» структурно невозможна — это разные контейнеры. Проверка
 * уникальности итогового пути нужна только ВНУТРИ пространства (уникальный slug
 * карточки, уникальный путь подборки), а не между коллекциями.
 */
import {
  type PathAvailability,
  type SharedEnv,
  canonicalizePath,
  checkReservedPath,
  currentEnv,
  findYearInSlug,
  isValidSlug,
} from '@otkritka/shared';

/** Контейнер карточек. Канонический URL карточки — `/otkrytki/<slug>`, навсегда. */
export const CARD_PATH_PREFIX = '/otkrytki';

/**
 * Контейнер подборок. Объявлен здесь вместе с карточным, чтобы разведение
 * пространств имён читалось в одном месте; коллекцию `collections` строит Э1-05.
 */
export const COLLECTION_PATH_PREFIX = '/podborki';

/** Канонический путь карточки. Единственный URL записи (ТЗ §5.4). */
export function buildCardPath(slug: string): string {
  return `${CARD_PATH_PREFIX}/${slug}`;
}

export interface ContentSlugOptions {
  /** Префикс пространства имён: {@link CARD_PATH_PREFIX} или путь родителя. */
  readonly prefix: string;
  readonly env?: SharedEnv;
  /**
   * Запрещён ли год в адресе (условие C3). Для карточки — да всегда, для
   * подборки решает вид узла (см. `collections/collection-path.ts`).
   */
  readonly forbidYear?: boolean;
}

/**
 * ЕДИНСТВЕННАЯ формулировка отказа «год в адресе» на весь проект.
 *
 * Правило одно (`hasYearInSlug` из `@otkritka/shared`), поэтому и текст один:
 * его видят и редактор в админке, и внешний AI-редактор в ответе API. Две
 * формулировки расходятся, а расхождение в этом правиле стоит дорого — адрес
 * после первой публикации неизменяем.
 */
export function yearInPathRefusal(args: {
  /** Одно предложение про эту запись: почему год запрещён именно здесь. */
  readonly subject: string;
  readonly target: string;
  readonly year: string;
}): string {
  return (
    `В адресе «${args.target}» есть год ${args.year}, а год в URL запрещён (CLAUDE.md, ` +
    '«Правила URL»: «Год не добавляется в URL ежегодных праздников»). ' +
    `${args.subject} Страница с годом в адресе через год устаревает: накопленные ссылки и ` +
    'позиции достаются мёртвому URL, а новому году нужен новый адрес и редирект. Адрес ' +
    'после первой публикации неизменяем, поэтому исправлять надо сейчас — уберите год из ' +
    'slug, а год события укажите в заголовке, вводном тексте или в поле даты.'
  );
}

const SLUG_RULES =
  'Ожидается один сегмент: строчные латинские буквы, цифры и дефисы между словами ' +
  '(без кириллицы, пробелов, подчёркиваний, слешей и параметров), не длиннее 80 ' +
  'символов и не только из цифр.';

/**
 * Проверяет slug записи по форме и по резерву маршрутов; год ищет в самом slug.
 *
 * Уточнение про год, чтобы не было ложного обещания: авторитетная проверка
 * «год не попадает в ИТОГОВЫЙ адрес» живёт в хуках (`enforceContentRules` для
 * карточки, `planCollectionNode` для подборки) и смотрит на собранный путь.
 * Здесь год ищется в slug — этого достаточно, потому что префиксы карточек
 * (`/otkrytki`) года не содержат, а решение всё равно принимает хук: валидацию
 * полей Payload умеет пропускать, коллекционный `beforeValidate` — нет.
 *
 * Возвращает `true` либо текст ошибки — форма, которую ожидает `validate` поля
 * Payload. Исключений не бросает даже при незаданном `PAYLOAD_ADMIN_PATH`:
 * проблема конфигурации обязана дойти до редактора текстом, а не пятисоткой,
 * иначе она выглядит как поломка админки.
 */
export function validateContentSlug(
  value: unknown,
  options: ContentSlugOptions,
): string | true {
  if (typeof value !== 'string' || value.trim() === '') {
    return `Slug обязателен: из него собирается URL записи. ${SLUG_RULES}`;
  }

  const slug = value.trim();

  if (!isValidSlug(slug)) {
    return (
      `Slug «${slug}» не проходит правила URL проекта. ${SLUG_RULES} ` +
      'URL записи неизменяем после первой публикации, поэтому исправлять его надо сейчас.'
    );
  }

  const env = options.env ?? currentEnv();
  const target = `${options.prefix}/${slug}`;

  if (options.forbidYear === true) {
    const year = findYearInSlug(slug);
    if (year !== null) {
      return yearInPathRefusal({
        subject:
          'У карточки открытки канонический адрес один навсегда, а поводы повторяются ' +
          'каждый год.',
        target: canonicalizePathSafe(target),
        year,
      });
    }
  }

  let availability: PathAvailability;
  try {
    availability = checkReservedPath(target, env);
  } catch (error) {
    // Реестр отказывает, когда путь админки неизвестен: без него нельзя
    // сказать, свободен ли путь записи. Подставлять дефолт нельзя — запись
    // заняла бы адрес админки.
    return (
      `Путь «${canonicalizePathSafe(target)}» проверить нельзя: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!availability.available) {
    return `Путь «${canonicalizePathSafe(target)}» недоступен: ${availability.reason}.`;
  }

  return true;
}

/** Каноническая форма пути для сообщения об ошибке; на мусорном входе — как есть. */
function canonicalizePathSafe(value: string): string {
  try {
    return canonicalizePath(value);
  } catch {
    return value;
  }
}
