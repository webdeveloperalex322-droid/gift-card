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

/**
 * Протокольно-относительный URL (`//example.test/x`).
 *
 * Проверка нужна отдельно от `looksLikeAbsoluteUrl` из `@otkritka/shared`: та
 * ищет схему (`https:`), а форма `//host/path` схемы не содержит и потому
 * проходит её насквозь. Для браузера и краулера это АБСОЛЮТНЫЙ адрес другого
 * хоста, а `canonicalizePath` схлопнул бы двойной слеш и превратил чужой хост в
 * первый сегмент пути — то есть ошибка стала бы невидимой. Проверку стоит
 * перенести в `packages/shared` рядом с `looksLikeAbsoluteUrl`; здесь она
 * находится потому, что пакет правит его владелец (см. отчёт задачи).
 */
export function isProtocolRelativeUrl(value: string): boolean {
  return value.trim().startsWith('//');
}

export interface ContentSlugOptions {
  /** Префикс пространства имён: {@link CARD_PATH_PREFIX} или путь родителя. */
  readonly prefix: string;
  readonly env?: SharedEnv;
}

const SLUG_RULES =
  'Ожидается один сегмент: строчные латинские буквы, цифры и дефисы между словами ' +
  '(без кириллицы, пробелов, подчёркиваний, слешей и параметров), не длиннее 80 ' +
  'символов и не только из цифр.';

/**
 * Проверяет slug записи по форме и по ИТОГОВОМУ пути.
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
