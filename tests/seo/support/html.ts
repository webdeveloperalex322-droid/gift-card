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

/** Значение атрибута из строки открывающего тега. Регистр имени не важен. */
function attributeValue(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (quoted !== null) {
    return quoted[2] ?? quoted[3] ?? null;
  }
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag);
  return bare === null ? null : (bare[1] ?? null);
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

export interface ImageTag {
  readonly tag: string;
  readonly src: string | null;
  readonly width: string | null;
  readonly height: string | null;
  readonly alt: string | null;
  readonly loading: string | null;
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
  }));
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
