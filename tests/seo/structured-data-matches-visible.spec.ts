/**
 * Требование (раздел «Структурированные данные»): разметка JSON-LD
 * СООТВЕТСТВУЕТ ВИДИМОМУ СОДЕРЖИМОМУ; фиктивные отзывы, рейтинги и авторы
 * запрещены.
 *
 * Это единственное требование чек-листа, которое нельзя проверить ни осмотром
 * страницы, ни осмотром разметки по отдельности: и то и другое бывает
 * правдоподобным, расходясь между собой. Поэтому spec сравнивает их друг с
 * другом на ОДНОМ ответе сервера:
 *
 *   - каждый блок `application/ld+json` разбирается как JSON. Неразобравшийся
 *     блок — это нарушение, а не помеха тесту: так выглядит потерянное
 *     экранирование, когда заголовок записи с последовательностью `</script>`
 *     закрывает тег и остаток разметки уезжает в HTML текстом;
 *   - у каждого блока `@context` = `https://schema.org`. Без него блок не
 *     является связанными данными вовсе;
 *   - у каждого `ListItem` (это и `BreadcrumbList`, и `ItemList` подборки)
 *     непустое имя, абсолютный адрес НА НАШЕМ хосте, имя присутствует в видимом
 *     тексте страницы, и — если адрес не равен адресу самой страницы — на
 *     странице есть `<a href>` на этот путь. Именно это утверждение ловит
 *     `ItemList`, собранный не из той выборки, что видимая сетка: список из 12
 *     элементов при 9 плитках на экране перестаёт быть описанием страницы;
 *   - `ImageObject.contentUrl` указывает на файл, который страница ПОКАЗЫВАЕТ:
 *     адрес обязан совпасть с `src` одного из `<img>`, а `width`/`height` — с его
 *     атрибутами. Разметка, описывающая другой файл, — заявление о картинке,
 *     которой на странице нет;
 *   - `url` у `WebPage` и `CollectionPage` совпадает с self-canonical символ в
 *     символ. Два разных адреса одной страницы в одном ответе — это заявка на
 *     дубль;
 *   - свойств `author`, `review`, `aggregateRating` нет ни у одного узла. Открытки
 *     генерирует нейросеть: автора-человека и отзывов у страницы нет, а
 *     выдуманные — прямой запрет п. 23 ТЗ. Проверка именно на ОТСУТСТВИЕ, потому
 *     что содержательно проверить «отзыв настоящий» машина не может.
 *
 * Страницы, объявленные в инвентаре как `structuredData: 'none'`, проверяются
 * обратным утверждением — что блоков нет. Иначе на странице без разметки spec
 * «проходил» бы, не встретив ни одного узла, и зелёный отчёт означал бы
 * выполненное требование там, где проверять было нечего.
 */

import { expect, test } from '@playwright/test';

import {
  anchorLinks,
  canonicalHrefs,
  imageTags,
  jsonLdBlocks,
  jsonLdNodes,
  visibleText,
} from './support/html.js';
import { fetchRaw } from './support/http.js';
import { ACCEPTANCE_PAGES } from './support/pages.js';
import { resolveAcceptanceTarget, urlFor } from './support/target.js';

const target = resolveAcceptanceTarget();

/** Запрещённые свойства: их наличие означает выдуманное утверждение. */
const FORBIDDEN_PROPERTIES = ['author', 'review', 'aggregateRating', 'ratingValue'] as const;

/** Строковое свойство узла либо `null`. */
function text(node: Record<string, unknown>, property: string): string | null {
  const value = node[property];
  return typeof value === 'string' ? value : null;
}

/** Числовое свойство узла либо `null`. */
function numeric(node: Record<string, unknown>, property: string): number | null {
  const value = node[property];
  return typeof value === 'number' ? value : null;
}

/** Путь из абсолютного адреса на нашем хосте либо `null`, если хост чужой. */
function ownPath(url: string, origin: string): string | null {
  if (!url.startsWith(`${origin}/`)) {
    return null;
  }
  return new URL(url).pathname;
}

/** Все узлы разметки страницы — плоским списком, включая вложенные. */
function allNodes(values: readonly unknown[]): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node['@type'] === 'string') {
      collected.push(node);
    }
    for (const nested of Object.values(node)) {
      walk(nested);
    }
  };
  walk(values);
  return collected;
}

for (const page of ACCEPTANCE_PAGES) {
  test(`разметка соответствует видимому: ${page.path} (${page.task})`, async ({ request }) => {
    const response = await fetchRaw(request, urlFor(target, page.path));
    expect(response.status, 'Страница обязана отдавать 200.').toBe(200);

    const blocks = jsonLdBlocks(response.body);

    if (page.structuredData === 'none') {
      expect(
        blocks.map((block) => block.text.slice(0, 160)),
        `Инвентарь приёмки объявляет страницу ${page.path} без структурированных данных, а в ` +
          'ответе они есть. Проверка соответствия разметки видимому содержимому для этой ' +
          'страницы ВЫКЛЮЧЕНА, пока она объявлена как `structuredData: none`. Объявите её ' +
          '`structuredData: required` в tests/seo/support/pages.ts тем же коммитом, которым ' +
          'добавили разметку.',
      ).toEqual([]);
      return;
    }

    expect(
      blocks.length,
      'Инвентарь объявляет у страницы структурированные данные, а в ответе сервера нет ни ' +
        'одного <script type="application/ld+json">.',
    ).toBeGreaterThan(0);

    const broken = blocks.filter((block) => block.error !== null);
    expect(
      broken.map((block) => `${block.error ?? ''}: ${block.text.slice(0, 160)}`),
      'Блок JSON-LD не разбирается как JSON. Так выглядит потерянное экранирование: ' +
        'последовательность </script> в заголовке записи закрывает тег, и остаток разметки ' +
        'уезжает в HTML текстом.',
    ).toEqual([]);

    const values = blocks.map((block) => block.value);
    for (const [index, value] of values.entries()) {
      const root = value as Record<string, unknown> | null;
      expect(
        root === null ? null : root['@context'],
        `У блока разметки №${String(index + 1)} обязан быть @context = https://schema.org: без ` +
          'него блок не является связанными данными вовсе.',
      ).toBe('https://schema.org');
    }

    const canonical = canonicalHrefs(response.body)[0] ?? '';
    const visible = visibleText(response.body);
    const anchors = anchorLinks(response.body);
    const hrefs = new Set(anchors.map((anchor) => (anchor.href ?? '').trim()));
    const nodes = allNodes(values);

    /* --- Запрещённые свойства ---------------------------------------- */

    const fabricated = nodes.flatMap((node) =>
      FORBIDDEN_PROPERTIES.filter((property) => property in node).map(
        (property) => `${String(node['@type'])}.${property}`,
      ),
    );
    expect(
      fabricated,
      'Свойства author, review, aggregateRating запрещены (п. 23 ТЗ): открытки генерирует ' +
        'нейросеть, автора-человека и отзывов у страницы нет, а выдуманные — прямой запрет.',
    ).toEqual([]);

    /* --- Адрес страницы --------------------------------------------- */

    for (const pageNode of [
      ...jsonLdNodes(values, 'WebPage'),
      ...jsonLdNodes(values, 'CollectionPage'),
    ]) {
      expect(
        text(pageNode, 'url'),
        'url страницы в разметке обязан совпадать с self-canonical символ в символ: два ' +
          'разных адреса одной страницы в одном ответе — это заявка на дубль.',
      ).toBe(canonical);
    }

    /* --- Элементы списков против видимого списка --------------------- */

    const listItems = jsonLdNodes(values, 'ListItem');
    expect(
      listItems.length,
      'Ни одного ListItem: у страницы с разметкой обязан быть либо BreadcrumbList, либо ' +
        'ItemList — оба описывают видимые списки.',
    ).toBeGreaterThan(0);

    for (const item of listItems) {
      const name = (text(item, 'name') ?? '').trim();
      const url = (text(item, 'url') ?? text(item, 'item') ?? '').trim();
      const label = `ListItem «${name}» → ${url}`;

      expect(
        name.length,
        `${label}: пустое имя. Это элемент списка, у которого нечего прочитать.`,
      ).toBeGreaterThan(0);

      const path = ownPath(url, target.origin);
      expect(
        path,
        `${label}: адрес обязан быть абсолютным и на хосте приёмки (${target.origin}). ` +
          'Относительный адрес в разметке или чужой хост означают ссылку не на эту страницу.',
      ).not.toBeNull();

      expect(
        visible.includes(name),
        `${label}: имя элемента разметки не найдено в видимом тексте страницы. Разметка ` +
          'обязана описывать то, что посетитель видит.',
      ).toBe(true);

      if (url !== canonical) {
        expect(
          hrefs.has(path ?? ''),
          `${label}: на странице нет <a href="${path ?? ''}">. Элемент списка, на который со ` +
            'страницы не ведёт ссылка, описывает не видимый список, а какую-то другую выборку.',
        ).toBe(true);
      }
    }

    /* --- Изображение в разметке против изображения на странице ------- */

    const images = imageTags(response.body);
    for (const imageNode of jsonLdNodes(values, 'ImageObject')) {
      const contentUrl = (text(imageNode, 'contentUrl') ?? '').trim();
      const path = ownPath(contentUrl, target.origin);
      expect(
        path,
        `ImageObject.contentUrl «${contentUrl}» обязан быть абсолютным адресом на хосте ` +
          'приёмки: разметка описывает файл, который отдаёт этот сайт.',
      ).not.toBeNull();

      const shown = images.find((image) => (image.src ?? '').trim() === path);
      expect(
        shown,
        `ImageObject.contentUrl «${contentUrl}» не совпал ни с одним <img src> на странице ` +
          `(есть: ${images.map((image) => image.src ?? '—').join(', ')}). Разметка описывает ` +
          'файл, которого страница не показывает.',
      ).toBeDefined();

      expect(
        [numeric(imageNode, 'width'), numeric(imageNode, 'height')],
        'width и height в ImageObject обязаны совпадать с атрибутами того же <img>: иначе ' +
          'разметка обещает файл другого размера.',
      ).toEqual([
        shown === undefined ? null : Number.parseInt(shown.width ?? '0', 10),
        shown === undefined ? null : Number.parseInt(shown.height ?? '0', 10),
      ]);
    }
  });
}
