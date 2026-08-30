/**
 * Страница подборки: разметка `CollectionPage` + `ItemList` (задача Э3-06).
 *
 * Норма — ТЗ §5.3 (состав страницы и разметки), `CLAUDE.md`, раздел
 * «Структурированные данные» («разметка соответствует видимому содержимому»).
 *
 * Главное, что здесь закрепляется: `ItemList` — это ВИДИМЫЙ список страницы, тот
 * же по составу, порядку и количеству. Проверить это можно только на входе
 * функции, поэтому она принимает уже собранный список — тот самый массив, который
 * шаблон отдаёт компоненту сетки (`apps/web/src/data/page-data.ts`, там же
 * проверяется, что массив ровно один).
 *
 * Хост в фикстуре синтетический: дефолта у `SITE_URL` в коде нет.
 */
import { describe, expect, it } from 'vitest';

import {
  type CollectionPageJsonLdInput,
  collectionPageJsonLd,
  type ListItemFacts,
} from '../../apps/web/src/seo/collection-page.js';
import { jsonLdScriptText } from '../../apps/web/src/seo/json-ld.js';

const ENV = { SITE_URL: 'https://podborki.test' } as const;

const ITEMS: readonly ListItemFacts[] = [
  { name: 'Открытка маме на 8 Марта с тюльпанами', path: '/otkrytki/otkrytka-mame-tyulpany' },
  { name: 'Открытка бабушке на 8 Марта', path: '/otkrytki/otkrytka-babushke-8-marta' },
  { name: 'Открытка коллеге на 8 Марта', path: '/otkrytki/otkrytka-kollege-8-marta' },
];

const INPUT: CollectionPageJsonLdInput = {
  canonicalPath: '/podborki/prazdniki/8-marta',
  heading: 'Открытки на 8 Марта',
  description: 'Открытки к 8 Марта: маме, бабушке, коллеге.',
  dateModified: '2026-02-14T10:00:00.000Z',
  items: ITEMS,
};

describe('разметка страницы подборки', () => {
  it('тип и абсолютный url страницы', () => {
    const jsonLd = collectionPageJsonLd(INPUT, ENV);

    expect(jsonLd['@context']).toBe('https://schema.org');
    expect(jsonLd['@type']).toBe('CollectionPage');
    expect(jsonLd.url).toBe(`${ENV.SITE_URL}/podborki/prazdniki/8-marta`);
    expect(jsonLd.name).toBe('Открытки на 8 Марта');
  });

  it('ItemList совпадает с видимым списком: те же элементы, тот же порядок, столько же', () => {
    const list = collectionPageJsonLd(INPUT, ENV).mainEntity;

    expect(list['@type']).toBe('ItemList');
    expect(list.numberOfItems).toBe(ITEMS.length);
    expect(list.itemListElement).toHaveLength(ITEMS.length);
    expect(list.itemListElement.map((element) => element.name)).toEqual(
      ITEMS.map((item) => item.name),
    );
    expect(list.itemListElement.map((element) => element.url)).toEqual(
      ITEMS.map((item) => `${ENV.SITE_URL}${item.path}`),
    );
    expect(list.itemListElement.map((element) => element.position)).toEqual([1, 2, 3]);
  });

  it('дата содержательного обновления попадает в dateModified как есть', () => {
    // Значение показывается на странице (ТЗ §5.3); в разметке оно то же самое —
    // дата без видимой даты была бы утверждением, которому нечего
    // соответствовать.
    expect(collectionPageJsonLd(INPUT, ENV).dateModified).toBe('2026-02-14T10:00:00.000Z');
  });

  it('незаполненные description и дата не дают пустых свойств', () => {
    const jsonLd = collectionPageJsonLd(
      { ...INPUT, dateModified: null, description: '  ' },
      ENV,
    );

    expect('description' in jsonLd).toBe(false);
    expect('dateModified' in jsonLd).toBe(false);
  });

  it('пустой список — отказ: у страницы без содержимого нет 200', () => {
    // Пустой ItemList описывал бы страницу, на которой ничего нет. Маршрут
    // обязан ответить 404 раньше (ТЗ §5.3), поэтому сюда пустой список приходить
    // не должен вовсе.
    expect(() => collectionPageJsonLd({ ...INPUT, items: [] }, ENV)).toThrow(/ItemList/);
  });

  it('пустое имя элемента и пустой заголовок отклоняются', () => {
    expect(() =>
      collectionPageJsonLd({ ...INPUT, items: [{ name: ' ', path: '/otkrytki/x' }] }, ENV),
    ).toThrow(/otkrytki\/x/);
    expect(() => collectionPageJsonLd({ ...INPUT, heading: '' }, ENV)).toThrow(/аголов/);
  });

  it('пути элементов приводятся к канонической форме — без завершающего слеша', () => {
    const list = collectionPageJsonLd(
      { ...INPUT, items: [{ name: 'Дочерняя подборка', path: '/podborki/prazdniki/8-marta/mame/' }] },
      ENV,
    ).mainEntity;

    expect(list.itemListElement[0]?.url).toBe(
      `${ENV.SITE_URL}/podborki/prazdniki/8-marta/mame`,
    );
  });

  it('абсолютный адрес вместо пути отклоняется', () => {
    expect(() =>
      collectionPageJsonLd({ ...INPUT, canonicalPath: 'https://chuzhoy.test/x' }, ENV),
    ).toThrow();
  });

  it('распарсенный текст блока тождественно равен объекту, а </script> тег не закрывает', () => {
    const jsonLd = collectionPageJsonLd(
      { ...INPUT, heading: 'Подборка </script><script>alert(1)</script>' },
      ENV,
    );
    const text = jsonLdScriptText(jsonLd);

    expect(JSON.parse(text)).toEqual(jsonLd);
    expect(text).not.toContain('</script>');
  });
});
