/**
 * Матрица прав по ролям (задача Э1-03) — единственное место, где записано, что
 * роль может и чего не может.
 *
 * Почему матрица живёт здесь, а не в конфигах коллекций: Payload сам отдаёт REST
 * и GraphQL для всех коллекций, поэтому правило, продублированное в двух
 * коллекциях по-разному, означает дыру ровно в одной из них — и найти её можно
 * будет только по факту. Коллекции обязаны звать предикаты отсюда.
 *
 * Файл состоит из двух частей:
 *   1. ЧИСТЫЕ предикаты (`can*`) — принимают минимальный контракт пользователя и
 *      данные документа, не знают о Payload и покрыты тестами в `policies.test.ts`;
 *   2. адаптеры под Payload (`*Access`) — тонкие обёртки, подставляющие `req.user`.
 *
 * Границы задачи (важно, чтобы не считать реализованным лишнее):
 *   - полная статусная модель с ГРОМКОЙ ошибкой на запрещённом переходе,
 *     валидация полноты перед `review` и предложение 301/404 при снятии с
 *     публикации — задача Э1-08. Здесь только роль: кто вправе назвать статус;
 *   - неизменяемость slug для ВСЕХ, включая `admin`, и атомарная смена URL с
 *     одиночным 301 — задача Э1-09. Здесь только роль;
 *   - негативные тесты через живой REST и GraphQL — задача Э6-02.
 *
 * Как Payload применяет отказ на уровне ПОЛЯ (проверено по исходникам,
 * `payload/dist/fields/hooks/beforeValidate/promise.js`): при `false` поле
 * удаляется из входных данных и остаётся прежнее значение — запрос не падает.
 * Для защиты этого достаточно (запрещённое значение записано не будет), но
 * внятного отказа сервисный аккаунт не получит: громкую ошибку добавляет Э1-08.
 * Там же важное следствие: `overrideAccess: true` (по умолчанию у Local API)
 * отключает проверки полей целиком — поэтому серверные хуки проекта могут
 * заполнять служебные поля, а внешний клиент через REST/GraphQL не может.
 */
import type { Access, FieldAccess, PayloadRequest, TypeWithID, Where } from 'payload';

import { CONTENT_STATUSES } from '@otkritka/shared';

import { type RoledUser, isAdmin, isAiEditor } from './roles';

/**
 * Поля документа, от которых зависят права. Намеренно шире сгенерированного
 * `Card`: те же правила действуют для `collections` (Э1-05), а предикаты должны
 * компилироваться до `pnpm generate:types`.
 */
export interface PublishableDoc {
  /** Дата ПЕРВОЙ публикации. Непустое значение = URL уже был в индексе. */
  readonly publishedAt?: string | null;
  readonly status?: string | null;
}

function isKnownStatus(value: unknown): boolean {
  return typeof value === 'string' && (CONTENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Публиковалась ли запись хоть раз.
 *
 * Критерий — `publishedAt`, а не текущий статус: иначе снятие записи с
 * публикации разблокировало бы slug, и URL, уже известный поисковику, можно
 * было бы сменить в два шага (`published` → `draft` → новый slug).
 */
export function hasBeenPublished(doc: PublishableDoc | null | undefined): boolean {
  const publishedAt = doc?.publishedAt;
  return typeof publishedAt === 'string' && publishedAt.trim() !== '';
}

/* ------------------------------------------------------------------ */
/* 1. Чистые предикаты                                                */
/* ------------------------------------------------------------------ */

/**
 * Вход в админку. Только человек: `ai-editor` — сервисный аккаунт с API-ключом,
 * интерфейс ему не нужен, а возможность войти означала бы, что часть правил
 * можно попробовать обойти через UI.
 */
export function canUseAdminPanel(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

/** Пользователи и API-ключи (ТЗ §9: ключи и роли — только администратор). */
export function canManageUsers(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

export function canCreateContent(user: RoledUser | null | undefined): boolean {
  return isAdmin(user) || isAiEditor(user);
}

export function canEditContent(user: RoledUser | null | undefined): boolean {
  return isAdmin(user) || isAiEditor(user);
}

/** Читать `draft` и `review` вправе только аутентифицированный: публично их нет. */
export function canReadDraftContent(user: RoledUser | null | undefined): boolean {
  return isAdmin(user) || isAiEditor(user);
}

/**
 * Вправе ли пользователь назначить записи статус `next`.
 *
 * `published` — только `admin` (ТЗ §8.2, п. 7.1 и п. 23 SEO ТЗ). Неизвестное
 * значение отклоняется у всех: иначе опечатка в значении статуса прошла бы
 * проверку «это не published» и запись оказалась бы в неизвестном состоянии.
 */
export function canSetStatus(user: RoledUser | null | undefined, next: unknown): boolean {
  if (!isKnownStatus(next)) {
    return false;
  }
  if (next === 'published') {
    return isAdmin(user);
  }
  return canEditContent(user);
}

/** Любая смена robots-директивы — действие человека (CLAUDE.md, ТЗ §9). */
export function canSetRobots(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

/**
 * Вправе ли пользователь открыть страницу в `index,follow` при статусе `status`.
 *
 * Два условия сразу: роль `admin` и статус `published`. Второе — из CLAUDE.md
 * («только published может получить index,follow»): черновик в индексе — это
 * ровно тот сценарий, от которого страхует статусная модель. Содержательные
 * условия п. 5.1 SEO ТЗ (спрос, объём, уникальность текстов) машиной не
 * проверяются и остаются ответственностью человека.
 */
export function canSetIndexFollow(user: RoledUser | null | undefined, status: unknown): boolean {
  return isAdmin(user) && status === 'published';
}

/** Переопределение canonical (ТЗ §8.1: «по умолчанию self; переопределение — только админ»). */
export function canOverrideCanonical(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

/**
 * Правка даты содержательного обновления. Только `admin`: это источник
 * `lastmod` в sitemap, а sitemap `ai-editor` не трогает (CLAUDE.md).
 */
export function canSetContentUpdatedAt(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

/**
 * Роль вправе править slug записи.
 *
 * Для `ai-editor` — только до первой публикации. Для `admin` предикат
 * возвращает `true`: право у него есть, но одного права мало — атомарность
 * «смена slug + одиночный 301» обеспечивает хук Э1-09, а не эта функция.
 */
export function canEditSlug(
  user: RoledUser | null | undefined,
  doc: PublishableDoc | null | undefined,
): boolean {
  if (isAdmin(user)) {
    return true;
  }
  if (!isAiEditor(user)) {
    return false;
  }
  return !hasBeenPublished(doc);
}

/** Редиректы — только `admin` (ТЗ §9, CLAUDE.md). */
export function canManageRedirects(user: RoledUser | null | undefined): boolean {
  return isAdmin(user);
}

/**
 * Удаление записи контента.
 *
 * `ai-editor` вправе удалить только свой черновик, который никогда не
 * публиковался: у такой записи не было публичного URL, поэтому удаление не
 * требует решения «301 или 404». Всё остальное — `admin`.
 */
export function canDeleteContent(
  user: RoledUser | null | undefined,
  doc: PublishableDoc | null | undefined,
): boolean {
  if (isAdmin(user)) {
    return true;
  }
  if (!isAiEditor(user)) {
    return false;
  }
  return doc?.status === 'draft' && !hasBeenPublished(doc);
}

/* ------------------------------------------------------------------ */
/* 2. Адаптеры под Payload                                            */
/* ------------------------------------------------------------------ */

/** Только `admin`. Форма для `access` коллекции. */
export const adminOnlyAccess: Access = ({ req }) => isAdmin(req.user);

/** Только `admin`. Форма для `access` ПОЛЯ. */
export const adminOnlyFieldAccess: FieldAccess = ({ req }) => isAdmin(req.user);

/** Любой аутентифицированный (человек или сервисный аккаунт). */
export const authenticatedAccess: Access = ({ req }) => Boolean(req.user);

/** Любой аутентифицированный. Форма для `access` ПОЛЯ (возвращает только boolean). */
export const authenticatedFieldAccess: FieldAccess = ({ req }) => Boolean(req.user);

/** Вход в админку: только человек. */
export const adminPanelAccess = ({ req }: { req: PayloadRequest }): boolean =>
  canUseAdminPanel(req.user);

/** Создание и правка контента: `admin` и `ai-editor`. */
export const contentWriteAccess: Access = ({ req }) => canEditContent(req.user);

/**
 * Чтение контента: аутентифицированному — всё, анониму — только `published`.
 *
 * Ограничение возвращается запросом (`Where`), а не логическим значением:
 * так публичный рендер (`apps/web`) физически не может получить черновик ни
 * через REST, ни через GraphQL, ни подбором параметров.
 */
export const contentReadAccess: Access = ({ req }) => {
  if (canReadDraftContent(req.user)) {
    return true;
  }
  const publishedOnly: Where = { status: { equals: 'published' } };
  return publishedOnly;
};

/**
 * Удаление контента: `admin` — всё, `ai-editor` — только неопубликованные
 * черновики. Ограничение тоже запросом: иначе массовое удаление (`DELETE` с
 * `where`) обошло бы поштучную проверку.
 */
export const contentDeleteAccess: Access = ({ req }) => {
  if (isAdmin(req.user)) {
    return true;
  }
  if (!isAiEditor(req.user)) {
    return false;
  }
  const ownDraftsOnly: Where = {
    and: [{ status: { equals: 'draft' } }, { publishedAt: { exists: false } }],
  };
  return ownDraftsOnly;
};

type StatusCarrier = { status?: string | null };

/**
 * Доступ к полю `status`, зависящий от ЗНАЧЕНИЯ: `ai-editor` вправе выставить
 * `draft` и `review`, но не `published`.
 *
 * Значение читается из `siblingData` (для поля верхнего уровня это входные
 * данные документа) с откатом на `data`. Если статус во входных данных не
 * передан, менять его никто не пытается — проверяется только право на правку.
 */
export const contentStatusFieldAccess: FieldAccess<TypeWithID & StatusCarrier, StatusCarrier> = ({
  data,
  req,
  siblingData,
}) => {
  const incoming = siblingData?.status ?? data?.status;
  if (incoming === undefined || incoming === null) {
    return canEditContent(req.user);
  }
  return canSetStatus(req.user, incoming);
};

/**
 * Доступ к полю `slug`: после первой публикации сервисный аккаунт его не меняет.
 *
 * На `create` документа ещё нет (`doc === undefined`) — тогда решает только роль.
 */
export const slugFieldAccess: FieldAccess<TypeWithID & PublishableDoc> = ({ doc, req }) =>
  canEditSlug(req.user, doc);

/** Поле `robots`. */
export const robotsFieldAccess: FieldAccess = ({ req }) => canSetRobots(req.user);

/** Поле `canonical`. */
export const canonicalFieldAccess: FieldAccess = ({ req }) => canOverrideCanonical(req.user);

/** Поле `updatedContentAt` (источник `lastmod`). */
export const contentUpdatedAtFieldAccess: FieldAccess = ({ req }) =>
  canSetContentUpdatedAt(req.user);

/**
 * Поле, которое не заполняется извне НИКЕМ, включая `admin`: `pHash`, ключ
 * производной, ревизия, суффикс имени файла, автор записи истории.
 *
 * Значение ставят серверные хуки, а они работают через Local API с
 * `overrideAccess: true` и проверки полей не проходят. Поэтому запрет здесь
 * закрывает именно внешний путь (REST/GraphQL и форму админки) — то есть тот,
 * по которому ключ производной или pHash можно было бы подменить руками.
 */
export const systemFieldAccess: FieldAccess = () => false;
