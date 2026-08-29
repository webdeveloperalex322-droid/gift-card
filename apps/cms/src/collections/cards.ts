import type { CollectionConfig, Field } from 'payload';

import {
  cardImageFieldAccess,
  contentDeleteAccess,
  contentReadAccess,
  contentWriteAccess,
  systemFieldAccess,
} from '../access/policies';
import { cardImageHooks } from '../images/card-image-hooks';
import { imageVariantFields } from '../images/image-mirror';
import { CARD_PATH_PREFIX, contentDocumentPath } from '../seo/paths';
import { collectFieldNames, contentHooks } from './content-hooks';
import {
  canonicalField,
  headingField,
  metaConflictField,
  metaDescriptionField,
  metaDuplicateKeyFields,
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
 *   - отдельные поля-атрибуты `occasion`, `recipient`, `style`, `mood` (ТЗ §8.1).
 *     Повод и адресат выражены связью `collections`: узел подборки уже несёт
 *     вид (`nodeKind`), поэтому «повод» карточки — это привязка к узлу вида
 *     `occasion`, а «адресат» — к узлу вида `recipient`. Вторая пара полей о том
 *     же означала бы два расходящихся источника одного факта. Стиль и
 *     настроение подборками не создаются вовсе (решение Ч-04-3: неиндексируемый
 *     фильтр без собственных URL), а перечислять их значения здесь нельзя —
 *     списка стилей человек не утверждал (см. отчёт Э1-05);
 *   - собственных полей о файлах здесь нет: всё, что относится к изображению, —
 *     ЗЕРКАЛО связанной записи `card-images`, которое заполняет хук
 *     (`derivative.*` вместе с `derivative.variants[]`, и `pHash`). Зеркало, а не
 *     чтение связи, потому что `card-images` анонимно не читается, а публичный
 *     рендер читает как аноним и на `depth: 0` — связь пришла бы
 *     идентификатором, и собрать `srcset` было бы нечем (задача Э3-03a). Второй
 *     довод: карточка — опубликованная сущность, поэтому условие C1 («ключ
 *     зафиксирован») и поиск дублей ПО СТАТУСУ формулируются про неё.
 *
 * Хуки статусной модели (Э1-08), неизменяемости URL с атомарным 301 (Э1-09) и
 * записи в `seo-history` (Э1-07) приходят из общей фабрики `contentHooks`: те же
 * правила обязаны действовать и для подборок, а две копии правил индексации
 * расходятся не ошибкой сборки, а страницей в индексе.
 *
 * Хуки изображения (Э2-05, Э2-06) приходят из `cardImageHooks`: зеркало полей
 * пути, право заменить изображение публиковавшейся карточки и блокировка
 * перевода в review при визуальном дубле. Сам пайплайн (производные, pHash,
 * запись в хранилище) живёт в коллекции `card-images` — там, где появляются
 * байты файла.
 *
 * Хуков, которых здесь по-прежнему нет: проверка дублей метатегов (Э5-01),
 * перегенерация sitemap (Э4-05).
 */

/**
 * Поля объявлены отдельной константой, потому что их имена нужны хукам: по
 * набору полей коллекции определяется, какие требования полноты применимы
 * СЕЙЧАС. С появлением поля `image` (Э2-04) требование «изображение заполнено»
 * включилось само — механизм остаётся для будущих полей ТЗ §8.1, которых в схеме
 * ещё нет.
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
  // forbidYear: адрес карточки один навсегда, а повод повторяется каждый год
  // (условие C3). Поле даёт быстрый отказ в форме админки; авторитетная проверка
  // стоит в хуке (`contentHooks`, опция `forbidYearInSlug`) — валидацию поля
  // Payload умеет пропускать при сохранении черновиков версий, хук — нет.
  slugField({ forbidYear: true, prefix: CARD_PATH_PREFIX }),
  {
    name: 'image',
    type: 'upload',
    relationTo: 'card-images',
    index: true,
    access: {
      create: cardImageFieldAccess,
      update: cardImageFieldAccess,
    },
    admin: {
      description:
        'Изображение открытки (ТЗ §8.1). Обязательно до перевода в review. После первой ' +
        'публикации сменить изображение может только admin: адреса всех производных при ' +
        'этом меняются (ТЗ §6.7), а URL файла постоянен (ТЗ §6.3). URL самой карточки не ' +
        'меняется никогда.',
    },
  },
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
  metaDescriptionField('Задаётся отдельно от видимого описания (ТЗ §8.1).'),
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
  ...metaDuplicateKeyFields(),
  metaConflictField(),
  {
    name: 'visualDuplicate',
    type: 'group',
    label: 'Проверка визуальных дублей',
    admin: {
      description:
        'Похожие открытки среди published и review (ТЗ §6.7 п. 4). Пока набор непуст, ' +
        'перевод в review заблокирован: решение принимает редактор, а порог похожести ' +
        'только подсказывает.',
    },
    fields: [
      {
        name: 'similar',
        type: 'array',
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: {
          description:
            'Заполняется хуком при каждом сохранении: что нашлось по перцептивному хешу и ' +
            'на каком расстоянии Хэмминга. Снаружи не пишется.',
          readOnly: true,
        },
        fields: [
          { name: 'card', type: 'relationship', relationTo: 'cards' },
          { name: 'distance', type: 'number' },
        ],
      },
      {
        name: 'decision',
        type: 'select',
        options: [
          { label: 'Уникально — совпадение ложное', value: 'unique' },
          { label: 'Это дубль', value: 'duplicate' },
        ],
        admin: {
          description:
            'Решение редактора о найденном наборе похожих. Только «уникально» открывает ' +
            'перевод в review; «это дубль» его закрывает — изображение нужно заменить.',
        },
      },
      {
        name: 'confirm',
        type: 'checkbox',
        defaultValue: false,
        admin: {
          description:
            'ОДНОРАЗОВОЕ подтверждение: отметьте его вместе с решением. Хук сбрасывает флаг ' +
            'после сохранения — иначе решение, принятое для прежней картинки, молча ' +
            'подтверждало бы и новую.',
        },
      },
      {
        name: 'decisionFor',
        type: 'text',
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: {
          description:
            'Отпечаток набора похожих, для которого выдано решение (хеш изображения плюс ' +
            'список найденных). Не совпал с текущим — решение устарело, и переход снова ' +
            'заблокирован.',
          readOnly: true,
        },
      },
      {
        name: 'decidedAt',
        type: 'date',
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: { description: 'Когда решение подтверждено.', readOnly: true },
      },
      {
        name: 'scanned',
        type: 'number',
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: {
          description:
            'Сколько записей просмотрено при последнем поиске похожих. Полнота проверки — ' +
            'часть её результата: без этого числа «похожих не найдено» невозможно отличить ' +
            'от «искали не везде».',
          readOnly: true,
        },
      },
      {
        name: 'scanTruncated',
        type: 'checkbox',
        defaultValue: false,
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: {
          description:
            'Обход каталога оборвался по пределу — проверка НЕПОЛНАЯ, и пустой список ' +
            'похожих ничего не гарантирует. Отметка ставится хуком и попадает в журнал ' +
            '(находка ревизии от 2026-08-22: прежний предел 500 записей обрезал круг ' +
            'поиска молча).',
          readOnly: true,
        },
      },
    ],
  },
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
        'Зеркало связанной записи card-images: служебные поля постоянства URL файлов и ' +
        'сами производные (variants). Заполняются пайплайном изображений (Э2-05, Э2-06) и ' +
        'хуком карточки (Э3-03a), снаружи не пишутся ни через админку, ни через API.',
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
        // 2, а не 1: у первого имени суффикса нет вовсе (иначе у одного файла
        // было бы два законных пути — «имя» и «имя-1»). Источник значения —
        // `card-images.nameSuffix` (min: 2) и `normalizeUniqueSuffix` в
        // `@otkritka/images`, который отклоняет всё меньше 2. Зеркало обязано
        // повторять источник: расхождение границы в зеркале означало бы, что
        // недопустимое значение проходит проверку на одной из двух сторон
        // (находка ревизии от 2026-08-22).
        min: 2,
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
      {
        name: 'variants',
        type: 'array',
        label: 'Производные файлы (зеркало)',
        access: {
          create: systemFieldAccess,
          update: systemFieldAccess,
        },
        admin: {
          description:
            'ЗЕРКАЛО card-images.variants[]: ключ, формат и ФАКТИЧЕСКИЕ размеры каждого ' +
            'файла. Из этого поля публичный рендер собирает src, srcset (дескриптор w), ' +
            'width и height — из одного значения (условие C8). Зеркало нужно потому, что ' +
            'коллекция card-images анонимно не читается, а публичный рендер читает как ' +
            'аноним и на depth 0: связь пришла бы идентификатором. Заполняется хуком при ' +
            'каждом сохранении карточки и пересинхронизируется при замене байтов ' +
            'изображения; снаружи не пишется никем — ни admin, ни ai-editor, ни через ' +
            'REST/GraphQL.',
          readOnly: true,
        },
        // Формы полей общие с источником (`card-images.variants`): разъехаться им
        // нельзя. `byteSize` в зеркало не переносится — разметка его не читает.
        fields: imageVariantFields({ includeByteSize: false }),
      },
    ],
  },
];

/**
 * Общие хуки контента плюс хуки изображения.
 *
 * Порядок внутри фазы значим: правила статусной модели (`contentHooks`) идут
 * ПЕРВЫМИ — они проверяют право на переход и полноту записи, и отказ по правам
 * должен звучать раньше отказа «есть похожее изображение». Зеркало служебных
 * полей пути тоже ставится после них: писать его в запись, которая всё равно
 * будет отклонена, незачем.
 */
function cardHooks(): NonNullable<CollectionConfig['hooks']> {
  const base = contentHooks({
    collectionSlug: 'cards',
    // Условие C3: год не попадает в адрес карточки. У подборок то же правило
    // применяется по виду узла в `collection-path.ts`.
    forbidYearInSlug: true,
    knownFields: collectFieldNames(cardFields),
    // Канонический URL карточки — /otkrytki/<slug>, один навсегда: путь не
    // хранится, потому что выводится из slug однозначно и другого источника у
    // него нет. Само выведение живёт в `../seo/paths` — проверка дублей
    // метатегов (Э5-01) называет редактору адрес ЧУЖОЙ страницы, и второй копии
    // этого правила быть не должно.
    pathOf: (doc) => contentDocumentPath('cards', doc),
    reviewRequirements: CARD_REVIEW_REQUIREMENTS,
  });
  const image = cardImageHooks();

  return {
    ...base,
    beforeChange: [...base.beforeChange, ...image.beforeChange],
    beforeOperation: [...base.beforeOperation, ...image.beforeOperation],
    beforeValidate: [...base.beforeValidate, ...image.beforeValidate],
  };
}

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
  hooks: cardHooks(),
  fields: cardFields,
};
