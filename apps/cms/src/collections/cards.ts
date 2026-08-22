import type { CollectionConfig, FieldHook, TypeWithID } from 'payload';

import {
  contentDeleteAccess,
  contentReadAccess,
  contentWriteAccess,
  systemFieldAccess,
} from '../access/policies';
import { CARD_PATH_PREFIX } from '../seo/paths';
import {
  canonicalField,
  publishedAtField,
  robotsField,
  slugField,
  statusField,
  updatedContentAtField,
} from './seo-fields';

/**
 * Карточка открытки (задача Э1-04, ТЗ §8.1).
 *
 * Канонический URL карточки — `/otkrytki/<slug>`, один навсегда (ТЗ §5.4).
 * Пространства имён карточек и подборок разведены решением человека от
 * 2026-08-22: подборки живут под `/podborki`, поэтому коллизия «карточка против
 * подборки» здесь структурно невозможна, и проверять её не нужно — нужна только
 * уникальность slug внутри `cards` (обеспечена `unique` на поле).
 *
 * Чего в коллекции НЕТ и почему (это не забытые поля, а адресованные пробелы):
 *
 *   - `image` (upload, ТЗ §8.1) — поле типа `upload` требует коллекции с
 *     `upload: true`, а её конфигурация — это выбор хранилища (Ч-03: S3 отложен,
 *     локальная ФС за адаптером) и задача Э2-04. Заводить коллекцию файлов
 *     заранее означало бы решить за Э2-04, где лежат оригиналы и производные;
 *   - `collections` (relation m:n, «первая — основная» для крошек) и атрибуты
 *     `occasion`, `recipient`, `style`, `mood` — по ТЗ §5.4 каждый атрибут это
 *     ССЫЛКА на соответствующую подборку, то есть связь с коллекцией
 *     `collections`, которой ещё нет (Э1-05). Подменять их перечислением
 *     значений нельзя: значения атрибутов ТЗ не задаёт, и придуманный список
 *     стал бы таксономией, которую человек не утверждал;
 *   - `формы/размеры` — производные пайплайна изображений (Э2-05), в записи
 *     появляются вместе с вариантами.
 *
 * Хуки, которых здесь сознательно нет: статусная модель и `publishedAt` (Э1-08),
 * неизменяемость slug и смена URL с 301 (Э1-09), запись в `seo-history` (Э1-07),
 * pHash и производные (Э2-05, Э2-06). Поля под них заведены и закрыты от записи
 * снаружи, чтобы эти задачи добавляли поведение, а не схему.
 */

/** Читает строковое поле из данных запроса (форма не гарантирована типом). */
function readStringField(source: unknown, name: string): string | undefined {
  if (typeof source !== 'object' || source === null || !(name in source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * ТЗ §8.1: «title, h1 — раздельно; по умолчанию совпадают».
 *
 * Заполняется только пустой H1: иначе редактор не смог бы сделать H1 отличным
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
  return readStringField(data, 'title') ?? value;
};

export const Cards: CollectionConfig = {
  slug: 'cards',
  labels: {
    singular: 'Открытка',
    plural: 'Открытки',
  },
  admin: {
    defaultColumns: ['title', 'slug', 'status', 'robots', 'updatedContentAt'],
    description:
      'Карточка открытки. URL — /otkrytki/<slug>, один навсегда. Новая запись создаётся ' +
      'в draft с noindex; публикует и открывает в индекс только человек.',
    useAsTitle: 'title',
  },
  access: {
    create: contentWriteAccess,
    delete: contentDeleteAccess,
    read: contentReadAccess,
    update: contentWriteAccess,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
      admin: {
        description:
          'Заголовок страницы (title). Уникален в пределах каталога — совпадения ' +
          'проверяются при сохранении (задача Э5-01). Смена заголовка URL не меняет.',
      },
    },
    {
      name: 'h1',
      type: 'text',
      admin: {
        description: 'H1 страницы. Пустой — совпадает с title (ТЗ §8.1).',
      },
      hooks: {
        beforeChange: [fillHeadingFromTitle],
      },
    },
    slugField({ prefix: CARD_PATH_PREFIX }),
    {
      name: 'alt',
      type: 'text',
      admin: {
        description:
          'Естественное описание изображения, не перечень ключей. Обязателен до ' +
          'перевода в review (проверка полноты — задача Э1-08).',
      },
    },
    {
      name: 'caption',
      type: 'textarea',
      admin: { description: 'Подпись или текст поздравления, видимый на странице.' },
    },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Описание открытки для страницы (видимый текст).' },
    },
    {
      name: 'metaDescription',
      type: 'textarea',
      admin: {
        description:
          'Meta description. Задаётся отдельно от описания (ТЗ §8.1); совпадения по ' +
          'каталогу проверяются при сохранении (задача Э5-01).',
      },
    },
    {
      name: 'usageTerms',
      type: 'textarea',
      admin: {
        description:
          'Условия использования изображения. Из этого поля берутся license и ' +
          'copyrightNotice в JSON-LD ImageObject (этап 3): если условия у открытки ' +
          'общие, поле остаётся пустым и подставляются условия проекта.',
      },
    },
    statusField(),
    robotsField(),
    canonicalField(),
    publishedAtField(),
    updatedContentAtField(),
    {
      name: 'pHash',
      type: 'text',
      index: true,
      access: {
        create: systemFieldAccess,
        update: systemFieldAccess,
      },
      admin: {
        description:
          'Перцептивный хеш изображения. Считает @otkritka/images при загрузке ' +
          '(задача Э2-05); снаружи не пишется, иначе поиск визуальных дублей можно ' +
          'было бы обойти подстановкой чужого значения.',
        readOnly: true,
      },
    },
    {
      name: 'derivative',
      type: 'group',
      label: 'Производная изображения (служебное)',
      admin: {
        description:
          'Служебные поля постоянства URL файлов. Заполняются пайплайном изображений ' +
          '(Э2-05, Э2-06) и не пишутся снаружи ни через админку, ни через API.',
      },
      fields: [
        {
          name: 'keyBase',
          type: 'text',
          access: {
            create: systemFieldAccess,
            update: systemFieldAccess,
          },
          admin: {
            description:
              'СОХРАНЁННЫЙ ключ производной (<префикс>/<revision>/<имя>), условие C1. ' +
              'Хранится, а не пересчитывается: сегодня ключ — функция от описания, ' +
              'лимита длины имени и таблицы транслитерации, поэтому правка заголовка ' +
              'или пополнение таблицы дали бы другой путь при том же содержимом. ' +
              'Фиксируется при первой публикации и далее неизменяем.',
            readOnly: true,
          },
        },
        {
          name: 'nameStem',
          type: 'text',
          access: {
            create: systemFieldAccess,
            update: systemFieldAccess,
          },
          admin: {
            description:
              'Имя файла на транслите вместе с суффиксом уникальности, присвоенное ' +
              'при загрузке. Хранится отдельно от ключа, потому что при замене ' +
              'изображения меняется только revision, а имя остаётся тем же.',
            readOnly: true,
          },
        },
        {
          name: 'nameSuffix',
          type: 'number',
          min: 1,
          access: {
            create: systemFieldAccess,
            update: systemFieldAccess,
          },
          admin: {
            description:
              'Число N в суффиксе -N, уникализирующем имя файла (решение человека, ' +
              'блок 5 п. 3). Присваивается ОДИН раз при загрузке и хранится: если ' +
              'вычислять его заново, удаление ранней записи освободило бы N и путь ' +
              'другой записи изменился бы незаметно. После удаления N не ' +
              'переиспользуется.',
            readOnly: true,
          },
        },
        {
          name: 'revision',
          type: 'text',
          access: {
            create: systemFieldAccess,
            update: systemFieldAccess,
          },
          admin: {
            description:
              'Короткий хеш байтов оригинала (решение Ч-28, вариант «а»). Меняется ' +
              'ТОЛЬКО при замене изображения — тогда меняются URL производных при ' +
              'неизменном URL карточки (ТЗ §6.7). Выводить revision из updatedAt или ' +
              'счётчика сохранений запрещено: каждое сохранение переписывало бы URL ' +
              'всех производных (условие C2).',
            readOnly: true,
          },
        },
      ],
    },
  ],
};
