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
 *     потерей содержания;
 *   - **не выводит горизонтальную линию и вложения.** Первое — оформление,
 *     второе (`upload`) требует чтения связанной записи, то есть слоя данных.
 *
 * Модуль ЧИСТЫЙ: входит в composite-проект `../../tsconfig.node.json` и
 * проверяется юнит-тестом `tests/unit/web-rich-text.test.ts`.
 */

import { looksLikeAbsoluteUrl } from '@otkritka/shared';

/**
 * Битовая маска форматирования текстового узла lexical.
 *
 * Значения скопированы из `NodeFormat` пакета `@payloadcms/richtext-lexical`
 * (`dist/lexical/utils/nodeFormat.js`), который сам копирует их из lexical.
 * Импортировать оттуда нельзя — см. шапку модуля; поэтому здесь ровно те же
 * числа с указанием источника. Расхождение возможно только при смене формата
 * самого lexical, и тогда оно проявится потерей выделения, а не потерей текста.
 */
const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 1 << 1;
const FORMAT_STRIKETHROUGH = 1 << 2;
const FORMAT_UNDERLINE = 1 << 3;
const FORMAT_CODE = 1 << 4;
const FORMAT_SUBSCRIPT = 1 << 5;
const FORMAT_SUPERSCRIPT = 1 << 6;

/**
 * Теги выделения в ПОРЯДКЕ ВЛОЖЕНИЯ — снаружи внутрь.
 *
 * Порядок фиксирован, чтобы у одного и того же текста была одна и та же
 * разметка: `<strong><em>слово</em></strong>`, а не то одно, то другое.
 */
const MARK_TAGS: readonly { readonly bit: number; readonly tag: string }[] = Object.freeze([
  { bit: FORMAT_BOLD, tag: 'strong' },
  { bit: FORMAT_ITALIC, tag: 'em' },
  { bit: FORMAT_UNDERLINE, tag: 'u' },
  { bit: FORMAT_STRIKETHROUGH, tag: 's' },
  { bit: FORMAT_SUBSCRIPT, tag: 'sub' },
  { bit: FORMAT_SUPERSCRIPT, tag: 'sup' },
  { bit: FORMAT_CODE, tag: 'code' },
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
 * Собирает фрагменты текста из поддерева, наследуя выделение и ссылку.
 *
 * Узел неизвестного типа не пропускается, а раскрывается: его дети попадают в
 * тот же поток. Молча выбросить содержимое нельзя — потерянный абзац виден не
 * ошибкой, а отсутствием текста на странице.
 */
function collectRuns(nodes: readonly unknown[], context: RunContext, out: TextRun[]): void {
  for (const raw of nodes) {
    const node = asNode(raw);
    if (node === null) {
      continue;
    }
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
