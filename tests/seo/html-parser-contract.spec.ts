/**
 * Контракт разборщика самой приёмки (`support/html.ts`).
 *
 * Зачем проверять инструмент, а не сайт: разборщик — это то, ЧЕМ приёмка видит
 * ответ сервера. Его ошибка не делает тесты красными, она делает их
 * неправдивыми: часть проверок начинает утверждать не то, что написано в их
 * сообщениях. Оба случая ниже — не гипотезы, оба уже давали неверный ответ на
 * реальном HTML этого сайта:
 *
 *   1. **пустое значение атрибута Astro печатает БЕСКАВЫЧНО.** `alt=""` в
 *      шаблоне приезжает как `<img … alt>`: `addAttribute` в
 *      `astro/dist/runtime/server/render/util.js` содержит
 *      `if (value === "") return markHTMLString(\` ${key}\`)` (astro 7.2.4).
 *      Прежний разбор искал `name\s*=` и такой атрибут не находил вовсе — то
 *      есть ДЕКОРАТИВНОЕ изображение с законным пустым `alt` выглядело как
 *      изображение, у которого `alt` забыли. Пока у открыток `alt` непустой,
 *      ложного падения не было; мина сработала бы на первом декоративном
 *      изображении — и обвинила бы владельца слоя в нарушении, которого нет;
 *   2. **граница слова ловила ЧУЖОЙ атрибут.** Перед `src` в `data-src` стоит
 *      дефис, поэтому `\bsrc` совпадал внутри чужого имени, и приёмка отвечала
 *      за `src` значением `data-src`. Это обратная ошибка, худшая: изображение,
 *      подставляемое скриптом из `data-src` (ровно то, что запрещено разделом
 *      «Рендеринг»), выглядело бы как изображение с настоящим `src`.
 *
 * Spec запускается без обращения к сайту: он о разборе строк, и падение здесь
 * говорит о приёмке, а не о состоянии сервера.
 */

import { expect, test } from '@playwright/test';

import {
  anchorLinks,
  attributeValue,
  imageTags,
  jsonLdBlocks,
  jsonLdNodes,
  titles,
  visibleText,
} from './support/html.js';

test('пустой атрибут отличается от отсутствующего', () => {
  const decorative = imageTags('<img src="/a.jpg" width="10" height="5" alt>')[0];
  expect(decorative?.alt, 'Бескавычный `alt` — это атрибут, который ЕСТЬ и пуст.').toBe('');

  const missing = imageTags('<img src="/a.jpg" width="10" height="5">')[0];
  expect(missing?.alt, 'Атрибута alt нет вовсе — это другое состояние, и оно нарушение.').toBeNull();

  // Пустой `alt` в кавычках встречается в чужом HTML и означает то же самое.
  const quotedEmpty = imageTags('<img src="/a.jpg" alt="">')[0];
  expect(quotedEmpty?.alt).toBe('');
});

test('атрибут с похожим именем не отвечает за другой атрибут', () => {
  expect(
    attributeValue('<img data-src="/lazy.jpg" width="10">', 'src'),
    'data-src — это НЕ src: изображение, подставляемое скриптом, обязано выглядеть как ' +
      'изображение без src.',
  ).toBeNull();

  expect(attributeValue('<a data-href="/x" href="/real">', 'href')).toBe('/real');
  expect(attributeValue('<img aria-label="подпись">', 'label')).toBeNull();
  expect(attributeValue('<img srcset="/a.jpg 320w">', 'src')).toBeNull();
});

test('формы записи атрибутов: кавычки, регистр, порядок, повтор', () => {
  const tag = "<img SRC='/b.jpg' Width=640 height=\"400\" loading=lazy alt='кот'>";
  expect(attributeValue(tag, 'src')).toBe('/b.jpg');
  expect(attributeValue(tag, 'width')).toBe('640');
  expect(attributeValue(tag, 'HEIGHT')).toBe('400');
  expect(attributeValue(tag, 'loading')).toBe('lazy');
  expect(attributeValue(tag, 'alt')).toBe('кот');

  // Повтор имени: браузер берёт первое вхождение, приёмка обязана делать то же.
  expect(attributeValue('<img alt="первое" alt="второе">', 'alt')).toBe('первое');

  // Самозакрывающаяся форма и лишние пробелы не мешают разбору.
  expect(attributeValue('<img   src="/c.jpg"   />', 'src')).toBe('/c.jpg');
});

test('изображение: полный набор атрибутов разбирается целиком', () => {
  const image = imageTags(
    '<picture><source type="image/avif" srcset="/a.avif 320w">' +
      '<img src="/a-640.jpg" srcset="/a-320.jpg 320w" sizes="100vw" width="640" height="400" ' +
      'alt="описание" fetchpriority="HIGH"></picture>',
  );
  expect(image).toHaveLength(1);
  expect(image[0]?.src).toBe('/a-640.jpg');
  expect(image[0]?.width).toBe('640');
  expect(image[0]?.height).toBe('400');
  expect(image[0]?.alt).toBe('описание');
  expect(image[0]?.loading, 'Атрибута loading нет — изображение неленивое.').toBeNull();
  expect(image[0]?.fetchpriority, 'Значение приводится к нижнему регистру.').toBe('high');
});

test('ссылки: href и видимый текст', () => {
  const links = anchorLinks(
    '<nav><a class="x" href="/podborki/8-marta"><span>Открытки к&nbsp;8 марта</span></a>' +
      '<a>без href</a></nav>',
  );
  expect(links).toHaveLength(2);
  expect(links[0]?.href).toBe('/podborki/8-marta');
  expect(links[0]?.text, 'Текст ссылки — без вложенных тегов и без сущностей.').toBe(
    'Открытки к 8 марта',
  );
  expect(links[1]?.href, '<a> без href ссылкой не является.').toBeNull();
});

test('JSON-LD: разбор, неудача разбора и поиск вложенного узла', () => {
  const html =
    '<script type="application/ld+json">' +
    '{"@context":"https://schema.org","@type":"CollectionPage",' +
    '"mainEntity":{"@type":"ItemList","numberOfItems":1,' +
    '"itemListElement":[{"@type":"ListItem","position":1,"name":"Первая","url":"http://h/x"}]}}' +
    '</script>';

  const blocks = jsonLdBlocks(html);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.error).toBeNull();

  const items = jsonLdNodes(
    blocks.map((block) => block.value),
    'ListItem',
  );
  expect(items, 'ItemList живёт внутри mainEntity: обход обязан идти в глубину.').toHaveLength(1);
  expect(items[0]?.['name']).toBe('Первая');

  const brokenBlocks = jsonLdBlocks('<script type="application/ld+json">{"@type":</script>');
  expect(
    brokenBlocks[0]?.error,
    'Неразобравшийся блок — это НАРУШЕНИЕ, о котором обязан сообщить spec, а не исключение ' +
      'посреди утверждения.',
  ).not.toBeNull();
});

test('видимый текст: голова, стили и разметка не считаются содержанием', () => {
  const html =
    '<!doctype html><html lang="ru"><head><title>Заголовок</title>' +
    '<style>body{color:red}</style></head><body><h1>Видно</h1>' +
    '<script type="application/ld+json">{"@type":"WebPage","name":"Не видно"}</script>' +
    '<p>Текст &amp; ещё текст</p></body></html>';

  expect(titles(html)).toEqual(['Заголовок']);
  const visible = visibleText(html);
  expect(visible).toBe('Видно Текст & ещё текст');
  expect(visible, 'Содержимое <style> содержанием страницы не является.').not.toContain('color');
  expect(visible, 'Тело JSON-LD видимым текстом не является.').not.toContain('Не видно');
});
