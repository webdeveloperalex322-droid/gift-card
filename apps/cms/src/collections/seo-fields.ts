/**
 * SEO-поля, общие для контентных коллекций: slug, status, robots, canonical,
 * publishedAt, updatedContentAt (ТЗ §8.1).
 *
 * Почему фабрики полей, а не копия набора в каждой коллекции: `cards` (Э1-04) и
 * `collections` (Э1-05) обязаны иметь ОДИНАКОВЫЕ правила индексации. Две копии
 * набора рано или поздно разойдутся, и расхождение проявится не ошибкой сборки,
 * а страницей в индексе, которой там быть не должно.
 *
 * Валидаторы вынесены отдельными чистыми функциями: они покрыты юнит-тестами и
 * не требуют поднятой базы. Проверки выполняются на сервере, поэтому действуют
 * одинаково для админки, REST и GraphQL.
 *
 * Границы: перевод статуса с ГРОМКОЙ ошибкой и валидация полноты перед `review`
 * — Э1-08; неизменяемость slug и атомарная смена URL с 301 — Э1-09; запись
 * изменений в `seo-history` — Э1-07. Здесь только определения полей, дефолты и
 * те правила, которые являются частью access control.
 */
import type { Field, SelectFieldSingleValidation, TextFieldSingleValidation } from 'payload';

import {
  CONTENT_STATUSES,
  type ContentStatus,
  canonicalizePath,
  looksLikeAbsoluteUrl,
} from '@otkritka/shared';

import {
  canSetIndexFollow,
  canonicalFieldAccess,
  contentStatusFieldAccess,
  contentUpdatedAtFieldAccess,
  robotsFieldAccess,
  slugFieldAccess,
  systemFieldAccess,
} from '../access/policies';
import { isProtocolRelativeUrl, validateContentSlug } from '../seo/paths';
import {
  DEFAULT_ROBOTS,
  ROBOTS_DIRECTIVES,
  isIndexableRobots,
  isRobotsDirective,
} from '../seo/robots';

/** Дефолт статуса. Новая запись — всегда черновик (ТЗ §8.2, CLAUDE.md). */
export const DEFAULT_STATUS: ContentStatus = 'draft';

/**
 * Подписи статусов в админке. Ключи — весь набор `CONTENT_STATUSES` из общего
 * пакета: добавление статуса там перестанет компилироваться здесь, а не молча
 * выпадет из списка выбора.
 */
const STATUS_LABELS: Record<ContentStatus, string> = {
  draft: 'Черновик (noindex, вне sitemap)',
  review: 'На проверке (noindex, вне sitemap)',
  published: 'Опубликовано (публикует человек)',
};

/**
 * Читает строковое поле из объекта неизвестной формы.
 *
 * `validate` Payload получает `data`/`siblingData` как `unknown`-подобные
 * значения: они собираются из входных данных запроса, а не из типа записи.
 * Поэтому чтение статуса — явное сужение, а не приведение типа.
 */
function readStringField(source: unknown, name: string): string | undefined {
  if (typeof source !== 'object' || source === null || !(name in source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/** Значение неизвестного типа в текст ошибки, без «[object Object]». */
function describeValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Проверяет robots-директиву против статуса записи и роли пользователя.
 *
 * Отказ громкий (текст ошибки), а не молчаливый: `index,follow` — это решение об
 * индексации, и редактор обязан узнать, почему оно не применилось. Доступ к
 * полю по роли закрывается отдельно (`robotsFieldAccess`), эта проверка ловит
 * второй случай — админ открывает в индекс НЕопубликованную страницу.
 */
export function validateRobotsForStatus(
  value: unknown,
  context: { readonly status?: string | undefined; readonly user?: { role?: string | null } | null },
): string | true {
  if (value === undefined || value === null || value === '') {
    return `Robots-директива обязательна. Значение по умолчанию — ${DEFAULT_ROBOTS}.`;
  }

  if (!isRobotsDirective(value)) {
    return (
      `Robots-директива «${describeValue(value)}» не входит в набор: ` +
      `${ROBOTS_DIRECTIVES.join(' / ')}. Набор закрытый: он управляет индексацией, ` +
      'и произвольное значение означало бы неизвестное поведение в поиске.'
    );
  }

  if (!isIndexableRobots(value)) {
    return true;
  }

  if (!canSetIndexFollow(context.user, context.status)) {
    return (
      'Открыть страницу в index,follow может только администратор и только для ' +
      `статуса published (сейчас статус «${context.status ?? 'не задан'}»). ` +
      'Черновик и запись на проверке обязаны оставаться noindex и вне sitemap.'
    );
  }

  return true;
}

/**
 * Проверяет переопределение canonical.
 *
 * Пусто — норма: по умолчанию canonical у записи self, и собирает его `apps/web`
 * единственным хелпером из `SITE_URL`. Абсолютный URL в поле запрещён именно
 * поэтому: он стал бы вторым источником хоста, и после переезда домена
 * canonical указывал бы на старый.
 */
export function validateCanonicalOverride(value: unknown): string | true {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return true;
  }

  if (typeof value !== 'string') {
    return 'Canonical задаётся путём от корня сайта, например /otkrytki/otkrytka-mame.';
  }

  const raw = value.trim();

  if (looksLikeAbsoluteUrl(raw) || isProtocolRelativeUrl(raw)) {
    return (
      `«${raw}» — абсолютный URL. Canonical задаётся путём от корня: хост подставляет ` +
      'единственный хелпер из SITE_URL, и вписанный руками домен разошёлся бы с ним ' +
      'при первом же переезде.'
    );
  }

  try {
    canonicalizePath(raw);
  } catch (error) {
    return `«${raw}» не является путём: ${error instanceof Error ? error.message : String(error)}`;
  }

  return true;
}

/**
 * Обёртки под типы валидаторов Payload.
 *
 * Аннотация нужна потому, что фабрики возвращают широкий тип `Field`: при
 * возврате объединения контекстная типизация до аргументов `validate` не
 * доходит, и параметры стали бы неявным `any` — то есть проверка потеряла бы
 * типы ровно там, где она защищает индексацию.
 */
function validateSlugValue(prefix: string): TextFieldSingleValidation {
  return (value) => validateContentSlug(value, { prefix });
}

const validateRobotsValue: SelectFieldSingleValidation = (
  value,
  { data, req, siblingData },
) =>
  validateRobotsForStatus(value, {
    status: readStringField(siblingData, 'status') ?? readStringField(data, 'status'),
    user: req.user,
  });

const validateCanonicalValue: TextFieldSingleValidation = (value) =>
  validateCanonicalOverride(value);

/** Поле slug. Валидация — по итоговому пути записи, а не по форме сегмента. */
export function slugField(options: { readonly prefix: string }): Field {
  return {
    name: 'slug',
    type: 'text',
    required: true,
    unique: true,
    index: true,
    access: {
      create: slugFieldAccess,
      update: slugFieldAccess,
    },
    admin: {
      description:
        `URL записи: ${options.prefix}/<slug>. Неизменяем после первой публикации ` +
        '(смена возможна только вместе с одиночным 301 — задача Э1-09). ' +
        'Смена заголовка URL не меняет.',
      position: 'sidebar',
    },
    validate: validateSlugValue(options.prefix),
  };
}

/** Поле статуса. Дефолт `draft`; `published` доступен только `admin`. */
export function statusField(): Field {
  return {
    name: 'status',
    type: 'select',
    required: true,
    defaultValue: DEFAULT_STATUS,
    index: true,
    options: CONTENT_STATUSES.map((status) => ({ label: STATUS_LABELS[status], value: status })),
    access: {
      create: contentStatusFieldAccess,
      update: contentStatusFieldAccess,
    },
    admin: {
      description:
        'draft → review → published. Перевод в published — осознанное действие ' +
        'человека с ролью admin; сервисный аккаунт ai-editor доводит запись до review.',
      position: 'sidebar',
    },
  };
}

/** Поле robots-директивы. Дефолт `noindex,follow`. */
export function robotsField(): Field {
  return {
    name: 'robots',
    type: 'select',
    required: true,
    defaultValue: DEFAULT_ROBOTS,
    options: ROBOTS_DIRECTIVES.map((directive) => ({ label: directive, value: directive })),
    access: {
      create: robotsFieldAccess,
      update: robotsFieldAccess,
    },
    admin: {
      description:
        'index,follow — только для published и только по решению администратора при ' +
        'выполнении условий п. 5.1 SEO ТЗ (подтверждённый спрос, отдельный интент, ' +
        'достаточный объём, уникальные тексты, страница в навигации).',
      position: 'sidebar',
    },
    validate: validateRobotsValue,
  };
}

/** Поле переопределения canonical. По умолчанию пусто = self-canonical. */
export function canonicalField(): Field {
  return {
    name: 'canonical',
    type: 'text',
    access: {
      create: canonicalFieldAccess,
      update: canonicalFieldAccess,
    },
    admin: {
      description:
        'Пусто = self-canonical (норма). Переопределение — только администратор и ' +
        'только путём от корня: абсолютный URL собирается из SITE_URL, вручную его ' +
        'вписывать нельзя.',
    },
    validate: validateCanonicalValue,
  };
}

/**
 * Дата ПЕРВОЙ публикации. Заполняется хуком (Э1-08) и снаружи не пишется:
 * от неё зависит блокировка slug, поэтому правка этого поля руками означала бы
 * возможность разблокировать URL.
 */
export function publishedAtField(): Field {
  return {
    name: 'publishedAt',
    type: 'date',
    access: {
      create: systemFieldAccess,
      update: systemFieldAccess,
    },
    admin: {
      description:
        'Дата первой публикации. Ставится автоматически при первом переводе в ' +
        'published (Э1-08) и далее не меняется: по ней определяется, что URL уже был ' +
        'известен поисковику.',
      position: 'sidebar',
      readOnly: true,
    },
    index: true,
  };
}

/** Дата содержательного обновления — источник `lastmod` в sitemap. */
export function updatedContentAtField(): Field {
  return {
    name: 'updatedContentAt',
    type: 'date',
    access: {
      create: contentUpdatedAtFieldAccess,
      update: contentUpdatedAtFieldAccess,
    },
    admin: {
      description:
        'Меняется ТОЛЬКО при содержательном обновлении: это lastmod в sitemap. ' +
        'Техническая правка (опечатка, служебное поле) дату не двигает — иначе ' +
        'lastmod перестаёт что-либо означать для поисковика.',
      position: 'sidebar',
    },
  };
}
