/**
 * Разбор ответа сервера как ТЕКСТА, без браузера и без выполнения JS.
 *
 * Почему регулярные выражения, а не DOM: требование «контент и первые
 * изображения присутствуют в HTML без выполнения JS» проверяется ровно тем, что
 * пришло по проводу. Как только HTML попадает в браузер, движок достраивает
 * пропущенные теги, переносит содержимое из `<head>` в `<body>` и исполняет
 * скрипты — то есть проверяется уже не ответ сервера. Браузер в приёмке нужен
 * для другого (видимость при отключённом JS) и используется отдельным spec'ом.
 *
 * Разбор намеренно узкий: каждая функция ищет один конкретный тег и не строит
 * дерево. Это делает падение конкретным («canonical два» вместо «HTML не
 * распарсился») и не создаёт впечатления, что тут есть полноценный парсер.
 */

/**
 * Атрибуты открывающего тега: имя в нижнем регистре → значение.
 *
 * Разбор идёт по атрибутам целиком, а не поиском одного имени регулярным
 * выражением, ровно по двум причинам — и обе уже давали неверный ответ:
 *
 *  1. **пустое значение Astro печатает БЕСКАВЫЧНО.** `alt=""` в шаблоне
 *     превращается в `<img … alt>`: `addAttribute` в
 *     `astro/dist/runtime/server/render/util.js` содержит
 *     `if (value === "") return markHTMLString(\` ${key}\`)` (замерено на
 *     astro 7.2.4). Поиск по `name\s*=` такой атрибут не находил вовсе, то есть
 *     ДЕКОРАТИВНОЕ изображение с законным пустым `alt` выглядело как
 *     изображение, у которого `alt` забыли. Приёмка обязана различать три
 *     состояния: атрибута нет (`null`), атрибут есть и пуст (`''`), атрибут
 *     есть со значением;
 *  2. **`\b` перед именем ловит чужой атрибут.** Перед `alt` в `data-alt`
 *     стоит дефис — небуквенный символ, поэтому граница слова совпадала, и
 *     `data-src`/`data-alt`/`aria-label` отвечали за `src`/`alt`/`label`.
 *     Атрибут, разобранный целиком, такой подмены не допускает.
 *
 * Повтор имени в теге: берётся ПЕРВОЕ вхождение — так же поступает браузер.
 */
function attributesOf(tag: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  // Отброшены имя тега (`<img`) и закрывающая часть (`>` либо `/>`): дальше в
  // строке остаются только атрибуты.
  const body = tag.replace(/^<[^\s/>]*/, '').replace(/\/?>$/, '');
  const pattern = /([^\s"'/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of body.matchAll(pattern)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === '' || attributes.has(name)) {
      continue;
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Значение атрибута из строки открывающего тега. Регистр имени не важен.
 *
 * `null` — атрибута НЕТ; пустая строка — атрибут есть и пуст. Различие
 * существенно: `<img alt>` — это описанное решение «изображение декоративное», а
 * `<img>` без `alt` — незаполненное поле записи.
 */
export function attributeValue(tag: string, name: string): string | null {
  return attributesOf(tag).get(name.toLowerCase()) ?? null;
}

/** Все открывающие теги указанного имени, как строки вида `<link ... >`. */
export function openingTags(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

/** Содержимое `<title>`: все вхождения, чтобы падало и на двух тегах. */
export function titles(html: string): string[] {
  return [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((match) =>
    decodeEntities((match[1] ?? '').trim()),
  );
}

/** Значения `content` у всех `<meta name="...">` с указанным именем. */
export function metaContents(html: string, name: string): string[] {
  return openingTags(html, 'meta')
    .filter((tag) => attributeValue(tag, 'name')?.toLowerCase() === name.toLowerCase())
    .map((tag) => decodeEntities(attributeValue(tag, 'content') ?? ''));
}

/** Значения `href` у всех `<link rel="canonical">`. */
export function canonicalHrefs(html: string): string[] {
  return openingTags(html, 'link')
    .filter((tag) => attributeValue(tag, 'rel')?.trim().toLowerCase() === 'canonical')
    .map((tag) => attributeValue(tag, 'href') ?? '');
}

/** Текст каждого `<h1>` — без вложенных тегов и без HTML-сущностей. */
export function headingTexts(html: string, level: 1 | 2 | 3): string[] {
  const pattern = new RegExp(`<h${String(level)}\\b[^>]*>([\\s\\S]*?)<\\/h${String(level)}>`, 'gi');
  return [...html.matchAll(pattern)].map((match) => stripTags(match[1] ?? ''));
}

export interface ScriptTag {
  /** Открывающий тег целиком — для сообщения об ошибке. */
  readonly tag: string;
  /** Значение `type`, приведённое к нижнему регистру, либо `null`. */
  readonly type: string | null;
  /** Значение `src`, либо `null` у инлайнового скрипта. */
  readonly src: string | null;
}

/**
 * Все `<script>` в ответе. Разделение на исполняемые и данные делает spec:
 * `type="application/ld+json"` — это структурированные данные (они обязательны
 * по ТЗ и появятся на карточке и подборке), а не клиентский JS.
 */
export function scriptTags(html: string): ScriptTag[] {
  return openingTags(html, 'script').map((tag) => ({
    tag,
    type: attributeValue(tag, 'type')?.trim().toLowerCase() ?? null,
    src: attributeValue(tag, 'src'),
  }));
}

export interface AnchorTag {
  readonly tag: string;
  readonly href: string | null;
}

/** Все `<a>` в ответе вместе со значением `href` (или `null`, если атрибута нет). */
export function anchorTags(html: string): AnchorTag[] {
  return openingTags(html, 'a').map((tag) => ({ tag, href: attributeValue(tag, 'href') }));
}

/** Все `<a>` в ответе: `href` и видимый текст ссылки. */
export function anchorLinks(html: string): AnchorLink[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: attributeValue(`<a${match[1] ?? ''}>`, 'href'),
    text: stripTags(match[2] ?? ''),
  }));
}

export interface AnchorLink {
  readonly href: string | null;
  /** Текст ссылки без вложенных тегов: то, что читает посетитель. */
  readonly text: string;
}

export interface ImageTag {
  readonly tag: string;
  readonly src: string | null;
  readonly width: string | null;
  readonly height: string | null;
  /**
   * `null` — атрибута `alt` НЕТ (нарушение: описание не заполнено); пустая
   * строка — `alt` есть и пуст, то есть заявлено «изображение декоративное».
   * Различие держится разбором атрибутов: пустое значение Astro печатает
   * бескавычно (`<img … alt>`), см. {@link attributesOf}.
   */
  readonly alt: string | null;
  readonly loading: string | null;
  /** Значение `fetchpriority` — у первого крупного изображения `high`. */
  readonly fetchpriority: string | null;
}

/** Все `<img>` в ответе с атрибутами, обязательными по разделу «Изображения». */
export function imageTags(html: string): ImageTag[] {
  return openingTags(html, 'img').map((tag) => ({
    tag,
    src: attributeValue(tag, 'src'),
    width: attributeValue(tag, 'width'),
    height: attributeValue(tag, 'height'),
    alt: attributeValue(tag, 'alt'),
    loading: attributeValue(tag, 'loading'),
    fetchpriority: attributeValue(tag, 'fetchpriority')?.trim().toLowerCase() ?? null,
  }));
}

/**
 * Тела всех `<script type="application/ld+json">`, разобранные как JSON.
 *
 * Разбор именно здесь, а не в spec'е: неразобравшийся блок — это НАРУШЕНИЕ (в
 * теле оказался незаэкранированный `</script>` или незакрытая строка), и оно
 * обязано называться отдельной ошибкой, а не падать исключением посреди
 * утверждения. Поэтому неудача разбора возвращается значением.
 */
export function jsonLdBlocks(html: string): readonly JsonLdBlock[] {
  return [
    ...html.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((match) => {
    const text = match[1] ?? '';
    try {
      return { text, value: JSON.parse(text) as unknown, error: null };
    } catch (error) {
      return { text, value: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export interface JsonLdBlock {
  /** Тело блока как есть — для сообщения об ошибке. */
  readonly text: string;
  /** Разобранное значение либо `null`, если разбор не удался. */
  readonly value: unknown;
  /** Причина неудачи разбора либо `null`. */
  readonly error: string | null;
}

/**
 * Все узлы разметки с указанным `@type` — в глубину, включая вложенные.
 *
 * В глубину намеренно: `ItemList` живёт свойством `mainEntity` внутри
 * `CollectionPage`, а `ImageObject` — отдельным узлом `@graph`. Плоский обход
 * верхнего уровня находил бы один и не находил другой.
 */
export function jsonLdNodes(value: unknown, type: string): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonLdNodes(item, type));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const node = value as Record<string, unknown>;
  const nested = Object.values(node).flatMap((item) => jsonLdNodes(item, type));
  return node['@type'] === type ? [node, ...nested] : nested;
}

/** Значение атрибута `lang` у `<html>`. */
export function htmlLang(html: string): string | null {
  const tag = openingTags(html, 'html')[0];
  return tag === undefined ? null : attributeValue(tag, 'lang');
}

/**
 * Видимый текст ответа: `<head>`, стили, скрипты и разметка выброшены. Нужен
 * ровно для одного утверждения — что содержание страницы приехало в HTML, а не
 * дорисовывается скриптом.
 */
export function visibleText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const source = body === null ? html : (body[1] ?? '');
  return stripTags(
    source
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' '),
  );
}

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
