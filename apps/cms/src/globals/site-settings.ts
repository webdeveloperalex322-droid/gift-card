import type { ArrayFieldValidation, Field, FieldHook, GlobalConfig, TextFieldSingleValidation, TypeWithID } from 'payload';

import {
  adminOnlyAccess,
  adminOnlyFieldAccess,
  systemFieldAccess,
} from '../access/policies';
import { HISTORY_AUTHOR_ROLES, describeHistoryAuthor, readAuthorUserId } from '../collections/seo-history-diff';
import type { SiteSetting } from '../payload-types';
import {
  AD_SLOT_POSITIONS,
  AD_SLOT_POSITION_LABELS,
  type AdSlotFacts,
  IMAGE_LICENSE_REQUIRED,
  INFO_PAGE_KEYS,
  INFO_PAGE_LABELS,
  INFO_PAGE_MIN_TEXT_LENGTH,
  INFO_PAGE_PATHS,
  type ImageLicenseFacts,
  type InfoPageFacts,
  type InfoPageKey,
  MAX_AD_SLOTS_PER_POSITION,
  ORGANIZATION_JSON_LD_REQUIRED,
  type OrganizationFacts,
  SITE_SETTINGS_SLUG,
  validateAdSlotRows,
  validateProfileUrl,
  validateSiteRootPath,
} from './site-settings-rules';

/**
 * Глобал «Настройки сайта» (задача Э3-00) — единственное место, где живут
 * значения, которые решения человека от 2026-08-21 требуют держать
 * РЕДАКТИРУЕМЫМИ, а не в коде: Ч-17 (`Organization`), Ч-10 (лицензия
 * изображений), Ч-19 (тексты служебных страниц), Ч-11 (рекламные места).
 *
 * ПОЧЕМУ ОДИН ГЛОБАЛ, А НЕ ЧЕТЫРЕ. Все четыре группы значений имеют одинаковую
 * природу: одна запись на сайт, пишет только человек, читает публичный рендер.
 * Разделение дало бы четыре одинаковых правила доступа (четыре места, где можно
 * ошибиться по-разному) и четыре запроса из шаблона там, где нужен один: часть
 * значений — лицензия карточки и рекламные места — требуется НА КАЖДОЙ странице,
 * поэтому лишний round-trip к базе оплачивался бы из бюджета TTFB ≤ 0,8 с.
 * Разделение оправдано только разными правами доступа, а их здесь нет.
 *
 * ВСЕ ПОЛЯ ПУСТЫЕ ПО УМОЛЧАНИЮ. Ни одного правдоподобного значения в коде:
 * пустое поле — это сигнал «человек не заполнил», по которому шаблон обязан
 * промолчать (предикаты в `site-settings-rules.ts`). Единственный
 * `defaultValue` — `enabled: false` у рекламного места: дефолт закрывающий, он
 * не выводит блок, а прячет его, как `DEFAULT_ROBOTS` не открывает страницу в
 * индекс.
 *
 * ДОСТУП. Чтение публичное — глобал читают шаблоны Astro без аутентификации.
 * Запись — только роль `admin`. Для `ai-editor` запрет действует и в REST, и в
 * GraphQL, потому что живёт в `access.update` самого глобала, а не в интерфейсе:
 * отказ на уровне ГЛОБАЛА громкий (Payload бросает Forbidden), в отличие от
 * отказа на уровне ПОЛЯ, где поле молча срезается из входных данных. Для
 * настроек нужен именно громкий: сервисный аккаунт обязан узнать, что настройки
 * сайта не его дело, а не получить 200 без изменений.
 *
 * ПОЧЕМУ ИЗМЕНЕНИЯ НЕ ПИШУТСЯ В `seo-history` — решение задачи, а не пропуск.
 * Журнал `seo-history` привязан к ДОКУМЕНТУ: `documentCollection` — закрытый
 * набор `cards | collections`, `documentId`, `documentPath` и `field` из
 * закрытого набора SEO-полей записи. У глобала нет ни идентификатора записи, ни
 * пути, ни статуса; чтобы вписать его туда, пришлось бы расширить два перечисления
 * БД и смешать «поля страницы» с «ключами настроек» — журнал перестал бы отвечать
 * на вопрос, для которого создан («почему у ЭТОЙ страницы сменился title/robots/URL»).
 * Вторая причина: смысл `seo-history` — проверяемая граница автоматизации, то
 * есть след действий `ai-editor`; в этот глобал `ai-editor` не пишет вовсе.
 * Вместо этого след устроен так:
 *   - `versions` глобала хранит все сохранённые состояния (что было → что стало);
 *   - группа `audit` фиксирует автора и время КАЖДОГО сохранения, а поскольку
 *     это обычные поля, они попадают в снимок версии — история значений и автор
 *     оказываются в одной записи.
 * Автор определяется той же функцией `describeHistoryAuthor`, что и в
 * `seo-history`: двух трактовок «кто это сделал» в проекте быть не должно.
 */

/** Поля, которые заполняет только сервер и которые не отдаются публично. */
const auditFieldAccess = {
  create: systemFieldAccess,
  read: adminOnlyFieldAccess,
  update: systemFieldAccess,
} as const;

const validateSiteRootPathValue: TextFieldSingleValidation = (value) => validateSiteRootPath(value);
const validateProfileUrlValue: TextFieldSingleValidation = (value) => validateProfileUrl(value);
const validateAdSlotsValue: ArrayFieldValidation = (value) => validateAdSlotRows(value);

/* ------------------------------------------------------------------ */
/* Ч-17: Organization                                                 */
/* ------------------------------------------------------------------ */

const organizationGroup: Field = {
  name: 'organization',
  type: 'group',
  label: 'Организация (JSON-LD Organization на главной)',
  admin: {
    description:
      'Данные для разметки Organization на главной (решение Ч-17). Пока не заполнены ' +
      `${ORGANIZATION_JSON_LD_REQUIRED.join(' и ')}, блок Organization не выводится ВОВСЕ — ` +
      'разметка с пустыми или придуманными значениями запрещена п. 23 ТЗ. Остальные поля ' +
      'попадают в разметку по одному, по факту заполнения.',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      admin: {
        description:
          'Название проекта так, как оно видно на сайте. Разметка обязана совпадать с ' +
          'видимым содержимым, поэтому здесь не «красивое» имя, а то же самое.',
      },
    },
    {
      name: 'legalName',
      type: 'text',
      admin: {
        description:
          'Юридическое наименование, если оно есть и отличается от бренда. Пусто — ' +
          'свойства legalName в разметке не будет.',
      },
    },
    {
      name: 'logo',
      type: 'text',
      admin: {
        description:
          'Путь к файлу логотипа от корня сайта, например /media/site/logo.svg. ' +
          'Абсолютный адрес недопустим: хост подставляет единственный хелпер из SITE_URL. ' +
          'Без логотипа блок Organization не выводится.',
      },
      validate: validateSiteRootPathValue,
    },
    {
      name: 'email',
      type: 'email',
      admin: { description: 'Контактный адрес. Пусто — свойства email в разметке не будет.' },
    },
    {
      name: 'telephone',
      type: 'text',
      admin: { description: 'Контактный телефон. Пусто — свойства telephone в разметке не будет.' },
    },
    {
      name: 'sameAs',
      type: 'array',
      label: 'Профили в других сервисах (sameAs)',
      admin: {
        description:
          'Ссылки на официальные профили проекта. Здесь — и только здесь — адрес полный: ' +
          'профиль живёт на чужом хосте, и правило «хост только из SITE_URL» к нему не ' +
          'относится.',
      },
      fields: [
        {
          name: 'url',
          type: 'text',
          required: true,
          validate: validateProfileUrlValue,
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Ч-10: лицензия изображений                                         */
/* ------------------------------------------------------------------ */

const imageLicenseGroup: Field = {
  name: 'imageLicense',
  type: 'group',
  label: 'Лицензия изображений (JSON-LD ImageObject карточки)',
  admin: {
    description:
      'Лицензионные свойства ImageObject (решение Ч-10). Набор проверяется ЦЕЛИКОМ: пока не ' +
      `заполнены все поля набора (${IMAGE_LICENSE_REQUIRED.join(', ')}), лицензионная часть ` +
      'разметки не выводится. Частично заполненная лицензия хуже отсутствующей — она выглядит ' +
      'юридически значимой, не будучи ею, а правится потом сразу на всём массиве ' +
      'опубликованных карточек.',
  },
  fields: [
    {
      name: 'creator',
      type: 'text',
      admin: {
        description:
          'Кто создал изображение (свойство creator). Фиктивный автор запрещён п. 23 ТЗ: ' +
          'изображения генерирует нейросеть, и указание должно быть правдивым.',
      },
    },
    {
      name: 'creditText',
      type: 'text',
      admin: { description: 'Строка указания источника (creditText).' },
    },
    {
      name: 'copyrightNotice',
      type: 'text',
      admin: { description: 'Уведомление об авторских правах (copyrightNotice).' },
    },
    {
      name: 'license',
      type: 'text',
      admin: {
        description:
          `Путь к странице лицензии от корня сайта — по решению Ч-10 это ${INFO_PAGE_PATHS.terms}. ` +
          'Абсолютный адрес недопустим: хост подставляет единственный хелпер из SITE_URL.',
      },
      validate: validateSiteRootPathValue,
    },
    {
      name: 'acquireLicensePage',
      type: 'text',
      admin: {
        description:
          `Путь к странице, где можно получить лицензию — по решению Ч-10 это ${INFO_PAGE_PATHS.terms}. ` +
          'Ссылка отсюда работает и на неиндексируемой странице, поэтому доводом за её ' +
          'индексацию не является (Ч-23).',
      },
      validate: validateSiteRootPathValue,
    },
    {
      name: 'aiDisclosure',
      type: 'textarea',
      label: 'Указание на генерацию ИИ (подпись на карточке)',
      admin: {
        description:
          'Формулировка указания на то, что изображение создано нейросетью (решение Ч-10). ' +
          'Выводится ВИДИМОЙ подписью на карточке, а не свойством разметки: свойства с таким ' +
          'смыслом в schema.org нет, а придумывать его нельзя — разметка обязана ' +
          'соответствовать видимому содержимому. Полная формулировка живёт в «Условиях ' +
          `использования» (${INFO_PAGE_PATHS.terms}).`,
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Ч-19 + Ч-23: служебные информационные страницы                     */
/* ------------------------------------------------------------------ */

function infoPageGroup(key: InfoPageKey): Field {
  return {
    name: key,
    type: 'group',
    label: INFO_PAGE_LABELS[key],
    admin: {
      description:
        `Тексты страницы ${INFO_PAGE_PATHS[key]}. Пока страница не наполнена реальным ` +
        `текстом (минимум ${INFO_PAGE_MIN_TEXT_LENGTH} символов в теле плюс заполненные ` +
        'title и description), она остаётся noindex и вне sitemap — таково условие ' +
        'решения Ч-23. Текст-заглушка на индексируемой странице запрещён п. 23 ТЗ.',
    },
    fields: [
      {
        name: 'title',
        type: 'text',
        admin: {
          description: 'Заголовок страницы (title). Обязан быть уникальным на выборке приёмки.',
        },
      },
      {
        name: 'h1',
        type: 'text',
        admin: {
          description:
            'H1 страницы. Пусто — совпадает с title: то же правило, что у контентных ' +
            'коллекций (ТЗ §8.1), поэтому H1 не входит в условия индексации.',
        },
      },
      {
        name: 'metaDescription',
        type: 'textarea',
        admin: { description: 'Description страницы. Обязателен для индексации (Ч-23).' },
      },
      {
        name: 'body',
        type: 'richText',
        admin: {
          description:
            'Основной текст. Присутствует в HTML-ответе сервера — страница обязана быть ' +
            'полноценной при отключённом JS.',
        },
      },
    ],
  };
}

const infoPagesGroup: Field = {
  name: 'infoPages',
  type: 'group',
  label: 'Служебные информационные страницы',
  admin: {
    description:
      'Тексты трёх страниц (решение Ч-19). Сами страницы — статические маршруты Astro, а не ' +
      'записи CMS: отдельной коллекции `pages` в модели данных нет, и реестр ' +
      'зарезервированных маршрутов запрещает запись CMS с таким путём. Здесь только ' +
      'содержимое, которое правит человек.',
  },
  fields: INFO_PAGE_KEYS.map((key) => infoPageGroup(key)),
};

/* ------------------------------------------------------------------ */
/* Ч-11: рекламные места                                              */
/* ------------------------------------------------------------------ */

const adSlotsField: Field = {
  name: 'adSlots',
  type: 'array',
  label: 'Рекламные места',
  maxRows: AD_SLOT_POSITIONS.length * MAX_AD_SLOTS_PER_POSITION,
  admin: {
    description:
      'Два ряда по три блока (решение Ч-11): под H1 над сеткой и после пагинации. Место ' +
      'резервируется по ЭТИМ размерам, поэтому блок без ширины и высоты не выводится вовсе: ' +
      'нулевой контейнер даёт ровно тот сдвиг макета, против которого резервирование и ' +
      'существует (CLS < 0,1). Порядок блоков внутри ряда — порядок строк здесь.',
  },
  validate: validateAdSlotsValue,
  fields: [
    {
      name: 'position',
      type: 'select',
      required: true,
      options: AD_SLOT_POSITIONS.map((position) => ({
        label: AD_SLOT_POSITION_LABELS[position],
        value: position,
      })),
      admin: {
        description:
          'Ряд, в котором стоит блок. Набор закрыт решением Ч-11: произвольная позиция ' +
          'означала бы блок, который шаблон не выведет нигде.',
      },
    },
    {
      name: 'width',
      type: 'number',
      min: 1,
      admin: {
        description:
          'Ширина блока в пикселях — точное значение из кабинета рекламной сети. Пусто — ' +
          'блок не выводится.',
      },
    },
    {
      name: 'height',
      type: 'number',
      min: 1,
      admin: {
        description:
          'Высота блока в пикселях. Соотношение сторон отдельным полем не задаётся: ' +
          'резервировать место можно только по конкретным числам, а из двух размеров ' +
          'соотношение выводится, обратное — нет.',
      },
    },
    {
      name: 'enabled',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description:
          'Выводить блок. По умолчанию выключен: дефолт закрывающий — реклама не появляется ' +
          'на странице сама.',
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Аудит: кто и когда менял настройки                                 */
/* ------------------------------------------------------------------ */

const stampAuthorRole: FieldHook<TypeWithID, string, unknown> = ({ req }) =>
  describeHistoryAuthor(req.user).authorRole;

const stampAuthorUser: FieldHook<TypeWithID, number | null, unknown> = ({ req }) =>
  readAuthorUserId(describeHistoryAuthor(req.user).userId);

const stampViaApiKey: FieldHook<TypeWithID, boolean, unknown> = ({ req }) =>
  describeHistoryAuthor(req.user).apiKey;

const stampChangedAt: FieldHook<TypeWithID, string, unknown> = () => new Date().toISOString();

const auditGroup: Field = {
  name: 'audit',
  type: 'group',
  label: 'Кто изменил настройки',
  admin: {
    description:
      'Заполняется сервером при каждом сохранении и снаружи не пишется. Вместе с историей ' +
      'версий даёт полный след: версия хранит значения, эти поля — автора и время. Публично ' +
      'не отдаётся: настройки — открытые данные, а кто их менял — внутренняя кухня.',
  },
  fields: [
    {
      name: 'changedAt',
      type: 'date',
      access: auditFieldAccess,
      admin: {
        date: { displayFormat: 'dd.MM.yyyy HH:mm:ss' },
        description: 'Момент последнего сохранения настроек.',
        readOnly: true,
      },
      hooks: { beforeChange: [stampChangedAt] },
    },
    {
      name: 'authorRole',
      type: 'select',
      options: HISTORY_AUTHOR_ROLES.map((role) => ({ label: role, value: role })),
      access: auditFieldAccess,
      admin: {
        description:
          'Роль автора. Здесь ожидается admin: запись в глобал доступна только человеку. ' +
          'Значение system означает операцию без пользователя (скрипт, миграция), ' +
          'unknown — нераспознанную роль, то есть инцидент.',
        readOnly: true,
      },
      hooks: { beforeChange: [stampAuthorRole] },
    },
    {
      name: 'changedBy',
      type: 'relationship',
      relationTo: 'users',
      access: auditFieldAccess,
      admin: {
        description: 'Аккаунт автора. Пусто — операция без пользователя.',
        readOnly: true,
      },
      hooks: { beforeChange: [stampAuthorUser] },
    },
    {
      name: 'viaApiKey',
      type: 'checkbox',
      access: auditFieldAccess,
      admin: {
        description:
          'Сохранение пришло по API-ключу (ТЗ §9). Признак отдельно от роли: один аккаунт ' +
          'может работать и через админку, и через API.',
        readOnly: true,
      },
      hooks: { beforeChange: [stampViaApiKey] },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Сам глобал                                                         */
/* ------------------------------------------------------------------ */

export const SiteSettings: GlobalConfig = {
  slug: SITE_SETTINGS_SLUG,
  label: 'Настройки сайта',
  access: {
    // Публично: глобал читают шаблоны Astro без аутентификации. Секретов в нём
    // нет — это тексты, размеры и данные организации, то есть то же, что видно
    // на страницах. Служебная группа `audit` закрыта доступом на уровне полей.
    read: () => true,
    // История версий — внутренняя информация о том, кто и что менял.
    readVersions: adminOnlyAccess,
    // Запись — только человек. Правило живёт здесь, поэтому действует одинаково
    // в админке, REST и GraphQL: обойти его внешним клиентом нельзя.
    update: adminOnlyAccess,
  },
  admin: {
    description:
      'Значения, которые решениями человека вынесены из кода в админку: данные организации ' +
      '(Ч-17), лицензия изображений (Ч-10), тексты служебных страниц (Ч-19), рекламные места ' +
      '(Ч-11). Все поля пустые по умолчанию, и пустое поле — это не «ещё не дошли руки», а ' +
      'команда шаблону промолчать: блока разметки нет, страница остаётся noindex, ' +
      'рекламное место не выводится.',
  },
  fields: [organizationGroup, imageLicenseGroup, infoPagesGroup, adSlotsField, auditGroup],
  typescript: {
    // Имя интерфейса задано явно: от него зависит импорт в apps/web, и
    // переименование по умолчанию (из слага) было бы неявной сменой контракта.
    interface: 'SiteSetting',
  },
  versions: {
    drafts: false,
    // Настройки правит человек и правит редко: пятидесяти состояний хватает,
    // чтобы найти, когда служебная страница вышла из индекса, и не хватит,
    // чтобы таблица версий росла без предела.
    max: 50,
  },
};

/* ------------------------------------------------------------------ */
/* Читатели: контракт между сгенерированным типом и правилами         */
/* ------------------------------------------------------------------ */

/**
 * Функции ниже — не удобство, а ПРОВЕРКА ТИПОМ. Предикаты в
 * `site-settings-rules.ts` описаны структурными интерфейсами (их зовёт и
 * `apps/web`, где данные приходят из REST-ответа), и без такой проверки
 * переименованное поле глобала разошлось бы с предикатом молча: предикат просто
 * увидел бы `undefined` и честно сказал «не выводить». Здесь же расхождение
 * ломает `pnpm check`.
 */

export function organizationFacts(settings: SiteSetting): OrganizationFacts {
  return settings.organization ?? {};
}

export function imageLicenseFacts(settings: SiteSetting): ImageLicenseFacts {
  return settings.imageLicense ?? {};
}

export function infoPageFacts(settings: SiteSetting, key: InfoPageKey): InfoPageFacts {
  return settings.infoPages?.[key] ?? {};
}

export function adSlotFacts(settings: SiteSetting): readonly AdSlotFacts[] {
  return settings.adSlots ?? [];
}
