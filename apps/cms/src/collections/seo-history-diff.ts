/**
 * История изменений SEO-полей (задача Э1-07): чистое ядро сравнения, без
 * Payload и без базы.
 *
 * Зачем история вообще. Модель проекта допускает, что часть правок делает
 * сервисный аккаунт `ai-editor` через API. Значит, на вопрос «почему у страницы
 * сменился title, robots или URL» должен быть машинный ответ с автором, иначе
 * граница автоматизации проверяется на доверии. ТЗ §8.1 требует фиксировать
 * «что, когда, кем, старое → новое» и держать записи только для чтения.
 *
 * РЕШЕНИЕ ПО ПОЛЮ `path` (открытый вопрос предыдущего агента): путь подборки
 * ПИШЕТСЯ в историю, хотя формально его нет в перечне SEO-полей §8.1. Причины:
 *
 *   1. `path` — это и есть URL записи; перечень §8.1 составлен для карточки, у
 *      которой URL однозначно выводится из `slug`, а у иерархической подборки
 *      этого выведения нет: путь собирается из цепочки родителей;
 *   2. перенос узла меняет URL ВСЕГО поддерева, причём у потомков не меняется ни
 *      один из полей §8.1 — ни slug, ни parent, ни nodeKind. Без записи по
 *      `path` в истории вообще не осталось бы следа от самой дорогой операции в
 *      проекте, и на вопрос «почему у этой страницы другой URL» ответа не было
 *      бы даже теоретически;
 *   3. цена решения — лишние записи истории при переносах. Цена обратного
 *      решения — непрослеживаемая потеря URL. Выбор очевиден.
 *
 * Что НЕ пишется и почему: `parent` и `nodeKind` отдельными записями не
 * фиксируются — их изменение наблюдается через `path`, который является их
 * следствием, а две записи об одном факте расходятся при первой же правке
 * логики склейки пути. `publishedAt` и `updatedContentAt` не пишутся: первое
 * ставится один раз хуком и видно в самой записи, второе по смыслу — журнал
 * содержательных правок, а не SEO-поле.
 */
import { ROLES } from '../access/roles';

/**
 * Поля, изменение которых обязано попасть в историю.
 *
 * Порядок — как в ТЗ §8.1 (title, h1, metaDescription, slug, canonical, robots,
 * status) с добавленным `path` рядом со `slug`: обе величины про URL, и в
 * дашборде (Э5-04) они читаются вместе.
 */
export const TRACKED_SEO_FIELDS = [
  'title',
  'h1',
  'metaDescription',
  'slug',
  'path',
  'canonical',
  'robots',
  'status',
] as const;

export type TrackedSeoField = (typeof TRACKED_SEO_FIELDS)[number];

export interface SeoFieldChange {
  readonly field: TrackedSeoField;
  readonly nextValue: string | null;
  readonly previousValue: string | null;
}

/**
 * Предел длины сохраняемого значения.
 *
 * История — журнал, а не копия контента: длинный metaDescription в ней нужен для
 * понимания «что было», а не для восстановления текста. Без предела одна запись
 * могла бы весить как сам документ.
 */
export const HISTORY_VALUE_MAX_LENGTH = 2000;

/**
 * Приводит значение поля к строке для хранения и сравнения.
 *
 * Пусто (`undefined`, `null`, пустая строка, строка из пробелов) — это одно и то
 * же `null`: иначе сохранение формы, где поле осталось пустым, порождало бы
 * запись «null → ''», то есть шум в журнале, по которому потом ищут реальные
 * изменения.
 */
export function normalizeHistoryValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  let text: string;
  if (typeof value === 'string') {
    text = value.trim();
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    text = JSON.stringify(value) ?? '';
  }

  if (text === '') {
    return null;
  }
  if (text.length > HISTORY_VALUE_MAX_LENGTH) {
    return `${text.slice(0, HISTORY_VALUE_MAX_LENGTH)}…`;
  }
  return text;
}

/**
 * Сравнивает документ «до» и «после» по отслеживаемым полям.
 *
 * `previous === null` означает создание записи: тогда каждое заполненное поле
 * фиксируется как «пусто → значение». Это не шум, а начало трассы: без него
 * первый slug и первый статус записи в журнале не отражены, и «почему у страницы
 * такой URL» отвечалось бы только по косвенным признакам.
 *
 * Поле, которого нет НИ в одном из двух документов, пропускается: так один и тот
 * же код обслуживает карточку (без `path`) и подборку (с `path`), не заявляя
 * несуществующих изменений.
 */
export function diffSeoFields(
  previous: Readonly<Record<string, unknown>> | null | undefined,
  next: Readonly<Record<string, unknown>>,
): readonly SeoFieldChange[] {
  const changes: SeoFieldChange[] = [];

  for (const field of TRACKED_SEO_FIELDS) {
    const presentInPrevious = previous !== null && previous !== undefined && field in previous;
    if (!presentInPrevious && !(field in next)) {
      continue;
    }

    const previousValue = normalizeHistoryValue(previous?.[field]);
    const nextValue = normalizeHistoryValue(next[field]);

    if (previousValue === nextValue) {
      continue;
    }

    changes.push({ field, nextValue, previousValue });
  }

  return changes;
}

/**
 * Кем выполнено изменение.
 *
 * `unknown` существует отдельно от `system` намеренно: пользователь с
 * нераспознанной ролью — это ненормальное состояние (набор ролей закрыт решением
 * Ч-16), и выдавать его за системную операцию значило бы потерять признак
 * инцидента ровно в том журнале, который для инцидентов и ведётся.
 */
export const HISTORY_AUTHOR_ROLES = [ROLES.admin, ROLES.aiEditor, 'system', 'unknown'] as const;

export type HistoryAuthorRole = (typeof HISTORY_AUTHOR_ROLES)[number];

export interface HistoryAuthor {
  /** Изменение пришло по API-ключу сервисного клиента (ТЗ §9). */
  readonly apiKey: boolean;
  readonly authorRole: HistoryAuthorRole;
  readonly userId: number | string | null;
}

/** Минимальный контракт пользователя: шире сгенерированного `User` намеренно. */
export interface HistoryActor {
  /** Стратегия аутентификации Payload; `api-key` для сервисного клиента. */
  readonly _strategy?: string | null;
  readonly id?: number | string | null;
  readonly role?: string | null;
}

/**
 * Идентификатор автора в том виде, в каком его принимает связь с `users`.
 *
 * Идентификаторы в этой базе числовые (`defaultIDType: number` в сгенерированных
 * типах), но `req.user.id` объявлен шире. Строковое числовое значение
 * приводится, а не отбрасывается: потерять автора изменения в журнале аудита
 * хуже, чем выполнить одно приведение.
 *
 * Живёт рядом с {@link describeHistoryAuthor}, а не в вызывающем коде, потому что
 * автора записывают уже два места — хуки контентных коллекций (`seo-history`) и
 * глобал настроек (Э3-00, группа `audit`). Две копии этого приведения означали
 * бы, что в одном журнале автор есть, а в другом он однажды потеряется.
 */
export function readAuthorUserId(value: number | string | null): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function describeHistoryAuthor(
  user: HistoryActor | null | undefined,
): HistoryAuthor {
  if (user === null || user === undefined) {
    return { apiKey: false, authorRole: 'system', userId: null };
  }

  const role: HistoryAuthorRole =
    user.role === ROLES.admin ? ROLES.admin : user.role === ROLES.aiEditor ? ROLES.aiEditor : 'unknown';

  return {
    apiKey: user._strategy === 'api-key',
    authorRole: role,
    userId: user.id ?? null,
  };
}
