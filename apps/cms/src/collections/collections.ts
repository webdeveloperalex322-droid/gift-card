import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
  Field,
  FieldHook,
  FilterOptionsProps,
  TypeWithID,
  Where,
} from 'payload';
import { APIError } from 'payload';

import {
  contentDeleteAccess,
  contentReadAccess,
  contentWriteAccess,
  systemFieldAccess,
  urlShapeFieldAccess,
} from '../access/policies';
import { ROLES, type RoledUser } from '../access/roles';
import type { Collection } from '../payload-types';
import { COLLECTION_PATH_PREFIX } from '../seo/paths';
import {
  ALLOWED_PARENT_KINDS,
  COLLECTION_NODE_KINDS,
  COLLECTION_NODE_KIND_LABELS,
  CollectionNodeError,
  type CollectionNodeKind,
  type CollectionNodeParent,
  isCollectionNodeKind,
  planCollectionNode,
} from './collection-path';
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
import { COLLECTION_REVIEW_REQUIREMENTS } from './status-model';
import { DEFAULT_READINESS_LEAD_DAYS, readinessDeadline } from './seasonal';

/**
 * Подборки и посадочные (задача Э1-05, ТЗ §8.1 и §5.3).
 *
 * Форма путей задана решением человека от 2026-08-22 (Ч-04-9):
 *
 *   /podborki                        каталог подборок
 *   /podborki/prazdniki              группирующий узел
 *   /podborki/prazdniki/8-marta      праздничная посадочная
 *   /podborki/prazdniki/8-marta/mame пара «праздник × адресат»
 *   /podborki/adresaty/mame          адресат без праздника
 *
 * Три решения этой коллекции стоят дороже остальных и объясняются здесь, а не в
 * коммите:
 *
 *   1. **Итоговый путь ХРАНИТСЯ в поле `path` с уникальным индексом БД.**
 *      Значение вычисляемое, и соблазн считать его на чтении велик, но
 *      уникальность обязана держаться на индексе: проверка «нет ли такого пути»
 *      запросом перед записью проходит у ДВУХ одновременных сохранений через
 *      API, и в базе оказываются две подборки с одним URL. Индекс — единственное
 *      место, где гонка проигрывает. Хранение даёт и второе: путь родителя
 *      авторитетен, поэтому цепочку родителей не надо обходить целиком на каждом
 *      сохранении.
 *   2. **Порядок сегментов — правило, а не соглашение** (решение Ч-04-7).
 *      Матрица `ALLOWED_PARENT_KINDS` в `collection-path.ts` не содержит
 *      сочетания «повод под уточнением», поэтому `/podborki/adresaty/mame/8-marta`
 *      не собирается ни в админке, ни через REST, ни через GraphQL.
 *   3. **Стили и настроения подборками не создаются** (решение Ч-04-3): в
 *      закрытом наборе видов узла для них нет вида, а URL появляется только у
 *      узла этой коллекции. То есть «стиль» не может получить путь даже по
 *      ошибке редактора; в модели он остаётся признаком карточки и фильтром без
 *      собственного URL.
 *
 * Хуки статусной модели с `publishedAt` (Э1-08), записи в `seo-history` (Э1-07) и
 * неизменяемости URL с атомарным 301 (Э1-09) приходят из общей фабрики
 * `contentHooks`: правила индексации у подборок и карточек обязаны быть одними и
 * теми же. Специфика подборок — в том, что переезд узла меняет URL всего
 * поддерева, поэтому 301 создаётся на КАЖДЫЙ переехавший путь: потомков
 * пересобирает `syncDescendantPaths` штатным обновлением, а значит у каждого
 * срабатывают те же хуки.
 *
 * Чего здесь сознательно НЕТ: порог перекрытия выдачи 80 % (Ч-04-6, этап 5),
 * дашборд сезонных дедлайнов (Э5-07).
 */

/** Возвращает id связи, как её отдаёт Payload: число, строка или сам документ. */
function readRelationId(value: unknown): number | string | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const { id } = value;
    if (typeof id === 'number' || typeof id === 'string') {
      return id;
    }
  }
  return null;
}

function isFilled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Собирает итоговый путь узла и кладёт его в `path`.
 *
 * Выполняется в `beforeChange` КОЛЛЕКЦИИ, то есть до валидации полей и до
 * записи, и одинаково для админки, REST и GraphQL — другого пути записи не
 * существует. Отказ поднимается как `APIError` с кодом 400: причина
 * содержательная, и редактор с внешним AI-редактором обязаны увидеть один и тот
 * же текст.
 *
 * Незаданные во входных данных поля берутся из `originalDoc`: частичное
 * обновление (`PATCH` с одним полем) не должно пересобирать путь из пустоты.
 */
const assignCollectionPath: CollectionBeforeChangeHook<Collection> = async ({
  data,
  originalDoc,
  req,
}) => {
  const slug = 'slug' in data ? data.slug : originalDoc?.slug;
  const nodeKind = 'nodeKind' in data ? data.nodeKind : originalDoc?.nodeKind;
  const parentValue = 'parent' in data ? data.parent : originalDoc?.parent;
  const parentId = readRelationId(parentValue);

  let parent: CollectionNodeParent | null = null;

  if (parentId !== null) {
    const parentDoc = await req.payload.findByID({
      collection: 'collections',
      id: parentId,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    });

    if (parentDoc === null) {
      throw new APIError(
        `Родительская подборка с id ${String(parentId)} не найдена, поэтому путь ` +
          'записи собрать нельзя.',
        400,
        { rule: 'missing-parent' },
        true,
      );
    }

    parent = { id: parentDoc.id, nodeKind: parentDoc.nodeKind, path: parentDoc.path };
  }

  try {
    const plan = planCollectionNode({
      candidate: {
        id: originalDoc?.id ?? null,
        currentPath: originalDoc?.path ?? null,
        nodeKind,
        parent,
        slug,
      },
    });

    return { ...data, path: plan.path };
  } catch (error) {
    if (error instanceof CollectionNodeError) {
      // 400, а не 500: отказ содержательный и одинаково выглядит в админке, в
      // REST и в GraphQL.
      throw new APIError(error.message, 400, { rule: error.rule }, true);
    }
    throw error;
  }
};

/**
 * Пересобирает пути дочерних узлов, когда путь родителя изменился.
 *
 * Зачем вообще: `path` — вычисляемое значение, которое ХРАНИТСЯ. Значит, оно
 * может разойтись с моделью, и разойтись молча: переименовали группирующий узел
 * — у праздничной посадочной под ним в базе остался прежний URL. Устаревший
 * сохранённый путь хуже отсутствующего: по нему строятся canonical и sitemap.
 *
 * Почему через `payload.update`, а не прямой записью в базу: дочерний узел
 * обязан пройти те же правила (реестр маршрутов, уникальность пути), а его
 * собственный `afterChange` продолжит спуск на следующий уровень. Рекурсия
 * конечна — матрица видов ограничивает глубину тремя уровнями, а цикл
 * отклоняется планировщиком. Операция идёт в ТОЙ ЖЕ транзакции, что и правка
 * родителя: либо переехало всё поддерево, либо ничего — промежуточное состояние
 * с половиной ветки на старых URL краулер успел бы увидеть.
 *
 * Границы: одиночный 301 на переехавший URL здесь НЕ создаётся — это задача
 * Э1-09 (атомарная смена URL), и там же появится запрет менять путь после первой
 * публикации. До неё переносить можно только неопубликованные узлы, у которых
 * публичного URL не было.
 */
const syncDescendantPaths: CollectionAfterChangeHook<Collection> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || doc.path === previousDoc?.path) {
    return doc;
  }

  const children = await req.payload.find({
    collection: 'collections',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: { parent: { equals: doc.id } },
  });

  for (const child of children.docs) {
    // Данные не передаются намеренно: путь ребёнка пересчитает его собственный
    // `beforeChange` из уже обновлённого пути родителя — так правило склейки
    // остаётся в одном месте.
    await req.payload.update({
      collection: 'collections',
      id: child.id,
      data: {},
      overrideAccess: true,
      req,
    });
  }

  return doc;
};

/**
 * Не даёт удалить узел, у которого есть дочерние.
 *
 * Причина та же, по которой пути пересобираются при переносе: `path` хранится.
 * Удаление родителя оставило бы потомков с путями, ссылающимися на исчезнувший
 * узел (`/podborki/prazdniki/8-marta` без `prazdniki`), — то есть с URL, которых
 * в иерархии больше нет. Такие записи попали бы в sitemap и canonical, а
 * заметить их можно было бы только по 404 в поиске.
 *
 * Отказ, а не каскадное удаление: удаление опубликованной страницы требует
 * решения «301 или 404» (ТЗ §8.2), и принимать его за человека молча, да ещё
 * пачкой на всё поддерево, нельзя.
 */
const rejectDeleteWithChildren: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const children = await req.payload.count({
    collection: 'collections',
    overrideAccess: true,
    req,
    where: { parent: { equals: id } },
  });

  if (children.totalDocs > 0) {
    throw new APIError(
      `У подборки есть вложенные (${String(children.totalDocs)}). Удаление оставило бы ` +
        'их с путями, ведущими в несуществующий узел: сохранённый путь потомка ' +
        'собран из пути этого родителя. Сначала перенесите или удалите вложенные — ' +
        'для каждого опубликованного URL при этом решается, 301 это или 404.',
      400,
      { rule: 'has-children' },
      true,
    );
  }
};

/**
 * Ответственный редактор по умолчанию (решение Ч-16: «по умолчанию — `admin`,
 * поле редактируемое»).
 *
 * Чистая функция, потому что правило содержательное: если запись создал
 * сервисный аккаунт `ai-editor`, ответственным всё равно становится ЧЕЛОВЕК —
 * иначе у подборки, доведённой агентом до `review`, не было бы адресата
 * проверки, а именно человек принимает решение о публикации.
 *
 * @param user кто выполняет операцию (может быть `null` для серверных вызовов)
 * @param admins администраторы, старейший первым
 */
export function pickDefaultResponsibleEditor(
  user: (RoledUser & { readonly id?: number | string }) | null | undefined,
  admins: readonly { readonly id: number | string }[],
): number | string | null {
  if (user?.role === ROLES.admin && user.id !== undefined) {
    return user.id;
  }
  return admins[0]?.id ?? null;
}

const fillResponsibleEditor: FieldHook<
  TypeWithID,
  number | string | null | undefined,
  unknown
> = async ({ req, value }) => {
  if (isFilled(value)) {
    return value;
  }

  const admins = await req.payload.find({
    collection: 'users',
    depth: 0,
    // Ровно один: нужен старейший администратор, а не список. `pagination: false`
    // здесь был бы ошибкой — он отменяет limit и тянет всех.
    limit: 1,
    overrideAccess: true,
    req,
    sort: 'createdAt',
    where: { role: { equals: ROLES.admin } },
  });

  return pickDefaultResponsibleEditor(req.user, admins.docs);
};

interface SeasonalSiblingData {
  readonly holidayDate?: string | Date | null;
}

/**
 * Ставит дату готовности за {@link DEFAULT_READINESS_LEAD_DAYS} дней до
 * праздника, если редактор её не задал (решение Ч-12).
 *
 * Заполняется только ПУСТОЕ значение: своя дата редактора важнее дефолта, иначе
 * поле нельзя было бы сдвинуть под реальный график наполнения.
 */
const fillReadinessDeadline: FieldHook<
  TypeWithID,
  string | Date | null | undefined,
  SeasonalSiblingData
> = ({ siblingData, value }) => {
  if (isFilled(value)) {
    return value;
  }

  const holiday = siblingData?.holidayDate;
  if (!(typeof holiday === 'string' || holiday instanceof Date) || !isFilled(holiday)) {
    return value;
  }

  try {
    return readinessDeadline(holiday);
  } catch {
    // Нераспознанную дату праздника разбирает валидация самого поля: подставлять
    // сюда «сегодня» нельзя — сорванный дедлайн выглядел бы соблюдённым.
    return value;
  }
};

/**
 * Ограничение выбора родителя в АДМИНКЕ: показываются только узлы того вида,
 * который допускает матрица.
 *
 * Это удобство интерфейса, а не защита: правило живёт в `beforeChange`, потому
 * что внешний AI-редактор через REST и GraphQL никаких `filterOptions` не
 * спрашивает. Когда вид узла во входных данных не задан (частичное обновление),
 * ограничение не накладывается — иначе валидация связи отклонила бы `PATCH`,
 * в котором вида просто нет.
 */
function parentFilterOptions({
  data,
  id,
  siblingData,
}: FilterOptionsProps<Collection>): Where | boolean {
  const nodeKind = readNodeKind(siblingData) ?? readNodeKind(data);
  if (nodeKind === null) {
    return true;
  }

  const allowed = ALLOWED_PARENT_KINDS[nodeKind].filter(
    (kind): kind is CollectionNodeKind => kind !== null,
  );

  if (allowed.length === 0) {
    return false;
  }

  const conditions: Where[] = [{ nodeKind: { in: [...allowed] } }];
  if (id !== undefined && id !== null) {
    conditions.push({ id: { not_equals: id } });
  }

  return { and: conditions };
}

function readNodeKind(source: unknown): CollectionNodeKind | null {
  if (typeof source !== 'object' || source === null || !('nodeKind' in source)) {
    return null;
  }
  const { nodeKind } = source;
  return isCollectionNodeKind(nodeKind) ? nodeKind : null;
}

/** Смежные подборки: любая, кроме самой записи. */
function relatedFilterOptions({ id }: FilterOptionsProps<Collection>): Where | boolean {
  if (id === undefined || id === null) {
    return true;
  }
  return { id: { not_equals: id } };
}

/**
 * Поля объявлены отдельной константой, потому что их имена нужны хукам: по
 * набору полей коллекции определяется, какие требования полноты применимы
 * сейчас (см. `content-hooks.ts`).
 */
const collectionFields: Field[] = [
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
  slugField({
    prefix: COLLECTION_PATH_PREFIX,
    // Уникален не сегмент, а итоговый путь: slug «mame» законно существует и
    // под праздником, и в ветке адресатов. Индекс стоит на поле `path`.
    unique: false,
    // Валидатор поля проверяет форму сегмента и путь ВЕРХНЕГО уровня
    // (`/podborki/<slug>`) — это подсказка в форме, а решает всё равно хук,
    // который знает родителя. Известное следствие: если PAYLOAD_ADMIN_PATH
    // настроен ВНУТРЬ /podborki, валидатор отклонит совпадающий slug и на
    // вложенном узле, где путь фактически свободен. Отказ в пользу
    // осторожности выбран сознательно: путь админки занимать нельзя, а
    // конфигурация эта пограничная.
    description:
      'Один сегмент URL. Итоговый путь собирается из пути родителя и этого ' +
      'сегмента, например /podborki/prazdniki/8-marta/mame. Slug праздника с ' +
      'фиксированной датой — <число>-<месяц> (8-marta, 9-maya); без фиксированной ' +
      'даты — короткое название (paskha, novyy-god), решение Ч-04-4. Год в URL ' +
      'ежегодного праздника не добавляется. Неизменяем после первой публикации ' +
      '(смена — только вместе с одиночным 301, задача Э1-09).',
  }),
  {
    name: 'path',
    type: 'text',
    unique: true,
    index: true,
    access: {
      create: systemFieldAccess,
      update: systemFieldAccess,
    },
    admin: {
      description:
        'ИТОГОВЫЙ путь подборки. Считается хуком из цепочки родителей и хранится ' +
        'с уникальным индексом БД: уникальность URL не может держаться на проверке ' +
        'запросом перед записью — два одновременных сохранения через API прошли бы ' +
        'её оба. Снаружи не пишется ни через админку, ни через API.',
      position: 'sidebar',
      readOnly: true,
    },
  },
  {
    name: 'nodeKind',
    type: 'select',
    required: true,
    index: true,
    options: COLLECTION_NODE_KINDS.map((kind) => ({
      label: COLLECTION_NODE_KIND_LABELS[kind],
      value: kind,
    })),
    access: {
      create: urlShapeFieldAccess,
      update: urlShapeFieldAccess,
    },
    admin: {
      description:
        'Определяет, куда узел можно вложить: группа — только в корень /podborki, ' +
        'повод — под группу, уточнение — под группу или под повод. Порядок только ' +
        '«повод → уточнение» (решение Ч-04-7): праздник под адресатом не создаётся ' +
        'никогда. Вида под стиль и настроение нет намеренно — по решению Ч-04-3 это ' +
        'фильтр без собственных URL.',
      position: 'sidebar',
    },
  },
  {
    name: 'parent',
    type: 'relationship',
    relationTo: 'collections',
    index: true,
    filterOptions: parentFilterOptions,
    access: {
      create: urlShapeFieldAccess,
      update: urlShapeFieldAccess,
    },
    admin: {
      description:
        'Родительский узел. Пусто — узел верхнего уровня (прямо под /podborki). ' +
        'Смена родителя меняет URL этой подборки и всех вложенных, поэтому после ' +
        'первой публикации она возможна только вместе с одиночным 301 (задача Э1-09).',
      position: 'sidebar',
    },
  },
  {
    name: 'intro',
    type: 'richText',
    admin: {
      description:
        'Вводный текст страницы (ТЗ §8.1). Должен быть уникальным и осмысленным: ' +
        'шаблонный текст с заменой пары слов — прямой запрет п. 23 SEO ТЗ, а ' +
        'уникальность вводного текста входит в условия открытия страницы в ' +
        'index,follow (п. 5.1).',
    },
  },
  {
    name: 'metaDescription',
    type: 'textarea',
    admin: {
      description:
        'Meta description. Совпадения по каталогу проверяются при сохранении ' +
        '(задача Э5-01).',
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
    name: 'responsibleEditor',
    type: 'relationship',
    relationTo: 'users',
    hooks: {
      beforeChange: [fillResponsibleEditor],
    },
    admin: {
      description:
        'Ответственный редактор подборки. По умолчанию — администратор (решение ' +
        'Ч-16): даже если запись создал сервисный аккаунт ai-editor, ответственным ' +
        'остаётся человек, потому что решение о публикации принимает он.',
      position: 'sidebar',
    },
  },
  {
    name: 'related',
    type: 'relationship',
    relationTo: 'collections',
    hasMany: true,
    filterOptions: relatedFilterOptions,
    admin: {
      description:
        'Смежные подборки (m:n, ТЗ §8.1). Из них строится перелинковка: она же ' +
        'закрывает требование «нет страниц-сирот» — каждая индексируемая страница ' +
        'достижима за ≤ 4 перехода от главной.',
    },
  },
  {
    name: 'seasonal',
    type: 'group',
    label: 'Сезонность',
    admin: {
      description:
        'Календарь праздников — официальный календарь РФ, даты вводятся здесь ' +
        `(решение Ч-12). Дата готовности по умолчанию — за ${String(DEFAULT_READINESS_LEAD_DAYS)} ` +
        'дней до праздника; окно ТЗ §8.6 — 4–8 недель.',
    },
    fields: [
      {
        name: 'holidayDate',
        type: 'date',
        admin: {
          date: { pickerAppearance: 'dayOnly' },
          description:
            'Дата праздника по официальному календарю РФ. Списка праздников в коде ' +
            'нет намеренно: он разошёлся бы с календарём при первом переносе ' +
            'выходных, а обновлять его пришлось бы деплоем.',
        },
      },
      {
        name: 'readyBy',
        type: 'date',
        hooks: {
          beforeChange: [fillReadinessDeadline],
        },
        admin: {
          date: { pickerAppearance: 'dayOnly' },
          description:
            `Дата готовности. Пусто — ставится автоматически за ${String(DEFAULT_READINESS_LEAD_DAYS)} ` +
            'дней до праздника (Ч-12); заданное значение не перезаписывается.',
        },
      },
      {
        name: 'showFrom',
        type: 'date',
        admin: {
          date: { pickerAppearance: 'dayOnly' },
          description:
            'С какого дня подборка показывается в сезонном блоке главной (ТЗ §8.1). ' +
            'Даты показа переключают БЛОК на главной и не создают отдельных URL.',
        },
      },
      {
        name: 'showUntil',
        type: 'date',
        admin: {
          date: { pickerAppearance: 'dayOnly' },
          description: 'По какой день подборка показывается в сезонном блоке главной.',
        },
      },
    ],
  },
];

/**
 * Общие хуки контента (Э1-07, Э1-08, Э1-09).
 *
 * `pathOf` берёт СОХРАНЁННЫЙ `path`, а не пересобирает его: путь узла
 * авторитетен именно в записи, и второй способ его вычислить означал бы, что
 * редирект при переносе может быть построен не от того адреса, который был в
 * sitemap.
 */
const collectionContentHooks = contentHooks({
  collectionSlug: 'collections',
  knownFields: collectFieldNames(collectionFields),
  pathOf: (doc) => (typeof doc.path === 'string' && doc.path !== '' ? doc.path : null),
  reviewRequirements: COLLECTION_REVIEW_REQUIREMENTS,
});

export const Collections: CollectionConfig = {
  slug: 'collections',
  labels: {
    singular: 'Подборка',
    plural: 'Подборки',
  },
  admin: {
    defaultColumns: ['title', 'path', 'nodeKind', 'status', 'robots', 'updatedContentAt'],
    description:
      'Подборки и посадочные. URL собирается из цепочки родителей: /podborki/<группа>/' +
      '<повод>/<уточнение>. Порядок только «повод → уточнение». Новая запись — draft с ' +
      'noindex; публикует и открывает в индекс только человек.',
    useAsTitle: 'title',
  },
  access: {
    create: contentWriteAccess,
    delete: contentDeleteAccess,
    read: contentReadAccess,
    update: contentWriteAccess,
  },
  hooks: {
    // Порядок значим. `syncDescendantPaths` идёт ПЕРВЫМ: он пересобирает пути
    // потомков штатным `payload.update`, поэтому у каждого потомка выполняется
    // его собственный набор этих же хуков — и переехавший путь потомка получает
    // свой одиночный 301 и свою запись в истории. Хуки общей фабрики идут после,
    // когда поддерево уже переехало.
    afterChange: [syncDescendantPaths, ...collectionContentHooks.afterChange],
    beforeChange: [assignCollectionPath, ...collectionContentHooks.beforeChange],
    beforeDelete: [rejectDeleteWithChildren],
    beforeOperation: [...collectionContentHooks.beforeOperation],
    beforeValidate: [...collectionContentHooks.beforeValidate],
  },
  fields: collectionFields,
};
