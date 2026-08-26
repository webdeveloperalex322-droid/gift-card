/**
 * Вводный текст подборки: lexical-документ → структура для серверного рендера
 * (задача Э3-06).
 *
 * Норма: ТЗ §5.3 (у подборки есть уникальный содержательный вводный текст),
 * `CLAUDE.md` — раздел «Рендеринг» («основной текст присутствует в HTML-ответе
 * сервера»; «ровно один `<h1>` на страницу»; «навигация — только `<a href>`»).
 *
 * ## Почему свой разбор, а не официальный конвертер Payload
 *
 * У `@payloadcms/richtext-lexical` есть синхронный `convertLexicalToHTML`, и он
 * был первым кандидатом. Отвергнут по двум причинам, обе замерены по исходникам
 * пакета (`dist/features/converters/lexicalToHtml/sync/`):
 *
 *   1. **`href="#"`.** Для внутренней ссылки (`linkType: 'internal'`) без
 *      резолвера конвертер печатает именно `href="#"`
 *      (`converters/link.js`). Это прямой запрет проекта: hash-адресов в
 *      навигации нет. Резолвер потребовал бы чтения записи по идентификатору из
 *      ЧИСТОГО модуля, то есть перенёс бы сюда слой данных;
 *   2. **вес зависимости.** Пакет объявляет peer-зависимости на `react`,
 *      `react-dom`, `next` и `@payloadcms/next`. Astro-приложение без React
 *      получило бы их в дерево зависимостей ради разбора одного поля.
 *
 * Поэтому здесь разбор в СТРУКТУРУ, а не в строку HTML. Следствие важнее
 * стиля: HTML печатает Astro (`../components/RichText.astro`), то есть
 * экранирование текста, введённого человеком, делает шаблонизатор, и потерять
 * его нельзя даже теоретически — `set:html` в этом пути не участвует.
 *
 * ## Что разбор делает с содержимым намеренно
 *
 *   - **понижает уровень заголовков.** Заголовок `h1` внутри вводного текста дал
 *     бы второй H1 на странице (провал п. 22.2), поэтому `h1`/`h2` становятся
 *     `<h2>`, `h3` — `<h3>`, остальные — `<h4>`. Единственный H1 страницы — это
 *     поле записи;
 *   - **не выводит внутренние ссылки ссылками.** Ссылка `linkType: 'internal'`
 *     остаётся ТЕКСТОМ: путь записи по её идентификатору здесь не вычислить, а
 *     подставить `#` или адрес наугад значило бы поставить ссылку в никуда.
 *     Слова при этом не теряются. Ограничение отмечено в отчёте задачи;
 *   - **пропускает адреса не тех схем.** Ссылкой становится либо путь от корня
 *     сайта, либо абсолютный `http`/`https`. `javascript:`, `data:` и прочее
 *     ссылкой не становятся вовсе — это не оформление, а исполняемый код в
 *     атрибуте;
 *   - **переносит строку пробелом.** Отдельного `<br>` нет: внутри вводного
 *     текста посадочной перенос — оформление, а склейка слов без пробела была бы
 *     потерей содержания. Тем же пробелом разделяются вложенные блоки внутри
 *     элемента списка (второй абзац, вложенный список): форма результата плоская,
 *     но слова через границу блока склеиваться не должны;
 *   - **не выводит горизонтальную линию.** Это оформление без содержания.
 *
 * ## Чего разбор НЕ делает молча — отказывает
 *
 * Узел, у которого нет ни текста, ни детей, а содержимое лежит в `fields`,
 * `value` или `relationTo` (`upload`, `relationship`, `block`, `inlineBlock`),
 * даёт ОТКАЗ с указанием типа узла — см. {@link PRINTABLE_NODE_TYPES} и
 * `assertPrintable`. Прежде такой узел давал ноль фрагментов и отбрасывался без
 * следа: текст исчезал с опубликованной страницы, и узнать об этом было
 * неоткуда. Со стороны CMS набор возможностей редактора сужен так, что эти узлы
 * в поле не сохранить; проверка здесь — вторая половина той же защиты, потому что
 * у поля есть история и документы, сохранённые прежним редактором.
 *
 * Модуль ЧИСТЫЙ: входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом `tests/unit/web-rich-text.test.ts`.
 */

import { looksLikeAbsoluteUrl } from '@otkritka/shared';

/**
 * Битовые маски форматирования текстового узла lexical — те, что разбор ПЕЧАТАЕТ.
 *
 * Значения скопированы из `NodeFormat` пакета `@payloadcms/richtext-lexical`
 * (`dist/lexical/utils/nodeFormat.js`), который сам копирует их из lexical.
 * Импортировать оттуда нельзя — см. шапку модуля; поэтому здесь ровно те же
 * числа с указанием источника.
 *
 * Копия числами держится не комментарием, а ТЕСТОМ: `tests/unit/web-rich-text.test.ts`
 * импортирует `NodeFormat` из самого пакета (в тесте это законно — пакет уже
 * зависимость `apps/cms`) и сверяет каждое значение. Без этой сверки расхождение
 * с апстримом проявилось бы потерей выделения без единого падения — находка
 * ревизии Э3-05/Э3-06. Имена ключей поэтому совпадают с именами `NodeFormat`
 * посимвольно: сверка идёт по ключу.
 */
export const TEXT_FORMAT_BITS = Object.freeze({
  IS_BOLD: 1,
  IS_CODE: 1 << 4,
  IS_ITALIC: 1 << 1,
  IS_STRIKETHROUGH: 1 << 2,
  IS_SUBSCRIPT: 1 << 5,
  IS_SUPERSCRIPT: 1 << 6,
  IS_UNDERLINE: 1 << 3,
});

/**
 * Форматы текста, которые разбор НЕ печатает — сознательно, а не по забывчивости.
 *
 * `IS_HIGHLIGHT` (подсветка маркером) — оформление без смысловой нагрузки: у него
 * нет естественного элемента в разметке страницы (`<mark>` означает «выделено
 * для читателя в связи с его запросом», а не «редактор покрасил»), и вводный
 * текст посадочной от его потери не меняется. Список существует, чтобы тест мог
 * отличить «решили не печатать» от «нового бита в апстриме никто не заметил».
 */
export const DECLINED_TEXT_FORMAT_BITS = Object.freeze({
  IS_HIGHLIGHT: 1 << 7,
});

/**
 * Теги выделения в ПОРЯДКЕ ВЛОЖЕНИЯ — снаружи внутрь.
 *
 * Порядок фиксирован, чтобы у одного и того же текста была одна и та же
 * разметка: `<strong><em>слово</em></strong>`, а не то одно, то другое.
 */
const MARK_TAGS: readonly { readonly bit: number; readonly tag: string }[] = Object.freeze([
  { bit: TEXT_FORMAT_BITS.IS_BOLD, tag: 'strong' },
  { bit: TEXT_FORMAT_BITS.IS_ITALIC, tag: 'em' },
  { bit: TEXT_FORMAT_BITS.IS_UNDERLINE, tag: 'u' },
  { bit: TEXT_FORMAT_BITS.IS_STRIKETHROUGH, tag: 's' },
  { bit: TEXT_FORMAT_BITS.IS_SUBSCRIPT, tag: 'sub' },
  { bit: TEXT_FORMAT_BITS.IS_SUPERSCRIPT, tag: 'sup' },
  { bit: TEXT_FORMAT_BITS.IS_CODE, tag: 'code' },
]);

/** Фрагмент текста с выделением и, возможно, ссылкой. */
export interface TextRun {
  readonly text: string;
  /** Теги выделения снаружи внутрь. Пустой массив — обычный текст. */
  readonly tags: readonly string[];
  /** Адрес ссылки либо `null` — тогда это просто текст. */
  readonly href: string | null;
  /** Ссылка ведёт на другой хост: у неё будет `rel="nofollow noopener"`. */
  readonly external: boolean;
}

export type RichTextBlock =
  | { readonly kind: 'paragraph'; readonly runs: readonly TextRun[] }
  | { readonly kind: 'quote'; readonly runs: readonly TextRun[] }
  | { readonly kind: 'heading'; readonly level: 2 | 3 | 4; readonly runs: readonly TextRun[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly TextRun[])[];
    };

interface LexicalNode {
  readonly type?: unknown;
  readonly children?: unknown;
  readonly text?: unknown;
  readonly format?: unknown;
  readonly tag?: unknown;
  readonly listType?: unknown;
  readonly fields?: unknown;
}

/**
 * Типы узлов, которые разбор УМЕЕТ обработать: напечатать либо сознательно
 * пропустить.
 *
 * Список нужен ради отказа, а не ради разбора: узел ВНЕ списка, у которого нет
 * детей, — это узел, чьё содержимое лежит в других полях (`fields`, `value`,
 * `relationTo`). Такому узлу разбор не может ни напечатать содержимое, ни
 * раскрыть детей, и молчаливый пропуск означал бы исчезновение текста с
 * опубликованной страницы (находка ревизии Э3-05/Э3-06, MAJOR). Проверка живёт в
 * {@link assertPrintable}.
 *
 * `horizontalrule` в списке есть: его пропуск — решение задачи Э3-06 (оформление
 * без содержания), а не потеря.
 */
const PRINTABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  'autolink',
  'heading',
  'horizontalrule',
  'linebreak',
  'link',
  'list',
  'listitem',
  'paragraph',
  'quote',
  'root',
  'tab',
  'text',
]);

/**
 * Типы узлов, которые внутри потока текста начинают НОВЫЙ блок.
 *
 * Внутри элемента списка такой узел (вложенный список, второй абзац) даёт
 * границу, на которой фрагменты нельзя печатать вплотную: «Раз» и «Вложенный»
 * склеивались в «РазВложенный» (находка ревизии Э3-05/Э3-06, MINOR 1) — при том,
 * что для переноса строки склейка специально исключена пробелом.
 */
const BLOCK_LEVEL_NODE_TYPES: ReadonlySet<string> = new Set([
  'heading',
  'list',
  'listitem',
  'paragraph',
  'quote',
]);

function asNode(value: unknown): LexicalNode | null {
  // Приведения здесь нет и не нужно: у `LexicalNode` все поля необязательны и
  // имеют тип `unknown`, поэтому любой объект ему соответствует. Читать поля всё
  // равно можно только через проверку типа значения — что и делают функции ниже.
  return typeof value === 'object' && value !== null ? value : null;
}

function childrenOf(node: LexicalNode): readonly unknown[] {
  return Array.isArray(node.children) ? node.children : [];
}

function nodeType(node: LexicalNode): string {
  return typeof node.type === 'string' ? node.type : '';
}

/**
 * Отказ на узле, содержимое которого разбор не увидит.
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ ПРОПУСК. Узел неизвестного типа С ДЕТЬМИ раскрывается — его
 * текст попадает в поток, и терять нечего (так и было задумано). Узел
 * неизвестного типа БЕЗ детей хранит содержимое в `fields`/`value`: `upload`,
 * `relationship`, `block`, `inlineBlock`. Для него у разбора нет ни печати, ни
 * раскрытия, поэтому исход только один из двух — либо текст исчезает со страницы
 * молча, либо страница честно падает. Молчаливая потеря дороже: она обнаружится
 * не падением, а вопросом «куда пропал абзац» через неделю после публикации.
 *
 * Со стороны CMS набор фич редактора сужен так, что такие узлы в поле не
 * сохранить (`apps/cms`, `publicRichTextEditor`). Проверка здесь — вторая
 * половина той же защиты: у поля есть история, а значит и документы, сохранённые
 * прежним, более широким редактором.
 *
 * @throws Error с указанием типа узла.
 */
function assertPrintable(node: LexicalNode): void {
  const type = nodeType(node);
  if (PRINTABLE_NODE_TYPES.has(type)) {
    return;
  }
  if (childrenOf(node).length > 0) {
    // Дети есть — текст не потеряется, узел раскроется. Ровно это проверяет тест
    // «неизвестный тип узла не теряет текста».
    return;
  }
  throw new Error(
    `Вводный текст содержит узел ${type === '' ? 'без поля type' : `типа «${type}»`}, у которого ` +
      'нет ни текста, ни детей: его содержимое лежит в других полях (fields, value, ' +
      'relationTo), и разбор его не напечатает. Пропустить такой узел молча нельзя — текст ' +
      'исчез бы с опубликованной страницы без следа. Либо уберите узел из поля, либо научите ' +
      'разбор его печатать (apps/web/src/seo/rich-text.ts).',
  );
}

function tagsFor(format: unknown): readonly string[] {
  const mask = typeof format === 'number' ? format : 0;
  return MARK_TAGS.filter((mark) => (mask & mark.bit) !== 0).map((mark) => mark.tag);
}

/**
 * Адрес ссылки из полей узла либо `null`.
 *
 * Белый список, а не чёрный: пропускается путь от корня сайта и абсолютный
 * адрес по `http`/`https`. Всё остальное — включая `javascript:`, `data:`,
 * протокольно-относительную форму `//host` и внутреннюю ссылку по
 * идентификатору записи — ссылкой не становится (обоснование в шапке модуля).
 */
function hrefFor(fields: unknown): { readonly href: string; readonly external: boolean } | null {
  const record = asNode(fields);
  if (record === null) {
    return null;
  }
  const raw = (record as { readonly url?: unknown }).url;
  const linkType = (record as { readonly linkType?: unknown }).linkType;
  if (linkType === 'internal' || typeof raw !== 'string') {
    return null;
  }
  const url = raw.trim();
  if (url === '') {
    return null;
  }
  if (!looksLikeAbsoluteUrl(url)) {
    return url.startsWith('/') ? { external: false, href: url } : null;
  }
  return /^https?:\/\//iu.test(url) ? { external: true, href: url } : null;
}

/**
 * Что фрагмент наследует от родительских узлов — только ссылка.
 *
 * Выделение НЕ наследуется, и это не упрощение: в lexical формат живёт битовой
 * маской самого ТЕКСТОВОГО узла, а не элемента-родителя. Жирный текст внутри
 * ссылки — это текстовый узел с битом `IS_BOLD` внутри узла `link`, поэтому
 * читать маску надо там, где она есть.
 */
interface RunContext {
  readonly href: string | null;
  readonly external: boolean;
}

const PLAIN: RunContext = { external: false, href: null };

/**
 * Разделитель на границе: пробел, и только если его там ещё нет.
 *
 * Ведущего пробела не появляется (пустой поток — выход), двойного тоже: у
 * вложенного списка граница возникает дважды — на самом списке и на его первом
 * элементе, — и без этой проверки между словами оказалось бы два пробела.
 */
function separate(context: RunContext, out: TextRun[]): void {
  const last = out.at(-1);
  if (last === undefined || last.text.endsWith(' ')) {
    return;
  }
  out.push({ ...context, tags: [], text: ' ' });
}

/**
 * Собирает фрагменты текста из поддерева, наследуя выделение и ссылку.
 *
 * Узел неизвестного типа не пропускается, а раскрывается: его дети попадают в
 * тот же поток. Молча выбросить содержимое нельзя — потерянный абзац виден не
 * ошибкой, а отсутствием текста на странице; узел, у которого и раскрывать
 * нечего, даёт отказ ({@link assertPrintable}).
 */
function collectRuns(nodes: readonly unknown[], context: RunContext, out: TextRun[]): void {
  for (const raw of nodes) {
    const node = asNode(raw);
    if (node === null) {
      continue;
    }
    assertPrintable(node);
    const type = nodeType(node);

    if (type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      if (text === '') {
        continue;
      }
      out.push({
        external: context.external,
        href: context.href,
        tags: tagsFor(node.format),
        text,
      });
      continue;
    }

    if (type === 'linebreak' || type === 'tab') {
      // Перенос и табуляция внутри абзаца — оформление. Пробел вместо них не
      // теряет содержания и не склеивает слова.
      out.push({ ...context, tags: [], text: ' ' });
      continue;
    }

    if (type === 'horizontalrule') {
      continue;
    }

    if (type === 'link' || type === 'autolink') {
      const link = hrefFor(node.fields);
      collectRuns(
        childrenOf(node),
        link === null ? context : { external: link.external, href: link.href },
        out,
      );
      continue;
    }

    if (BLOCK_LEVEL_NODE_TYPES.has(type)) {
      // Вложенный блок внутри потока текста (второй абзац или вложенный список
      // в элементе списка). Отдельным блоком его здесь не сделать — форма
      // результата плоская, — но и склеивать слова через границу нельзя.
      separate(context, out);
      collectRuns(childrenOf(node), context, out);
      continue;
    }

    collectRuns(childrenOf(node), context, out);
  }
}

function runsOf(node: LexicalNode): readonly TextRun[] {
  const runs: TextRun[] = [];
  collectRuns(childrenOf(node), PLAIN, runs);
  return runs;
}

function hasContent(runs: readonly TextRun[]): boolean {
  return runs.some((run) => run.text.trim() !== '');
}

/** Уровень заголовка внутри текста. Уровня 1 не бывает — см. шапку модуля. */
function headingLevel(tag: unknown): 2 | 3 | 4 {
  if (tag === 'h3') {
    return 3;
  }
  return tag === 'h1' || tag === 'h2' ? 2 : 4;
}

function listItems(node: LexicalNode): readonly (readonly TextRun[])[] {
  const items: (readonly TextRun[])[] = [];
  for (const raw of childrenOf(node)) {
    const item = asNode(raw);
    if (item === null) {
      continue;
    }
    // По той же причине, что и на верхнем уровне: `runsOf` смотрит на ДЕТЕЙ, а
    // сам элемент списка через проверку не проходит.
    assertPrintable(item);
    const runs = runsOf(item);
    if (hasContent(runs)) {
      items.push(runs);
    }
  }
  return items;
}

/**
 * Блоки вводного текста в порядке документа.
 *
 * Пустой или незаполненный документ даёт пустой массив: тогда шаблон не выводит
 * блок вовсе, а не выводит пустой абзац. Отказа здесь нет намеренно — вводный
 * текст обязателен перед `review` (проверка полноты в CMS), и его отсутствие у
 * опубликованной записи означает не повреждение данных, а страницу, которую
 * человек опубликовал именно такой.
 */
export function richTextBlocks(document: unknown): readonly RichTextBlock[] {
  // Документ приходит либо целиком (`{ root: … }` — так его хранит Payload), либо
  // уже развёрнутым корневым узлом: вторая форма нужна тесту и вложенным
  // структурам, и различать их вызывающему незачем.
  const wrapper = asNode(document);
  const root = asNode((wrapper as { readonly root?: unknown } | null)?.root ?? document);
  if (root === null) {
    return [];
  }

  const blocks: RichTextBlock[] = [];
  for (const raw of childrenOf(root)) {
    const node = asNode(raw);
    if (node === null) {
      continue;
    }
    // Проверка нужна ЗДЕСЬ отдельно от `collectRuns`: тот получает уже ДЕТЕЙ
    // узла, поэтому сам корневой узел через его проверку не проходит. Именно на
    // верхнем уровне и живут `upload`, `relationship`, `block` — узлы, чьё
    // содержимое лежит вне `children`.
    assertPrintable(node);
    const type = nodeType(node);

    if (type === 'list') {
      const items = listItems(node);
      if (items.length > 0) {
        blocks.push({ items, kind: 'list', ordered: node.listType === 'number' });
      }
      continue;
    }

    if (type === 'horizontalrule') {
      continue;
    }

    const runs = runsOf(node);
    if (!hasContent(runs)) {
      continue;
    }

    if (type === 'heading') {
      blocks.push({ kind: 'heading', level: headingLevel(node.tag), runs });
      continue;
    }
    blocks.push({ kind: type === 'quote' ? 'quote' : 'paragraph', runs });
  }

  return blocks;
}
