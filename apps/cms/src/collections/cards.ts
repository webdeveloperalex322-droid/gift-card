import type { CollectionConfig, Field } from 'payload';

import {
  contentDeleteAccess,
  contentReadAccess,
  contentWriteAccess,
  systemFieldAccess,
} from '../access/policies';
import { CARD_PATH_PREFIX, buildCardPath } from '../seo/paths';
import { collectFieldNames, contentHooks } from './content-hooks';
import {
  canonicalField,
  headingField,
  publishedAtField,
  robotsField,
  slugField,
  statusField,
  updatedContentAtField,
  urlChangeField,
  withdrawalField,
} from './seo-fields';
import { CARD_REVIEW_REQUIREMENTS } from './status-model';

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
 *   - отдельные поля-атрибуты `occasion`, `recipient`, `style`, `mood` (ТЗ §8.1).
 *     Повод и адресат выражены связью `collections`: узел подборки уже несёт
 *     вид (`nodeKind`), поэтому «повод» карточки — это привязка к узлу вида
 *     `occasion`, а «адресат» — к узлу вида `recipient`. Вторая пара полей о том
 *     же означала бы два расходящихся источника одного факта. Стиль и
 *     настроение подборками не создаются вовсе (решение Ч-04-3: неиндексируемый
 *     фильтр без собственных URL), а перечислять их значения здесь нельзя —
 *     списка стилей человек не утверждал (см. отчёт Э1-05);
 *   - `формы/размеры` — производные пайплайна изображений (Э2-05), в записи
 *     появляются вместе с вариантами.
 *
 * Хуки статусной модели (Э1-08), неизменяемости URL с атомарным 301 (Э1-09) и
 * записи в `seo-history` (Э1-07) приходят из общей фабрики `contentHooks`: те же
 * правила обязаны действовать и для подборок, а две копии правил индексации
 * расходятся не ошибкой сборки, а страницей в индексе.
 *
 * Хуков, которых здесь по-прежнему нет: pHash и производные (Э2-05, Э2-06),
 * проверка дублей метатегов (Э5-01), перегенерация sitemap (Э4-05).
 */

/**
 * Поля объявлены отдельной константой, потому что их имена нужны хукам: по
 * набору полей коллекции определяется, какие требования полноты применимы
 * СЕЙЧАС. Требование к полю `image`, которого до Э2-04 в схеме нет, иначе
 * заблокировало бы перевод любой карточки в review.
 */
const cardFields: Field[] = [
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
  headingField(),
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
  {
    name: 'collections',
    type: 'relationship',
    relationTo: 'collections',
    hasMany: true,
    index: true,
    admin: {
      description:
        'Подборки, в которые входит открытка (m:n, ТЗ §8.1). ПЕРВАЯ — основная: ' +
        'из неё строятся хлебные крошки. Открытка входит в несколько подборок БЕЗ ' +
        'дублирования URL: канонический адрес карточки остаётся один навсегда — ' +
        '/otkrytki/<slug>, копии карточки внутри подборок не создаются.',
    },
  },
  statusField(),
  robotsField(),
  canonicalField(),
  publishedAtField(),
  updatedContentAtField(),
  withdrawalField(),
  urlChangeField(),
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
];

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
  hooks: contentHooks({
    collectionSlug: 'cards',
    knownFields: collectFieldNames(cardFields),
    // Канонический URL карточки — /otkrytki/<slug>, один навсегда: путь не
    // хранится, потому что выводится из slug однозначно и другого источника у
    // него нет.
    pathOf: (doc) => (typeof doc.slug === 'string' && doc.slug !== '' ? buildCardPath(doc.slug) : null),
    reviewRequirements: CARD_REVIEW_REQUIREMENTS,
  }),
  fields: cardFields,
};
