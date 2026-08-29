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
 * Границы: сами правила статусной модели и блокировки URL живут в
 * `status-model.ts` (чистое ядро) и `content-hooks.ts` (проводка в Payload).
 * Здесь только определения полей, дефолты и те проверки, которые являются частью
 * определения поля.
 */
import type {
  Field,
  FieldHook,
  SelectFieldSingleValidation,
  TextFieldSingleValidation,
  TypeWithID,
} from 'payload';

import {
  CONTENT_STATUSES,
  type ContentStatus,
  canonicalizePath,
  isValidSlug,
  looksLikeAbsoluteUrl,
  pathSegments,
} from '@otkritka/shared';

import {
  adminOnlyFieldAccess,
  authenticatedFieldAccess,
  canSetIndexFollow,
  canonicalFieldAccess,
  contentStatusFieldAccess,
  contentUpdatedAtFieldAccess,
  robotsFieldAccess,
  slugFieldAccess,
  systemFieldAccess,
} from '../access/policies';
import { validateContentSlug } from '../seo/paths';
import {
  META_DUPLICATE_FIELDS,
  META_DUPLICATE_FIELD_LABELS,
  describeMetaConflicts,
  readMetaConflictFacts,
} from './meta-duplicates';
import { normalizeRedirectPath } from './redirects-plan';
import { WITHDRAWAL_MODES } from './status-model';
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
 *
 * Форма пути проверяется ПОСЕГМЕНТНО правилами slug проекта (`isValidSlug` из
 * общего пакета) — находка ревизии `url-guard`: до неё поле принимало
 * `/otkrytki/Drugaya-STRANICA/` и `otkrytki/x` без ведущего слеша, то есть
 * администратор мог молча выставить canonical на адрес, которого нет. Верхний
 * регистр здесь не «некрасиво»: URL проекта — только нижний регистр, и адрес с
 * заглавными буквами отдаёт 404. Своих правил формы сегмента тут нет намеренно:
 * они те же, по которым живут slug записей.
 */
export function validateCanonicalOverride(value: unknown): string | true {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return true;
  }

  if (typeof value !== 'string') {
    return 'Canonical задаётся путём от корня сайта, например /otkrytki/otkrytka-mame.';
  }

  const raw = value.trim();

  // Предикат общего пакета распознаёт обе формы абсолютного адреса: со схемой и
  // протокольно-относительную (`//host/path`). Второй проверки рядом быть не
  // должно — правило одно.
  if (looksLikeAbsoluteUrl(raw)) {
    return (
      `«${raw}» — абсолютный URL. Canonical задаётся путём от корня: хост подставляет ` +
      'единственный хелпер из SITE_URL, и вписанный руками домен разошёлся бы с ним ' +
      'при первом же переезде.'
    );
  }

  if (!raw.startsWith('/')) {
    return (
      `«${raw}» не начинается со слеша. Canonical задаётся путём ОТ КОРНЯ сайта, ` +
      'например /otkrytki/otkrytka-mame: относительное значение зависело бы от того, ' +
      'на какой странице оно выведено, а canonical обязан быть одним адресом.'
    );
  }

  let canonical: string;
  try {
    canonical = canonicalizePath(raw);
  } catch (error) {
    return `«${raw}» не является путём: ${error instanceof Error ? error.message : String(error)}`;
  }

  for (const segment of pathSegments(canonical)) {
    if (!isValidSlug(segment)) {
      return (
        `Сегмент «${segment}» в «${raw}» не соответствует правилам URL проекта: только ` +
        'нижний регистр, транслитерация и дефисы между словами. Адрес с заглавными ' +
        'буквами, пробелами, подчёркиваниями или кириллицей отдаёт 404, то есть canonical ' +
        'указал бы на несуществующую страницу — а это хуже отсутствия переопределения.'
      );
    }
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
function validateSlugValue(prefix: string, forbidYear: boolean): TextFieldSingleValidation {
  return (value) => validateContentSlug(value, { forbidYear, prefix });
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

export interface SlugFieldOptions {
  /** Префикс пространства имён записи: `/otkrytki` или `/podborki`. */
  readonly prefix: string;
  /**
   * Уникален ли САМ slug. По умолчанию `true` — так у карточки, чей путь равен
   * `<префикс>/<slug>`.
   *
   * Для подборок значение `false`, и это не послабление: у иерархической записи
   * уникален ИТОГОВЫЙ ПУТЬ, а не сегмент. Slug `mame` законно существует и под
   * праздником (`/podborki/prazdniki/8-marta/mame`), и в ветке адресатов
   * (`/podborki/adresaty/mame`); уникальный индекс стоит на поле `path`.
   */
  readonly unique?: boolean;
  /** Пояснение в админке, если путь собирается не как `<префикс>/<slug>`. */
  readonly description?: string;
  /**
   * Запрещён ли год в адресе (условие C3). У карточки — да: её адрес один
   * навсегда, а повод повторяется каждый год. У подборки правило зависит от вида
   * узла, поэтому здесь оно НЕ включается — его применяет
   * `collections/collection-path.ts`, где вид узла известен.
   */
  readonly forbidYear?: boolean;
}

/** Поле slug. Валидация — по итоговому пути записи, а не по форме сегмента. */
export function slugField(options: SlugFieldOptions): Field {
  return {
    name: 'slug',
    type: 'text',
    required: true,
    unique: options.unique ?? true,
    index: true,
    access: {
      create: slugFieldAccess,
      update: slugFieldAccess,
    },
    admin: {
      description:
        options.description ??
        `URL записи: ${options.prefix}/<slug>. Неизменяем после первой публикации ` +
          '(смена возможна только вместе с одиночным 301 — задача Э1-09). ' +
          'Смена заголовка URL не меняет.',
      position: 'sidebar',
    },
    validate: validateSlugValue(options.prefix, options.forbidYear === true),
  };
}

/** Читает непустое строковое поле из данных запроса (форма не гарантирована типом). */
function readFilledStringField(source: unknown, name: string): string | undefined {
  const value = readStringField(source, name);
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * ТЗ §8.1: «title, h1 — раздельно; по умолчанию совпадают».
 *
 * Заполняется только ПУСТОЙ H1: иначе редактор не смог бы сделать H1 отличным
 * от title — а именно раздельность этих двух полей требует ТЗ.
 */
const fillHeadingFromTitle: FieldHook<
  TypeWithID & { title?: string | null },
  string | null | undefined,
  unknown
> = ({ data, value }) => {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return readFilledStringField(data, 'title') ?? value;
};

/**
 * Поле H1. Фабрика, а не копия в каждой коллекции: правило «пустой H1 равен
 * title» одинаково для карточек и подборок, а две копии разошлись бы не ошибкой
 * сборки, а страницей с чужим заголовком.
 */
export function headingField(): Field {
  return {
    name: 'h1',
    type: 'text',
    admin: {
      description: 'H1 страницы. Пустой — совпадает с title (ТЗ §8.1).',
    },
    hooks: {
      beforeChange: [fillHeadingFromTitle],
    },
  };
}

/**
 * Условие индексации, названное ПОСЛЕДСТВИЕМ, а не требованием к полю.
 *
 * Одна строка на два места — подпись поля `robots` и подпись `metaDescription`:
 * решение об индексации принимают в первом, а ломают его во втором, и человеку
 * нужно прочитать одно и то же в обоих. Формулировка совпадает с текстом отказа
 * `index-requires-description` (`./status-model.ts`) сознательно: подсказка,
 * обещающая не то, что делает отказ, хуже отсутствия подсказки.
 */
export const INDEX_NEEDS_DESCRIPTION_HINT =
  'index,follow не применяется, пока пусто meta description: страница без непустого ' +
  'описания понижается до noindex,follow и не попадает в sitemap. Поэтому сохранение с ' +
  'index,follow и пустым описанием отклоняется — иначе решение осталось бы в поле и не ' +
  'действовало на сайте.';

/**
 * Поле meta description.
 *
 * Фабрика, а не два одинаковых объявления, по той же причине, что и остальные
 * поля этого модуля: `metaDescription` входит в требования полноты перед
 * `review` у ОБЕИХ коллекций и в условие индексации, поэтому разойтись подписям
 * этого поля нельзя — редактор карточки и редактор подборки обязаны прочитать
 * одно и то же следствие пустого значения.
 *
 * @param note приписка, объясняющая место поля именно в этой коллекции
 */
export function metaDescriptionField(note?: string): Field {
  return {
    name: 'metaDescription',
    type: 'textarea',
    admin: {
      description:
        `Meta description.${note === undefined ? '' : ` ${note}`} Совпадения по каталогу ` +
        `проверяются при сохранении (задача Э5-01). ${INDEX_NEEDS_DESCRIPTION_HINT}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Дубли метатегов (задача Э5-01, ТЗ §8.3.1)                          */
/* ------------------------------------------------------------------ */

/**
 * Нормализованные ключи метатегов — то, по чему ищется совпадение.
 *
 * ПОЧЕМУ ХРАНИМЫЕ ПОЛЯ, А НЕ ПОИСК ПО ИСХОДНЫМ ЗНАЧЕНИЯМ. Совпадение считается
 * по нормализованному значению (регистр и пробелы не создают «разных»
 * заголовков), а нормализованного значения в базе иначе нет: искать пришлось бы
 * полным обходом обеих коллекций на каждом сохранении — тем самым, который уже
 * стоит у визуальных дублей и стоит дорого. С хранимым ключом под индексом
 * поиск конфликта превращается в одно точное сравнение.
 *
 * Второе следствие, ради которого выбрана именно эта форма: дашборд (Э5-04)
 * получает список дублей одной группировкой по этому полю, а не повторным
 * обходом каталога.
 *
 * Поля служебные: снаружи не пишутся никем (`systemFieldAccess`) и скрыты из
 * формы админки — редактор правит title, а не его нормализованную копию. В REST
 * и GraphQL они приходят: `admin.hidden` прячет поле из интерфейса, но не из API.
 *
 * ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: ключ появляется у записи при первом сохранении после
 * появления этих полей. Записи, не сохранявшиеся с тех пор, в поиске конфликтов
 * не участвуют (их ключ пуст). На пустом каталоге это ничего не значит, но перед
 * переносом накопленных данных потребуется разовое пересохранение — отмечено в
 * отчёте этапа.
 */
export function metaDuplicateKeyFields(): Field[] {
  return [
    {
      name: 'titleKey',
      type: 'text',
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { hidden: true },
    },
    {
      name: 'metaDescriptionKey',
      type: 'text',
      index: true,
      access: { create: systemFieldAccess, update: systemFieldAccess },
      admin: { hidden: true },
    },
  ];
}

/**
 * Человеческое описание снимка конфликтов — вычисляется НА ЧТЕНИИ.
 *
 * Виртуальное поле, а не хранимая строка: хранимая копия описания разошлась бы
 * со списком при первой же правке, а виртуальная считается из соседних полей той
 * же группы. Тот же приём, что у `indexationState` в глобале настроек (Э4).
 */
const readMetaConflictSummary: FieldHook = ({ siblingData }) =>
  describeMetaConflicts(readMetaConflictFacts(siblingData));

/**
 * Группа «Проверка дублей метатегов» (ТЗ §8.3.1).
 *
 * ФОРМА ПРЕДУПРЕЖДЕНИЯ. ТЗ требует «предупреждение со ссылками на конфликтующие
 * страницы», то есть сохранение обязано пройти. Предупреждать в CMS сегодня
 * нечем: единственный сквозной канал — журнал сервера, которого внешний
 * AI-редактор через REST и GraphQL не видит (разбор этапа 4). Поэтому
 * предупреждение выражено СНИМКОМ В САМОЙ ЗАПИСИ: хук заполняет группу при
 * каждом сохранении, и она возвращается в ответе на то же сохранение — одинаково
 * в форме админки, в REST и в GraphQL.
 *
 * Снимок именно снимок, и это сказано в подписи поля: он верен на момент
 * последнего сохранения записи (`checkedAt`). Держать его всегда актуальным
 * можно было бы только запросом на каждое чтение, включая список из полусотни
 * строк, — а всегда актуальный ответ на вопрос «где дубли» даёт не он, а
 * нормализованные ключи ({@link metaDuplicateKeyFields}).
 *
 * Подтверждение (`confirm`) — ОДНОРАЗОВЫЙ флаг операции, тем же приёмом, что
 * подтверждение смены URL (Э1-09) и решение о визуальном дубле (Э2-05): хук
 * сбрасывает его после сохранения, а действует оно только для того набора
 * конфликтов, отпечаток которого записан в `confirmedFor`.
 */
export function metaConflictField(): Field {
  return {
    name: 'metaConflict',
    type: 'group',
    // Читают только аутентифицированные. Снимок называет АДРЕСА конфликтующих
    // страниц, а среди них бывают записи в `review` — их `contentReadAccess`
    // анониму не отдаёт вовсе. Без этой строки путь непубличной страницы
    // утекал бы в публичный ответ по опубликованной карточке: правило чтения
    // соблюдалось бы для самой записи и обходилось бы через чужой снимок.
    access: { read: authenticatedFieldAccess },
    label: 'Проверка дублей метатегов',
    admin: {
      description:
        'Совпадения title и meta description с другими страницами — по открыткам и ' +
        'подборкам сразу, в статусах published и review (ТЗ §8.3.1). Сохранение при ' +
        'совпадении проходит: это предупреждение. А перевод в review и дальше — только ' +
        'после правки текста или явного подтверждения.',
    },
    fields: [
      {
        name: 'conflicts',
        type: 'array',
        label: 'Конфликтующие страницы',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          description:
            'Заполняется хуком при каждом сохранении: чей текст совпал, по какому полю и ' +
            'по какому адресу лежит страница. Снаружи не пишется.',
          readOnly: true,
        },
        fields: [
          {
            name: 'field',
            type: 'select',
            options: META_DUPLICATE_FIELDS.map((field) => ({
              label: META_DUPLICATE_FIELD_LABELS[field],
              value: field,
            })),
          },
          {
            name: 'documentCollection',
            type: 'select',
            options: [
              { label: 'Открытки', value: 'cards' },
              { label: 'Подборки', value: 'collections' },
            ],
          },
          {
            name: 'documentId',
            type: 'text',
            admin: {
              description:
                'Идентификатор конфликтующей записи строкой, а не связью: снимок обязан ' +
                'переживать удаление той записи — иначе исчезал бы след ровно того ' +
                'события, ради которого снимок и смотрят.',
            },
          },
          { name: 'path', type: 'text', label: 'Адрес конфликтующей страницы' },
          { name: 'status', type: 'text' },
          { name: 'title', type: 'text', label: 'Заголовок конфликтующей записи' },
        ],
      },
      {
        name: 'total',
        type: 'number',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          description:
            'Сколько совпадений найдено ВСЕГО. Отдельно от длины списка: список ограничен, ' +
            'а по этому числу видно, что за ним стоит.',
          readOnly: true,
        },
      },
      {
        name: 'truncated',
        type: 'checkbox',
        defaultValue: false,
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          description: 'Список показан не полностью: найдено больше, чем помещается.',
          readOnly: true,
        },
      },
      {
        name: 'checkedAt',
        type: 'date',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
          description:
            'Когда снимок сделан. Снимок верен НА ЭТОТ МОМЕНТ: конфликтующую страницу с тех ' +
            'пор могли переименовать или удалить.',
          readOnly: true,
        },
      },
      {
        name: 'confirm',
        type: 'checkbox',
        defaultValue: false,
        admin: {
          description:
            'ОДНОРАЗОВОЕ подтверждение: «совпадение вижу, веду страницу дальше». Отметьте ' +
            'его в том же сохранении, которым переводите запись в review. Хук снимает флаг ' +
            'после сохранения, а само подтверждение действует только для ТОГО набора ' +
            'совпадений, который был на момент отметки: изменился текст или круг ' +
            'конфликтующих страниц — подтверждайте заново.',
        },
      },
      {
        name: 'confirmedFor',
        type: 'text',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          description:
            'Отпечаток набора совпадений, для которого выдано подтверждение. Не совпал с ' +
            'текущим — подтверждение устарело, и переход снова заблокирован.',
          readOnly: true,
        },
      },
      {
        name: 'confirmedAt',
        type: 'date',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
          description: 'Когда подтверждение выдано.',
          readOnly: true,
        },
      },
      {
        name: 'confirmedBy',
        type: 'relationship',
        relationTo: 'users',
        access: { create: systemFieldAccess, update: systemFieldAccess },
        admin: {
          description:
            'Кто подтвердил совпадение. Записывается потому, что подтверждать вправе и ' +
            'сервисный аккаунт ai-editor (перевод draft → review — его штатное действие), ' +
            'а решение «две страницы с одинаковым заголовком допустимы» обязано быть ' +
            'прослеживаемым.',
          readOnly: true,
        },
      },
      {
        // Идёт ПОСЛЕДНИМ намеренно: значение считается по соседним полям, а
        // порядок обхода полей на чтении — их порядок здесь.
        name: 'summary',
        type: 'text',
        label: 'Что сейчас с дублями метатегов',
        // Виртуальное: в базе не хранится, вычисляется на чтении. Хранимая копия
        // описания разошлась бы со списком и врала бы уверенно.
        virtual: true,
        hooks: { afterRead: [readMetaConflictSummary] },
        admin: {
          description:
            'Одной строкой по тому же снимку. Поле приходит в REST и GraphQL: правило, ' +
            'видимое только в форме админки, для внешнего клиента не существует.',
          readOnly: true,
        },
      },
    ],
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
        `достаточный объём, уникальные тексты, страница в навигации). ${INDEX_NEEDS_DESCRIPTION_HINT}`,
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

/**
 * Проверяет путь замены при снятии страницы с публикации.
 *
 * Правила ровно те же, что у поля `to` в `redirects`, и берутся оттуда же
 * (`normalizeRedirectPath`): значение этого поля станет целью настоящего 301,
 * поэтому вторая, «своя» проверка пути означала бы, что через это поле можно
 * записать редирект, который сама коллекция редиректов не приняла бы.
 */
export function validateWithdrawalTarget(value: unknown, mode: unknown): string | true {
  const filled = typeof value === 'string' && value.trim() !== '';

  if (mode === '301' && !filled) {
    return (
      'Для решения 301 нужен путь замены: 301 — это перенос на конкретный URL. ' +
      'Если замены нет, выберите 410 (удалено без замены) или 404.'
    );
  }
  if (mode !== '301' && filled) {
    return (
      `Решение «${typeof mode === 'string' ? mode : 'без замены'}» означает, что замены ` +
      'нет, поэтому путь замены должен быть пустым.'
    );
  }
  if (!filled) {
    return true;
  }

  try {
    normalizeRedirectPath(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return true;
}

const validateWithdrawalTargetValue: TextFieldSingleValidation = (value, { siblingData }) =>
  validateWithdrawalTarget(value, readStringField(siblingData, 'mode'));

/**
 * Решение о судьбе URL при снятии страницы с публикации (ТЗ §8.2: «с
 * автоматическим предложением 301/404»).
 *
 * Поля хранятся в записи, а не передаются мимо неё, по двум причинам: решение
 * должно быть видно в самой записи (по нему потом объясняют, почему адрес
 * отдаёт 301), и внешний клиент обязан иметь возможность его передать — правило,
 * доступное только через форму админки, для API не существует. Хук сбрасывает
 * решение при возврате записи в публикацию, поэтому «прошлое решение» не
 * применяется молча ко следующему снятию.
 */
export function withdrawalField(): Field {
  return {
    name: 'withdrawal',
    type: 'group',
    label: 'Снятие с публикации: судьба URL',
    admin: {
      description:
        'Заполняется при переводе опубликованной записи в draft или review. Без ' +
        'решения снятие с публикации отклоняется: этот URL уже известен поисковику, ' +
        'и молчаливое исчезновение страницы — это либо потерянный вес ссылки, либо ' +
        'мягкий 404.',
    },
    fields: [
      {
        name: 'mode',
        type: 'select',
        options: [
          { label: '301 — страница переехала на другой URL', value: '301' },
          { label: '410 — удалено без замены (явная запись в redirects)', value: '410' },
          { label: '404 — снято без записи в redirects', value: '404' },
        ],
        access: { create: adminOnlyFieldAccess, update: adminOnlyFieldAccess },
        admin: {
          description:
            'Снятие с публикации — действие администратора, поэтому и решение о судьбе ' +
            `URL тоже: допустимы только ${WITHDRAWAL_MODES.join(' / ')}.`,
        },
      },
      {
        name: 'redirectTo',
        type: 'text',
        access: { create: adminOnlyFieldAccess, update: adminOnlyFieldAccess },
        admin: {
          description:
            'Путь замены от корня сайта — только для 301. Абсолютный URL недопустим: ' +
            'хост собирается единственным хелпером из SITE_URL.',
        },
        validate: validateWithdrawalTargetValue,
      },
    ],
  };
}

/**
 * Подтверждение смены URL (задача Э1-09).
 *
 * После первой публикации slug (а у подборки ещё parent и nodeKind) заблокирован
 * для ВСЕХ, включая администратора. Разблокирует его только это подтверждение —
 * и ровно на одну операцию: тем же сохранением создаётся одиночный 301 со старого
 * пути на новый, в одной транзакции. Флаг сбрасывается хуком при каждом
 * сохранении, поэтому «подтверждено однажды» не превращается в «разрешено
 * навсегда».
 *
 * Почему подтверждение, а не отдельная ручка в интерфейсе: правило обязано
 * работать одинаково в админке, в REST и в GraphQL. Кнопка существует только в
 * админке, поле — везде.
 */
export function urlChangeField(): Field {
  return {
    name: 'urlChange',
    type: 'group',
    label: 'Смена URL (только вместе с 301)',
    admin: {
      description:
        'URL опубликованной записи неизменяем. Чтобы перенести страницу, поставьте ' +
        'подтверждение и в том же сохранении измените slug (у подборки — slug, ' +
        'родителя или вид узла): 301 создастся автоматически, в той же транзакции. ' +
        'Цепочки редиректов при этом схлопываются, а не выстраиваются.',
    },
    fields: [
      {
        name: 'confirm',
        type: 'checkbox',
        defaultValue: false,
        access: { create: adminOnlyFieldAccess, update: adminOnlyFieldAccess },
        admin: {
          description:
            'Подтверждаю смену URL: со старого пути будет создан одиночный 301. ' +
            'Одноразовое: после сохранения флаг снимается.',
        },
      },
      {
        name: 'reason',
        type: 'text',
        access: { create: adminOnlyFieldAccess, update: adminOnlyFieldAccess },
        admin: {
          description:
            'Причина переноса. Попадает в комментарий редиректа: через год именно он ' +
            'объясняет, почему адрес отдаёт 301.',
        },
      },
    ],
  };
}
