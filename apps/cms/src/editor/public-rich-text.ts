/**
 * Редактор richText для полей, которые печатает публичный шаблон.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ НАБОР ФИЧ. Корневой `lexicalEditor()` в `payload.config.ts`
 * поднимается с `defaultEditorFeatures`, а в нём есть `UploadFeature()` и
 * `RelationshipFeature()` (проверено по
 * `@payloadcms/richtext-lexical/dist/lexical/config/server/default.js`). Узлы
 * этих фич держат содержимое не в `children`, а в `fields`/`value`, и разбор
 * lexical в `apps/web` (`src/seo/rich-text.ts`) их не печатает: он раскрывает
 * неизвестный узел в его детей, а детей у них нет. Итог — редактор вставляет
 * изображение или ссылку-запись, видит её в админке и НЕ видит на
 * опубликованной странице. Ни ошибки, ни следа.
 *
 * Правка сделана в конфигурации, а не в шаблоне, сознательно: неподдерживаемый
 * узел должен быть НЕВЫРАЗИМЫМ, а не деградирующим после публикации. Проверка,
 * живущая в рендере, срабатывает уже после того, как человек сохранил и
 * опубликовал запись; отсутствие кнопки в редакторе — до.
 *
 * ЧТО В НАБОРЕ. Ровно то, что публичный разбор печатает без потерь:
 * выделение (`strong`, `em`, `u`, `s`, `sub`, `sup`, `code`), абзацы,
 * заголовки h2–h4, маркированный и нумерованный списки, цитата, ссылка и
 * плавающая панель инструментов (она ничего не печатает вовсе).
 *
 * ЧЕГО В НАБОРЕ НЕТ И ПОЧЕМУ (каждое — молчаливая потеря на странице):
 *   - `upload`, `relationship`, `blocks` — узлы без `children`: содержимое
 *     исчезает целиком;
 *   - `horizontalRule` — разбор пропускает разделитель как оформление;
 *   - `checklist` — состояние галочки печатать нечем, остался бы обычный список;
 *   - `align`, `indent` — выравнивание и отступ разбор игнорирует: в админке
 *     текст по центру, на странице — нет.
 *
 * ЗАГОЛОВКИ ОГРАНИЧЕНЫ h2–h4 ({@link PUBLIC_RICH_TEXT_HEADING_SIZES}), и это не
 * стиль: `h1` на странице ровно один — это поле записи (требование п. 22.2
 * приёмки), а разбор в `apps/web` понижает `h1` до `<h2>`. Пока `h1` можно
 * выбрать в редакторе, админка и страница показывают разное. Набор h2/h3/h4
 * делает соответствие уровней точным.
 *
 * ССЫЛКИ. Внутренняя ссылка по идентификатору записи (`linkType: 'internal'`)
 * выключена: у публичного разбора нет слоя данных, чтобы превратить id в путь,
 * поэтому такая ссылка печаталась бы ТЕКСТОМ. Ссылаться внутрь сайта надо
 * путём от корня — это разрешено и печатается ссылкой. Адрес проверяется общим
 * правилом `validatePublicRichTextHref` из `@otkritka/shared`: то же правило
 * решает, что печатать, у `apps/web`. Автоссылки отключены: вставленный
 * адрес-текст остаётся текстом и в редакторе, и на странице, вместо того чтобы
 * стать узлом, который сохранить нельзя.
 *
 * ОДНОГО НАБОРА ФИЧ НЕДОСТАТОЧНО — и это главное здесь. Проверено по
 * `@payloadcms/richtext-lexical/dist/validate/validateNodes.js`: валидация
 * обходит узлы и запускает проверки, ЗАРЕГИСТРИРОВАННЫЕ фичами. Узел, чьей фичи
 * в наборе нет, проверок не имеет вовсе — то есть проходит молча и сохраняется.
 * В админке его не вставить (кнопки нет), а вот `POST /api/collections/...` с
 * узлом `upload` внутри `intro` прошёл бы: правило, живущее в интерфейсе,
 * внешний AI-редактор обходит через API. Поэтому рядом с набором фич стоит
 * серверный хук {@link publicRichTextHooks}, отклоняющий документ с узлом вне
 * {@link PUBLIC_RICH_TEXT_NODE_TYPES}. Это и делает неподдерживаемый узел
 * невыразимым — во всех входах, а не только в форме.
 *
 * ГРАНИЦА: набор расширяется только ВМЕСТЕ с публичным разбором. Обратный
 * порядок — сначала фича, потом «когда-нибудь рендер» — это и есть исходный
 * дефект.
 */
import {
  BlockquoteFeature,
  BoldFeature,
  HeadingFeature,
  InlineCodeFeature,
  InlineToolbarFeature,
  ItalicFeature,
  LinkFeature,
  OrderedListFeature,
  ParagraphFeature,
  StrikethroughFeature,
  SubscriptFeature,
  SuperscriptFeature,
  UnderlineFeature,
  UnorderedListFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical';
import type {
  Field,
  FieldAffectingData,
  FieldHook,
  TextFieldSingleValidation,
  TypeWithID,
} from 'payload';
import { APIError } from 'payload';

import { validatePublicRichTextHref } from '@otkritka/shared';

/**
 * Уровни заголовков внутри текста. `h1` отсутствует намеренно: единственный
 * `h1` страницы — это поле записи.
 */
export const PUBLIC_RICH_TEXT_HEADING_SIZES = ['h2', 'h3', 'h4'] as const;

const validateHref: TextFieldSingleValidation = (value) => validatePublicRichTextHref(value);

/**
 * Поля редактора ссылки с суженной проверкой адреса.
 *
 * Заменяется только валидатор поля `url`; остальные поля (текст ссылки, вид,
 * «в новой вкладке») приходят из Payload как есть — переписывать их означало бы
 * поддерживать копию базовой схемы ссылки при каждом обновлении пакета.
 *
 * Вид `internal` в этой схеме не появляется вовсе: он добавляется только при
 * непустом наборе коллекций для внутренних ссылок, а он здесь пуст
 * (`enabledCollections: []`, см. `getBaseFields` в пакете).
 */
function publicLinkFields({
  defaultFields,
}: {
  readonly defaultFields: FieldAffectingData[];
}): (Field | FieldAffectingData)[] {
  return defaultFields.map((field) => {
    if (field.name !== 'url' || field.type !== 'text') {
      return field;
    }
    // Признаки множественного значения отбрасываются, а не переносятся спредом.
    // Тип текстового поля Payload распадается на два варианта — одиночное и
    // `hasMany` — и валидатор одиночного значения допустим только в первом;
    // перенесённые `hasMany`/`maxRows`/`minRows` при `exactOptionalPropertyTypes`
    // оставляли бы объект похожим на второй. Адрес ссылки одиночный по
    // определению, поэтому потери здесь нет.
    const { hasMany, maxRows, minRows, ...single } = field;
    void hasMany;
    void maxRows;
    void minRows;
    return { ...single, validate: validateHref };
  });
}

/**
 * Фичи для полей, которые печатает публичный шаблон.
 *
 * Функция, а не константа: экземпляры фич не переиспользуются между полями.
 * `LinkFeature` при сборке конфигурации ПИШЕТ в свои props (`props.fields =
 * sanitizedFields`), поэтому один экземпляр на два поля означал бы, что второе
 * поле получает уже обработанную схему первого.
 */
export function publicRichTextFeatures() {
  return [
    BoldFeature(),
    ItalicFeature(),
    UnderlineFeature(),
    StrikethroughFeature(),
    SubscriptFeature(),
    SuperscriptFeature(),
    InlineCodeFeature(),
    ParagraphFeature(),
    HeadingFeature({ enabledHeadingSizes: [...PUBLIC_RICH_TEXT_HEADING_SIZES] }),
    UnorderedListFeature(),
    OrderedListFeature(),
    LinkFeature({
      // Автоссылка из вставленного адреса не создаётся: она стала бы узлом,
      // который может не пройти проверку адреса, и сохранение упало бы там, где
      // человек всего лишь вставил текст.
      disableAutoLinks: true,
      // Пустой набор коллекций убирает и вид ссылки `internal`, и поле выбора
      // записи: см. `getBaseFields` в пакете. Ссылка внутрь сайта задаётся
      // путём от корня.
      enabledCollections: [],
      fields: publicLinkFields,
    }),
    BlockquoteFeature(),
    InlineToolbarFeature(),
  ];
}

/**
 * Редактор для полей публичного текста.
 *
 * Один экземпляр на все такие поля — сравнение по ссылке в тесте («у этого поля
 * именно суженный редактор») возможно только так. Фичи при этом каждый раз
 * новые: `features` передан ФУНКЦИЕЙ, а её Payload вызывает на каждую сборку
 * поля.
 */
export const publicRichTextEditor = lexicalEditor({
  features: () => publicRichTextFeatures(),
});

/**
 * Типы узлов lexical, которые публичный разбор печатает.
 *
 * Список — не копия набора фич, а его СЛЕДСТВИЕ, записанное машинно: фичи
 * задают, что можно вставить в админке, а этот набор — что можно СОХРАНИТЬ через
 * любой вход, включая REST и GraphQL. Расширяется только вместе с публичным
 * разбором `apps/web`.
 */
export const PUBLIC_RICH_TEXT_NODE_TYPES: ReadonlySet<string> = new Set([
  // База документа.
  'root',
  'paragraph',
  'text',
  'linebreak',
  'tab',
  // Включённые фичи.
  'heading',
  'list',
  'listitem',
  'quote',
  'link',
]);

function readNodeType(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null;
  }
  const { type } = value;
  return typeof type === 'string' ? type : null;
}

function readChildren(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null || !('children' in value)) {
    return [];
  }
  const { children } = value;
  return Array.isArray(children) ? children : [];
}

/**
 * Типы узлов документа, которые публичный разбор не печатает.
 *
 * Возвращается ВЕСЬ набор без повторов, а не первый: редактор должен увидеть
 * объём проблемы одним отказом. Пустой массив — документ печатается целиком.
 */
export function unsupportedRichTextNodes(value: unknown): readonly string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    const type = readNodeType(node);
    if (type !== null && !PUBLIC_RICH_TEXT_NODE_TYPES.has(type)) {
      found.add(type);
      // Дети неподдерживаемого узла не обходятся: причина уже названа, а его
      // содержимое всё равно не будет напечатано.
      return;
    }
    for (const child of readChildren(node)) {
      walk(child);
    }
  };

  if (typeof value === 'object' && value !== null && 'root' in value) {
    walk((value as { readonly root?: unknown }).root);
  } else {
    walk(value);
  }

  return [...found].sort();
}

/**
 * Отклоняет документ с узлом, которого публичный разбор не печатает.
 *
 * Живёт в хуке ПОЛЯ, а не в валидации фичи: у отсутствующей фичи нет и
 * валидации, поэтому её узел проходит молча (см. шапку модуля). Хук выполняется
 * одинаково для админки, REST и GraphQL — другого пути записи не существует.
 *
 * @throws APIError 400 с машинным признаком `rule`
 */
const rejectUnsupportedNodes: FieldHook<TypeWithID, unknown, unknown> = ({ value }) => {
  const unsupported = unsupportedRichTextNodes(value);
  if (unsupported.length > 0) {
    throw new APIError(
      'Текст содержит узлы, которых публичная страница не печатает: ' +
        `${unsupported.join(', ')}. Такой узел не «почти работает» — он исчезает на ` +
        'странице целиком и молча, поэтому сохранение отклонено. Допустимы абзацы, ' +
        'заголовки h2–h4, списки, цитата, выделение и ссылка (путь от корня сайта либо ' +
        'полный адрес по http/https). Изображение внутри вводного текста не ' +
        'предусмотрено: изображения живут в карточках открыток.',
      400,
      { rule: 'unsupported-rich-text-node' },
      true,
    );
  }
  return value;
};

/**
 * Хуки поля публичного текста. Ставятся ВМЕСТЕ с {@link publicRichTextEditor}:
 * набор фич закрывает форму админки, хук — все остальные входы.
 *
 * Функция, а не константа: Payload ожидает изменяемые массивы хуков, а общий
 * массив на несколько полей означал бы, что правка одного поля видна в другом.
 */
export function publicRichTextHooks(): {
  beforeValidate: FieldHook<TypeWithID, unknown, unknown>[];
} {
  return { beforeValidate: [rejectUnsupportedNodes] };
}
